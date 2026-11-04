/**
 * import.js — 导出文件反向解析
 *
 * 上位机导出的东西必须能自己读回来，否则「导出」只是单行道。
 * 这里覆盖 export.js 能产出的全部 7 种格式，外加常见变体：
 *
 *   轨迹  gpx / kml / geojson / csv
 *   日志  nmea（无时间戳） / logtext（ISO 前缀） / jsonl
 *
 * 设计原则：
 *   1. 不信任文件，任何一行坏了都不能让整个文件解析失败 —— 记 warning 继续；
 *   2. 不猜数据。没有时间戳就说没有，绝不按 1Hz 假造一串时间出来；
 *   3. 纯函数。XML 优先用 DOMParser（浏览器），没有就退回正则扫描（Node 单测走这条路）。
 *
 * 坐标一律按 WGS84 处理，不做任何基准转换。
 */

import { verify, checksum } from './nmea.js';
import { lineType } from './export.js';

/** 格式清单：kind 决定这份文件进「轨迹」还是「日志」分析 */
export const IMPORT_FORMATS = {
  gpx: { kind: 'track', label: 'GPX', note: 'GPS 通用轨迹' },
  kml: { kind: 'track', label: 'KML', note: 'Google Earth 轨迹' },
  geojson: { kind: 'track', label: 'GeoJSON', note: 'GIS 轨迹' },
  trackcsv: { kind: 'track', label: '轨迹 CSV', note: '表格轨迹' },
  nmea: { kind: 'log', label: 'NMEA 日志', note: '原始语句流' },
  logtext: { kind: 'log', label: '带时间戳日志', note: 'ISO 时间 + 语句' },
  jsonl: { kind: 'log', label: 'JSONL 日志', note: '逐行 JSON' },
};

export const TRACK_IMPORT_IDS = ['gpx', 'kml', 'geojson', 'trackcsv'];
export const LOG_IMPORT_IDS = ['nmea', 'logtext', 'jsonl'];

/** 文件后缀 → 候选格式 */
const EXT_MAP = {
  gpx: 'gpx', kml: 'kml', geojson: 'geojson', json: 'geojson',
  csv: 'trackcsv', nmea: 'nmea', log: 'nmea', txt: 'logtext',
  jsonl: 'jsonl', ndjson: 'jsonl',
};

/* ============================================================
   0. 小工具
   ============================================================ */

/** 数值转换：空串 / 非数字都返回 null，别产生 NaN 混进统计 */
export function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 合法经纬度：排除 (0,0) 这个典型的「空值写成零」占位 */
export function validLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

/** 取标签属性值，单双引号都认 */
function attr(src, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(src);
  return m ? m[1] : null;
}

/** 取标签内文本，无此标签返回 null */
function tagText(src, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i');
  const m = re.exec(src);
  return m ? m[1].trim() : null;
}

/** 去 XML 实体 */
function unxml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** ISO 时间串 → 毫秒。没有时区标记时按 UTC 处理（GNSS 日志全是 UTC） */
export function parseTimeMs(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  // 纯数字当成已经是毫秒
  if (/^\d{10,}$/.test(str)) return Number(str);
  let iso = str.replace(' ', 'T');
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 格式嗅探：先看内容再看后缀，内容永远优先 */
export function sniffFormat(name, text) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const head = String(text).slice(0, 8192).replace(/^\uFEFF/, '');
  const t = head.trimStart();

  if (/<gpx[\s>]/i.test(t.slice(0, 600))) return 'gpx';
  if (/<kml[\s>]/i.test(t.slice(0, 600))) return 'kml';

  if (t[0] === '{' || t[0] === '[') {
    if (/"type"\s*:\s*"(FeatureCollection|Feature|LineString|MultiLineString|Point|GeometryCollection)"/.test(head)) {
      return 'geojson';
    }
    // 多行、每行一个对象 → JSONL
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines.slice(0, 5).every((l) => l.trim()[0] === '{')) return 'jsonl';
    return 'geojson';
  }

  // 日志：几行里能认出两种以上语句类型
  const lines = t.split(/\r?\n/, 40).filter((l) => l.trim());
  const nmeaHits = lines.filter((l) => /\$[A-Z]{2}(GGA|RMC|GSV|GSA|VTG|GLL|ZDA|TXT)/.test(l)).length;
  if (nmeaHits >= 2) {
    const tsHits = lines.filter((l) => /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(l)).length;
    return tsHits >= lines.length / 2 ? 'logtext' : 'nmea';
  }

  // CSV：表头同时出现纬度与经度列
  const first = lines[0] || '';
  if (first.includes(',') && /\b(lat|latitude)\b/i.test(first) && /\b(lon|lng|longitude)\b/i.test(first)) {
    return 'trackcsv';
  }

  return EXT_MAP[ext] || 'unknown';
}

/* ============================================================
   1. 轨迹解析
   ============================================================ */

/**
 * 统一轨迹点结构。
 * t 允许为 null（GPX 不带 <time> 时），后续分析会自动降级到纯空间检查。
 */
function mkPoint(lat, lon, extra = {}) {
  return {
    lat, lon,
    alt: Number.isFinite(extra.alt) ? extra.alt : null,
    t: Number.isFinite(extra.t) ? extra.t : null,
    speed: Number.isFinite(extra.speed) ? extra.speed : null,
    course: Number.isFinite(extra.course) ? extra.course : null,
    hdop: Number.isFinite(extra.hdop) ? extra.hdop : null,
    quality: Number.isFinite(extra.quality) ? extra.quality : null,
  };
}

/**
 * GPX 1.1（也兼容只写了 <wpt> 的简易文件）
 * 优先 DOMParser；Node 里没有，退回正则。
 */
export function parseGPX(text) {
  const warnings = [];
  let pts = [];

  if (typeof DOMParser !== 'undefined') {
    try {
      pts = parseGPXDom(text, warnings);
    } catch (e) {
      warnings.push(`DOM 解析失败，改用文本扫描：${e.message}`);
      pts = [];
    }
  }
  if (!pts.length) pts = parseGPXRegex(text);

  if (!pts.length) warnings.push('没有找到任何 trkpt / rtept / wpt 节点');

  const meta = {};
  const nameM = /<metadata\b[\s\S]*?<name>([\s\S]*?)<\/name>/i.exec(text);
  if (nameM) meta.name = unxml(nameM[1].trim());

  const noTime = pts.filter((p) => p.t == null).length;
  if (noTime && noTime === pts.length) {
    warnings.push('文件不含 <time>，无法做时间连续性分析，只做空间检查');
  } else if (noTime) {
    warnings.push(`${noTime} 个点缺 <time>，这些点不参与时间分析`);
  }
  return { points: pts, meta, warnings };
}

function parseGPXDom(text, warnings) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML 格式错误');

  const nodes = [...doc.querySelectorAll('trkpt')];
  const extra = [...doc.querySelectorAll('rtept'), ...doc.querySelectorAll('wpt')];
  const all = nodes.length ? nodes : extra;
  if (!nodes.length && extra.length) warnings.push('没有 trkpt，改用 rtept / wpt');

  return all.map((n) => {
    const lat = toNum(n.getAttribute('lat'));
    const lon = toNum(n.getAttribute('lon'));
    if (!validLatLon(lat, lon)) return null;
    const el = n.querySelector('ele');
    const time = n.querySelector('time');
    const hdop = n.querySelector('hdop') || n.querySelector('pdop');
    const spd = n.querySelector('speed');
    const crs = n.querySelector('course');
    return mkPoint(lat, lon, {
      alt: toNum(el && el.textContent),
      t: parseTimeMs(time && time.textContent),
      hdop: toNum(hdop && hdop.textContent),
      speed: toNum(spd && spd.textContent),
      course: toNum(crs && crs.textContent),
    });
  }).filter(Boolean);
}

function parseGPXRegex(text) {
  const out = [];
  // 自闭合与成对两种写法一起处理
  const re = /<(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lat = toNum(attr(m[2], 'lat'));
    const lon = toNum(attr(m[2], 'lon'));
    if (!validLatLon(lat, lon)) continue;
    const body = m[3] || '';
    out.push(mkPoint(lat, lon, {
      alt: toNum(tagText(body, 'ele')),
      t: parseTimeMs(tagText(body, 'time') || attr(m[2], 'time')),
      hdop: toNum(tagText(body, 'hdop')),
      speed: toNum(tagText(body, 'speed')),
      course: toNum(tagText(body, 'course')),
    }));
  }
  return out;
}

/**
 * KML 2.2
 * 只取 LineString / gx:Track —— 单独 <Point> 在本工具里是起点终点标记，
 * 混进轨迹会凭空多出两个不连续点。
 */
export function parseKML(text) {
  const warnings = [];
  const pts = [];
  let tIndex = 0;
  let times = [];

  // gx:Track：<when> 与 <gx:coord> 按顺序一一对应
  const trackRe = /<gx:Track\b[\s\S]*?<\/gx:Track\s*>/gi;
  let tm;
  while ((tm = trackRe.exec(text)) !== null) {
    const block = tm[0];
    times = [...block.matchAll(/<when>([\s\S]*?)<\/when>/gi)].map((x) => parseTimeMs(unxml(x[1])));
    const coords = [...block.matchAll(/<gx:coord>([\s\S]*?)<\/gx:coord>/gi)];
    coords.forEach((c, i) => {
      const v = c[1].trim().split(/\s+/).map(Number);
      const [lon, lat, alt] = v;
      if (!validLatLon(lat, lon)) return;
      pts.push(mkPoint(lat, lon, { alt, t: times[i] ?? null }));
    });
  }

  // 标准 LineString
  const lineRe = /<LineString\b[\s\S]*?<\/LineString\s*>/gi;
  let lm;
  while ((lm = lineRe.exec(text)) !== null) {
    const cb = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(lm[0]);
    if (!cb) continue;
    const tuples = unxml(cb[1]).trim().split(/\s+/).filter(Boolean);
    for (const tp of tuples) {
      const v = tp.split(',').map(Number);
      const [lon, lat, alt] = v;
      if (!validLatLon(lat, lon)) continue;
      // gx:Track 已经有时间序列时，不再重复补充无时间的线
      pts.push(mkPoint(lat, lon, { alt, t: times[tIndex++] ?? null }));
    }
  }

  if (!pts.length) {
    // 兜底：整个文件只有一个 <coordinates>（没有 LineString 包裹的野格式）
    const cb = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(text);
    if (cb) {
      for (const tp of unxml(cb[1]).trim().split(/\s+/).filter(Boolean)) {
        const [lon, lat, alt] = tp.split(',').map(Number);
        if (validLatLon(lat, lon)) pts.push(mkPoint(lat, lon, { alt }));
      }
      if (pts.length) warnings.push('没有 LineString 节点，按裸 coordinates 解析');
    }
  }

  if (!pts.length) warnings.push('没有找到 LineString / gx:Track 坐标');
  const noTime = pts.length && pts.every((p) => p.t == null);
  if (noTime) warnings.push('KML 不含时间序列，无法做时间连续性分析');

  const nameM = /<name>([\s\S]*?)<\/name>/i.exec(text);
  return { points: pts, meta: nameM ? { name: unxml(nameM[1].trim()) } : {}, warnings };
}

/**
 * GeoJSON（RFC 7946）
 * ⚠️ 坐标数组是 [经度, 纬度]，和 GPX 的 lat/lon 属性正好相反。
 */
export function parseGeoJSON(text) {
  const warnings = [];
  const pts = [];
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { points: [], meta: {}, warnings: [`JSON 解析失败：${e.message}`] };
  }

  const takeLine = (coords) => {
    for (const c of coords || []) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const lon = toNum(c[0]);
      const lat = toNum(c[1]);
      if (!validLatLon(lat, lon)) continue;
      pts.push(mkPoint(lat, lon, { alt: toNum(c[2]) }));
    }
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const g = node.geometry || (node.type && node.type !== 'Feature' ? node : null);
    if (g && g.type) {
      if (g.type === 'LineString') takeLine(g.coordinates);
      else if (g.type === 'MultiLineString') (g.coordinates || []).forEach(takeLine);
      else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(walk);
      // Point 是起终点标记，不收
    }
    if (node.features) node.features.forEach(walk);
  };
  walk(obj);

  if (!pts.length) warnings.push('没有找到 LineString 几何（Point 不当作轨迹）');

  const meta = {};
  const props = obj && (obj.properties || (obj.features && obj.features[0] && obj.features[0].properties));
  if (props && props.name) meta.name = String(props.name);
  if (props && props.distance_m != null) meta.declaredDistance = toNum(props.distance_m);
  return { points: pts, meta, warnings };
}

/** 完整 CSV 行解析，支持引号包裹与双引号转义 */
export function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 轨迹 CSV：按表头找列，不认列序。
 * 这样本工具导出的、Excel 另存的、别的软件导出的都能读。
 */
export function parseTrackCSV(text) {
  const warnings = [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { points: [], meta: {}, warnings: ['空文件'] };

  const head = splitCSVLine(lines[0]).map((s) => s.trim().toLowerCase());
  const find = (...names) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iLat = find('lat', 'latitude');
  const iLon = find('lon', 'lng', 'longitude');
  if (iLat < 0 || iLon < 0) {
    return { points: [], meta: {}, warnings: ['CSV 表头里找不到 lat / lon 列'] };
  }
  const iAlt = find('alt_m', 'alt', 'ele', 'elevation', 'altitude');
  const iIso = find('time_iso', 'iso', 'time', 'utc', 'datetime');
  const iMs = find('epoch_ms', 't', 'timestamp_ms');
  const iSpeed = find('speed_kmh', 'speed', 'sog');
  const iCourse = find('course_deg', 'course', 'cog', 'heading');
  const iHdop = find('hdop');
  const iFix = find('fix_quality', 'quality', 'fix');

  let bad = 0;
  const pts = [];
  for (let r = 1; r < lines.length; r++) {
    const f = splitCSVLine(lines[r]);
    const lat = toNum(f[iLat]);
    const lon = toNum(f[iLon]);
    if (!validLatLon(lat, lon)) { bad++; continue; }
    const msCol = iMs >= 0 ? toNum(f[iMs]) : null;
    pts.push(mkPoint(lat, lon, {
      alt: iAlt >= 0 ? toNum(f[iAlt]) : null,
      t: Number.isFinite(msCol) ? msCol : (iIso >= 0 ? parseTimeMs(f[iIso]) : null),
      speed: iSpeed >= 0 ? toNum(f[iSpeed]) : null,
      course: iCourse >= 0 ? toNum(f[iCourse]) : null,
      hdop: iHdop >= 0 ? toNum(f[iHdop]) : null,
      quality: iFix >= 0 ? toNum(f[iFix]) : null,
    }));
  }
  if (bad) warnings.push(`${bad} 行经纬度非法已跳过`);
  if (pts.length && pts.every((p) => p.t == null)) warnings.push('CSV 不含时间列，只做空间检查');
  return { points: pts, meta: {}, warnings };
}

/* ============================================================
   2. 日志解析
   ============================================================ */

const TS_PREFIX = /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+(.*)$/;

/**
 * NMEA 文本日志（含带 ISO 前缀的变体）。
 * 时间戳优先用行首的主机时间；没有的话由 GGA/RMC 的 UTC 字段推。
 */
export function parseLogText(text, name = '') {
  const warnings = [];
  const entries = [];
  const rows = String(text).split(/\r?\n/);
  let tsHit = 0;
  let junk = 0;

  for (const row of rows) {
    const raw = row.replace(/\s+$/, '');
    if (!raw) continue;
    let t = null;
    let line = raw;
    const m = TS_PREFIX.exec(raw);
    if (m) { t = parseTimeMs(m[1]); line = m[2].trim(); tsHit++; }
    if (!line) continue;
    if (line[0] !== '$') { junk++; continue; }
    entries.push({ t, line });
  }

  if (junk) warnings.push(`${junk} 行不是 NMEA 语句，已忽略`);
  if (!entries.length) return { entries: [], meta: {}, warnings: [...warnings, '没有解析到任何 $ 开头的语句'] };

  if (!tsHit) {
    const ok = deriveTimesFromNMEA(entries);
    if (ok) warnings.push('日志本身不带主机时间，已用 GGA / RMC 的 UTC 字段还原');
    else warnings.push('日志既无主机时间也无 UTC 日期，无法做时间连续性分析');
  } else if (tsHit < entries.length) {
    warnings.push(`${entries.length - tsHit} 行没有时间前缀，已沿用上一条的时间`);
  }

  fillForwardTimes(entries);

  return { entries, meta: { name }, warnings };
}

/**
 * 前向补齐缺失时间。
 * NMEA 里 GSV/GSA/TXT/私有帧都不带时间，只能沿用最近一条带时间的语句；
 * 开头那几条没有「上一条」，就取全文件第一个已知时间。
 * 这一步不能省：否则时间轴分析会把它们当成没有时间的数据整条漏掉。
 */
export function fillForwardTimes(entries) {
  let first = null;
  for (const e of entries) if (e.t != null) { first = e.t; break; }
  if (first == null) return 0;

  let last = first;
  let filled = 0;
  for (const e of entries) {
    if (e.t == null) { e.t = last; filled++; } else last = e.t;
  }
  return filled;
}

/**
 * 用 NMEA 自带的 UTC 时间 + RMC 的日期还原绝对时间。
 * 跨零点（时间回跳超过 12 小时）自动进一天。
 */
export function deriveTimesFromNMEA(entries) {
  let date = null;   // {y,m,d}
  let last = null;
  let hits = 0;

  for (const e of entries) {
    const type = lineType(e.line);
    const f = e.line.slice(1).split(/[*]/)[0].split(',');

    if (type.endsWith('RMC') && f[9] && /^\d{6}$/.test(f[9])) {
      const dd = Number(f[9].slice(0, 2));
      const mm = Number(f[9].slice(2, 4));
      let yy = Number(f[9].slice(4, 6));
      yy += yy < 80 ? 2000 : 1900;
      date = { y: yy, m: mm, d: dd };
    }
    if (type.endsWith('ZDA') && f[2] && f[3] && f[4]) {
      date = { y: Number(f[2]), m: Number(f[3]), d: Number(f[4]) };
    }

    const utc = f[1];
    if (!date || !utc || !/^\d{6}(\.\d+)?$/.test(utc)) continue;

    const hh = Number(utc.slice(0, 2));
    const mi = Number(utc.slice(2, 4));
    const ss = Number(utc.slice(4));
    let ms = Date.UTC(date.y, date.m - 1, date.d, hh, mi, Math.floor(ss), Math.round((ss % 1) * 1000));

    if (last != null && ms < last - 43200000) {
      // 跨 UTC 零点：RMC 还没更新日期，手工进一天
      date = { ...date, d: date.d + 1 };
      ms += 86400000;
    }
    e.t = ms;
    last = ms;
    hits++;
  }
  return hits > 0;
}

/** JSONL：一行一个 { t, iso, type, line } */
export function parseJSONL(text) {
  const warnings = [];
  const entries = [];
  let bad = 0;
  for (const row of String(text).split(/\r?\n/)) {
    const s = row.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { bad++; continue; }
    if (!o || typeof o !== 'object') { bad++; continue; }
    const line = typeof o.line === 'string' ? o.line : (o.msg || o.nmea || '');
    const t = Number.isFinite(o.t) ? o.t : parseTimeMs(o.iso || o.time);
    if (!line) { bad++; continue; }
    entries.push({ t, line });
  }
  if (bad) warnings.push(`${bad} 行不是合法 JSON 对象，已跳过`);
  if (!entries.length) warnings.push('没有解析到任何有效记录');
  fillForwardTimes(entries);
  return { entries, meta: {}, warnings };
}

/* ============================================================
   3. 统一入口
   ============================================================ */

/**
 * 解析单个文件。
 * @param {string} name 文件名（用于嗅探与展示）
 * @param {string} text 文件内容
 * @returns {{name, format, kind, points?, entries?, meta, warnings, bytes}}
 */
export function parseFile(name, text) {
  const body = String(text ?? '');
  const format = sniffFormat(name, body);
  const base = { name, format, bytes: body.length, warnings: [], meta: {} };

  const merge = (r) => {
    base.warnings.push(...(r.warnings || []));
    base.meta = r.meta || {};
    return r;
  };

  switch (format) {
    case 'gpx': return { ...base, kind: 'track', ...merge(parseGPX(body)) };
    case 'kml': return { ...base, kind: 'track', ...merge(parseKML(body)) };
    case 'geojson': return { ...base, kind: 'track', ...merge(parseGeoJSON(body)) };
    case 'trackcsv': return { ...base, kind: 'track', ...merge(parseTrackCSV(body)) };
    case 'nmea':
    case 'logtext': return { ...base, kind: 'log', ...merge(parseLogText(body, name)) };
    case 'jsonl': return { ...base, kind: 'log', ...merge(parseJSONL(body)) };
    default:
      return { ...base, kind: 'unknown', warnings: ['无法识别文件格式'] };
  }
}

/**
 * 把轨迹点按时间排序（有时间的排前面，没时间的保持原序追加）。
 * 导出的文件本来就有序，但外部文件未必 —— 乱序会让所有 Δt 变成负数。
 */
export function sortPointsByTime(points) {
  const withT = points.filter((p) => p.t != null);
  const noT = points.filter((p) => p.t == null);
  if (!withT.length) return points.slice();
  const sorted = withT.slice().sort((a, b) => a.t - b.t);
  return [...sorted, ...noT];
}

/** 估算 NMEA 语句里的校验和是否普遍缺失（有些设备不发 *hh） */
export function checksumCoverage(entries) {
  let withSum = 0;
  for (const e of entries) if (e.line && e.line.lastIndexOf('*') > 0) withSum++;
  return entries.length ? withSum / entries.length : 0;
}

export { verify, checksum };
