/**
 * analyze.js — 轨迹与日志的分析引擎
 *
 * 分三层，职责不混：
 *   第 1 层  analyzeTrack / analyzeLog   只产出「事实」（统计量 + 原始异常）
 *   第 2 层  correlate                   把轨迹缺口与日志时间轴对齐，给出归因
 *   第 3 层  diagnose                     把事实翻译成人能看的「问题 + 原因 + 处置」
 *
 * 全部纯函数，不碰 DOM，可在 node 里直接单测。
 *
 * 一条重要判断原则：**不把静止当成故障**。
 * 上位机写轨迹时会把重复坐标丢掉（见 nmea.js `_pushTrack`），所以设备停着不动
 * 时轨迹本来就不会增加点，Δt 会变得很大。这是正常行为，不是丢数据。
 * 只有「位移明显但时间断了」才算真缺口。
 */

import { haversine, lineType } from './export.js';
import { parseGGA } from './nmea.js';

/* ============================================================
   0. 阈值（全部集中在这里，报告里会原样引用，避免文档和代码两套数）
   ============================================================ */
export const TH = {
  gapFactor: 3,          // 采样间隔 > 中位值 3 倍才算缺口的候选
  gapMinS: 3,            // 且至少 3 秒
  gapStaticM: 12,        // 缺口期间位移 < 12m → 判定为静止停留（留出单点漂移余量）
  jumpSpeedKmh: 60,      // 跳点隐含速度下限
  jumpMinM: 20,          // 跳点位移下限
  spikeLegM: 25,         // 折返尖峰：两条腿都要超过 25m
  driftSpeedKmh: 4,      // 静止漂移的低速阈值
  driftMinS: 20,         // 持续 20 秒以上才算
  driftRadiusM: 6,       // 包络半径超过 6m
  driftPathRatio: 2.5,   // 且累计路径长度 > 2.5 倍半径（原地打转）
  altJumpM: 30,          // 高程跳变
  altJumpDistM: 80,      // 且水平位移小于 80m
  hdopWarn: 2.5,
  satsWarn: 6,
  logGapMinS: 2,
  lossMinS: 5,           // 连续未定位超过 5 秒才报
  badChecksumPct: 0.5,   // 校验错误率超过 0.5% 报警
  rateDropRatio: 0.5,    // 句率掉到中位数一半以下
};

/* ============================================================
   1. 统计小工具
   ============================================================ */

export function median(arr) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 分位数，p ∈ [0,1] */
export function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[i];
}

function sum(arr) {
  let s = 0;
  for (const v of arr) if (Number.isFinite(v)) s += v;
  return s;
}

function round(v, d = 1) {
  if (!Number.isFinite(v)) return null;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** 序列抽稀：保留首尾，按等间隔取样，图表只用这么多点 */
export function downsample(list, maxN = 240) {
  const a = Array.isArray(list) ? list : [];
  if (a.length <= maxN) return a.slice();
  const step = (a.length - 1) / (maxN - 1);
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(a[Math.round(i * step)]);
  return out;
}

/** 两个整数间的并集长度（用于累加重叠时段） */
function mergeRanges(ranges) {
  const a = ranges.filter((r) => r && r[1] > r[0]).sort((x, y) => x[0] - y[0]);
  if (!a.length) return [];
  const out = [a[0].slice()];
  for (let i = 1; i < a.length; i++) {
    const last = out[out.length - 1];
    if (a[i][0] <= last[1]) last[1] = Math.max(last[1], a[i][1]);
    else out.push(a[i].slice());
  }
  return out;
}

function rangeLen(ranges) {
  return mergeRanges(ranges).reduce((s, r) => s + (r[1] - r[0]), 0);
}

/* ============================================================
   2. 轨迹分析（第 1 层）
   ============================================================ */

/**
 * 合并同一处异常的多次命中。
 * 一次「飞出去又回来」会产生两条超速相邻对（出去一腿、回来一腿），
 * 折返尖峰规则还会再命中一次。合并后一次异常只报一条，`span` 记录跨了几个点。
 */
function mergeJumps(list) {
  const sorted = list.slice().sort((a, b) => a.i - b.i);
  const out = [];
  for (const j of sorted) {
    const last = out[out.length - 1];
    if (last && j.i - last.i <= 1) {
      last.span = (last.span || 1) + 1;
      last.distM = Math.max(last.distM || 0, j.distM || 0);
      last.speedKmh = Math.max(last.speedKmh || 0, j.speedKmh || 0) || null;
      if (j.kind === 'spike') last.kind = 'spike';
      continue;
    }
    out.push({ ...j, span: 1 });
  }
  return out;
}

/**
 * @param {Array} points 已按时间排序的轨迹点
 * @returns 事实对象，不含任何「原因」判断
 */
export function analyzeTrack(points) {
  const pts = Array.isArray(points) ? points : [];
  const n = pts.length;

  const out = {
    count: n,
    withTime: 0,
    distanceM: 0,
    durationS: 0,
    startT: null,
    endT: null,
    dt: null,            // {median, p95, max, min}
    speed: null,         // {p50, p95, p99, max, implied:[]}
    hdop: null,
    sats: null,
    qualityHist: [],
    bounds: null,
    gaps: [],
    jumps: [],
    drifts: [],
    altJumps: [],
    fixChanges: [],
    staticRatio: null,
    warnings: [],
  };
  if (!n) { out.warnings.push('没有轨迹点'); return out; }

  /* ---- 边界框 ---- */
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  if (minLat <= maxLat) {
    out.bounds = {
      minLat, maxLat, minLon, maxLon,
      centerLat: (minLat + maxLat) / 2,
      centerLon: (minLon + maxLon) / 2,
      spanLatM: haversine(minLat, minLon, maxLat, minLon),
      spanLonM: haversine(minLat, minLon, minLat, maxLon),
    };
  }

  /* ---- 逐对相邻点：距离、时间差、隐含速度 ---- */
  const pairs = [];
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dist = haversine(a.lat, a.lon, b.lat, b.lon);
    out.distanceM += dist;
    const dt = (a.t != null && b.t != null) ? (b.t - a.t) / 1000 : null;
    const kmh = (dt && dt > 0) ? (dist / dt) * 3.6 : null;
    pairs.push({ i, dist, dt, kmh });
  }

  const timed = pairs.filter((p) => Number.isFinite(p.dt) && p.dt > 0);
  out.withTime = timed.length ? n : 0;

  if (!timed.length) {
    out.warnings.push('轨迹点没有可用的时间戳，跳过了所有时间相关检查');
  } else {
    const dts = timed.map((p) => p.dt);
    const medDt = median(dts);
    out.dt = {
      median: round(medDt, 2),
      p95: round(percentile(dts, 0.95), 2),
      min: round(Math.min(...dts), 3),
      max: round(Math.max(...dts), 2),
      samples: dts.length,
    };
    const t0 = pts.find((p) => p.t != null)?.t;
    const t1 = [...pts].reverse().find((p) => p.t != null)?.t;
    out.startT = t0 ?? null;
    out.endT = t1 ?? null;
    if (t0 != null && t1 != null) out.durationS = Math.max(0, (t1 - t0) / 1000);

    /* ---- 采样缺口 ---- */
    const gapThr = Math.max(TH.gapMinS, medDt * TH.gapFactor);
    for (const p of timed) {
      if (p.dt <= gapThr) continue;
      const a = pts[p.i - 1];
      const b = pts[p.i];
      out.gaps.push({
        i0: p.i - 1, i1: p.i,
        t0: a.t, t1: b.t,
        dtS: round(p.dt, 1),
        distM: round(p.dist, 1),
        speedKmh: round(p.kmh, 1),
        from: { lat: a.lat, lon: a.lon },
        to: { lat: b.lat, lon: b.lon },
        kind: 'unknown',
        cause: '',
        evidence: [],
      });
    }
    out.gaps.sort((x, y) => y.dtS - x.dtS);

    /* ---- 跳点：隐含速度异常 ---- */
    const speeds = timed.filter((p) => p.dist > 1).map((p) => p.kmh).filter(Number.isFinite);
    const p95 = percentile(speeds, 0.95);
    const jumpThr = Math.max((p95 ?? 0) * 3, TH.jumpSpeedKmh);
    for (const p of timed) {
      if (p.dt > 60) continue;                     // 断档跨接不算跳点
      if (p.dist < TH.jumpMinM) continue;
      if (!(p.kmh > jumpThr)) continue;
      out.jumps.push({
        i: p.i, t: pts[p.i].t,
        distM: round(p.dist, 1),
        dtS: round(p.dt, 2),
        speedKmh: round(p.kmh, 1),
        threshold: round(jumpThr, 1),
        lat: pts[p.i].lat, lon: pts[p.i].lon,
        kind: 'speed',
      });
    }
  }

  /* ---- 折返尖峰：出去又回来，前后两点却挨得很近 ---- */
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const d1 = haversine(a.lat, a.lon, b.lat, b.lon);
    const d2 = haversine(b.lat, b.lon, c.lat, c.lon);
    const d3 = haversine(a.lat, a.lon, c.lat, c.lon);
    if (d1 > TH.spikeLegM && d2 > TH.spikeLegM && d3 < 0.5 * Math.min(d1, d2)) {
      out.jumps.push({
        i, t: b.t, distM: round(d1, 1), dtS: null,
        speedKmh: null, threshold: null,
        lat: b.lat, lon: b.lon, kind: 'spike',
        returnM: round(d3, 1),
      });
    }
  }
  if (out.jumps.length > 200) out.jumps.length = 200;
  // 同一个异常点会被「速度」和「折返尖峰」两条规则各抓一次；
  // 出去的腿和回来的腿又是两个相邻索引。合并成一次事件，否则计数会翻倍，看着像出了 4 次问题。
  out.jumps = mergeJumps(out.jumps);

  /* ---- 静止漂移：低速段里原地打转 ---- */
  {
    const lowPairs = [];
    for (let k = 0; k < pairs.length; k++) {
      const p = pairs[k];
      if (Number.isFinite(p.kmh) && p.kmh < TH.driftSpeedKmh && p.dt <= 10) lowPairs.push(k);
    }
    // 把相邻的索引连成段
    const runs = [];
    let cur = null;
    for (const k of lowPairs) {
      if (cur && k === cur[cur.length - 1] + 1) cur.push(k);
      else { cur = [k]; runs.push(cur); }
    }
    for (const run of runs) {
      if (run.length < 3) continue;
      const i0 = pairs[run[0]].i - 1;
      const i1 = pairs[run[run.length - 1]].i;
      const seg = pts.slice(i0, i1 + 1);
      const t0 = seg[0].t, t1 = seg[seg.length - 1].t;
      if (t0 == null || t1 == null) continue;
      const durS = (t1 - t0) / 1000;
      if (durS < TH.driftMinS) continue;

      const cLat = sum(seg.map((p) => p.lat)) / seg.length;
      const cLon = sum(seg.map((p) => p.lon)) / seg.length;
      let maxR = 0;
      for (const p of seg) maxR = Math.max(maxR, haversine(cLat, cLon, p.lat, p.lon));
      const pathLen = sum(seg.slice(1).map((p, k) => haversine(seg[k].lat, seg[k].lon, p.lat, p.lon)));

      if (maxR > TH.driftRadiusM && pathLen > TH.driftPathRatio * maxR) {
        out.drifts.push({
          i0, i1, t0, t1,
          durS: round(durS, 1),
          radiusM: round(maxR, 1),
          pathLenM: round(pathLen, 1),
          center: { lat: cLat, lon: cLon },
          points: seg.length,
        });
      }
    }
    if (out.drifts.length > 50) out.drifts.length = 50;

    // 静止占比：低于 1km/h 的时间 / 总时长
    if (out.durationS > 0) {
      const stillS = sum(lowPairs.map((k) => pairs[k].dt));
      out.staticRatio = round(Math.min(1, stillS / out.durationS) * 100, 1);
    }
  }

  /* ---- 高程跳变 ---- */
  for (const p of pairs) {
    const a = pts[p.i - 1], b = pts[p.i];
    if (a.alt == null || b.alt == null) continue;
    const dAlt = Math.abs(b.alt - a.alt);
    if (dAlt < TH.altJumpM) continue;
    if (p.dist > TH.altJumpDistM) continue;
    if (p.dt != null && p.dt > 10) continue;
    out.altJumps.push({
      i: p.i, t: b.t, dAltM: round(b.alt - a.alt, 1),
      distM: round(p.dist, 1), lat: b.lat, lon: b.lon,
    });
  }
  if (out.altJumps.length > 100) out.altJumps.length = 100;

  /* ---- 定位质量变化 ---- */
  for (let i = 1; i < n; i++) {
    const q0 = pts[i - 1].quality;
    const q1 = pts[i].quality;
    if (q0 == null || q1 == null || q0 === q1) continue;
    out.fixChanges.push({
      i, t: pts[i].t, from: q0, to: q1,
      lat: pts[i].lat, lon: pts[i].lon,
      dir: q1 > q0 ? 'up' : 'down',
    });
  }
  if (out.fixChanges.length > 200) out.fixChanges.length = 200;

  /* ---- 质量分布与 DOP ---- */
  const qCount = new Map();
  for (const p of pts) {
    if (p.quality == null) continue;
    qCount.set(p.quality, (qCount.get(p.quality) || 0) + 1);
  }
  out.qualityHist = [...qCount.entries()]
    .map(([q, cnt]) => ({ q: Number(q), count: cnt }))
    .sort((a, b) => a.q - b.q);

  const hdops = pts.map((p) => p.hdop).filter(Number.isFinite);
  if (hdops.length) {
    out.hdop = {
      min: round(Math.min(...hdops), 2),
      median: round(median(hdops), 2),
      p95: round(percentile(hdops, 0.95), 2),
      max: round(Math.max(...hdops), 2),
      overPct: round((hdops.filter((h) => h > TH.hdopWarn).length / hdops.length) * 100, 1),
    };
  }

  // 卫星数只有日志（GGA 第 8 字段）里有，轨迹点不带这个信息 —— 不在这里编造。

  /* ---- 速度统计 ---- */
  if (timed.length && out.durationS > 0) {
    // dist > 1m 才计入分位数：静止时的厘米级抖动会把 p50 拉到 0 附近，没意义
    const sp = timed.filter((p) => p.dist > 1).map((p) => p.kmh).filter(Number.isFinite);
    out.speed = {
      p50: sp.length ? round(percentile(sp, 0.5), 1) : null,
      p95: sp.length ? round(percentile(sp, 0.95), 1) : null,
      p99: sp.length ? round(percentile(sp, 0.99), 1) : null,
      max: sp.length ? round(Math.max(...sp), 1) : null,
      // 整体平均速度含静止时段，用里程 / 时长算，不依赖分位数样本
      avgMv: round((out.distanceM / out.durationS) * 3.6, 1),
      samples: sp.length,
    };
  }

  return out;
}

/* ============================================================
   3. 日志分析（第 1 层）
   ============================================================ */

export function analyzeLog(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.line === 'string');
  const out = {
    count: list.length,
    spanS: 0,
    startT: null,
    endT: null,
    ratePerSec: null,
    types: [],
    typeCount: 0,
    badChecksum: 0,
    badPct: 0,
    sumCoverage: 0,
    gaps: [],
    gga: [],
    fixSegments: [],
    qualityTime: [],
    lossPeriods: [],
    txt: [],
    ins: [],
    timeBackwards: 0,
    missingTypes: [],
    warnings: [],
  };
  if (!list.length) { out.warnings.push('没有日志条目'); return out; }

  /* ---- 类型分布 + 校验和 ---- */
  const tCount = new Map();
  let withSum = 0;
  for (const e of list) {
    const ty = lineType(e.line);
    tCount.set(ty || '?', (tCount.get(ty || '?') || 0) + 1);
    const star = e.line.lastIndexOf('*');
    if (star > 0) withSum++;
  }
  out.types = [...tCount.entries()].map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  out.typeCount = out.types.length;
  out.sumCoverage = round((withSum / list.length) * 100, 1);

  /* ---- 时间轴 ---- */
  const ts = list.map((e) => e.t).filter(Number.isFinite);
  if (ts.length < 2) {
    out.warnings.push('日志没有可用时间戳，无法做时序分析');
  } else {
    out.startT = Math.min(...ts);
    out.endT = Math.max(...ts);
    out.spanS = (out.endT - out.startT) / 1000;
    if (out.spanS > 0) out.ratePerSec = round(list.length / out.spanS, 2);

    let prev = null;
    const dts = [];
    for (const e of list) {
      if (!Number.isFinite(e.t)) continue;
      if (prev != null) {
        const dt = (e.t - prev) / 1000;
        if (dt < -1) out.timeBackwards++;
        else if (dt > 0) dts.push(dt);
      }
      prev = e.t;
    }
    const medDt = median(dts);
    if (medDt != null) {
      const thr = Math.max(TH.logGapMinS, medDt * TH.gapFactor);
      prev = null;
      let prevLine = null;
      for (const e of list) {
        if (!Number.isFinite(e.t)) continue;
        if (prev != null) {
          const dt = (e.t - prev) / 1000;
          if (dt > thr) {
            out.gaps.push({
              t0: prev, t1: e.t, dtS: round(dt, 1),
              before: prevLine, after: e.line,
              typeBefore: lineType(prevLine || ''), typeAfter: lineType(e.line),
            });
          }
        }
        prev = e.t; prevLine = e.line;
      }
      out.gaps.sort((a, b) => b.dtS - a.dtS);
      if (out.gaps.length > 200) out.gaps.length = 200;
    }
  }

  /* ---- GGA 序列 ---- */
  for (const e of list) {
    const ty = lineType(e.line);
    if (!ty.endsWith('GGA')) continue;
    const f = e.line.slice(1).split('*')[0].split(',');
    const g = parseGGA(f);
    if (g.quality == null) continue;
    out.gga.push({
      t: e.t,
      quality: g.quality,
      sats: g.sats,
      // 无定位时很多设备把 HDOP 填 99.99 当占位符，直接当数据画会把曲线压扁
      hdop: g.hdop != null && g.hdop < 50 ? g.hdop : null,
      lat: g.lat,
      lon: g.lon,
      alt: g.alt,
    });
  }

  /* ---- 按定位质量切段 ---- */
  if (out.gga.length) {
    let seg = null;
    for (const g of out.gga) {
      if (!seg || seg.quality !== g.quality) {
        if (seg) seg.t1 = g.t ?? seg.t1;
        if (seg) out.fixSegments.push(seg);
        seg = { quality: g.quality, t0: g.t, t1: g.t, count: 1 };
      } else {
        seg.count++;
        if (g.t != null) seg.t1 = g.t;
      }
    }
    if (seg) out.fixSegments.push(seg);

    for (const s of out.fixSegments) {
      s.durS = (s.t0 != null && s.t1 != null) ? round((s.t1 - s.t0) / 1000, 1) : null;
    }

    // 各质量等级累计时长（含重叠段合并，避免重复计时）
    const byQ = new Map();
    for (const s of out.fixSegments) {
      if (s.durS == null) continue;
      const arr = byQ.get(s.quality) || [];
      arr.push([s.t0, s.t1]);
      byQ.set(s.quality, arr);
    }
    for (const [q, ranges] of byQ) {
      out.qualityTime.push({ q, seconds: round(rangeLen(ranges) / 1000, 1) });
    }
    out.qualityTime.sort((a, b) => a.q - b.q);

    // 连续未定位
    for (const s of out.fixSegments) {
      if (s.quality !== 0) continue;
      if (s.durS == null || s.durS < TH.lossMinS) continue;
      out.lossPeriods.push({ t0: s.t0, t1: s.t1, durS: s.durS });
    }
    if (out.lossPeriods.length > 100) out.lossPeriods.length = 100;
  } else {
    out.warnings.push('日志里没有可解析的 GGA 语句，定位质量无法评估');
  }

  /* ---- TXT / 惯导状态 ---- */
  for (const e of list) {
    const ty = lineType(e.line);
    if (ty.endsWith('TXT')) {
      const f = e.line.slice(1).split('*')[0].split(',');
      const text = f.slice(4).join(',').trim();
      if (text) out.txt.push({ t: e.t, text });
    } else if (ty === 'SNRSTAT') {
      const f = e.line.slice(1).split('*')[0].split(',');
      out.ins.push({ t: e.t, ins: Number(f[1]), odo: Number(f[2]) });
    }
  }
  if (out.txt.length > 200) out.txt.length = 200;

  /* ---- 语句类型完整性 ---- */
  const has = (suffix) => out.types.some((t) => t.type.endsWith(suffix));
  const expect = [
    ['GGA', '定位数据'], ['RMC', '最小定位信息'],
    ['GSV', '可见卫星'], ['GSA', '精度因子与参与解算'],
  ];
  for (const [suf, why] of expect) {
    if (!has(suf)) out.missingTypes.push({ type: suf, why });
  }

  /* ---- 校验和错误（放最后，避免拖慢前面的循环） ---- */
  out.badChecksum = 0;
  for (const e of list) {
    const star = e.line.lastIndexOf('*');
    if (star < 0) continue;
    let c = 0;
    for (let i = 1; i < star; i++) c ^= e.line.charCodeAt(i);
    const want = e.line.slice(star + 1, star + 3).toUpperCase();
    const got = c.toString(16).toUpperCase().padStart(2, '0');
    if (want && want !== got) out.badChecksum++;
  }
  out.badPct = round((out.badChecksum / list.length) * 100, 3);

  return out;
}

/* ============================================================
   4. 轨迹 × 日志 时间轴对齐（第 2 层）
   ============================================================ */

/**
 * 给每个轨迹缺口定性。
 *
 * 判据顺序很重要：
 *   ① 日志在缺口时段整个没有数据  → 链路 / 供电 / 波特率问题
 *   ② 日志有数据但 GGA 全是 quality=0 → 定位丢失（遮挡、多路径、天空视野不足）
 *   ③ 日志定位正常、位移又很小      → 设备静止，轨迹去重导致没有新点（正常）
 *   ④ 日志定位正常、位移也明显      → 记录侧问题（缓冲丢点、解析异常）
 */
export function correlate(trackA, logA) {
  if (!trackA || !trackA.gaps || !trackA.gaps.length) return trackA;
  const gga = (logA && logA.gga) || [];
  const logGaps = (logA && logA.gaps) || [];
  const hasLog = !!(logA && logA.count);

  for (const g of trackA.gaps) {
    const t0 = g.t0, t1 = g.t1;
    if (t0 == null || t1 == null) { g.kind = 'notime'; continue; }

    if (!hasLog) {
      g.kind = g.distM < TH.gapStaticM ? 'static' : 'unknown';
      g.cause = g.kind === 'static'
        ? '期间位移很小，设备应处于静止状态；静止时坐标不变，轨迹不会新增点'
        : '没有日志文件，无法判定是定位丢失还是链路中断。建议同时导入同时间段的日志';
      continue;
    }

    // ① 日志本身在这段时间也断了
    const covering = logGaps.find((lg) => lg.t0 <= t1 && lg.t1 >= t0);
    const inWindow = gga.filter((x) => x.t != null && x.t >= t0 && x.t <= t1);
    const logSilent = covering || (!inWindow.length && (t1 - t0) > (TH.logGapMinS * 1000));

    if (logSilent) {
      g.kind = 'link';
      const dur = covering ? covering.dtS : g.dtS;
      g.cause = `日志在同一时段也中断了 ${dur}s，说明语句流本身没到上位机 —— `
        + '通常是 USB 线松动 / 供电跌落 / 串口被占用 / 设备重启，而不是卫星信号问题';
      g.evidence.push(covering
        ? `日志最后一条：${(covering.before || '').slice(0, 42)}…`
        : '该时段日志无任何语句');
      continue;
    }

    // ② 有数据但没定位
    const zero = inWindow.filter((x) => x.quality === 0).length;
    if (inWindow.length && zero / inWindow.length > 0.8) {
      g.kind = 'lost';
      g.cause = `期间收到 ${inWindow.length} 条 GGA，其中 ${zero} 条 quality=0（未定位）—— `
        + '定位解算中断，常见原因是天线被遮挡（隧道、地库、楼间）、多路径反射或天空视野不足';
      const satellites = inWindow.map((x) => x.sats).filter(Number.isFinite);
      if (satellites.length) g.evidence.push(`期间参与解算卫星数 ${Math.min(...satellites)}~${Math.max(...satellites)} 颗`);
      continue;
    }

    // ③ / ④ 有定位，看点有没有动
    // 只看轨迹两端的距离不够：长时间停车时单点漂移能攒出十几米。
    // 用窗口内所有 GGA 相对首点的最大偏移，才能判断「是不是真的没动」。
    const withPos = inWindow.filter((x) => x.lat != null && x.lon != null);
    let spreadM = 0;
    if (withPos.length > 1) {
      const p0 = withPos[0];
      for (const x of withPos) {
        spreadM = Math.max(spreadM, haversine(p0.lat, p0.lon, x.lat, x.lon));
      }
    }
    const movedM = Math.max(g.distM, spreadM);

    if (movedM < TH.gapStaticM) {
      g.kind = 'static';
      g.cause = `期间最大位移仅 ${round(movedM, 1)}m，设备在原地停着；坐标没变，上位机按「相同坐标不入轨迹」处理，`
        + '所以轨迹出现空档属正常现象，不是丢数据';
      g.evidence.push(`窗口内 ${withPos.length || 0} 条 GGA 的位置基本没动`);
      continue;
    }

    g.kind = 'unrecorded';
    g.cause = `期间日志定位正常（${inWindow.length} 条 GGA，quality 均大于 0）且位置移动了 ${round(movedM, 1)}m，`
      + '但轨迹少了这一段 —— 问题出在记录侧：可能是轨迹缓冲达到上限后滚掉了早期点，或导入的时间范围被裁剪过';
  }

  return trackA;
}

/* ============================================================
   5. 问题诊断（第 3 层）
   ============================================================ */

const SEV = { info: 1, warn: 2, bad: 3 };

const FIX_NAME = {
  0: '未定位', 1: '单点定位', 2: '伪距差分', 3: 'PPS',
  4: 'RTK 固定', 5: 'RTK 浮动', 6: '航位推算', 7: '手动', 8: '仿真',
};

/** 毫秒 → HH:MM:SS（本地时间），报告与列表都按本地时间显示 */
export function hhmmss(ms) {
  if (!Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  return `${Math.floor(sec / 3600)} 时 ${Math.round((sec % 3600) / 60)} 分`;
}

/**
 * 生成问题清单。
 * @returns {{issues: Array, counts: {bad,warn,info}}}
 */
export function diagnose(trackA, logA, opts = {}) {
  const issues = [];
  const push = (iss) => {
    issues.push({
      id: `${iss.code}-${issues.length}`,
      level: 'info',
      evidence: [],
      count: 1,
      ...iss,
    });
  };

  /* ---------- 轨迹 ---------- */
  if (trackA && trackA.count) {
    const a = trackA;

    if (!a.withTime) {
      push({
        level: 'warn',
        code: 'TRACK_NO_TIME',
        title: '轨迹文件不含时间戳',
        detail: '所有点都缺时间字段，采样间隔、断档、速度都无法计算。',
        cause: '导出的格式里时间为空，或源文件（如部分 KML）本身没有时间序列。',
        advice: '改用 GPX 或 CSV 格式导出 —— 这两种都带 ISO 时间；KML 的 LineString 不带时间。',
      });
    }

    if (a.count < 10) {
      push({
        level: 'warn',
        code: 'TRACK_FEW',
        title: `轨迹只有 ${a.count} 个点，样本太少`,
        detail: '点数不足以判断定位质量与连续性，任何统计结论都不可靠。',
        cause: '记录时间过短，或导入时被「最近 N 分钟」范围裁掉了大部分。',
        advice: '至少记录 2~3 分钟再导出，并确认导出范围选的是「全部」。',
      });
    }

    // 缺口：按定性分别汇总，但每条缺口单独列出（原因可能不同）
    const gapGroups = { link: [], lost: [], static: [], unrecorded: [], unknown: [], notime: [] };
    for (const g of a.gaps) (gapGroups[g.kind] || gapGroups.unknown).push(g);

    for (const g of gapGroups.link.slice(0, 8)) {
      push({
        level: 'bad',
        code: 'TRACK_GAP_LINK',
        title: `轨迹中断 ${fmtDur(g.dtS)}（${hhmmss(g.t0)} → ${hhmmss(g.t1)}）`,
        detail: `这段没有任何轨迹点；恢复后位置直接跳到 ${g.distM} m 之外，`
          + `相当于 ${g.speedKmh ?? '—'} km/h 的位移。`,
        cause: g.cause,
        advice: '换一根短的、带屏蔽的 USB 线；避免用无源 HUB；确认供电稳定（模块板 5V 输入）。'
          + '若用的是 CH343，注意 macOS 在休眠恢复后可能重新枚举设备。',
        t: g.t0, lat: g.from.lat, lon: g.from.lon,
        evidence: g.evidence,
        samples: [g],
      });
    }

    for (const g of gapGroups.lost.slice(0, 8)) {
      push({
        level: 'warn',
        code: 'TRACK_GAP_LOST',
        title: `定位丢失 ${fmtDur(g.dtS)}（${hhmmss(g.t0)} → ${hhmmss(g.t1)}）`,
        detail: `这段没有有效定位解；恢复后位置跳到 ${g.distM} m 之外。`,
        cause: g.cause,
        advice: '把天线尽量放到车顶或窗外，避开金属车顶与贴膜玻璃；'
          + '城市峡谷里单频单点定位本来就不可靠，属预期行为。',
        t: g.t0, lat: g.from.lat, lon: g.from.lon,
        evidence: g.evidence,
        samples: [g],
      });
    }

    if (gapGroups.static.length) {
      const total = sum(gapGroups.static.map((g) => g.dtS));
      push({
        level: 'info',
        code: 'TRACK_GAP_STATIC',
        title: `${gapGroups.static.length} 段静止停留共 ${fmtDur(total)}`,
        detail: '这些空档期间设备没有移动，坐标未变化，上位机按「相同坐标不重复入轨迹」处理。',
        cause: '不是故障：轨迹点只记录位置变化，静止时本来就不会产生新点。',
        advice: '无需处理。若希望静止时也有连续记录，应改用「按时间采样」的日志分析而不是看轨迹点密度。',
        count: gapGroups.static.length,
      });
    }

    if (gapGroups.unrecorded.length) {
      const total = sum(gapGroups.unrecorded.map((g) => g.dtS));
      push({
        level: 'warn',
        code: 'TRACK_GAP_UNREC',
        title: `${gapGroups.unrecorded.length} 段轨迹缺失但日志正常，共 ${fmtDur(total)}`,
        detail: '同一时段日志里定位有效，轨迹却少了这段 —— 定位没问题，是记录环节丢了。',
        cause: '轨迹缓冲上限 20000 点，超出后最早的会被滚动丢弃；或导出时选了较短的时间范围。',
        advice: '长时间记录请直接导出日志（NMEA 全量），用日志分析板块做时序统计，不要依赖轨迹数组。',
        count: gapGroups.unrecorded.length,
      });
    }

    if (gapGroups.unknown.length) {
      const worst = gapGroups.unknown[0];
      push({
        level: 'warn',
        code: 'TRACK_GAP_UNKNOWN',
        title: `${gapGroups.unknown.length} 段轨迹中断原因未定`,
        detail: `最长一段 ${fmtDur(worst.dtS)}（${hhmmss(worst.t0)}），期间位移 ${worst.distM} m。`,
        cause: '只导入了轨迹文件，没有同时间段的日志，无法区分「链路断了」和「定位丢了」。',
        advice: '把同时段的 NMEA 日志一起导入，本工具会自动对齐时间轴并给出判定。',
        count: gapGroups.unknown.length,
      });
    }

    // 跳点
    if (a.jumps.length) {
      const worst = a.jumps.slice().sort((x, y) => y.distM - x.distM)[0];
      push({
        level: 'warn',
        code: 'TRACK_JUMP',
        title: `${a.jumps.length} 处位置跳变`,
        detail: `最大一次 ${hhmmss(worst.t)} 跳了 ${worst.distM} m`
          + (worst.speedKmh ? `，隐含速度 ${worst.speedKmh} km/h（阈值 ${worst.threshold}）` : '，前后两点却靠得很近'),
        cause: '多路径反射（玻璃幕墙、大车侧面、金属结构）或卫星几何突变导致解算位置瞬间偏移；'
          + '参考星切换、星历更新时也会出现单点跳变。',
        advice: '导入日志看该时刻的 HDOP 与参与解算卫星数：HDOP 骤升或卫星数骤降即印证多路径。'
          + '后处理时可对这类点做剔除，但不要平滑掉整段。',
        t: worst.t, lat: worst.lat, lon: worst.lon,
        count: a.jumps.length,
        samples: a.jumps.slice(0, 5),
      });
    }

    // 静止漂移
    if (a.drifts.length) {
      const worst = a.drifts.slice().sort((x, y) => y.radiusM - x.radiusM)[0];
      push({
        level: 'info',
        code: 'TRACK_DRIFT',
        title: `${a.drifts.length} 段静止漂移，最大 ${worst.radiusM} m`,
        detail: `${hhmmss(worst.t0)} 起静止 ${fmtDur(worst.durS)}，位置在 ${worst.radiusM} m 范围内游走，累计路径 ${worst.pathLenM} m`,
        cause: '单点定位的固有精度极限（手册标称 1.5 m CEP 是开阔天空下的水平精度，实际受 HDOP 与多路径影响更大）。'
          + '静止时定位解会围绕真值随机游走，看起来像在动。',
        advice: '这是正常现象，不是模块故障。要减小漂移需差分（伪距差分可改善）或换 RTK 机型（UM980/UM981）。'
          + '后处理时对低速段做停留点合并即可。',
        t: worst.t0, lat: worst.center.lat, lon: worst.center.lon,
        count: a.drifts.length,
        samples: a.drifts.slice(0, 3),
      });
    }

    // 高程跳变
    if (a.altJumps.length) {
      const worst = a.altJumps.slice().sort((x, y) => Math.abs(y.dAltM) - Math.abs(x.dAltM))[0];
      push({
        level: 'info',
        code: 'TRACK_ALT_JUMP',
        title: `${a.altJumps.length} 处高程跳变`,
        detail: `最大一次 ${hhmmss(worst.t)} 高程突变 ${worst.dAltM} m，水平位移只有 ${worst.distM} m`,
        cause: '高程方向（VDOP）本来就是最弱的一维；卫星几何变化或对流层模型修正会导致高程台阶式跳变。',
        advice: '平面导航一般不需要关心；若业务依赖高程，需专门评估 VDOP 并考虑高程约束。',
        t: worst.t, lat: worst.lat, lon: worst.lon,
        count: a.altJumps.length,
      });
    }

    // 定位质量降级
    const downs = (a.fixChanges || []).filter((c) => c.dir === 'down');
    if (downs.length) {
      const worst = downs[0];
      push({
        level: 'warn',
        code: 'TRACK_FIX_DOWN',
        title: `定位状态降级 ${downs.length} 次`,
        detail: `首次出现在 ${hhmmss(worst.t)}：${FIX_NAME[worst.from] || worst.from} → ${FIX_NAME[worst.to] || worst.to}`,
        cause: '卫星几何变差、信号遮挡，或差分数据中断（若之前在差分状态）。',
        advice: '对照日志确认同一时刻的卫星数与 HDOP；若用的是 NTRIP 差分，检查 caster 是否掉线。',
        t: worst.t, lat: worst.lat, lon: worst.lon,
        count: downs.length,
      });
    }

    // HDOP
    if (a.hdop && a.hdop.overPct > 5) {
      push({
        level: 'warn',
        code: 'TRACK_HDOP',
        title: `HDOP 偏高，${a.hdop.overPct}% 的时间超过 ${TH.hdopWarn}`,
        detail: `中位 ${a.hdop.median}，95 分位 ${a.hdop.p95}，最大 ${a.hdop.max}`,
        cause: '参与解算的卫星几何分布差 —— 卫星集中在天顶或某一侧，水平方向撑不开。',
        advice: '开阔环境下 HDOP 通常 < 1.5。持续偏高说明安装位置视野受限，优先改善天线位置而不是换模块。',
      });
    }
  }

  /* ---------- 日志 ---------- */
  if (logA && logA.count) {
    const l = logA;

    for (const g of (l.gaps || []).slice(0, 8)) {
      if (g.dtS < TH.logGapMinS * 2) continue;
      push({
        level: g.dtS > 10 ? 'bad' : 'warn',
        code: 'LOG_GAP',
        title: `语句流中断 ${fmtDur(g.dtS)}（${hhmmss(g.t0)} → ${hhmmss(g.t1)}）`,
        detail: `断开前最后一条是 ${g.typeBefore || '未知'}，恢复后第一条是 ${g.typeAfter || '未知'}`,
        cause: '上位机在这段时间没收到任何字节。可能：串口读循环卡住、USB 掉线重连、设备重启、'
          + '或浏览器标签页被后台节流（Chrome 对后台页会限制定时器）。',
        advice: '长时间记录时保持页面在前台；用带独立供电的 HUB；检查 `dmesg` 里是否有 USB 重新枚举。',
        t: g.t0,
        count: 1,
        samples: [g],
      });
    }

    if (l.badPct > TH.badChecksumPct) {
      push({
        level: 'warn',
        code: 'LOG_CHECKSUM',
        title: `校验和错误 ${l.badChecksum} 条（${l.badPct}%）`,
        detail: `共 ${l.count} 条语句，其中 ${l.badChecksum} 条校验不通过。`,
        cause: '字节在传输中被破坏。常见于波特率不匹配（模块 460800，上位机设成 115200 会满屏错误）、'
          + '线材过长、共地不良、或 USB 转串口芯片供电不足。',
        advice: '先确认两端波特率一致；再换短线；TTL 直连时务必共地。'
          + '零星几十条属正常（热插拔瞬间），持续出现才是问题。',
      });
    }

    if (l.sumCoverage < 95 && l.count > 100) {
      push({
        level: 'info',
        code: 'LOG_NOSUM',
        title: `${(100 - l.sumCoverage).toFixed(1)}% 的语句没有校验和`,
        detail: '这些语句无法验证完整性，坏字节会被当成正常数据解析。',
        cause: '设备侧关闭了校验和输出，或日志被别的工具裁剪过。',
        advice: '一般不影响使用，但排查数据错误时建议让设备输出校验和（默认是开的）。',
      });
    }

    for (const p of (l.lossPeriods || []).slice(0, 8)) {
      push({
        level: p.durS > 30 ? 'bad' : 'warn',
        code: 'LOG_NO_FIX',
        title: `连续未定位 ${fmtDur(p.durS)}（${hhmmss(p.t0)} 起）`,
        detail: '这段时间 GGA 的 quality 字段一直是 0，没有有效定位解。',
        cause: '天线被遮挡或信号太弱；冷启动初期搜星也属正常（首次定位通常 30~60 秒）。',
        advice: '确认是否在室内/地库/隧道；室外长时间不定位要检查天线连接与供电，'
          + '并回读 CFGSYS 确认频点没有被关掉。',
        t: p.t0,
        count: 1,
        samples: [p],
      });
    }

    // 未定位总时长
    const zeroTime = (l.qualityTime || []).find((q) => q.q === 0);
    if (zeroTime && l.spanS > 0) {
      const pct = (zeroTime.seconds / l.spanS) * 100;
      if (pct > 20) {
        push({
          level: 'warn',
          code: 'LOG_FIX_LOW',
          title: `未定位时间占 ${pct.toFixed(1)}%`,
          detail: `总时长 ${fmtDur(l.spanS)}，其中 ${fmtDur(zeroTime.seconds)} 处于 quality=0。`,
          cause: '记录期间有相当比例时间没有定位解，通常是室内测试或天线位置不佳。',
          advice: '若为室内测试属正常；若在车上路测出现，需检查天线安装位置与馈线。',
        });
      }
    }

    if (l.missingTypes.length) {
      push({
        level: 'info',
        code: 'LOG_MISSING',
        title: `日志里缺少 ${l.missingTypes.map((m) => m.type).join(' / ')} 语句`,
        detail: l.missingTypes.map((m) => `${m.type}（${m.why}）`).join('、') + ' 完全没有出现。',
        cause: '输出语句配置里把这些关掉了，或导出的是裁剪过的片段。',
        advice: '需要完整分析时，在控制中心的「输出语句」里把 GGA/RMC/GSV/GSA 都打开。',
      });
    }

    if (l.timeBackwards > 3) {
      push({
        level: 'warn',
        code: 'LOG_TIME_BACK',
        title: `时间戳回退 ${l.timeBackwards} 次`,
        detail: '主机时间出现倒退，说明日志里混入了不同来源，或系统时间被调整过。',
        cause: '常见于把多段日志拼接在一起，或记录过程中系统对时（NTP）跳变。',
        advice: '分析时序前先确认是同一次会话的日志；必要时按文件名分段分析。',
      });
    }

    if (l.ins.length) {
      const last = l.ins[l.ins.length - 1];
      if (Number.isFinite(last.ins) && last.ins >= 0 && last.ins < 3) {
        push({
          level: 'warn',
          code: 'LOG_INS_UNREADY',
          title: `惯导未完成初始化（insstatus=${last.ins}）`,
          detail: `结束时 insstatus 仍为 ${last.ins}，说明组合导航没有收敛。`,
          cause: '惯导需要真实运动才能完成安装角与刻度因数标定；原地静止会一直停在「初始化开始」。'
            + '也可能是安装方式配置不对（应为自由安装）。',
          advice: '按「自由安装 → 车辆行驶 5~10 分钟（含转弯与加减速）→ insstatus=3 → 完全断电」的流程做一次标定。',
        });
      }
    }

    for (const t of (l.txt || []).slice(0, 10)) {
      push({
        level: 'info',
        code: 'LOG_TXT',
        title: `设备文本消息：${t.text.slice(0, 40)}`,
        detail: `出现在 ${hhmmss(t.t)}。`,
        cause: '模块通过 $xxTXT 主动上报的状态或告警。',
        advice: '对照协议文档的 TXT 消息表解读；反复出现同一条要重视，偶发可忽略。',
        t: t.t,
        count: 1,
      });
    }
  }

  /* ---------- 排序 ---------- */
  issues.sort((a, b) => (SEV[b.level] - SEV[a.level]) || ((b.t || 0) - (a.t || 0)));

  const counts = { bad: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.level]++;

  return { issues, counts };
}

/* ============================================================
   6. 评分与结论
   ============================================================ */

/**
 * 三维评分，全部 0~100：
 *   定位可用率   —— 有 quality>0 的时间占比（来自日志，没有日志则用轨迹 quality 估算）
 *   轨迹连续性   —— 减去真正异常缺口（不含静止停留）后的时长占比
 *   链路完整性   —— 日志无中断时长占比
 */
export function score(trackA, logA) {
  const dims = [];
  let fix = null;

  if (logA && logA.spanS > 0 && logA.qualityTime.length) {
    const bad = sum(logA.qualityTime.filter((q) => q.q === 0).map((q) => q.seconds));
    fix = Math.max(0, 100 * (1 - bad / logA.spanS));
  } else if (trackA && trackA.count > 1 && trackA.qualityHist.length && trackA.durationS > 0) {
    const noFix = trackA.qualityHist.find((q) => q.q === 0);
    if (noFix) fix = Math.max(0, 100 * (1 - noFix.count / trackA.count));
  }
  if (fix != null) dims.push({ id: 'fix', name: '定位可用率', value: round(fix, 1) });

  if (trackA && trackA.durationS > 0) {
    const realGaps = trackA.gaps.filter((g) => g.kind !== 'static' && g.kind !== 'notime');
    const lost = sum(realGaps.map((g) => g.dtS));
    dims.push({
      id: 'track',
      name: '轨迹连续性',
      value: round(Math.max(0, 100 * (1 - lost / trackA.durationS)), 1),
    });
  }

  if (logA && logA.spanS > 0) {
    const lost = sum(logA.gaps.map((g) => g.dtS));
    dims.push({
      id: 'link',
      name: '数据链路完整性',
      value: round(Math.max(0, 100 * (1 - lost / logA.spanS)), 1),
    });
    if (logA.badPct != null) {
      dims.push({
        id: 'crc',
        name: '语句校验正确率',
        value: round(Math.max(0, 100 - logA.badPct * 4), 1),
      });
    }
  }

  const weights = { fix: 0.45, track: 0.25, link: 0.2, crc: 0.1 };
  let wsum = 0, total = 0;
  for (const d of dims) {
    const w = weights[d.id] ?? 0.1;
    total += d.value * w;
    wsum += w;
  }
  const overall = wsum ? round(total / wsum, 1) : null;
  const grade = overall == null ? '—'
    : overall >= 92 ? 'A'
      : overall >= 80 ? 'B'
        : overall >= 65 ? 'C' : 'D';

  return { dims, overall, grade };
}

/**
 * 一句话结论。要有立场：说清楚这次测试能不能用、卡在哪。
 */
export function verdict(trackA, logA, sc, issues) {
  const bad = issues.filter((i) => i.level === 'bad').length;
  const warn = issues.filter((i) => i.level === 'warn').length;

  if (!trackA?.count && !logA?.count) {
    return { headline: '没有可分析的数据', body: '请先导入轨迹或日志文件。', usable: false };
  }

  const parts = [];
  let usable = true;

  if (sc.overall == null) {
    parts.push('缺少时间信息，无法给出量化结论。');
    usable = false;
  } else {
    const map = Object.fromEntries(sc.dims.map((d) => [d.id, d.value]));
    if (map.fix != null) {
      if (map.fix >= 95) parts.push(`定位可用率 ${map.fix}%，全程基本连续。`);
      else if (map.fix >= 80) parts.push(`定位可用率 ${map.fix}%，有可感知的定位中断。`);
      else { parts.push(`定位可用率只有 ${map.fix}%，不具备连续导航能力。`); usable = false; }
    }
    if (map.link != null) {
      if (map.link >= 99.5) parts.push('数据链路完整，全程无断流。');
      else if (map.link >= 90) {
        parts.push(`数据链路完整性 ${map.link}%，有短暂串口断流：缺失时段的数据不可用，其余时段正常。`);
      } else {
        parts.push(`数据链路完整性只有 ${map.link}%，取数本身就不稳定，先解决 USB 供电与接触问题再谈定位。`);
        usable = false;
      }
    }
    if (map.track != null && map.track < 90) {
      parts.push(`轨迹连续性 ${map.track}%，断档原因见下方问题清单。`);
    }
    if (sc.grade === 'D') usable = false;
  }

  if (trackA?.count) {
    parts.push(`轨迹 ${trackA.count} 点、${(trackA.distanceM / 1000).toFixed(2)} km、`
      + `${fmtDur(trackA.durationS)}。`);
  }
  if (logA?.count) {
    parts.push(`日志 ${logA.count} 条、句率 ${logA.ratePerSec ?? '—'} 句/秒。`);
  }
  parts.push(bad ? `其中 ${bad} 项严重问题、${warn} 项警告需要处理。`
    : warn ? `无严重问题，${warn} 项警告建议关注。` : '未发现异常。');

  let headline;
  if (sc.overall == null) headline = '数据不足，无法评级';
  else if (!usable) headline = `评级 ${sc.grade}（${sc.overall} 分）：数据存在硬伤，结论不可直接采信`;
  else if (bad) headline = `评级 ${sc.grade}（${sc.overall} 分）：整体可用，${bad} 处严重问题需处理`;
  else headline = `评级 ${sc.grade}（${sc.overall} 分）：本次记录可用于后续分析`;

  return { headline, body: parts.join(''), usable, grade: sc.grade, score: sc.overall };
}

/* ============================================================
   7. 总入口：把一批已解析文件跑成一份分析结果
   ============================================================ */

/**
 * @param {Array} files parseFile() 的结果数组
 */
export function analyzeAll(files) {
  const list = Array.isArray(files) ? files : [];
  const trackFiles = list.filter((f) => f.kind === 'track' && f.points && f.points.length);
  const logFiles = list.filter((f) => f.kind === 'log' && f.entries && f.entries.length);

  const notes = [];
  let trackSrc = null;
  if (trackFiles.length) {
    // 多份轨迹：取点数最多的做主分析，其余只列出，避免把两次不同的行程拼成一条
    trackSrc = trackFiles.slice().sort((a, b) => b.points.length - a.points.length)[0];
    if (trackFiles.length > 1) {
      const others = trackFiles.filter((f) => f !== trackSrc).map((f) => f.name);
      notes.push(`导入 ${trackFiles.length} 份轨迹，只分析点数最多的《${trackSrc.name}》；`
        + `未参与：${others.join('、')}。若要分析另一份，请单独导入。`);
    }
  }

  // 日志合并：多份按时间排序后拼接
  let entries = [];
  if (logFiles.length) {
    for (const f of logFiles) entries = entries.concat(f.entries);
    if (logFiles.length > 1) notes.push(`合并了 ${logFiles.length} 份日志，共 ${entries.length} 条语句。`);
    entries.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }

  const points = trackSrc ? trackSrc.points : [];

  const trackA = points.length ? analyzeTrack(points) : null;
  const logA = entries.length ? analyzeLog(entries) : null;

  if (trackA && logA) {
    // 交叉前先粗对齐时间：两份数据若完全不在同一时段，交叉结论没有意义
    const overlap = trackA.startT != null && logA.startT != null
      && Math.min(trackA.endT, logA.endT) > Math.max(trackA.startT, logA.startT);
    if (!overlap) {
      notes.push('轨迹与日志的时间区间不重叠，未做交叉归因（轨迹缺口一律标为原因未定）。'
        + '请确认两份文件来自同一次记录。');
    } else {
      correlate(trackA, logA);
    }
  } else if (trackA) {
    correlate(trackA, null);
  }

  const { issues, counts } = diagnose(trackA, logA);
  const sc = score(trackA, logA);
  const vd = verdict(trackA, logA, sc, issues);

  return {
    files: list,
    trackSrc: trackSrc ? trackSrc.name : null,
    logSrcs: logFiles.map((f) => f.name),
    points,          // 原始轨迹点，地图与曲线直接用它
    track: trackA,
    log: logA,
    issues,
    counts,
    score: sc,
    verdict: vd,
    notes,
    analyzedAt: Date.now(),
  };
}
