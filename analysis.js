/**
 * analysis.js — 日志分析面板（导入 → 分析 → 地图 → 诊断 → 报告）
 *
 * 这是「导出」的反向闭环：把上位机自己导出的文件读回来，
 * 给出测试报告和轨迹问题的归因，而不是让用户自己去数 NMEA 行。
 *
 * 三个数据源：轨迹（GPX/KML/GeoJSON/CSV）、日志（NMEA/TXT/JSONL）、或两者同时。
 * 两者都在时，轨迹缺口会和日志时间轴对齐做归因 —— 这是本面板最有价值的部分。
 */

import { parseFile } from './import.js';
import { analyzeAll, hhmmss, fmtDur, downsample } from './analyze.js';
import { REPORT_FORMATS, reportFilename } from './report.js';
import { StaticTrackMap, TrackMap, isPlaceholderKey } from './map.js';
import { fetchServerConfig, loadMapConfig } from './config.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE_MB = 96;

const an = {
  files: [],
  model: null,
  map: null,
  mapKind: null,
  tab: 'all',
  levels: { bad: true, warn: true, info: true },
  busy: false,
};

/* ============================================================
   0. 通用
   ============================================================ */

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const LEVEL_TEXT = { bad: '严重', warn: '警告', info: '提示' };

/** 空状态模板。用类名 + 事件委托绑按钮，重建 innerHTML 后不需要重新绑定 */
const EMPTY_HTML = `<div class="an-drop">
  <div class="an-drop-ico">
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <path d="M24 6v22m0 0l-8-8m8 8l8-8" fill="none" stroke="#4ea8ff" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 32v4a4 4 0 004 4h24a4 4 0 004-4v-4" fill="none" stroke="#3a4a5d"
        stroke-width="2.4" stroke-linecap="round"/>
    </svg>
  </div>
  <div class="an-drop-title">把导出的文件拖进来</div>
  <p class="dim">轨迹：GPX / KML / GeoJSON / CSV　·　日志：NMEA / TXT / JSONL</p>
  <p class="dim">同时导入轨迹和日志，才能判断轨迹断档到底是「定位丢了」还是「串口断了」</p>
  <div class="an-drop-actions">
    <button class="primary an-pick">选择文件</button>
    <button class="an-pick-sample">载入示例</button>
  </div>
</div>`;

/* ============================================================
   1. 本地平面绘图（没有地图 Key 时的兜底）
   ------------------------------------------------------------
   没有底图，但轨迹形状、问题点位置、起终点同样能看。
   投影用等距近似（按中心纬度做经度收缩），几十公里内误差可忽略。
   ============================================================ */

class LocalPlot {
  constructor(el) {
    this.el = el;
    this.points = [];
    this.markers = [];
    this.center = null;
    this.spanM = 2000;      // 视野跨度（米）
    this.canvas = null;
    this.ctx = null;
    this.size = [0, 0];
  }

  init() {
    this.el.innerHTML = '';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'an-local-cv';
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    return this;
  }

  resize() {
    if (!this.canvas) return;
    const r = this.el.getBoundingClientRect();
    const w = Math.max(80, Math.round(r.width));
    const h = Math.max(80, Math.round(r.height));
    this.size = [w, h];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setData(points) {
    this.points = Array.isArray(points) ? points : [];
    this.fit();
  }

  setMarkers(list) {
    this.markers = Array.isArray(list) ? list : [];
    this.draw();
  }

  _metersPerDeg(lat) { return { y: 111132, x: 111320 * Math.cos((lat * Math.PI) / 180) }; }

  fit() {
    const pts = this.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!pts.length) { this.draw(); return; }
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of pts) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    this.center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    const m = this._metersPerDeg(this.center[1]);
    this.spanM = Math.max(30, Math.max((maxLon - minLon) * m.x, (maxLat - minLat) * m.y) * 1.35);
    this.draw();
  }

  focus(lat, lon, level = 17) {
    this.center = [lon, lat];
    this.spanM = Math.max(120, 40000 / Math.pow(2, level - 12));
    this.draw();
  }

  draw() {
    if (!this.ctx || !this.size[0] || !this.center) return;
    const [w, h] = this.size;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d141c';
    ctx.fillRect(0, 0, w, h);

    const m = this._metersPerDeg(this.center[1]);
    const scale = Math.min(w, h) / this.spanM;
    const toPx = (lat, lon) => [
      w / 2 + (lon - this.center[0]) * m.x * scale,
      h / 2 - (lat - this.center[1]) * m.y * scale,
    ];

    // 网格
    ctx.strokeStyle = '#16222e';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo((w / 8) * i, 0); ctx.lineTo((w / 8) * i, h);
      ctx.moveTo(0, (h / 8) * i); ctx.lineTo(w, (h / 8) * i);
      ctx.stroke();
    }

    // 轨迹
    if (this.points.length > 1) {
      ctx.beginPath();
      this.points.forEach((p, i) => {
        const [px, py] = toPx(p.lat, p.lon);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(78,168,255,.25)';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = '#4ea8ff';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }

    // 问题标记
    for (const mk of this.markers) {
      if (!Number.isFinite(mk.lat) || !Number.isFinite(mk.lon)) continue;
      const [px, py] = toPx(mk.lat, mk.lon);
      const color = mk.level === 'bad' ? '#ff5d5d' : mk.level === 'warn' ? '#ffb020' : '#4ea8ff';
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = `${color}44`;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    // 起终点
    if (this.points.length) {
      const a = this.points[0];
      const b = this.points[this.points.length - 1];
      for (const [p, color] of [[a, '#3ddc84'], [b, '#8b9bb0']]) {
        const [px, py] = toPx(p.lat, p.lon);
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // 比例尺
    const barM = Math.pow(10, Math.round(Math.log10(this.spanM / 4)));
    const barPx = barM * scale;
    ctx.strokeStyle = '#3a4a5d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, h - 16); ctx.lineTo(14 + barPx, h - 16);
    ctx.moveTo(14, h - 20); ctx.lineTo(14, h - 12);
    ctx.moveTo(14 + barPx, h - 20); ctx.lineTo(14 + barPx, h - 12);
    ctx.stroke();
    ctx.fillStyle = '#75859a';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText(barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, 16, h - 22);
  }

  destroy() { if (this.el) this.el.innerHTML = ''; }
}

/* ============================================================
   2. 图表（canvas）
   ============================================================ */

function prepCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const w = Math.max(60, Math.round(r.width));
  const h = Math.max(40, Math.round(r.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** 定位状态色带：一整条时间轴按 quality 上色 */
function drawFixBand(cv, gga) {
  const { ctx, w, h } = prepCanvas(cv);
  ctx.fillStyle = '#0d141c';
  ctx.fillRect(0, 0, w, h);
  if (!gga || gga.length < 2) {
    ctx.fillStyle = '#4d5b6d';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('没有 GGA 数据', 10, h / 2 + 4);
    return;
  }
  const t0 = gga[0].t;
  const t1 = gga[gga.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const padL = 8;
  const padR = 8;
  const iw = w - padL - padR;

  for (let i = 0; i < gga.length; i++) {
    const g = gga[i];
    const x = padL + ((g.t - t0) / span) * iw;
    const nxt = i + 1 < gga.length ? gga[i + 1] : null;
    const x2 = nxt ? padL + ((nxt.t - t0) / span) * iw : x + 1;
    const color = g.quality === 0 ? '#ff5d5d' : g.quality === 1 ? '#ffb020' : '#3ddc84';
    ctx.fillStyle = color;
    ctx.fillRect(x, 6, Math.max(1, x2 - x), h - 22);
  }
  ctx.fillStyle = '#4d5b6d';
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillText(hhmmss(t0), padL, h - 5);
  ctx.textAlign = 'right';
  ctx.fillText(hhmmss(t1), w - padR, h - 5);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#75859a';
  ctx.fillText('定位状态', padL + 2, 16);
}

/**
 * 时间序列双轴折线。断档处断线，不要连成一条假线。
 * @param {Array<{t:number, a:number, b:number}>} rows
 */
function drawSeries(cv, rows, cfg) {
  const { ctx, w, h } = prepCanvas(cv);
  ctx.fillStyle = '#0d141c';
  ctx.fillRect(0, 0, w, h);
  if (!rows || rows.length < 2) {
    ctx.fillStyle = '#4d5b6d';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('数据不足', 10, h / 2 + 4);
    return;
  }
  const padL = 30, padR = 34, padT = 16, padB = 16;
  const iw = Math.max(10, w - padL - padR);
  const ih = Math.max(10, h - padT - padB);
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const span = Math.max(1, t1 - t0);

  const va = rows.map((r) => r.a).filter(Number.isFinite);
  const vb = rows.map((r) => r.b).filter(Number.isFinite);
  const maxA = niceMax(Math.max(1, ...va));
  const maxB = niceMax(Math.max(0.1, ...vb));

  // 网格
  ctx.strokeStyle = '#1c2733';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = padT + (ih / 2) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y);
    ctx.stroke();
  }

  // 断档阈值
  const dts = [];
  for (let i = 1; i < rows.length; i++) dts.push(rows[i].t - rows[i - 1].t);
  dts.sort((x, y) => x - y);
  const medDt = dts.length ? dts[dts.length >> 1] : 1000;
  const brk = Math.max(3000, medDt * 4);

  const plot = (key, max, color) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    let pen = false;
    let prevT = null;
    for (const r of rows) {
      const v = r[key];
      if (!Number.isFinite(v)) { pen = false; prevT = r.t; continue; }
      if (prevT != null && r.t - prevT > brk) pen = false;
      const x = padL + ((r.t - t0) / span) * iw;
      const y = padT + ih - (Math.min(v, max) / max) * ih;
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      prevT = r.t;
    }
    ctx.stroke();
  };

  plot('a', maxA, cfg.colorA);
  plot('b', maxB, cfg.colorB);

  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = cfg.colorA;
  ctx.textAlign = 'right';
  ctx.fillText(String(Math.round(maxA)), padL - 4, padT + 8);
  ctx.fillText('0', padL - 4, padT + ih + 2);
  ctx.fillStyle = cfg.colorB;
  ctx.textAlign = 'left';
  ctx.fillText(String(maxB.toFixed(maxB < 10 ? 1 : 0)), w - padR + 4, padT + 8);
  ctx.fillText('0', w - padR + 4, padT + ih + 2);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#75859a';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText(cfg.labelA, padL + 2, 11);
  ctx.fillStyle = cfg.colorB;
  ctx.fillText(cfg.labelB, padL + 8 + ctx.measureText(cfg.labelA).width, 11);
}

/* ============================================================
   3. 地图适配层
   ============================================================ */

async function buildMap() {
  const box = $('anMap');
  const local = loadMapConfig();
  const srv = await fetchServerConfig();

  let mode = 'none';
  let jsKey = '';
  let sec = '';
  if (!isPlaceholderKey(local.key)) {
    mode = 'jsapi'; jsKey = local.key; sec = local.securityJsCode || '';
  } else if (srv.mapMode === 'jsapi' && srv.jsKey) {
    mode = 'jsapi'; jsKey = srv.jsKey; sec = srv.securityCode || '';
  } else if (srv.mapMode === 'static') {
    mode = 'static';
  }

  if (mode === 'static') {
    const m = new StaticTrackMap();
    await m.init(box);
    return { kind: 'static', m };
  }
  if (mode === 'jsapi') {
    const m = new TrackMap();
    await m.init(box, jsKey, sec);
    m.setFollow(false);
    return { kind: 'jsapi', m };
  }
  const m = new LocalPlot(box);
  m.init();
  return { kind: 'local', m };
}

function mapNote(kind) {
  if (kind === 'static') return '静态底图 · 高德';
  if (kind === 'jsapi') return '高德 JS API';
  return '本地平面图 · 未配置地图 Key，无底图';
}

/* ============================================================
   4. 文件导入
   ============================================================ */

async function readFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  if (an.busy) { toast('正在解析，请稍等'); return; }
  an.busy = true;
  $('anSub').textContent = `正在读取 ${files.length} 个文件…`;

  const parsed = [];
  for (const f of files) {
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      parsed.push({
        name: f.name, format: 'unknown', kind: 'unknown', bytes: f.size,
        warnings: [`文件 ${fmtBytes(f.size)} 超过 ${MAX_FILE_MB}MB 上限，已跳过`], meta: {},
      });
      continue;
    }
    try {
      const text = await f.text();
      parsed.push(parseFile(f.name, text));
    } catch (e) {
      parsed.push({
        name: f.name, format: 'unknown', kind: 'unknown', bytes: f.size,
        warnings: [`读取失败：${e.message}`], meta: {},
      });
    }
  }

  an.busy = false;
  an.files = an.files.concat(parsed);
  rebuild();
}

function clearFiles() {
  an.files = [];
  an.model = null;
  if (an.map) { an.map.destroy(); an.map = null; an.mapKind = null; }
  $('anGrid').hidden = true;
  $('anEmpty').hidden = false;
  $('anEmpty').innerHTML = EMPTY_HTML;
  $('anSub').textContent = '导入导出的轨迹与日志，自动生成测试报告';
}

/* ============================================================
   5. 重建视图
   ============================================================ */

async function rebuild() {
  const good = an.files.filter((f) => f.kind !== 'unknown');
  if (!good.length) {
    $('anGrid').hidden = true;
    $('anEmpty').hidden = false;
    $('anEmpty').innerHTML = `<div class="an-drop">
      <div class="an-drop-title">没有可分析的内容</div>
      <p class="dim">导入的文件都没能识别出轨迹点或日志语句。</p>
      <p class="dim">支持：GPX / KML / GeoJSON / 轨迹 CSV / NMEA / 带时间戳文本 / JSONL</p>
      <div class="an-drop-actions"><button class="primary an-pick">重新选择文件</button></div>
    </div>`;
    return;
  }

  $('anEmpty').hidden = true;
  $('anGrid').hidden = false;

  an.model = analyzeAll(an.files);
  const m = an.model;

  renderFiles();
  renderOverview();
  renderIssues();
  renderNotes();

  // 地图懒初始化：第一次打开面板才去请求底图
  if (!an.map) {
    try {
      const r = await buildMap();
      an.map = r.m;
      an.mapKind = r.kind;
      $('anMapNote').textContent = mapNote(r.kind);
    } catch (e) {
      const m2 = new LocalPlot($('anMap'));
      m2.init();
      an.map = m2;
      an.mapKind = 'local';
      $('anMapNote').textContent = `底图加载失败：${e.message}`;
    }
  } else {
    $('anMapNote').textContent = mapNote(an.mapKind);
  }

  syncMap();
  requestAnimationFrame(() => {
    if (an.map && an.map.resize) an.map.resize();
    renderCharts();
  });

  $('anSub').textContent = `${m.files.filter((f) => f.kind !== 'unknown').length} 个文件 · `
    + `${m.points.length} 个轨迹点 · ${m.log ? m.log.count.toLocaleString() + ' 条语句' : '无日志'}`;
}

function syncMap() {
  const m = an.model;
  if (!an.map || !m) return;
  const pts = m.points || [];
  if (an.mapKind === 'jsapi' || an.mapKind === 'static') {
    an.map.update(pts, null);
    an.map.setMarkers(m.issues.filter((i) => Number.isFinite(i.lat)));
    an.map.fit();
  } else {
    an.map.setData(pts);
    an.map.setMarkers(m.issues.filter((i) => Number.isFinite(i.lat)));
    an.map.fit();
  }
}

function renderFiles() {
  const rows = an.files.map((f, i) => {
    const kindText = f.kind === 'track' ? '轨迹' : f.kind === 'log' ? '日志' : '未识别';
    const n = (f.points || f.entries || []).length;
    const warn = (f.warnings || []).length;
    return `<div class="an-file ${f.kind === 'unknown' ? 'bad' : ''}">
      <div class="an-file-top">
        <span class="an-file-kind ${f.kind}">${kindText}</span>
        <span class="an-file-name" title="${f.name}">${f.name}</span>
        <button class="an-file-x" data-del="${i}" title="移除">×</button>
      </div>
      <div class="an-file-meta">${f.format} · ${n.toLocaleString()} 条 · ${fmtBytes(f.bytes)}
        ${warn ? ` · <span class="warn">${warn} 条提示</span>` : ''}</div>
      ${warn ? `<div class="an-file-warn">${f.warnings.join('；')}</div>` : ''}
    </div>`;
  }).join('');

  $('anFiles').innerHTML = rows || '<div class="an-none">还没导入文件</div>';
}

function renderOverview() {
  const m = an.model;
  const sc = m.score;

  const grade = sc.grade || '—';
  const gradeCls = /^A/.test(grade) ? 'ok' : /^B/.test(grade) ? 'acc' : /^C/.test(grade) ? 'warn' : 'bad';

  $('anScore').innerHTML = `
    <div class="an-grade ${gradeCls}">${grade}</div>
    <div class="an-score-num">${sc.overall == null ? '—' : sc.overall}<span>分</span></div>
    <div class="an-score-k">综合评分</div>`;

  $('anScoreDims').innerHTML = sc.dims.map((d) => `
    <div class="an-dim">
      <div class="an-dim-top"><span>${d.name}</span><b>${d.value}</b></div>
      <div class="an-bar"><i style="width:${Math.max(0, Math.min(100, d.value))}%;background:${d.value >= 90 ? 'var(--ok)' : d.value >= 70 ? 'var(--warn)' : 'var(--bad)'}"></i></div>
    </div>`).join('') || '<div class="an-none">数据不足</div>';

  $('anVerdict').textContent = m.verdict.headline;
  $('anVerdictBody').textContent = m.verdict.body;

  const t = m.track;
  const l = m.log;
  const kv = [];
  if (t) {
    kv.push(['轨迹点', t.count.toLocaleString()]);
    kv.push(['里程', `${(t.distanceM / 1000).toFixed(2)} km`]);
    kv.push(['时长', fmtDur(t.durationS)]);
    kv.push(['采样间隔', t.dt ? `${t.dt.median}s` : '—']);
    kv.push(['平均速度', t.speed ? `${t.speed.avgMv} km/h` : '—']);
    kv.push(['静止占比', Number.isFinite(t.staticRatio) ? `${t.staticRatio}%` : '—']);
  }
  if (l) {
    kv.push(['日志条数', l.count.toLocaleString()]);
    kv.push(['句率', l.ratePerSec != null ? `${l.ratePerSec}/s` : '—']);
    kv.push(['校验错', `${l.badChecksum}`]);
    kv.push(['语句类型', `${l.typeCount}`]);
  }
  $('anOverview').innerHTML = kv.length
    ? kv.map(([k, v]) => `<div class="an-kv"><span>${k}</span><b>${v}</b></div>`).join('')
    : '<div class="an-none">—</div>';
}

function renderNotes() {
  const m = an.model;
  const all = [...(m.notes || [])];
  if (m.track && m.track.warnings) all.push(...m.track.warnings);
  if (m.log && m.log.warnings) all.push(...m.log.warnings);
  $('anNotes').innerHTML = all.length
    ? all.map((x) => `<div class="an-note-row">· ${x}</div>`).join('')
    : '';
  $('anNotes').hidden = !all.length;
}

function renderIssues() {
  const m = an.model;
  const counts = m.counts;

  $('anIssueTabs').innerHTML = [
    ['all', '全部', m.issues.length],
    ['bad', '严重', counts.bad],
    ['warn', '警告', counts.warn],
    ['info', '提示', counts.info],
  ].map(([id, name, n]) => `<button data-tab="${id}" class="${an.tab === id ? 'on' : ''}">${name}<em>${n}</em></button>`).join('');

  const list = m.issues.filter((i) => an.tab === 'all' || i.level === an.tab);

  if (!list.length) {
    $('anIssues').innerHTML = `<div class="an-clear">
      <div class="an-clear-ico">✓</div>
      <div>没有发现问题</div>
      <div class="dim">轨迹连续、日志无中断、校验全通过</div>
    </div>`;
    return;
  }

  $('anIssues').innerHTML = list.map((it, idx) => {
    const canLocate = Number.isFinite(it.lat) && Number.isFinite(it.lon);
    // 标题里已经写了次数（「2 处位置跳变」）就不再重复挂 ×2
    const showCount = it.count > 1 && !it.title.includes(String(it.count));
    return `<div class="an-iss ${it.level}" data-idx="${idx}" data-id="${it.id}">
      <div class="an-iss-head">
        <span class="an-iss-dot"></span>
        <span class="an-iss-time">${Number.isFinite(it.t) ? hhmmss(it.t) : '—'}</span>
        <span class="an-iss-title">${it.title}${showCount ? `<em>×${it.count}</em>` : ''}</span>
        ${canLocate ? '<button class="an-iss-loc" title="在地图上定位">定位</button>' : ''}
      </div>
      <div class="an-iss-body">
        ${it.detail ? `<p class="an-iss-detail">${it.detail}</p>` : ''}
        ${it.cause ? `<p><b>原因</b>${it.cause}</p>` : ''}
        ${it.advice ? `<p><b>建议</b>${it.advice}</p>` : ''}
        ${(it.evidence || []).filter(Boolean).length
          ? `<p class="an-iss-ev"><b>证据</b>${it.evidence.filter(Boolean).join('<br>')}</p>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ============================================================
   6. 曲线
   ============================================================ */

function renderCharts() {
  const m = an.model;
  if (!m) return;

  const l = m.log;
  const gga = l ? l.gga : [];
  const step = gga.length > 700 ? Math.ceil(gga.length / 700) : 1;
  const g = gga.filter((_, i) => i % step === 0);

  // 先把容器显示出来，再取尺寸 —— 隐藏元素 getBoundingClientRect 是 0，画出来会糊成一团
  $('anChartSats').hidden = !(g.length > 1);
  $('cvAnFix').parentElement.hidden = !g.length;

  drawFixBand($('cvAnFix'), g);
  if (g.length > 1) {
    drawSeries($('cvAnSats'), g.map((x) => ({ t: x.t, a: x.sats, b: x.hdop })), {
      colorA: '#4ea8ff', colorB: '#ffb020',
      labelA: '卫星数', labelB: 'HDOP',
    });
  }

  // 速度：优先用点自带的速度，没有就用相邻点反算
  const pts = downsample(m.points || [], 700);
  const rows = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let v = p.speed;
    if (!Number.isFinite(v) && i > 0 && Number.isFinite(p.t) && Number.isFinite(pts[i - 1].t)) {
      const dt = (p.t - pts[i - 1].t) / 1000;
      if (dt > 0.2 && dt < 30) {
        const dy = (p.lat - pts[i - 1].lat) * 111320;
        const dx = (p.lon - pts[i - 1].lon) * 111320 * Math.cos((p.lat * Math.PI) / 180);
        v = (Math.hypot(dx, dy) / dt) * 3.6;
      }
    }
    rows.push({ t: p.t, a: v, b: Number.isFinite(p.hdop) ? p.hdop : null });
  }
  const withT = rows.filter((r) => Number.isFinite(r.t));
  $('anChartSpeed').hidden = !(withT.length > 1);
  if (withT.length > 1) {
    drawSeries($('cvAnSpeed'), withT, {
      colorA: '#3ddc84', colorB: '#8b9bb0',
      labelA: '速度 km/h', labelB: 'HDOP',
    });
  }
}

/* ============================================================
   7. 交互
   ============================================================ */

function locateIssue(id) {
  const m = an.model;
  if (!m) return;
  const it = m.issues.find((x) => x.id === id);
  if (!it || !Number.isFinite(it.lat)) return;
  if (an.map && an.map.focus) an.map.focus(it.lat, it.lon, 17);
  toast(`${hhmmss(it.t)} · ${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}`, 3000);
}

function exportReport(fmtId) {
  const m = an.model;
  if (!m) { toast('还没有可分析的数据'); return; }
  const f = REPORT_FORMATS.find((x) => x.id === fmtId) || REPORT_FORMATS[0];
  const text = f.build(m);
  download(reportFilename(m, f.ext), text, f.mime);
  closeReportMenu();
  toast(`已生成 ${f.name}：${reportFilename(m, f.ext)}`, 4200);
}

function openReportMenu() {
  const box = $('anReportMenu');
  box.innerHTML = REPORT_FORMATS.map((f) => `
    <button data-fmt="${f.id}">
      <b>${f.name}</b>
      <span>${f.note}</span>
    </button>`).join('');
  box.hidden = false;
}

function closeReportMenu() { $('anReportMenu').hidden = true; }

/* ============================================================
   8. 打开 / 关闭
   ============================================================ */

export function openAnalysis(opts = {}) {
  $('anModal').hidden = false;
  $('anReportMenu').hidden = true;
  if (an.files.length) {
    $('anEmpty').hidden = true;
    $('anGrid').hidden = false;
    requestAnimationFrame(() => { if (an.map && an.map.resize) an.map.resize(); renderCharts(); });
  } else {
    $('anEmpty').hidden = false;
    $('anGrid').hidden = true;
  }
  if (opts.sample) loadSample();
}

export function closeAnalysis() {
  closeReportMenu();
  $('anModal').hidden = true;
  if (an.map && an.map.destroy) { an.map.destroy(); an.map = null; an.mapKind = null; }
}

async function loadSample() {
  const list = [
    'samples/gnss-track-20261101-0930.gpx',
    'samples/gnss-log-20261101-0930.nmea',
  ];
  const files = [];
  for (const url of list) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const name = url.split('/').pop();
        files.push(parseFile(name, await r.text()));
      }
    } catch { /* 示例缺失不影响主流程 */ }
  }
  if (!files.length) {
    toast('示例文件缺失（samples/ 目录），请直接用「导入文件」');
    return;
  }
  an.files = files;
  an.model = null;
  if (an.map) { an.map.destroy(); an.map = null; an.mapKind = null; }
  rebuild();
  toast(`已载入示例：轨迹 ${files[0].points?.length || 0} 点 + 日志 ${files[1]?.entries?.length || 0} 条`, 3600);
}

/* ============================================================
   9. 初始化
   ============================================================ */

export function initAnalysis() {
  $('btnAn').addEventListener('click', () => openAnalysis());
  $('btnAnImport').addEventListener('click', () => $('anFile').click());
  $('btnAnSample').addEventListener('click', loadSample);
  $('btnAnClear').addEventListener('click', clearFiles);

  // 空状态里的按钮用事件委托，重建 innerHTML 后不用重新绑
  $('anBody').addEventListener('click', (e) => {
    if (e.target.closest('.an-pick')) { $('anFile').click(); return; }
    if (e.target.closest('.an-pick-sample')) loadSample();
  });

  $('anFile').addEventListener('change', (e) => {
    readFiles(e.target.files);
    e.target.value = '';
  });

  $('btnAnReport').addEventListener('click', (e) => {
    e.stopPropagation();
    const box = $('anReportMenu');
    if (box.hidden) openReportMenu(); else closeReportMenu();
  });

  $('anReportMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) exportReport(b.dataset.fmt);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#anReportMenu') && !e.target.closest('#btnAnReport')) closeReportMenu();
  });

  $('anIssueTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    an.tab = b.dataset.tab;
    renderIssues();
  });

  $('anIssues').addEventListener('click', (e) => {
    const loc = e.target.closest('.an-iss-loc');
    const card = e.target.closest('.an-iss');
    if (!card) return;
    if (loc) { e.stopPropagation(); locateIssue(card.dataset.id); return; }
    card.classList.toggle('open');
  });

  $('anFiles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    an.files.splice(Number(b.dataset.del), 1);
    if (!an.files.length) { clearFiles(); return; }
    rebuild();
  });

  // 拖拽导入
  const body = $('anBody');
  let dragDepth = 0;
  ['dragenter', 'dragover'].forEach((ev) => {
    body.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragenter') dragDepth++;
      $('anDropMask').hidden = false;
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    body.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave') { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth) return; }
      else dragDepth = 0;
      $('anDropMask').hidden = true;
    });
  });
  body.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      readFiles(e.dataTransfer.files);
    }
  });

  $('btnAnMapFit').addEventListener('click', () => { if (an.map) an.map.fit(); });

  document.querySelectorAll('[data-close="an"]').forEach((el) => {
    el.addEventListener('click', closeAnalysis);
  });

  // 容器尺寸变化：地图必须跟着 resize，否则瓦片错位
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (!$('anModal').hidden && an.map) an.map.resize();
    });
    ro.observe($('anMap'));
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('anModal').hidden) {
      if (!$('anReportMenu').hidden) { closeReportMenu(); return; }
      closeAnalysis();
    }
  });
}
