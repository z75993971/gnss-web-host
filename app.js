/**
 * app.js — GNSS 上位机主程序
 *
 * 功能：Web Serial 串口连接 / NMEA 解析 / 天空图 / 载噪比 / 轨迹 / 时序 / 命令台
 * 布局参考：u-center（天空图 + SNR 柱图）、gpsmon（原始流监控）、RTKLIB rtkplot（时序图）
 */

import {
  GnssState, SYS, FIX_QUALITY, FIX_TYPE, INS_STATUS, ODO_STATUS, checksum, verify,
} from './nmea.js';
import { TrackMap, StaticTrackMap, isPlaceholderKey } from './map.js';
import {
  loadMapConfig, saveMapConfig, loadUiConfig, saveUiConfig, fetchServerConfig,
  loadExportConfig, saveExportConfig, loadPortConfig, savePortConfig,
} from './config.js';
import { ControlCenter } from './controls.js';
import { NtripClient } from './ntrip.js';
import { initAnalysis, openAnalysis } from './analysis.js';
import { VendorDetector, VENDOR, resolveVendor } from './vendor.js';
import {
  TRACK_FORMATS, LOG_FORMATS, findFormat, trackStats, sliceByTime, toLogNMEA,
} from './export.js';

/* ============================================================
   0. 小工具
   ============================================================ */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const num = (v, d = 6) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const state = new GnssState();
const stats = {
  rx: 0, lines: 0, parsed: 0, bad: 0, tx: 0,
  lastRx: 0, lastLines: 0, bps: 0, lps: 0, lastT: performance.now(),
};

/* ============================================================
   0.5 界面状态：星座筛选 / 轨迹显示模式
   ============================================================ */
const FILTER_SYS = ['GP', 'GB', 'GL', 'GA', 'GQ', 'SB', 'GI'];

const uiCfg = loadUiConfig();
const savedFilter = Array.isArray(uiCfg.sysFilter) && uiCfg.sysFilter.length
  ? uiCfg.sysFilter.filter((k) => FILTER_SYS.includes(k))
  : FILTER_SYS.slice();
// SBAS 是后加的星座：老配置里没有它，默认补上，避免升级后被静默隐藏
if (!savedFilter.includes('SB')) savedFilter.push('SB');

const filter = {
  sys: new Set(savedFilter),
  usedOnly: !!uiCfg.usedOnly,
};

let trackMode = uiCfg.trackMode === 'map' ? 'map' : 'local';
// 地图适配器有两种实现：JS API（可拖动缩放）与静态底图（仅有 Web服务 Key 时的兜底）
// 由 ensureMap() 根据 Key 类型现场决定，所以这里用 let 而不是 const。
let trackMap = new TrackMap();
let mapMode = null;
let mapLoading = false;
let ctl = null;
let ntrip = null;
let lastGga = '';

/* ---------- 厂商识别 ----------
   主干功能（天空图/轨迹/导出/日志分析）跟厂商无关，识别结果只决定控制中心发哪套命令。
   默认「自动」：收到 $PDTINFO / $CFG* 才认 Unicore，否则按标准 NMEA 处理。 */
const vdetect = new VendorDetector();
let vendorMode = [VENDOR.NMEA, VENDOR.UNICORE].includes(uiCfg.vendor) ? uiCfg.vendor : VENDOR.AUTO;
let autoQueried = false;   // 自动模式下是否已经补发过一轮只读查询

/**
 * 应用星座筛选后的卫星列表。
 * 未知星座不参与筛选，避免新系统上线后被静默隐藏。
 */
function visibleSats() {
  return state.satList().filter((s) => {
    if (FILTER_SYS.includes(s.sys) && !filter.sys.has(s.sys)) return false;
    if (filter.usedOnly && !s.used) return false;
    return true;
  });
}

/* ============================================================
   0.6 厂商模式
   ============================================================ */
function effectiveVendor() {
  return resolveVendor(vendorMode, vdetect.vendor);
}

/** 识别结果或手动模式变化：刷新顶栏标签、控制中心页签、命令台预设 */
function updateVendorUI() {
  const badge = $('badgeDevice');
  if (badge) {
    badge.textContent = vdetect.label;
    badge.classList.toggle('ok', effectiveVendor() === VENDOR.UNICORE);
  }
  if (ctl) ctl.setVendor({ mode: vendorMode, vendor: effectiveVendor(), label: vdetect.label });
  buildPresets();
}

/** 手动切模式。手动选择优先级高于自动识别，记进 localStorage。 */
function setVendorMode(mode) {
  vendorMode = mode === VENDOR.NMEA || mode === VENDOR.UNICORE ? mode : VENDOR.AUTO;
  saveUiConfig({ vendor: vendorMode });
  updateVendorUI();
  if (vendorMode === VENDOR.UNICORE && ctl && link.writer) ctl.queryAll(true);
}

/* ============================================================
   1. 串口连接（Web Serial API）
   ============================================================ */
const link = {
  port: null,
  reader: null,
  writer: null,
  connected: false,
  closing: false,
  decoder: new TextDecoder('utf-8', { fatal: false }),
  buf: '',
};

const SUPPORTED = 'serial' in navigator;

/* ---------- 波特率侦测 ----------
   NMEA-0183 没有速率协商，模块出厂速率从 4800 到 921600 都有。挨个试听是最笨也最可靠的办法：
   速率错了读到的是乱码，校验和几乎不可能连续通过两条。 */
const BAUD_TRY = [115200, 9600, 38400, 57600, 230400, 460800, 921600, 19200, 4800];
const BAUD_PROBE_MS = 900;

async function probeBaud(port, baud) {
  try {
    await port.open({
      baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none',
      flowControl: 'none', bufferSize: 4096,
    });
  } catch {
    return false;      // 该速率打不开，跳过
  }

  let reader = null;
  let text = '';
  const dec = new TextDecoder('utf-8', { fatal: false });
  try {
    reader = port.readable.getReader();
    const deadline = performance.now() + BAUD_PROBE_MS;
    while (performance.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((res) => setTimeout(() => res(null), 200)),
      ]);
      if (chunk === null) continue;        // 200ms 没数据，接着等
      if (chunk.done) break;
      if (chunk.value && chunk.value.length) {
        text += dec.decode(chunk.value, { stream: true });
        const good = text.split('\n').map((l) => l.trim())
          .filter((l) => /^\$[A-Z]{2}[A-Z0-9]{3},/.test(l) && verify(l).ok);
        if (good.length >= 2) return true; // 连续两条校验通过，速率可以确定
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    try { await reader?.cancel(); } catch { /* ignore */ }
    try { reader?.releaseLock(); } catch { /* ignore */ }
    try { await port.close(); } catch { /* ignore */ }
  }
}

async function scanBaud() {
  if (!SUPPORTED) { toast('当前浏览器不支持 Web Serial，请改用 Edge 或 Chrome', 4000); return; }
  if (link.connected) { toast('先断开当前连接再侦测', 3000); return; }

  let port;
  try { port = await navigator.serial.requestPort(); } catch { return; }

  const btn = $('btnBaudScan');
  btn.disabled = true;
  btn.textContent = '侦测中';
  toast('正在逐个速率试听，最多 8 秒…', 5000);
  try {
    for (const rate of BAUD_TRY) {
      if (await probeBaud(port, rate)) {
        $('baud').value = String(rate);
        savePortConfig({ baud: rate });
        toast(`侦测到 ${rate} bps，正在连接`, 3000);
        await openPort(port);
        return;
      }
    }
    toast('没听到有效 NMEA：检查接线与天线，或手动指定波特率', 5200);
  } finally {
    btn.disabled = false;
    btn.textContent = '侦测';
  }
}

async function pickAndConnect() {
  if (!SUPPORTED) {
    toast('当前浏览器不支持 Web Serial，请改用 Edge 或 Chrome', 4000);
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await openPort(port);
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'AbortError')) return; // 用户取消
    toast('打开失败：' + (e && e.message ? e.message : e), 4000);
    console.error(e);
  }
}

function describePort(port, baud) {
  let info = {};
  try { info = port.getInfo ? port.getInfo() : {}; } catch { /* ignore */ }
  const vid = info.usbVendorId;
  const pid = info.usbProductId;
  const id = (vid != null && pid != null)
    ? `${vid.toString(16).toUpperCase().padStart(4, '0')}:${pid.toString(16).toUpperCase().padStart(4, '0')}`
    : '串口';
  return `${id} @ ${baud}`;
}

async function openPort(port) {
  const baud = Number($('baud').value);
  await port.open({
    baudRate: baud,
    dataBits: Number($('dataBits').value),
    stopBits: Number($('stopBits').value),
    parity: $('parity').value,
    flowControl: 'none',
    bufferSize: 65536,
  });

  link.port = port;
  link.connected = true;
  link.closing = false;
  link.buf = '';
  try { link.writer = port.writable.getWriter(); } catch { link.writer = null; }

  state.reset();
  rawBuf.length = 0;
  rawDirty = true;
  // 新会话从头记：轨迹已经 reset 了，日志留着会和轨迹对不上
  logBuf.length = 0;
  logDropped = 0;

  $('portName').textContent = describePort(port, baud);
  $('hintBar').classList.remove('show');
  setConnUI(true);
  readLoop(port);

  // 换了一块板子就重新识别，别把上一台的结论带过来
  vdetect.reset();
  autoQueried = false;
  savePortConfig({
    baud,
    dataBits: Number($('dataBits').value),
    parity: $('parity').value,
    stopBits: Number($('stopBits').value),
  });
  updateVendorUI();

  // 连上后按模式决定发什么：
  //   已知 Unicore → 直接读全部配置
  //   自动        → 只发一条 $PDTINFO 探一下，等它自己暴露身份
  //   标准 NMEA   → 什么都不发，陌生设备不该被灌私有命令
  setTimeout(() => {
    if (!ctl || !link.writer) return;
    if (vendorMode === VENDOR.UNICORE) ctl.queryAll(true);
    else if (vendorMode === VENDOR.AUTO) ctl.probe();
  }, 900);
}

async function readLoop(port) {
  while (port.readable && !link.closing) {
    let reader = null;
    try {
      reader = port.readable.getReader();
      link.reader = reader;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) ingestBytes(value);
      }
    } catch (e) {
      if (!link.closing) {
        console.warn('读取中断', e);
        toast('读取中断：' + e.message, 3000);
      }
    } finally {
      try { reader && reader.releaseLock(); } catch { /* ignore */ }
      link.reader = null;
    }
  }
  if (!link.closing) scheduleReconnect();
}

async function closePort(silent) {
  link.closing = true;
  // 串口断了，差分流也没有意义了（写回去没人接收），顺手断开 caster
  if (ntrip && ntrip.active) ntrip.disconnect(true);
  try { await link.reader?.cancel(); } catch { /* ignore */ }
  try { link.writer?.releaseLock(); } catch { /* ignore */ }
  link.writer = null;
  try { await link.port?.close(); } catch { /* ignore */ }

  const port = link.port;
  link.port = null;
  link.connected = false;
  setConnUI(false);

  if (!silent) $('portName').textContent = '未连接';
  if (port) lastPortHint = port;
}

function scheduleReconnect() {
  if (!$('autoReconnect').checked) { closePort(true); return; }
  const port = link.port;
  link.connected = false;
  setConnUI(false);
  $('portName').textContent = '连接中断，2 秒后重试…';
  setTimeout(async () => {
    if (link.connected) return;
    try {
      await closePort(true);
      if (port) await openPort(port);
      toast('已自动重连');
    } catch (e) {
      $('portName').textContent = '重连失败，请手动连接';
    }
  }, 2000);
}

let lastPortHint = null;

function setConnUI(on) {
  $('btnConnect').disabled = on;
  $('btnConnect').textContent = on ? '已连接' : '连接串口';
  $('btnDisconnect').disabled = !on;
  $('baud').disabled = on;
  $('dataBits').disabled = on;
  $('parity').disabled = on;
  $('stopBits').disabled = on;
  $('stConn').textContent = on ? '● 已连接' : '● 未连接';
  $('stConn').className = on ? 'st-ok' : '';
  $('btnPause').textContent = rawPaused ? '继续' : '暂停';
}

/* ---------- 串口写队列 ----------
   文本命令和 NTRIP 的 RTCM 二进制块会同时往串口写。Web Serial 的 write()
   是异步的，两条流各自 await 会交错，把一帧 RTCM 拆散。统一排一条队列。 */
let writeChain = Promise.resolve();

function queueWrite(bytes) {
  if (!link.writer) return Promise.reject(new Error('未连接串口'));
  const p = writeChain.then(() => link.writer.write(bytes));
  writeChain = p.catch(() => {});   // 单次失败不能把整条链带崩
  return p;
}

async function sendCmd(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (!link.writer) { toast('未连接串口，无法发送'); return; }
  const payload = t + '\r\n';
  try {
    await queueWrite(new TextEncoder().encode(payload));
    stats.tx += payload.length;
    pushCmdLog('→ ' + t);
  } catch (e) {
    toast('发送失败：' + e.message, 3000);
  }
}

/* ============================================================
   2. 数据接收与解析
   ============================================================ */
const rawBuf = [];
let rawPaused = false;
let rawDirty = false;

/* 全量日志缓冲（导出用），和 rawBuf 是两套东西：
 *   rawBuf —— 只留 600 条给「原始流」面板显示，暂停时也不记录；
 *   logBuf —— 与暂停、与显示都无关，完整记录整个会话，只受容量上限约束。
 * 按实测约 27 条/秒计算，20 万条约合 2 小时，内存 30MB 上下。 */
const LOG_LIMIT = 200000;
const logBuf = [];
let logDropped = 0;

function pushLog(line) {
  logBuf.push({ t: Date.now(), line });
  if (logBuf.length > LOG_LIMIT) {
    // 一次丢 10%，避免每来一条就 shift —— 大数组头部删除是 O(n)，会卡住解析循环
    const drop = Math.ceil(LOG_LIMIT * 0.1);
    logBuf.splice(0, drop);
    logDropped += drop;
  }
}

function pushRaw(line) {
  if (rawPaused) return;
  rawBuf.push(line);
  if (rawBuf.length > 600) rawBuf.splice(0, rawBuf.length - 600);
  rawDirty = true;
}

function ingestBytes(bytes) {
  stats.rx += bytes.length;
  link.buf += link.decoder.decode(bytes, { stream: true });
  if (link.buf.length > 400000) link.buf = link.buf.slice(-1000); // 防爆保护

  let nl;
  while ((nl = link.buf.indexOf('\n')) >= 0) {
    const line = link.buf.slice(0, nl).replace(/\r$/, '');
    link.buf = link.buf.slice(nl + 1);
    if (line) handleLine(line);
  }
}

function handleLine(line) {
  stats.lines++;
  // 先记日志再校验：校验失败的语句恰恰是排查时最需要留证的
  pushLog(line);
  const badBefore = state.badChecksum;
  const key = state.ingest(line);
  if (state.badChecksum > badBefore) { stats.bad++; return; }
  if (key) stats.parsed++;

  // 厂商识别：只看设备自己吐出来的私有语句，识别到 Unicore 时补一轮只读查询
  if (vdetect.feed(line)) {
    updateVendorUI();
    if (vendorMode === VENDOR.AUTO && vdetect.vendor === VENDOR.UNICORE
      && !autoQueried && ctl && link.writer) {
      autoQueried = true;
      setTimeout(() => { if (ctl && link.writer) ctl.queryAll(true); }, 300);
    }
  }

  if (ctl) ctl.pushResponse(line);   // 设备应答进控制中心的响应区
  // NTRIP 的虚拟参考站要靠位置才发对应天顶的改正数，GGA 必须回传给 caster
  if (line.startsWith('$G') && line.slice(3, 6) === 'GGA') {
    lastGga = line;
    if (ntrip) ntrip.feedGga(line);
  }
  pushRaw(line);
}

function pushCmdLog(s) {
  const box = $('cmdSent');
  const div = document.createElement('div');
  div.textContent = s;
  box.appendChild(div);
  while (box.children.length > 12) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ============================================================
   3. Canvas 通用
   ============================================================ */
/**
 * 按父容器实测尺寸设置画布。
 * 注意：不能依赖 canvas 的 CSS 百分比高度 —— 在 flex/grid 容器里百分比高度
 * 解析不稳定，会导致绘制坐标系与显示尺寸不一致（天空图会变成椭圆）。
 */
function setup(cv) {
  const box = cv.parentElement || cv;
  const r = box.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width));
  const H = Math.max(1, Math.round(r.height));
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(W * dpr);
  const ph = Math.round(H * dpr);

  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw;
    cv.height = ph;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
  }

  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}

function line(ctx, x1, y1, x2, y2, color, w = 1, dash) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  if (dash) ctx.setLineDash(dash);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

function text(ctx, s, x, y, color, size = 10, align = 'center', baseline = 'middle', bold = false) {
  ctx.fillStyle = color;
  ctx.font = `${bold ? '600 ' : ''}${size}px ${MONO}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/* ============================================================
   4. 天空图
   ============================================================ */
function drawSky() {
  const cv = $('cvSky');
  const { ctx, W, H } = setup(cv);
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.max(20, Math.min(W, H) / 2 - 26);

  // 底盘
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, '#101c28');
  g.addColorStop(1, '#080e15');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#2b3c50';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 仰角圈
  for (const el of [30, 60]) {
    const r = R * (1 - el / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#1b2836';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    text(ctx, `${el}°`, cx + r * 0.707, cy - r * 0.707 - 5, '#33465c', 8);
  }

  // 十字与方位
  line(ctx, cx - R, cy, cx + R, cy, '#16212d', 1);
  line(ctx, cx, cy - R, cx, cy + R, '#16212d', 1);
  text(ctx, 'N', cx, cy - R - 11, '#5b7089', 10, 'center', 'middle', true);
  text(ctx, 'S', cx, cy + R + 11, '#42546a', 10);
  text(ctx, 'E', cx + R + 11, cy, '#42546a', 10);
  text(ctx, 'W', cx - R - 11, cy, '#42546a', 10);

  // 卫星（已应用星座筛选）
  const sats = visibleSats().filter((s) => s.el != null && s.az != null);
  for (const s of sats) {
    const r = R * (1 - clamp(s.el, 0, 90) / 90);
    const a = ((s.az - 90) * Math.PI) / 180;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    const col = (SYS[s.sys] || {}).color || '#8b9bb0';
    const size = 3.4 + (clamp(s.snr ?? 0, 0, 50) / 50) * 5.2;

    if (s.used) {
      ctx.beginPath();
      ctx.arc(x, y, size + 3, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.13;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.globalAlpha = s.used ? 0.98 : 0.3;
    ctx.fillStyle = col;
    ctx.fill();
    ctx.globalAlpha = s.used ? 0.9 : 0.5;
    ctx.strokeStyle = s.used ? '#ffffff' : col;
    ctx.lineWidth = s.used ? 1.1 : 0.9;
    ctx.stroke();
    ctx.globalAlpha = 1;

    const lx = x + size + 3;
    const ly = y - size - 4;
    text(ctx, s.prn, lx, ly, s.used ? '#c3d5e6' : '#4f6275', 8, 'left', 'middle');
  }

  const empty = $('skyEmpty');
  empty.style.display = sats.length ? 'none' : 'flex';
  if (!sats.length) {
    empty.textContent = state.sats.size ? '当前筛选下没有卫星' : '等待数据…';
  }
}

/** 构建星座筛选 chip（图例即可点击的筛选器） */
function buildLegend() {
  const box = $('skyLegend');
  box.innerHTML = '';
  for (const k of FILTER_SYS) {
    const v = SYS[k];
    const b = document.createElement('button');
    b.className = 'chip lg' + (filter.sys.has(k) ? ' on' : '');
    b.style.setProperty('--c', v.color);
    b.innerHTML = `<i class="sw"></i>${v.short}`;
    b.title = `显示 / 隐藏 ${v.name}`;
    b.addEventListener('click', () => {
      if (filter.sys.has(k)) {
        if (filter.sys.size <= 1) { toast('至少保留一个星座'); return; }
        filter.sys.delete(k);
      } else {
        filter.sys.add(k);
      }
      b.classList.toggle('on', filter.sys.has(k));
      saveUiConfig({ sysFilter: [...filter.sys] });
    });
    box.appendChild(b);
  }

  const used = $('chipUsedOnly');
  used.classList.toggle('on', filter.usedOnly);
  used.addEventListener('click', () => {
    filter.usedOnly = !filter.usedOnly;
    used.classList.toggle('on', filter.usedOnly);
    saveUiConfig({ usedOnly: filter.usedOnly });
  });
}

/* ============================================================
   5. 载噪比柱状图
   ============================================================ */
function drawSnr() {
  const cv = $('cvSnr');
  const { ctx, W, H } = setup(cv);
  const sats = visibleSats();

  $('snrEmpty').style.display = sats.length ? 'none' : 'flex';
  if (!sats.length) { $('snrPeak').textContent = '—'; return; }

  const padL = 24, padR = 8, padT = 10, padB = 20;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const yMax = 55;

  // 网格
  for (const v of [0, 20, 40]) {
    const y = padT + ph * (1 - v / yMax);
    line(ctx, padL, y, W - padR, y, v === 0 ? '#243342' : '#16212d', 1, v === 0 ? null : [2, 4]);
    text(ctx, String(v), padL - 5, y, '#3f5165', 8, 'right', 'middle');
  }

  // 按星座分组
  const groups = new Map();
  for (const s of sats) {
    if (!groups.has(s.sys)) groups.set(s.sys, []);
    groups.get(s.sys).push(s);
  }

  const slot = pw / sats.length;
  const barW = clamp(slot * 0.6, 3, 13);
  let i = 0;
  let peak = 0;

  for (const [sys, list] of groups) {
    const col = (SYS[sys] || {}).color || '#8b9bb0';
    // 组起始分隔
    if (i > 0) line(ctx, padL + slot * i, padT, padL + slot * i, padT + ph, '#243342', 1, [3, 3]);

    for (const s of list) {
      const cx = padL + slot * i + slot / 2;
      const v = clamp(s.snr ?? 0, 0, yMax);
      peak = Math.max(peak, v);
      const h = (ph * v) / yMax;
      const y = padT + ph - h;

      if (h > 0.5) {
        ctx.globalAlpha = s.used ? 0.95 : 0.42;
        ctx.fillStyle = col;
        roundRect(ctx, cx - barW / 2, y, barW, h, 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#1e2a38';
        ctx.fillRect(cx - barW / 2, padT + ph - 1.5, barW, 1.5);
      }

      // 卫星多时隔位标注，避免 PRN 挤在一起看不清
      if (slot >= 15 || i % 2 === 0) {
        text(ctx, s.prn, cx, H - 9, s.used ? '#7f94a9' : '#3d4d5e', 8);
      }
      i++;
    }
  }

  $('snrPeak').textContent = `峰值 ${Math.round(peak)} dB-Hz`;
}

/* ============================================================
   6. 轨迹图
   ============================================================ */
function drawTrack() {
  const cv = $('cvTrack');
  const { ctx, W, H } = setup(cv);
  const pts = state.track;

  $('trackEmpty').style.display = pts.length > 1 ? 'none' : 'flex';
  if (pts.length < 2) { $('trackDist').textContent = '—'; return; }

  // 点数过多时等距抽稀再画：两万点每帧全量 map + 两次 stroke 会明显掉帧，
  // 而画布也就几百像素宽，抽到 3000 点视觉上没有区别。导出仍用原始全量数据。
  const MAX_DRAW = 3000;
  let drawPts = pts;
  if (pts.length > MAX_DRAW) {
    const step = Math.ceil(pts.length / MAX_DRAW);
    drawPts = [];
    for (let i = 0; i < pts.length; i += step) drawPts.push(pts[i]);
    const tail = pts[pts.length - 1];
    if (drawPts[drawPts.length - 1] !== tail) drawPts.push(tail);
  }

  const lat0 = drawPts[0].lat;
  const lon0 = drawPts[0].lon;
  const mLat = 111320;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = drawPts.map((p) => [(p.lon - lon0) * mLon, (p.lat - lat0) * mLat]);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < xy.length; i++) {
    const [x, y] = xy[i];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }

  const pad = 16;
  const spanX = Math.max(maxX - minX, 4);
  const spanY = Math.max(maxY - minY, 4);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const ox = (W - spanX * scale) / 2 - minX * scale;
  const oy = (H - spanY * scale) / 2 + maxY * scale;
  const toPx = ([x, y]) => [x * scale + ox, oy - y * scale];

  // 网格
  const step = niceStep(Math.max(spanX, spanY) / 4);
  for (let g = Math.ceil(minX / step) * step; g <= maxX; g += step) {
    const [px] = toPx([g, 0]);
    line(ctx, px, pad * 0.6, px, H - pad * 0.6, '#131d28', 1);
  }
  for (let g = Math.ceil(minY / step) * step; g <= maxY; g += step) {
    const [, py] = toPx([0, g]);
    line(ctx, pad * 0.6, py, W - pad * 0.6, py, '#131d28', 1);
  }

  // 轨迹线（带辉光）
  ctx.beginPath();
  xy.forEach((p, i) => {
    const [px, py] = toPx(p);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.strokeStyle = 'rgba(78,168,255,0.25)';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = '#4ea8ff';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 起点
  const [sx, sy] = toPx(xy[0]);
  ctx.beginPath();
  ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = '#3ddc84';
  ctx.fill();

  // 当前位置 + 航向
  const [ex, ey] = toPx(xy[xy.length - 1]);
  ctx.beginPath();
  ctx.arc(ex, ey, 8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,176,32,0.16)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb020';
  ctx.fill();

  if (state.course != null) {
    const a = ((state.course - 90) * Math.PI) / 180;
    line(ctx, ex, ey, ex + Math.cos(a) * 15, ey + Math.sin(a) * 15, '#ffd17a', 1.4);
  }

  // 比例尺
  const barM = niceStep(Math.max(spanX, spanY) / 4);
  const barPx = barM * scale;
  const bx = W - pad - barPx - 4;
  const by = H - 13;
  line(ctx, bx, by, bx + barPx, by, '#57697d', 1.4);
  line(ctx, bx, by - 3, bx, by + 3, '#57697d', 1.4);
  line(ctx, bx + barPx, by - 3, bx + barPx, by + 3, '#57697d', 1.4);
  text(ctx, barM >= 1000 ? `${(barM / 1000).toFixed(1)} km` : `${barM} m`, bx + barPx / 2, by - 7, '#57697d', 8);
}

function niceStep(v) {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-6))));
  const m = v / e;
  const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return s * e;
}

/* ============================================================
   7. 时序图（卫星数 / HDOP）
   ============================================================ */
function drawTs() {
  const cv = $('cvTs');
  const { ctx, W, H } = setup(cv);
  const data = state.series;

  $('tsEmpty').style.display = data.length > 2 ? 'none' : 'flex';
  if (data.length < 2) return;

  const padL = 24, padR = 26, padT = 10, padB = 16;
  const pw = W - padL - padR;
  const ph = H - padT - padB;

  const maxSat = Math.max(20, Math.ceil(Math.max(...data.map((d) => d.visible)) / 10) * 10);
  const hdops = data.map((d) => d.hdop).filter((v) => v != null && isFinite(v) && v < 90);
  const maxHdop = Math.max(2, Math.ceil(Math.max(...(hdops.length ? hdops : [2]))));

  for (let i = 0; i <= 4; i++) {
    const y = padT + (ph * i) / 4;
    line(ctx, padL, y, W - padR, y, '#141e29', 1);
    text(ctx, String(Math.round(maxSat * (1 - i / 4))), padL - 5, y, '#3f5165', 8, 'right');
    text(ctx, (maxHdop * (1 - i / 4)).toFixed(1), W - padR + 5, y, '#4a3f2c', 8, 'left');
  }

  const X = (i) => padL + (pw * i) / (data.length - 1);
  const YS = (v) => padT + ph * (1 - clamp(v, 0, maxSat) / maxSat);
  const YH = (v) => padT + ph * (1 - clamp(v ?? maxHdop, 0, maxHdop) / maxHdop);

  const series = (getY, color, w = 1.5) => {
    ctx.beginPath();
    let started = false;
    data.forEach((d, i) => {
      const v = getY(d);
      if (v == null || !isFinite(v)) { started = false; return; }
      const x = X(i), y = v;
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  // 可见数（细线，背景）
  series((d) => YS(d.visible), 'rgba(78,168,255,0.45)', 1);
  // 参与解算数（主线）
  series((d) => YS(d.used), '#3ddc84', 1.6);
  // HDOP（右轴）
  series((d) => (d.hdop != null && d.hdop < 90 ? YH(d.hdop) : null), '#ffb020', 1.2);
}

/* ============================================================
   8. 面板刷新
   ============================================================ */
function updatePanels() {
  const fq = FIX_QUALITY[state.fixQuality] || { text: '未定位', cls: 'dim' };
  const ft = FIX_TYPE[state.fix];
  const fixText = ft ? ft.text : fq.text;

  const vFix = $('vFix');
  vFix.textContent = state.fixQuality != null ? fixText : '等待数据';
  vFix.className = ft && ft.cls !== 'dim' ? ft.cls : fq.cls;

  $('vLat').textContent = state.lat != null ? state.lat.toFixed(7) + '°' : '—';
  $('vLon').textContent = state.lon != null ? state.lon.toFixed(7) + '°' : '—';
  $('vAlt').textContent = state.alt != null ? state.alt.toFixed(1) + ' m' : '—';
  $('vSpeed').textContent = state.speedKmh != null ? state.speedKmh.toFixed(2) + ' km/h' : '—';
  $('vCourse').textContent = state.course != null ? state.course.toFixed(1) + '°' : '—';
  $('vUsed').textContent = state.satsUsed || '—';
  $('vVisible').textContent = state.sats.size || '—';
  $('vHdop').textContent = state.hdop != null ? state.hdop.toFixed(2) : '—';
  $('vPdop').textContent = (state.pdop != null && state.vdop != null)
    ? `${state.pdop.toFixed(2)} / ${state.vdop.toFixed(2)}` : '—';
  $('vUtc').textContent = fmtUtc(state.utc);

  // 惯导
  const ins = state.unicore.insstatus;
  const odo = state.unicore.odostatus;
  const vIns = $('vIns');
  const vOdo = $('vOdo');
  vIns.textContent = ins == null ? '未知' : (INS_STATUS[ins] || `状态 ${ins}`);
  vIns.className = ins === 3 ? 'good' : ins === -1 ? 'bad' : ins == null ? 'dim' : 'warn';
  vOdo.textContent = odo == null ? '未知' : (ODO_STATUS[odo] || `状态 ${odo}`);
  vOdo.className = odo === 2 ? 'good' : odo === -1 ? 'bad' : odo == null ? 'dim' : 'warn';
  $('insHint').classList.toggle('show', ins != null && ins !== 3);

  // 统计
  $('vRx').textContent = formatBytes(stats.rx);
  $('vLines').textContent = String(stats.lines);
  $('vBad').textContent = String(stats.bad);
  $('vBps').textContent = `${formatBytes(stats.bps)}/s`;

  // 顶栏徽章
  const bFix = $('badgeFix');
  bFix.textContent = state.fixQuality != null ? fixText : '未定位';
  bFix.className = 'badge ' + (ft ? ft.cls : 'bad');
  $('badgeSats').textContent = `${state.satsUsed || 0} 星`;
  $('badgeRate').textContent = `${Math.round(stats.lps)} 句/秒`;

  // 卫星表
  updateSatTable();

  $('stMsg').textContent = `语句 ${stats.lines} · 解析 ${stats.parsed} · 校验错 ${stats.bad} · TX ${stats.tx} B`;
  $('stPort').textContent = link.port ? $('portName').textContent : '—';
}

function fmtUtc(utc) {
  if (!utc || utc.length < 6) return '—';
  return `${utc.slice(0, 2)}:${utc.slice(2, 4)}:${utc.slice(4, 6)} UTC`;
}

function formatBytes(n) {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

let satTableKey = '';
function updateSatTable() {
  const list = visibleSats();
  const key = list.map((s) => s.sys + s.prn + s.snr + (s.used ? 1 : 0)).join('')
    + `|${[...filter.sys].join(',')}|${filter.usedOnly ? 1 : 0}`;
  if (key === satTableKey) return;
  satTableKey = key;

  $('satCount').textContent = String(list.length);
  const body = $('satBody');

  if (!list.length) {
    const msg = state.sats.size ? '当前筛选下没有卫星' : '暂无卫星';
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-mute);padding:14px 0">${msg}</td></tr>`;
    return;
  }

  const rows = list.map((s) => {
    const col = (SYS[s.sys] || {}).color || '#8b9bb0';
    const w = clamp(((s.snr ?? 0) / 50) * 100, 0, 100);
    const snrTxt = s.snr == null ? '—' : String(s.snr);
    return `<tr class="${s.used ? 'used' : ''}">`
      + `<td><span class="dot" style="background:${col}"></span>${(SYS[s.sys] || {}).short || s.sys}</td>`
      + `<td>${s.prn}</td>`
      + `<td>${s.el ?? '—'}</td>`
      + `<td>${s.az ?? '—'}</td>`
      + `<td><div class="snr-cell"><div class="snr-bar"><i style="width:${w}%;background:${col}"></i></div>${snrTxt}</div></td>`
      + '</tr>';
  });
  body.innerHTML = rows.join('');
}

/* ============================================================
   9. 渲染循环
   ============================================================ */
let lastDraw = 0;

function renderFrame() {
  const now = performance.now();
  if (now - lastDraw < 180) return;
  lastDraw = now;

  updatePanels();
  drawSky();
  drawSnr();
  if (trackMode === 'map') syncMap();
  else drawTrack();
  drawTs();
  updateTrackDistance();
  if (rawDirty) flushRaw();
}

/** 轨迹里程（米），两种显示模式共用 */
function trackDistance() {
  const pts = state.track;
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const mLat = 111320;
    const mLon = 111320 * Math.cos((pts[i].lat * Math.PI) / 180);
    d += Math.hypot((pts[i].lon - pts[i - 1].lon) * mLon, (pts[i].lat - pts[i - 1].lat) * mLat);
  }
  return d;
}

function updateTrackDistance() {
  const d = trackDistance();
  $('trackDist').textContent = state.track.length > 1
    ? (d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${d.toFixed(0)} m`)
    : '—';
}

/** 把当前状态推给高德地图 */
function syncMap() {
  if (!trackMap.ready) return;
  trackMap.update(state.track, {
    lat: state.lat, lon: state.lon, course: state.course, hdop: state.hdop,
  });
}

function tick() {
  requestAnimationFrame(tick);
  renderFrame();
}

// 兜底：标签页在后台时 rAF 会被浏览器暂停，用定时器保证数据仍然刷新
setInterval(renderFrame, 250);

function flushRaw() {
  rawDirty = false;
  const el = $('raw');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent = rawBuf.join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

/* 速率统计 */
setInterval(() => {
  const now = performance.now();
  const dt = (now - stats.lastT) / 1000;
  if (dt <= 0.2) return;
  stats.bps = (stats.rx - stats.lastRx) / dt;
  stats.lps = (stats.lines - stats.lastLines) / dt;
  stats.lastRx = stats.rx;
  stats.lastLines = stats.lines;
  stats.lastT = now;
}, 1000);

/* ============================================================
   6.5 轨迹地图（高德）
   ============================================================ */
function setTrackMode(mode) {
  trackMode = mode === 'map' ? 'map' : 'local';
  saveUiConfig({ trackMode });

  document.querySelectorAll('#trackTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === trackMode);
  });

  const isMap = trackMode === 'map';
  $('cvTrack').style.display = isMap ? 'none' : 'block';
  $('mapBox').hidden = !isMap;

  if (isMap) {
    $('trackEmpty').style.display = 'none';
    ensureMap();
  } else {
    $('mapKeyTip').hidden = true;
    $('trackEmpty').style.display = state.track.length > 1 ? 'none' : 'flex';
  }
}

function showMapTip(html) {
  const tip = $('mapKeyTip');
  tip.hidden = false;
  tip.innerHTML = html;
  const btn = tip.querySelector('#btnMapTipKey');
  if (btn) btn.addEventListener('click', openKeyModal);
}

async function ensureMap() {
  const local = loadMapConfig();
  const srv = await fetchServerConfig();

  // 优先级：页面里填过的 JS API Key > 服务端探测到 JS API Key > 静态底图兜底
  let mode = 'none';
  let jsKey = '';
  let sec = '';
  if (!isPlaceholderKey(local.key)) {
    mode = 'jsapi';
    jsKey = local.key;
    sec = local.securityJsCode || '';
  } else if (srv.mapMode === 'jsapi' && srv.jsKey) {
    mode = 'jsapi';
    jsKey = srv.jsKey;
    sec = srv.securityCode || '';
  } else if (srv.mapMode === 'static') {
    mode = 'static';
  }

  if (mode === 'none') {
    const offline = srv.__offline;
    showMapTip(`
      <div><b>${offline ? '本地服务没有在运行' : '地图还没配置 Key'}</b></div>
      ${offline
        ? '<div>用 <code>bash start.sh</code> 启动本地服务后再打开页面，地图功能才会生效。</div>'
        : `<div>页面上填一个「Web端(JS API)」的 Key 就能拖动缩放；填「Web服务」的 Key 只能看静态底图。</div>
           <div>申请：<code>console.amap.com/dev/key/app</code></div>`}
      <button class="mini primary" id="btnMapTipKey">填入 Key</button>`);
    return;
  }

  // 切换实现方式时重建适配器
  if (mapMode !== mode) {
    if (trackMap.ready) trackMap.destroy();
    trackMap = mode === 'jsapi' ? new TrackMap() : new StaticTrackMap();
    mapMode = mode;
    const sat = $('btnMapSat');
    const canSat = mode === 'jsapi';
    sat.disabled = !canSat;
    sat.classList.toggle('off', !canSat);
    sat.title = canSat
      ? '切换到卫星影像底图'
      : '静态底图不支持卫星影像；换成「Web端(JS API)」的 Key 才有';
    if (!canSat && srv.hasWebKey) {
      toast('当前用的是「Web服务」Key，只能显示静态底图；可拖动缩放需要「Web端(JS API)」Key', 5200);
    }
  }

  if (trackMap.ready) {
    $('mapKeyTip').hidden = true;
    trackMap.resize();
    syncMap();
    return;
  }

  if (mapLoading) return;          // 连点切换时避免重复初始化
  mapLoading = true;

  showMapTip(mode === 'jsapi'
    ? '<div>正在加载高德地图…</div>'
    : '<div>正在取静态底图…</div>');
  try {
    if (mode === 'jsapi') {
      await trackMap.init($('mapCanvas'), jsKey, sec);
      trackMap.setSatellite(local.satellite && !$('btnMapSat').disabled);
    } else {
      await trackMap.init($('mapCanvas'));
    }
    trackMap.setFollow(local.follow);
    $('btnMapSat').classList.toggle('on', !!trackMap.satellite);
    $('btnMapFollow').classList.toggle('on', local.follow);
    $('mapKeyTip').hidden = true;
    trackMap.resize();
    syncMap();

    // 软校验：只有 JS API 模式才需要。SDK 加载成功但 Key 类型不对时，
    // 高德只会在控制台报错，页面上是一片灰底。
    if (mode === 'jsapi') {
      setTimeout(() => {
        const box = $('mapCanvas');
        if (box && !box.querySelector('.amap-container')) {
          showMapTip(`
            <div><b>地图没有正常渲染</b></div>
            <div>多半是 Key 类型选错了：必须选「Web端(JS API)」，选成「Web服务」用不了。</div>
            <div>也检查 Referer 白名单是否放行了 <code>127.0.0.1</code></div>
            <button class="mini primary" id="btnMapTipKey">重新填写</button>`);
        }
      }, 1600);
    }
  } catch (e) {
    console.error('地图初始化失败', e);
    showMapTip(`
      <div><b>地图加载失败</b></div>
      <div>${String(e.message || e)}</div>
      <div>常见原因：Key 未开通「Web端(JS API)」、Referer 白名单没放行 127.0.0.1</div>
      <button class="mini primary" id="btnMapTipKey">检查 Key</button>`);
  } finally {
    mapLoading = false;
  }
}

function openKeyModal() {
  const cfg = loadMapConfig();
  $('mapKeyInput').value = cfg.key || '';
  $('mapSecInput').value = cfg.securityJsCode || '';
  $('keyModal').hidden = false;
  setTimeout(() => $('mapKeyInput').focus(), 30);
}

async function saveKeyAndLoad() {
  const key = $('mapKeyInput').value.trim();
  const sec = $('mapSecInput').value.trim();
  if (isPlaceholderKey(key)) {
    toast('Key 看起来不完整，请确认复制完整后再保存', 3600);
    return;
  }

  const changed = (trackMap.key || '') !== key;
  saveMapConfig({ key, securityJsCode: sec });
  $('keyModal').hidden = true;

  if (changed) {
    // 换 Key 可能把模式从静态底图切到 JS API（或反过来），整体重建最干净
    if (trackMap.ready) trackMap.destroy();
    mapMode = null;
    await ensureMap();
    return;
  }
  await ensureMap();
}

function bindMapEvents() {
  document.querySelectorAll('#trackTabs button').forEach((b) => {
    b.addEventListener('click', () => setTrackMode(b.dataset.mode));
  });

  $('btnMapFollow').addEventListener('click', () => {
    const on = !trackMap.follow;
    trackMap.setFollow(on);
    $('btnMapFollow').classList.toggle('on', on);
    saveMapConfig({ follow: on });
  });

  $('btnMapFit').addEventListener('click', () => {
    trackMap.setFollow(false);
    $('btnMapFollow').classList.remove('on');
    saveMapConfig({ follow: false });
    trackMap.fit();
  });

  $('btnMapSat').addEventListener('click', (ev) => {
    if (ev.currentTarget.disabled) {
      toast('静态底图没有卫星影像。去高德控制台建一个「Web端(JS API)」的 Key 就能切了', 4600);
      return;
    }
    const on = !trackMap.satellite;
    trackMap.setSatellite(on);
    $('btnMapSat').classList.toggle('on', on);
    saveMapConfig({ satellite: on });
  });

  $('btnMapKey').addEventListener('click', openKeyModal);
  $('btnKeySave').addEventListener('click', saveKeyAndLoad);
  $('btnKeyClear').addEventListener('click', () => {
    $('mapKeyInput').value = '';
    $('mapSecInput').value = '';
    saveMapConfig({ key: '', securityJsCode: '' });
    toast('已清除已保存的 Key');
  });
  document.querySelectorAll('[data-close="key"]').forEach((el) => {
    el.addEventListener('click', () => { $('keyModal').hidden = true; });
  });

  // 窗口尺寸变化：地图必须跟着 resize，否则瓦片错位
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (trackMode === 'map') trackMap.resize(); }, 180);
  });
}

/* ============================================================
   6.6 控制中心
   ============================================================ */
function initControlCenter() {
  // 必须在 ControlCenter 之前建好：面板初始化时就要把 ntrip 引用塞进 io
  ntrip = new NtripClient({
    writeBytes: (u8) => queueWrite(u8),
    getGga: () => lastGga,
    onStatus: (st) => { if (ctl) ctl.renderNtrip(st); },
    toast: (m, ms) => toast(m, ms),
  });

  ctl = new ControlCenter($('ctlRoot'), {
    send: (c) => sendCmd(c),
    toast: (m, ms) => toast(m, ms),
    isConnected: () => !!link.writer,
    // 控制中心顶部的厂商模式开关，改的是界面状态，不是设备配置
    setVendorMode: (m) => setVendorMode(m),
    vendorMode: () => vendorMode,
    // 位置辅助要用"上次定位"，直接把状态机里最新的定位给出去
    getPos: () => ({ lat: state.lat, lon: state.lon, alt: state.alt }),
    ntrip,
  });

  $('btnCtl').addEventListener('click', () => { $('ctlModal').hidden = false; });
  document.querySelectorAll('[data-close="ctl"]').forEach((el) => {
    el.addEventListener('click', () => { $('ctlModal').hidden = true; });
  });
}

/* ============================================================
   10. 命令台
   ============================================================ */
const PRESETS = [
  { label: '保存配置', cmd: '$CFGSAVE', title: '把当前配置写入 Flash', v: VENDOR.UNICORE },
  { label: '自由安装', cmd: '$CFGROTAT,0,0,0,2', title: '自动安装角模式，需行驶完成校准', v: VENDOR.UNICORE },
  { label: '固定安装', cmd: '$CFGROTAT,0,0,0,0', title: '普通安装模式（手工输入角度）', v: VENDOR.UNICORE },
  { label: '状态查询', cmd: '$SNRSTAT', title: '请求输出初始化状态', v: VENDOR.UNICORE },
  { label: '里程计正向', cmd: '$CFGODOFWD,1', title: '配置里程计方向信号', v: VENDOR.UNICORE },
  { label: '里程计反向', cmd: '$CFGODOFWD,0', title: '配置里程计方向信号', v: VENDOR.UNICORE },
  { label: '碰撞唤醒关', cmd: '$CFGACC,0,0', title: '关闭碰撞唤醒，降低待机功耗', v: VENDOR.UNICORE },
  // 标准 NMEA 设备的常用命令。两条家族的都列出来，标签写清前缀，别让人瞎试。
  { label: '探测厂商', cmd: '$PDTINFO', title: '和芯星通设备会回型号，其他设备一般静默', v: VENDOR.NMEA },
  { label: 'PMTK 1 Hz', cmd: '$PMTK220,1000*1F', title: 'MediaTek 芯片改输出频率', v: VENDOR.NMEA },
  { label: 'PMTK 5 Hz', cmd: '$PMTK220,200*2C', title: 'MediaTek 芯片改输出频率', v: VENDOR.NMEA },
  { label: 'UBX GGA 1 Hz', cmd: '$PUBX,40,GGA,0,1,0,0,0*47', title: 'u-blox 芯片开通 GGA（UART1）', v: VENDOR.NMEA },
  { label: 'UBX GSV 1 Hz', cmd: '$PUBX,40,GSV,0,1,0,0,0*44', title: 'u-blox 芯片开通 GSV（UART1）', v: VENDOR.NMEA },
];

function buildPresets() {
  const box = $('presets');
  const vendor = effectiveVendor();
  box.innerHTML = '';
  for (const p of PRESETS.filter((x) => x.v === vendor)) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.title = `${p.cmd}\n${p.title || ''}`;
    b.addEventListener('click', () => sendCmd(p.cmd));
    box.appendChild(b);
  }
}

/* ============================================================
   11. 导出
   ============================================================ */
function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---- 快速导出：原始流卡片右上角的「导出」按钮，直接给全量 NMEA ---- */
function exportRaw() {
  if (!logBuf.length) { toast('还没有数据'); return; }
  download(`gnss-log-${stamp()}.nmea`, toLogNMEA(logBuf));
  const tail = logDropped ? `，缓冲区已丢弃最早 ${logDropped} 条` : '';
  toast(`已导出 ${logBuf.length} 条语句${tail}`, 3600);
}

/* ============================================================
   11.1 导出面板（轨迹 / 日志可分别导出，格式可选）
   ============================================================ */

let expCfg = loadExportConfig();

/** 按当前勾选与时间范围取实际要导出的数据 */
function exportPayload() {
  const rangeMin = expCfg.rangeMin || 0;
  return {
    track: expCfg.trackOn ? sliceByTime(state.track, rangeMin) : [],
    log: expCfg.logOn ? sliceByTime(logBuf, rangeMin) : [],
  };
}

/** 平均行长：采样尾部 1000 条够用了，日志几万条时全量遍历没必要 */
function avgLineLen(log) {
  const n = Math.min(log.length, 1000);
  if (!n) return 0;
  let sum = 0;
  for (let i = log.length - n; i < log.length; i++) sum += (log[i].line || '').length;
  return sum / n;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.round((sec % 3600) / 60)} 分`;
}

/** 格式按钮只建一次，之后靠 class 切换，避免每次刷新都重建 DOM 闪一下 */
function buildFmtSeg(box, list) {
  if (box.children.length === list.length) return;
  box.innerHTML = '';
  for (const f of list) {
    const b = document.createElement('button');
    b.textContent = f.name;
    b.dataset.id = f.id;
    b.title = f.note;
    box.appendChild(b);
  }
}

/** 各格式每个轨迹点的大致字节数，实测 200 点样本反推（含缩进、时间、海拔等常规字段） */
const TRACK_BYTES_PER_POINT = { gpx: 240, kml: 42, geojson: 97, csv: 91 };
/** 各日志格式在每行原文之外的开销（换行、ISO 时间、JSON 包装） */
const LOG_BYTES_OVERHEAD = { nmea: 1, text: 26, jsonl: 62 };

/** 刷新面板统计、体积估算与可导出状态 */
function syncExportUI() {
  $('expTrackOn').checked = expCfg.trackOn;
  $('expLogOn').checked = expCfg.logOn;

  document.querySelectorAll('#expRange button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.min) === (expCfg.rangeMin || 0));
  });

  const tFmt = findFormat(TRACK_FORMATS, expCfg.trackFmt);
  const lFmt = findFormat(LOG_FORMATS, expCfg.logFmt);
  buildFmtSeg($('expTrackFmt'), TRACK_FORMATS);
  buildFmtSeg($('expLogFmt'), LOG_FORMATS);
  [...$('expTrackFmt').children].forEach((b) => b.classList.toggle('on', b.dataset.id === tFmt.id));
  [...$('expLogFmt').children].forEach((b) => b.classList.toggle('on', b.dataset.id === lFmt.id));
  $('expTrackNote').textContent = tFmt.note;
  $('expLogNote').textContent = lFmt.note;

  // 未勾选的行整块压暗，省得用户以为还能选格式
  $('expTrackOn').closest('.exp-row').classList.toggle('off', !expCfg.trackOn);
  $('expLogOn').closest('.exp-row').classList.toggle('off', !expCfg.logOn);

  const { track, log } = exportPayload();
  const st = trackStats(track);

  // 体积一律估算，不真的生成字符串 —— 面板每秒刷新一次，生成 2 万点的 GPX
  // 要几十毫秒，会明显卡顿；估算误差在 ±30% 以内，显示「约」就够了。
  const trackBytes = track.length * (TRACK_BYTES_PER_POINT[tFmt.id] || 100);
  const logBytes = Math.round(log.length * (avgLineLen(log) + (LOG_BYTES_OVERHEAD[lFmt.id] || 0)));

  $('expTrackMeta').textContent = track.length
    ? `${track.length.toLocaleString()} 点 · ${(st.distanceM / 1000).toFixed(2)} km · ${fmtDuration(st.durationS)}`
    : '暂无数据';

  $('expLogMeta').textContent = log.length
    ? `${log.length.toLocaleString()} 条 · 约 ${formatBytes(logBytes)}`
    : '暂无数据';

  const parts = [];
  if (expCfg.trackOn && track.length) parts.push(`轨迹约 ${formatBytes(trackBytes)}`);
  if (expCfg.logOn && log.length) parts.push(`日志约 ${formatBytes(logBytes)}`);

  let html;
  if (!expCfg.trackOn && !expCfg.logOn) {
    html = '<span class="warn">轨迹和日志都没勾选，没有可导出的内容</span>';
  } else if (!parts.length) {
    html = '<span class="warn">当前范围内没有数据。先连上设备，或把时间范围放宽到「全部」</span>';
  } else {
    html = `将导出 <b>${parts.length}</b> 个文件 · ${parts.join(' · ')}`;
    if (logDropped) {
      html += `<br><span class="warn">日志缓冲已满，最早 ${logDropped.toLocaleString()} 条被丢弃</span>`;
    }
    if (parts.length > 1) {
      html += '<br>浏览器若提示「要下载多个文件」，选允许即可（每个会话只问一次）';
    }
  }
  $('expSummary').innerHTML = html;
  $('btnExpDo').disabled = parts.length === 0;
}

let expTimer = null;

function openExport() {
  expCfg = loadExportConfig();
  syncExportUI();
  $('expModal').hidden = false;
  // 面板开着时数据还在涨，每秒刷一次，别让用户看着过期数字做决定
  if (expTimer) clearInterval(expTimer);
  expTimer = setInterval(syncExportUI, 1000);
}

function closeExport() {
  if (expTimer) { clearInterval(expTimer); expTimer = null; }
  $('expModal').hidden = true;
}

async function doExport() {
  const { track, log } = exportPayload();
  const ts = stamp();
  const jobs = [];

  if (expCfg.trackOn && track.length) {
    const f = findFormat(TRACK_FORMATS, expCfg.trackFmt);
    jobs.push({
      name: `gnss-track-${ts}.${f.ext}`,
      mime: f.mime,
      text: f.build(track, { name: 'GNSS 轨迹', exportedAt: Date.now() }),
    });
  }
  if (expCfg.logOn && log.length) {
    const f = findFormat(LOG_FORMATS, expCfg.logFmt);
    jobs.push({ name: `gnss-log-${ts}.${f.ext}`, mime: f.mime, text: f.build(log) });
  }

  if (!jobs.length) { toast('没有可导出的数据'); return; }

  // 多个文件必须隔开触发：连着调 click 会被浏览器判成批量下载直接拦掉
  for (let i = 0; i < jobs.length; i++) {
    download(jobs[i].name, jobs[i].text, jobs[i].mime);
    if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 500));
  }

  closeExport();
  toast(jobs.length > 1
    ? `已导出 ${jobs.length} 个文件（若浏览器拦截请点「允许」）`
    : `已导出 ${jobs[0].name}`, 4200);
}

function initExport() {
  $('btnExport').addEventListener('click', openExport);
  $('btnExpDo').addEventListener('click', doExport);

  $('expTrackOn').addEventListener('change', (e) => {
    expCfg = saveExportConfig({ trackOn: e.target.checked });
    syncExportUI();
  });
  $('expLogOn').addEventListener('change', (e) => {
    expCfg = saveExportConfig({ logOn: e.target.checked });
    syncExportUI();
  });

  $('expTrackFmt').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    expCfg = saveExportConfig({ trackFmt: b.dataset.id });
    syncExportUI();
  });
  $('expLogFmt').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    expCfg = saveExportConfig({ logFmt: b.dataset.id });
    syncExportUI();
  });
  $('expRange').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    expCfg = saveExportConfig({ rangeMin: Number(b.dataset.min) || 0 });
    syncExportUI();
  });

  document.querySelectorAll('[data-close="exp"]').forEach((el) => {
    el.addEventListener('click', closeExport);
  });
}

/* ============================================================
   12. 仿真模式（无硬件时演示 / 验证界面）
   用法：index.html?demo=1
   ============================================================ */
function frame(body) {
  return '$' + body + '*' + checksum(body).toString(16).toUpperCase().padStart(2, '0');
}

function startDemo() {
  state.reset();
  const t0 = Date.now();
  let lat = 34.16402, lon = 108.88633;

  const pool = [
    ['GP', [5, 12, 15, 18, 24, 28, 30, 32]],
    ['GB', [1, 3, 7, 9, 11, 19, 21, 26, 33, 35, 37, 40]],
    ['GL', [65, 66, 72, 74, 81, 82]],
    ['GA', [2, 5, 9, 11, 19, 24, 36]],
    ['GQ', [2, 3, 4]],
  ];

  const emit = () => {
    const el = ((Date.now() - t0) / 1000) % 90;
    const lines = [];

    const satsBySys = [];
    for (const [sys, prns] of pool) {
      const base = sys.charCodeAt(0) * 7 + sys.charCodeAt(1) * 13;
      const sats = prns.map((prn, i) => {
        // 方位按索引均匀铺开，仰角用独立相位，避免所有星挤在一条弧上
        const az = (base * 3 + i * 47 + el * 0.7) % 360;
        // 基础仰角在星座内均匀铺开，再叠加缓慢漂移，模拟卫星升落
        const drift = Math.sin(((el * 3 + i * 47) * Math.PI) / 180) * 14;
        const elev = clamp(16 + (70 * ((i * 13 + base * 7) % 11)) / 10 + drift, 6, 88);
        const snr = Math.round(28 + 22 * Math.abs(Math.cos(((i * 41 + el) * Math.PI) / 180)) * (sys === 'GB' ? 1 : 0.9));
        return { prn, az: Math.round(az), el: Math.round(elev), snr };
      });
      satsBySys.push([sys, sats]);
    }

    // GSV：按每 4 颗分片
    for (const [sys, sats] of satsBySys) {
      const total = Math.ceil(sats.length / 4);
      for (let i = 0; i < total; i++) {
        const chunk = sats.slice(i * 4, i * 4 + 4);
        const body = chunk.map((s) => `${String(s.prn).padStart(2, '0')},${s.el},${String(s.az).padStart(3, '0')},${String(s.snr).padStart(2, '0')}`).join(',');
        lines.push(frame(`${sys}GSV,${total},${i + 1},${String(sats.length).padStart(2, '0')},${body}`));
      }
    }

    // GSA：每个星座一条，系统 ID 对应
    const sysId = { GP: 1, GL: 2, GA: 3, GB: 4, GQ: 5 };
    const usedBySys = {};
    for (const [sys, sats] of satsBySys) {
      const used = sats.filter((s) => s.el > 15).slice(0, 8);
      usedBySys[sys] = used;
      const slots = [...used.map((s) => String(s.prn).padStart(2, '0')), ...Array(12).fill('')].slice(0, 12).join(',');
      lines.push(frame(`GNGSA,A,3,${slots},1.85,1.12,1.32,${sysId[sys]}`));
    }

    const usedTotal = Object.values(usedBySys).reduce((a, b) => a + b.length, 0);
    lat += Math.sin(el / 12) * 0.000045;
    lon += Math.cos(el / 12) * 0.000038;

    const hhmmss = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const dd = new Date().toISOString().slice(8, 10);
    const mm = new Date().toISOString().slice(5, 7);
    const yy = new Date().toISOString().slice(2, 4);
    const latStr = toNmeaCoord(lat, true);
    const lonStr = toNmeaCoord(lon, false);

    lines.push(frame(`GNGGA,${hhmmss}.00,${latStr},N,${lonStr},E,1,${String(usedTotal).padStart(2, '0')},1.12,473.8,M,-8.1,M,,`));
    lines.push(frame(`GNRMC,${hhmmss}.00,A,${latStr},N,${lonStr},E,0.62,212.4,${dd}${mm}${yy},,,A`));
    lines.push(frame('GNVTG,212.4,T,213.1,M,0.62,N,1.15,K,A'));
    lines.push(frame('SNRSTAT,1,1,0,2'));
    lines.push(frame('GNTXT,01,01,02,GNSS DEMO MODE'));

    stats.rx += lines.reduce((a, l) => a + l.length + 2, 0);
    for (const l of lines) handleLine(l);
  };

  emit();
  setInterval(emit, 1000);

  $('portName').textContent = '仿真模式（无硬件）';
  $('hintBar').classList.remove('show');
  $('stConn').textContent = '● 仿真';
  $('stConn').className = 'st-ok';
  $('btnConnect').textContent = '仿真中';
  toast('已进入仿真模式：界面用合成数据驱动', 3600);
}

function toNmeaCoord(v, isLat) {
  const abs = Math.abs(v);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const degW = isLat ? 2 : 3;
  return String(deg).padStart(degW, '0') + min.toFixed(5).padStart(8, '0');
}

/* ============================================================
   13. 初始化
   ============================================================ */
function bindEvents() {
  $('btnConnect').addEventListener('click', pickAndConnect);
  $('btnDisconnect').addEventListener('click', () => closePort(false));
  $('btnBaudScan').addEventListener('click', scanBaud);

  $('btnPause').addEventListener('click', () => {
    rawPaused = !rawPaused;
    $('btnPause').textContent = rawPaused ? '继续' : '暂停';
  });
  $('btnClear').addEventListener('click', () => {
    rawBuf.length = 0;
    rawDirty = true;
    $('raw').textContent = '';
  });
  $('btnSaveRaw').addEventListener('click', exportRaw);

  $('btnSend').addEventListener('click', () => {
    sendCmd($('cmdInput').value);
    $('cmdInput').value = '';
  });
  $('cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendCmd($('cmdInput').value);
      $('cmdInput').value = '';
    }
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.metaKey && e.key === 's') { e.preventDefault(); openExport(); }
    if (e.metaKey && e.key === 'k') { e.preventDefault(); $('cmdInput').focus(); }
    if (e.key === 'Escape') {
      if (!$('ctlModal').hidden) $('ctlModal').hidden = true;
      if (!$('keyModal').hidden) $('keyModal').hidden = true;
      if (!$('expModal').hidden) closeExport();
    }
  });

  // 串口热插拔提示
  if (SUPPORTED) {
    navigator.serial.addEventListener('disconnect', (e) => {
      if (link.port && e.target === link.port) toast('设备已拔出', 3000);
    });
  }
}

async function tryAutoOpen() {
  if (!SUPPORTED || !$('autoReopen').checked) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return;
    await openPort(ports[ports.length - 1]);
    toast('已自动连接上次使用的串口');
  } catch (e) {
    console.warn('自动连接失败', e);
    $('portName').textContent = '未连接（点“连接串口”选择设备）';
  }
}

/**
 * 恢复上次的串口参数。
 * 默认 115200 —— 绝大多数 GNSS 模块出厂就是这个速率。改过一次就记住，
 * 自己那块跑 460800 的板子第二次打开页面不用再选。
 */
function restorePortConfig() {
  const cfg = loadPortConfig();
  const setSel = (id, v) => {
    const el = $(id);
    if (!el || v == null) return;
    const s = String(v);
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === s)) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      el.appendChild(o);
    }
    el.value = s;
  };
  setSel('baud', cfg.baud);
  setSel('dataBits', cfg.dataBits);
  setSel('parity', cfg.parity);
  setSel('stopBits', cfg.stopBits);
}

function init() {
  bindEvents();
  buildPresets();
  buildLegend();
  bindMapEvents();
  initControlCenter();
  initExport();
  initAnalysis();
  restorePortConfig();
  updateVendorUI();
  setConnUI(false);
  setTrackMode(trackMode);

  $('stVer').textContent = SUPPORTED
    ? 'Web Serial 可用 · 布局参考 u-center / gpsmon'
    : '当前浏览器不支持 Web Serial，请用 Edge 或 Chrome';

  if (new URLSearchParams(location.search).get('demo') === '1') {
    startDemo();
  } else if (!SUPPORTED) {
    $('hintBar').classList.add('show');
    $('hintBar').innerHTML = '当前浏览器不支持 Web Serial。请用 <b>Microsoft Edge</b> 或 <b>Chrome</b> 打开本页面；'
      + 'Safari 因安全策略限制，无法访问串口。';
    $('btnConnect').disabled = true;
  } else {
    $('hintBar').classList.add('show');   // 未连接时先给出操作引导
    tryAutoOpen();
  }

  // 深链：?track=map 切地图，?ctl=1 开控制中心（&tab=sys），?exp=1 开导出面板
  const qs = new URLSearchParams(location.search);
  if (qs.get('track') === 'map') setTrackMode('map');
  if (qs.get('ctl') === '1') {
    $('ctlModal').hidden = false;
    if (qs.get('tab') && ctl) ctl.show(qs.get('tab'));
  }
  if (qs.get('exp') === '1') openExport();
  if (qs.get('an')) openAnalysis({ sample: qs.get('an') === 'sample' });

  requestAnimationFrame(tick);
}

document.addEventListener('DOMContentLoaded', init);
