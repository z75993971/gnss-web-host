/**
 * config.js — 本地配置（地图 Key 等）
 *
 * ⚠️ 合规要求：本项目源码不内置任何可用的地图密钥。前端明文 Key 可被抓包，
 * 仅供个人本地使用，且务必在高德控制台配置 Referer 白名单。
 *
 * 使用方式（三选一，优先级从高到低）：
 *   1. 页面内填：轨迹卡片切到「地图」→ 填 Key → 存 localStorage（推荐日常用）；
 *   2. 本机私有文件：同目录建 map-key.local.js，写入
 *        window.__GNSS_MAP_KEY__ = '你的Key';
 *        window.__GNSS_MAP_SEC__ = '你的安全密钥';   // 可选
 *      该文件已在 .gitignore 里，不会被提交；换机器照样能用；
 *   3. 改下面 MAP_KEY：不推荐，容易误提交。
 *
 * 申请入口：https://console.amap.com/dev/key/app
 *   服务平台选「Web端(JS API)」，才能加载 JS API 2.0 的瓦片。
 */

export const MAP_KEY = 'Please apply for your own key at the AMap Open Platform and replace this placeholder';
export const MAP_SECURITY_CODE = '';

/**
 * 读取本机私有密钥文件（index.html 里以普通 script 提前加载）。
 * 同时认旧版键名 __UM621_MAP_*，升上来的人不用改本地文件。
 */
function localKey() {
  const g = typeof window !== 'undefined' ? window : {};
  const pick = (now, old) => {
    if (typeof g[now] === 'string' && g[now].trim()) return g[now].trim();
    if (typeof g[old] === 'string' && g[old].trim()) return g[old].trim();
    return '';
  };
  return {
    key: pick('__GNSS_MAP_KEY__', '__UM621_MAP_KEY__'),
    sec: pick('__GNSS_MAP_SEC__', '__UM621_MAP_SEC__'),
  };
}

const LS_MAP = 'gnss.map.cfg';
const LS_UI = 'gnss.ui.cfg';
const LS_PORT = 'gnss.port.cfg';

/**
 * 旧版本的 localStorage 键是 um621.*，换成 gnss.* 之后把老数据搬过来，
 * 免得升级一次地图 Key 和界面偏好全丢。
 */
const LEGACY_KEYS = {
  'gnss.map.cfg': 'um621.map.cfg',
  'gnss.ui.cfg': 'um621.ui.cfg',
  'gnss.exp.cfg': 'um621.exp.cfg',
};

function readJson(key, fallback) {
  try {
    let raw = localStorage.getItem(key);
    const old = LEGACY_KEYS[key];
    if (!raw && old) {
      raw = localStorage.getItem(old);
      if (raw) localStorage.setItem(key, raw);   // 搬过来，下次不再回退
    }
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式忽略 */ }
}

/** 地图配置：页面内填的 > 本机私有文件 > 代码内占位符 */
export function loadMapConfig() {
  const saved = readJson(LS_MAP, { key: '', securityJsCode: '', satellite: false, follow: true });
  const loc = localKey();
  const codeKey = MAP_KEY.startsWith('Please apply') ? '' : MAP_KEY;
  const key = saved.key || loc.key || codeKey;
  const securityJsCode = saved.securityJsCode || loc.sec || MAP_SECURITY_CODE || '';
  return { key, securityJsCode, satellite: !!saved.satellite, follow: saved.follow !== false };
}

export function saveMapConfig(patch) {
  const cur = loadMapConfig();
  const next = { ...cur, ...patch };
  writeJson(LS_MAP, next);
  return next;
}

/* ============================================================
   服务端配置
   ------------------------------------------------------------
   server.py 会探测 map-key.local.js 里那张 Key 到底是「Web服务」还是
   「Web端(JS API)」，并按结果决定地图走哪条路。Web服务 Key 只留在后台，
   前端拿不到，避免明文外露。
   ============================================================ */
let serverCfgPromise = null;

export function fetchServerConfig() {
  if (serverCfgPromise) return serverCfgPromise;
  serverCfgPromise = fetch('/api/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j) => ({ mapMode: 'none', jsKey: '', securityCode: '', hasWebKey: false, ...j }))
    .catch(() => ({ mapMode: 'none', jsKey: '', securityCode: '', hasWebKey: false, __offline: true }));
  return serverCfgPromise;
}

/** 界面偏好：星座筛选、厂商模式等 */
export function loadUiConfig() {
  return readJson(LS_UI, {
    sysFilter: ['GP', 'GB', 'GL', 'GA', 'GQ', 'GI'],
    usedOnly: false,
    syncFilter: true,
    trackMode: 'local',
    vendor: 'auto',      // auto / nmea / unicore
  });
}

export function saveUiConfig(patch) {
  const next = { ...loadUiConfig(), ...patch };
  writeJson(LS_UI, next);
  return next;
}

/* ============================================================
   导出偏好
   ------------------------------------------------------------
   记住上次选的格式，下次打开导出面板不用重选。
   ============================================================ */
const LS_EXP = 'gnss.exp.cfg';

export function loadExportConfig() {
  return readJson(LS_EXP, {
    trackOn: true,      // 是否导出轨迹
    logOn: true,        // 是否导出日志
    trackFmt: 'gpx',    // gpx / kml / geojson / csv
    logFmt: 'nmea',     // nmea / text / jsonl
    rangeMin: 0,        // 0 = 全部
  });
}

export function saveExportConfig(patch) {
  const next = { ...loadExportConfig(), ...patch };
  writeJson(LS_EXP, next);
  return next;
}

/* ============================================================
   串口偏好
   ------------------------------------------------------------
   默认 115200 是绝大多数 GNSS 模块的出厂速率。改过一次就记住 ——
   自己那块板子跑 460800 的，第二次打开页面还是 460800。
   ============================================================ */
export function loadPortConfig() {
  return readJson(LS_PORT, { baud: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
}

export function savePortConfig(patch) {
  const next = { ...loadPortConfig(), ...patch };
  writeJson(LS_PORT, next);
  return next;
}
