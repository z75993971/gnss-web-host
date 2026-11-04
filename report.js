/**
 * report.js — 测试报告生成
 *
 * 三种产物，都是纯字符串输出，不碰 DOM：
 *   toReportHTML  可编辑的独立 HTML（双击就能看，能改、能打印、能另存）
 *   toReportMD    Markdown，方便丢进文档系统或提交给同事
 *   toIssuesCSV   问题清单，Excel / pandas 直接读
 *
 * 报告是给「要拿去做判断的人」看的，所以：结论放最前，数据次之，证据在附录。
 */

import { isoUtc, xmlEscape as esc } from './export.js';

const FIX = {
  0: '未定位', 1: '单点定位', 2: '伪距差分', 3: 'PPS',
  4: 'RTK 固定', 5: 'RTK 浮动', 6: '航位推算', 7: '手动', 8: '仿真',
};

const LEVEL = {
  bad: { name: '严重', cls: 'bad' },
  warn: { name: '警告', cls: 'warn' },
  info: { name: '提示', cls: 'info' },
};

function hhmmss(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.round((sec % 3600) / 60)} 分`;
}

function n(v, d = 1) {
  return Number.isFinite(v) ? v.toFixed(d) : '—';
}

/* ============================================================
   图表（内联 SVG，报告离线也能看）
   ============================================================ */

const W = 720;
const H = 150;

/** 把一串数值映射成折线路径（顶部留出标签位置，曲线不会压到标题上） */
function lineChart(vals, { color, fill, label, unit = '', min, max, w = W, h = H }) {
  if (!vals.length) return '<p class="muted">无数据</p>';
  const padT = 22;
  const padB = 10;
  const padX = 8;
  const lo = min ?? Math.min(...vals.filter(Number.isFinite));
  const hi = max ?? Math.max(...vals.filter(Number.isFinite));
  const span = (hi - lo) || 1;
  const step = vals.length > 1 ? (w - padX * 2) / (vals.length - 1) : 0;
  const ih = h - padT - padB;

  let d = '';
  vals.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const x = padX + i * step;
    const y = padT + ih - ((v - lo) / span) * ih;
    d += `${d ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = d ? `${d}L${(w - padX).toFixed(1)},${h - padB}L${padX},${h - padB}Z` : '';
  const text = `${label}　最高 ${n(hi)}${unit}　最低 ${n(lo)}${unit}`;

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#f7f9fc"/>
  <line x1="0" y1="${h - padB}" x2="${w}" y2="${h - padB}" stroke="#e3e9f2" stroke-width="1"/>
  ${fill && area ? `<path d="${area}" fill="${fill}" opacity="0.32"/>` : ''}
  <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
  <text x="8" y="15" font-size="11" fill="#5b6b7f">${esc(text)}</text>
</svg>`;
}

/** 定位质量色带：一整条时间轴按状态上色，和面板里的画法保持一致 */
function qualityChart(gga, w = W, h = 120) {
  if (!gga || !gga.length) return '<p class="muted">无 GGA 数据</p>';
  const step = gga.length > 1 ? (w - 12) / (gga.length - 1) : 0;
  let bars = '';
  gga.forEach((g, i) => {
    const x = 6 + i * step;
    const color = g.quality === 0 ? '#e05a4f' : g.quality === 1 ? '#e0a03f' : '#3aa76d';
    bars += `<rect x="${x.toFixed(1)}" y="8" width="${Math.max(1, step * 1.05).toFixed(1)}" height="${h - 30}" fill="${color}"/>`;
  });
  const t0 = hhmmss(gga[0].t);
  const t1 = hhmmss(gga[gga.length - 1].t);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="定位状态时间轴">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#f7f9fc"/>
  ${bars}
  <text x="6" y="${h - 4}" font-size="10" fill="#8494a8">${esc(t0)}</text>
  <text x="${w - 6}" y="${h - 4}" font-size="10" fill="#8494a8" text-anchor="end">${esc(t1)}</text>
</svg>`;
}

/** 轨迹平面图：等距近似投影，问题点打标记 */
function trackChart(points, issues, w = 720, h = 300) {
  const pts = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) return '<p class="muted">轨迹点不足，无法绘制</p>';
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max(1e-9, (maxLon - minLon) * kx);
  const spanY = Math.max(1e-9, maxLat - minLat);
  const pad = 24;
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;
  const px = (lon) => w / 2 + (lon - cx) * kx * s;
  const py = (lat) => h / 2 - (lat - cy) * s;

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.lon).toFixed(1)},${py(p.lat).toFixed(1)}`).join('');

  let marks = '';
  for (const it of issues || []) {
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) continue;
    const color = it.level === 'bad' ? '#e05a4f' : it.level === 'warn' ? '#e0a03f' : '#5b8dd6';
    marks += `<circle cx="${px(it.lon).toFixed(1)}" cy="${py(it.lat).toFixed(1)}" r="4.5" fill="none" stroke="${color}" stroke-width="2"/>`;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];

  return `<svg class="chart map" viewBox="0 0 ${w} ${h}" role="img" aria-label="轨迹平面图">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#f7f9fc"/>
  <path d="${d}" fill="none" stroke="#1f6fd0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${marks}
  <circle cx="${px(a.lon).toFixed(1)}" cy="${py(a.lat).toFixed(1)}" r="5" fill="#3aa76d"/>
  <circle cx="${px(b.lon).toFixed(1)}" cy="${py(b.lat).toFixed(1)}" r="5" fill="#5b6b7f"/>
  <text x="8" y="16" font-size="11" fill="#5b6b7f">绿=起点　灰=终点　橙圈=警告　红圈=严重</text>
</svg>`;
}

/* ============================================================
   HTML 报告
   ============================================================ */

const CSS = `
:root{--ink:#182230;--ink2:#3d4d61;--mute:#6b7c91;--line:#dbe3ee;--bg:#fff;
--panel:#f7f9fc;--accent:#1f6fd0;--bad:#d93025;--warn:#b26b00;--info:#3a6ea5;--ok:#0f7b4f}
*{box-sizing:border-box}
body{margin:0;background:#eef2f7;color:var(--ink);
font:14px/1.7 -apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif}
.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:8px;
padding:9px 16px;background:#fff;border-bottom:1px solid var(--line);box-shadow:0 1px 4px rgba(20,40,70,.06)}
.bar b{font-size:13px}
.bar .sp{flex:1}
.bar button{font:inherit;font-size:12px;padding:5px 12px;border:1px solid var(--line);
border-radius:5px;background:#fff;color:var(--ink);cursor:pointer}
.bar button:hover{background:var(--panel);border-color:#c3cfdd}
.bar button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.doc{max-width:900px;margin:18px auto 60px;background:var(--bg);padding:34px 40px 46px;
border-radius:6px;box-shadow:0 2px 16px rgba(20,40,70,.09)}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.2px}
.sub{color:var(--mute);font-size:12.5px;margin-bottom:22px}
h2{font-size:16px;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:13.5px;margin:18px 0 6px;color:var(--ink2)}
p{margin:8px 0}
.muted{color:var(--mute)}
.verdict{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);
border-radius:4px;padding:14px 16px;margin:14px 0 18px}
.verdict .head{font-size:15px;font-weight:600;margin-bottom:6px}
.verdict .body{color:var(--ink2);font-size:13px}
.scores{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 4px}
.sc{flex:1 1 120px;min-width:110px;background:var(--panel);border:1px solid var(--line);
border-radius:5px;padding:10px 12px}
.sc .v{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.sc .k{font-size:11.5px;color:var(--mute)}
.grade{display:inline-block;font-size:30px;font-weight:700;line-height:1;
margin-right:10px;vertical-align:-3px}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:10px 0}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--panel);font-weight:600;color:var(--ink2);font-size:12px;white-space:nowrap}
td.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;
border:1px solid;white-space:nowrap;line-height:1.6}
.tag.bad{color:var(--bad);border-color:#f0c0bb;background:#fdf1f0}
.tag.warn{color:var(--warn);border-color:#ecd6ae;background:#fdf7ec}
.tag.info{color:var(--info);border-color:#c7d8ea;background:#eff5fb}
.chart{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:4px;margin:8px 0 2px}
.chart.map{height:300px}
.cap{font-size:11.5px;color:var(--mute);margin:2px 0 14px}
.cols{display:flex;gap:24px;flex-wrap:wrap}
.cols>div{flex:1 1 300px;min-width:260px}
ul{margin:8px 0;padding-left:20px}
li{margin:3px 0}
.ev{font-size:11.5px;color:var(--mute);margin-top:3px}
.note{background:#fdf7ec;border:1px solid #ecd6ae;border-radius:4px;padding:9px 12px;
font-size:12.5px;color:#7a4d00;margin:12px 0}
.foot{margin-top:34px;padding-top:12px;border-top:1px solid var(--line);
font-size:11.5px;color:var(--mute)}
[contenteditable="true"]:focus{outline:2px dashed #b9d2f0;outline-offset:4px}
@media print{
  body{background:#fff}
  .bar{display:none}
  .doc{box-shadow:none;margin:0;padding:0;max-width:none}
  h2{break-after:avoid}
  table,svg{break-inside:avoid}
  @page{margin:16mm}
}
`;

function issueTable(issues) {
  if (!issues.length) return '<p class="muted">未发现异常。</p>';
  const rows = issues.map((it) => {
    const lv = LEVEL[it.level] || LEVEL.info;
    const where = Number.isFinite(it.t)
      ? hhmmss(it.t)
      : (Number.isFinite(it.lat) ? `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}` : '—');
    const ev = (it.evidence || []).filter(Boolean).map((e) => `<div class="ev">· ${esc(e)}</div>`).join('');
    // 标题里已经写了次数就不再重复挂 ×N
    const cnt = it.count > 1 && !it.title.includes(String(it.count))
      ? `<span class="muted"> ×${it.count}</span>` : '';
    return `<tr>
      <td><span class="tag ${lv.cls}">${lv.name}</span></td>
      <td class="num">${esc(where)}</td>
      <td><b>${esc(it.title)}</b>${cnt}${it.detail ? `<div class="ev">${esc(it.detail)}</div>` : ''}${ev}</td>
      <td>${esc(it.cause || '—')}</td>
      <td>${esc(it.advice || '—')}</td>
    </tr>`;
  }).join('');

  return `<table>
  <thead><tr><th>级别</th><th>时间</th><th>现象</th><th>原因</th><th>处置建议</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

/**
 * 生成完整 HTML 报告。
 * @param {object} m analyzeAll() 的返回值
 */
export function toReportHTML(m) {
  const t = m.track;
  const l = m.log;
  const sc = m.score;
  const vd = m.verdict;
  const gen = new Date(m.analyzedAt || Date.now());
  const reportId = `r${gen.getTime()}`;

  const gradeColor = /^A/.test(vd.grade || '') ? 'var(--ok)'
    : /^B/.test(vd.grade || '') ? 'var(--accent)'
      : /^C/.test(vd.grade || '') ? 'var(--warn)' : 'var(--bad)';

  /* ---- 概览表 ---- */
  const overview = [];
  if (t) {
    overview.push(['轨迹点数', `${t.count} 点`]);
    overview.push(['总里程', `${(t.distanceM / 1000).toFixed(3)} km`]);
    overview.push(['记录时长', fmtDur(t.durationS)]);
    overview.push(['时间范围', `${isoUtc(t.startT).replace('T', ' ').slice(0, 19) || '—'} → ${isoUtc(t.endT).slice(11, 19) || '—'} UTC`]);
    overview.push(['采样间隔', t.dt ? `中位 ${t.dt.median}s / 95 分位 ${t.dt.p95}s / 最大 ${t.dt.max}s` : '无时间信息']);
    overview.push(['平均速度', t.speed ? `${n(t.speed.avgMv)} km/h（含静止）` : '—']);
    overview.push(['最高速度', t.speed ? `${n(t.speed.p99)} km/h（99 分位）` : '—']);
    overview.push(['静止占比', Number.isFinite(t.staticRatio) ? `${t.staticRatio}%` : '—']);
  }
  if (l) {
    overview.push(['日志条数', `${l.count.toLocaleString()} 条`]);
    overview.push(['语句类型', `${l.typeCount} 种`]);
    overview.push(['平均句率', l.ratePerSec != null ? `${l.ratePerSec} 句/秒` : '—']);
    overview.push(['校验错误', `${l.badChecksum} 条（${l.badPct}%）`]);
    overview.push(['时间覆盖', fmtDur(l.spanS)]);
  }

  /* ---- 定位质量分布 ---- */
  let fixRows = '';
  if (l && l.qualityTime && l.qualityTime.length) {
    const total = l.spanS || 1;
    fixRows = l.qualityTime.map((q) => {
      const pct = ((q.seconds / total) * 100).toFixed(1);
      return `<tr><td>${esc(FIX[q.q] || String(q.q))}</td>
        <td class="num">${fmtDur(q.seconds)}</td>
        <td class="num">${pct}%</td></tr>`;
    }).join('');
  } else if (t && t.qualityHist && t.qualityHist.length) {
    const total = t.count || 1;
    fixRows = t.qualityHist.map((q) => `<tr><td>${esc(FIX[q.q] || String(q.q))}</td>
      <td class="num">${q.count} 点</td>
      <td class="num">${((q.count / total) * 100).toFixed(1)}%</td></tr>`).join('');
  }

  /* ---- 语句类型 ---- */
  const typeRows = l && l.types.length
    ? l.types.slice(0, 16).map((x) => `<tr><td>${esc(x.type || '?')}</td>
        <td class="num">${x.count.toLocaleString()}</td>
        <td class="num">${((x.count / l.count) * 100).toFixed(1)}%</td></tr>`).join('')
    : '';

  /* ---- 图表 ---- */
  const gga = l ? l.gga : [];
  const step = gga.length > 600 ? Math.ceil(gga.length / 600) : 1;
  const ggaDown = gga.filter((_, i) => i % step === 0);
  const satsVals = ggaDown.map((g) => g.sats).filter(Number.isFinite);
  const hdopVals = ggaDown.map((g) => g.hdop).filter(Number.isFinite);

  const ptsDown = (m.points || []).filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 1200)) === 0);

  const files = (m.files || []).map((f) => `<tr>
    <td>${esc(f.name)}</td>
    <td>${esc(f.format)}</td>
    <td>${f.kind === 'track' ? '轨迹' : f.kind === 'log' ? '日志' : '未知'}</td>
    <td class="num">${(f.points || f.entries || []).length.toLocaleString()}</td>
    <td class="num">${(f.bytes / 1024).toFixed(1)} KB</td>
    <td>${(f.warnings || []).length ? esc((f.warnings || []).join('；')) : '<span class="muted">—</span>'}</td>
  </tr>`).join('');

  const notes = (m.notes || []).length
    ? `<div class="note">${m.notes.map((x) => esc(x)).join('<br>')}</div>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GNSS 测试报告 · ${esc(gen.toISOString().slice(0, 10))}</title>
<style>${CSS}</style>
</head>
<body data-report-id="${reportId}">

<div class="bar">
  <b>GNSS 测试报告</b>
  <span class="muted" style="font-size:12px">正文可直接编辑，改动自动存在本机浏览器</span>
  <span class="sp"></span>
  <button id="bSave">保存 HTML</button>
  <button id="bPrint">打印 / 存 PDF</button>
  <button id="bReset">还原</button>
  <button id="bEdit" class="on">编辑中</button>
</div>

<main class="doc" id="doc" contenteditable="true" spellcheck="false">

<h1>GNSS 接收机 测试报告</h1>
<div class="sub">
  生成时间 ${esc(gen.toLocaleString('zh-CN'))}　·　
  数据来源 ${esc([m.trackSrc, ...(m.logSrcs || [])].filter(Boolean).join(' + ') || '—')}
</div>

<div class="verdict">
  <div class="head">
    <span class="grade" style="color:${gradeColor}">${esc(vd.grade || '—')}</span>
    ${esc(vd.headline)}
  </div>
  <div class="body">${esc(vd.body)}</div>
</div>

<div class="scores">
  ${(sc.dims || []).map((d) => `<div class="sc">
    <div class="v" style="color:${d.value >= 90 ? 'var(--ok)' : d.value >= 70 ? 'var(--warn)' : 'var(--bad)'}">${d.value}</div>
    <div class="k">${esc(d.name)}</div>
  </div>`).join('')}
</div>
${notes}

<h2>一、结论与建议</h2>
<p>${esc(vd.body)}</p>
<p class="muted">评分说明：定位可用率按有有效定位解的时间占比计算；轨迹连续性扣除真实的记录断档（不含静止停留）；
数据链路完整性按语句流未中断的时长占比计算。权重分别为 45% / 25% / 20% / 10%。</p>

<h2>二、测试概览</h2>
<table><tbody>
${overview.map(([k, v]) => `<tr><th style="width:150px">${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('')}
</tbody></table>

<h2>三、问题清单</h2>
<p class="muted">共 ${m.issues.length} 项：严重 ${m.counts.bad} 项、警告 ${m.counts.warn} 项、提示 ${m.counts.info} 项。
每条都给出了判定依据与处置方向。</p>
${issueTable(m.issues)}

${m.points && m.points.length > 1 ? `<h2>四、轨迹</h2>
${trackChart(ptsDown, m.issues)}
<div class="cap">轨迹平面投影（等距近似），用于快速判断整体形状与异常点位置；精确叠图请看上位机分析面板里的地图。</div>` : ''}

${gga.length ? `<h2>${m.points && m.points.length > 1 ? '五' : '四'}、定位状态与信号</h2>
${qualityChart(ggaDown)}
<div class="cap">定位状态时间轴：绿 = 差分 / RTK，橙 = 单点定位，红 = 完全未定位。红色块越长，说明这段时间越不可用。</div>
${satsVals.length ? lineChart(satsVals, { color: '#1f6fd0', fill: '#cfe0f5', label: '参与解算卫星数', unit: ' 颗', min: 0 }) : ''}
${hdopVals.length ? lineChart(hdopVals, { color: '#b26b00', fill: '#f5e2c4', label: 'HDOP', min: 0 }) : ''}
<div class="cap">卫星数持续低于 6 颗或 HDOP 持续高于 2.5，说明天空视野受限，定位精度不可指望。</div>` : ''}

<div class="cols">
<div>
<h2>${gga.length ? '六' : '四'}、定位质量分布</h2>
${fixRows ? `<table><thead><tr><th>状态</th><th class="num">时长 / 点数</th><th class="num">占比</th></tr></thead><tbody>${fixRows}</tbody></table>`
      : '<p class="muted">无定位质量数据（缺少 GGA 或轨迹 quality 字段）。</p>'}
</div>
<div>
<h2>${gga.length ? '七' : '五'}、语句类型分布</h2>
${typeRows ? `<table><thead><tr><th>类型</th><th class="num">条数</th><th class="num">占比</th></tr></thead><tbody>${typeRows}</tbody></table>`
      : '<p class="muted">无日志数据。</p>'}
</div>
</div>

<h2>${gga.length ? '八' : '六'}、数据文件</h2>
<table><thead><tr><th>文件</th><th>格式</th><th>类型</th><th class="num">记录</th><th class="num">大小</th><th>解析提示</th></tr></thead>
<tbody>${files || '<tr><td colspan="6" class="muted">—</td></tr>'}</tbody></table>

<h2>${gga.length ? '九' : '七'}、判定阈值</h2>
<table><tbody>
<tr><th style="width:220px">采样缺口</th><td>相邻点时间差 &gt; max(3 秒, 3 × 中位间隔)</td></tr>
<tr><th>静止停留</th><td>缺口期间位移 &lt; 12 米（含 GGA 位置抖动）</td></tr>
<tr><th>跳点</th><td>隐含速度 &gt; max(3 × 95 分位速度, 60 km/h) 且位移 &gt; 20 米；或出去又折回的尖峰</td></tr>
<tr><th>静止漂移</th><td>速度 &lt; 4 km/h 持续 ≥ 20 秒，包络半径 &gt; 6 米且累计路径 &gt; 2.5 倍半径</td></tr>
<tr><th>高程跳变</th><td>相邻点高程差 &gt; 30 米且水平位移 &lt; 80 米</td></tr>
<tr><th>语句流中断</th><td>相邻语句时间差 &gt; max(2 秒, 3 × 中位间隔)</td></tr>
<tr><th>校验错误</th><td>错误率 &gt; 0.5% 报警</td></tr>
</tbody></table>

<div class="foot">
  本报告由 GNSS 上位机自动生成。所有结论基于导入文件的原始数据推算，
  阈值见上一节。若对某条结论有疑问，回到上位机的「日志分析」面板点击对应条目可在地图上定位。
</div>

</main>

<script>
(function () {
  var KEY = 'gnss.report.' + (document.body.dataset.reportId || 'x');
  var doc = document.getElementById('doc');
  var edit = document.getElementById('bEdit');
  var timer = 0;

  function save() {
    try {
      localStorage.setItem(KEY, doc.innerHTML);
      localStorage.setItem(KEY + '.at', new Date().toLocaleString('zh-CN'));
    } catch (e) { /* file:// 下可能被禁用，忽略 */ }
  }
  function restore() {
    try {
      var v = localStorage.getItem(KEY);
      if (v) doc.innerHTML = v;
    } catch (e) {}
  }
  restore();

  doc.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  });

  document.getElementById('bSave').addEventListener('click', function () {
    save();
    var html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = document.title.replace(/[\\\\/:*?"<>|]/g, '-') + '.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  });

  document.getElementById('bPrint').addEventListener('click', function () { window.print(); });

  document.getElementById('bReset').addEventListener('click', function () {
    if (!confirm('放弃所有手工修改，回到生成时的内容？')) return;
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.reload();
  });

  edit.addEventListener('click', function () {
    var on = doc.getAttribute('contenteditable') !== 'true';
    doc.setAttribute('contenteditable', on ? 'true' : 'false');
    edit.classList.toggle('on', on);
    edit.textContent = on ? '编辑中' : '已锁定';
  });
})();
</script>
</body>
</html>
`;
}

/* ============================================================
   Markdown
   ============================================================ */

function mdEsc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function toReportMD(m) {
  const t = m.track;
  const l = m.log;
  const sc = m.score;
  const vd = m.verdict;
  const gen = new Date(m.analyzedAt || Date.now());

  const out = [];
  out.push('# GNSS 接收机 测试报告');
  out.push('');
  out.push(`生成时间：${gen.toLocaleString('zh-CN')}`);
  out.push(`数据来源：${[m.trackSrc, ...(m.logSrcs || [])].filter(Boolean).join(' + ') || '—'}`);
  out.push('');
  out.push(`## 结论`);
  out.push('');
  out.push(`**${vd.headline}**`);
  out.push('');
  out.push(vd.body);
  out.push('');
  if (sc.dims.length) {
    out.push('| 维度 | 得分 |');
    out.push('| --- | ---: |');
    for (const d of sc.dims) out.push(`| ${d.name} | ${d.value} |`);
    out.push('');
  }

  out.push('## 概览');
  out.push('');
  if (t) {
    out.push(`- 轨迹：${t.count} 点，${(t.distanceM / 1000).toFixed(3)} km，${fmtDur(t.durationS)}`);
    out.push(`- 采样间隔：中位 ${t.dt ? t.dt.median : '—'} s，最大 ${t.dt ? t.dt.max : '—'} s`);
    out.push(`- 速度：平均 ${t.speed ? n(t.speed.avgMv) : '—'} km/h，99 分位 ${t.speed ? n(t.speed.p99) : '—'} km/h`);
  }
  if (l) {
    out.push(`- 日志：${l.count} 条，${l.typeCount} 种语句，${l.ratePerSec ?? '—'} 句/秒，校验错误 ${l.badChecksum} 条`);
  }
  out.push('');

  out.push('## 问题清单');
  out.push('');
  if (!m.issues.length) out.push('未发现异常。');
  else {
    out.push('| 级别 | 时间 | 现象 | 原因 | 建议 |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const it of m.issues) {
      const lv = (LEVEL[it.level] || LEVEL.info).name;
      const at = Number.isFinite(it.t) ? hhmmss(it.t) : '—';
      out.push(`| ${lv} | ${at} | ${mdEsc(it.title)} | ${mdEsc(it.cause)} | ${mdEsc(it.advice)} |`);
    }
  }
  out.push('');

  if (l && l.types.length) {
    out.push('## 语句类型');
    out.push('');
    out.push('| 类型 | 条数 | 占比 |');
    out.push('| --- | ---: | ---: |');
    for (const x of l.types.slice(0, 20)) {
      out.push(`| ${x.type} | ${x.count} | ${((x.count / l.count) * 100).toFixed(1)}% |`);
    }
    out.push('');
  }

  out.push('## 数据文件');
  out.push('');
  out.push('| 文件 | 格式 | 记录数 | 提示 |');
  out.push('| --- | --- | ---: | --- |');
  for (const f of m.files || []) {
    out.push(`| ${mdEsc(f.name)} | ${f.format} | ${(f.points || f.entries || []).length} | ${mdEsc((f.warnings || []).join('；') || '—')} |`);
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push('*本报告由 GNSS 上位机自动生成，阈值与判定依据见上位机「日志分析」面板。*');
  return out.join('\n') + '\n';
}

/* ============================================================
   问题清单 CSV
   ============================================================ */

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toIssuesCSV(m) {
  const head = ['id', 'level', 'code', 'time', 'iso_utc', 'lat', 'lon',
    'title', 'detail', 'cause', 'advice', 'count'].join(',');
  const rows = (m.issues || []).map((it) => [
    it.id,
    (LEVEL[it.level] || LEVEL.info).name,
    it.code,
    Number.isFinite(it.t) ? hhmmss(it.t) : '',
    Number.isFinite(it.t) ? isoUtc(it.t) : '',
    Number.isFinite(it.lat) ? it.lat.toFixed(6) : '',
    Number.isFinite(it.lon) ? it.lon.toFixed(6) : '',
    it.title, it.detail, it.cause, it.advice,
    it.count,
  ].map(csvCell).join(','));
  return `${head}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

/** 报告导出清单，界面据此渲染按钮 */
export const REPORT_FORMATS = [
  { id: 'html', name: 'HTML 报告', ext: 'html', mime: 'text/html',
    build: toReportHTML, note: '可编辑、可打印成 PDF，带图表与轨迹缩略图' },
  { id: 'md', name: 'Markdown', ext: 'md', mime: 'text/markdown',
    build: toReportMD, note: '纯文本，便于贴进文档系统或提交评审' },
  { id: 'csv', name: '问题清单 CSV', ext: 'csv', mime: 'text/csv',
    build: toIssuesCSV, note: '一行一个问题，Excel / pandas 可直接分析' },
];

export function reportFilename(m, ext) {
  const d = new Date(m.analyzedAt || Date.now());
  const p = (x) => String(x).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `gnss-report-${ts}.${ext}`;
}
