/**
 * export.js — 轨迹与日志导出格式生成器
 *
 * 纯函数，不碰 DOM，可直接在 node 里单测（selftest.mjs 第十五节）。
 *
 * 轨迹点结构：{ lat, lon, alt, t, speed, course, hdop, quality }
 *   lat/lon 十进制度，WGS84 原始值
 *   alt     海拔米（GGA 第 9 字段，已扣大地水准面差距），不是椭球高
 *   t       Date.now() 毫秒
 *   speed   km/h，course 度，均可能为 null
 *
 * 日志条目结构：{ t, line }，t 为毫秒时间戳，line 是原始语句（不含换行）
 *
 * ⚠️ 坐标基准：导出的是设备原始 WGS84 坐标，**不做 GCJ-02 偏移**。
 *    高德底图需要火星坐标，但 GPX / KML / GeoJSON 的规范都是 WGS84，
 *    若把偏移后的坐标写进去，导入 Google Earth、奥维、QGIS 会整体偏几百米。
 *    本模块只负责"标准格式"，不负责"对齐某家底图"。
 */

const D2R = Math.PI / 180;

/* ============================================================
   通用工具
   ============================================================ */

/** 毫秒 → ISO 8601 UTC，如 2026-11-01T03:22:56.123Z */
export function isoUtc(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

/** XML 文本/属性转义（GPX 与 KML 共用） */
export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CSV 字段转义：含逗号、引号、换行时加引号并把内部引号翻倍 */
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 数值格式化：非有限值输出空串，避免 CSV 里出现 "null" / "NaN" */
function num(v, digits) {
  if (v == null || !Number.isFinite(v)) return '';
  return digits == null ? String(v) : v.toFixed(digits);
}

/** 四舍五入到指定小数位，非有限值返回 null（JSON 用，需要真正的数字） */
function round(v, digits = 7) {
  if (!Number.isFinite(v)) return null;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** 两点大圆距离（米）。用 haversine 而不是平面近似，跨纬度才准。 */
export function haversine(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 从 NMEA 语句提取类型，$GNGGA → 'GNGGA'，$SNRSTAT → 'SNRSTAT' */
export function lineType(line) {
  if (typeof line !== 'string' || line[0] !== '$') return '';
  return line.slice(1).split(/[,*]/)[0] || '';
}

/* ============================================================
   统计
   ============================================================ */

/**
 * 轨迹统计：点数、总里程、起止时间、耗时、最高速度。
 * 空数组不返回 null，全部给零值，调用方不用到处判空。
 */
export function trackStats(pts) {
  const list = Array.isArray(pts) ? pts : [];
  const out = {
    count: list.length,
    distanceM: 0,
    durationS: 0,
    startT: null,
    endT: null,
    maxSpeed: null,
  };
  if (!list.length) return out;

  let dist = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (a && b) dist += haversine(a.lat, a.lon, b.lat, b.lon);
  }
  out.distanceM = dist;

  for (const p of list) {
    if (Number.isFinite(p?.speed) && (out.maxSpeed == null || p.speed > out.maxSpeed)) {
      out.maxSpeed = p.speed;
    }
  }

  out.startT = Number.isFinite(list[0]?.t) ? list[0].t : null;
  const tail = list[list.length - 1];
  out.endT = Number.isFinite(tail?.t) ? tail.t : null;
  if (out.startT != null && out.endT != null) {
    out.durationS = Math.max(0, (out.endT - out.startT) / 1000);
  }
  return out;
}

/** 按"最近 N 分钟"裁剪，minutes 为 0 / null 表示全部 */
export function sliceByTime(list, minutes, nowMs = Date.now()) {
  const arr = Array.isArray(list) ? list : [];
  if (!minutes || minutes <= 0) return arr.slice();
  const cut = nowMs - minutes * 60000;
  return arr.filter((x) => Number.isFinite(x?.t) && x.t >= cut);
}

/** 字节长度（UTF-8），给界面估算文件体积用 */
export function byteLen(s) {
  const str = String(s == null ? '' : s);
  if (str.length === 0) return 0;
  // ASCII 之外才逐码点算，NMEA 与 CSV 全是 ASCII，走快分支
  if (!/[^\x00-\x7f]/.test(str)) return str.length;
  let n = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/* ============================================================
   轨迹：GPX / KML / GeoJSON / CSV
   ============================================================ */

/**
 * GPX 1.1
 * 兼容性最好的一种：Google Earth、奥维地图、QGIS、Strava、GPSBabel 都认。
 * 海拔写 <ele>（单位米），速度与航向放进 <extensions>，不认的软件会忽略。
 */
export function toGPX(pts, meta = {}) {
  const list = Array.isArray(pts) ? pts : [];
  const name = xmlEscape(meta.name || 'GNSS 轨迹');
  const exported = isoUtc(meta.exportedAt ?? Date.now());

  const rows = list.map((p) => {
    const kids = [];
    if (Number.isFinite(p.alt)) kids.push(`<ele>${num(p.alt, 1)}</ele>`);
    if (Number.isFinite(p.t)) kids.push(`<time>${isoUtc(p.t)}</time>`);
    if (Number.isFinite(p.hdop)) kids.push(`<hdop>${num(p.hdop, 2)}</hdop>`);
    const ext = [];
    if (Number.isFinite(p.speed)) ext.push(`<speed>${num(p.speed, 2)}</speed>`);
    if (Number.isFinite(p.course)) ext.push(`<course>${num(p.course, 1)}</course>`);
    if (ext.length) kids.push(`<extensions>${ext.join('')}</extensions>`);

    const open = `      <trkpt lat="${num(p.lat, 7)}" lon="${num(p.lon, 7)}"`;
    if (!kids.length) return `${open}/>`;
    // 每个子元素独立一行：导出的文件用户会拿文本编辑器看，挤成一行没法读
    return `${open}>\n${kids.map((k) => `        ${k}`).join('\n')}\n      </trkpt>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gnss-web-host" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <time>${exported}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${rows}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * KML 2.2
 * Google Earth 原生格式。用标准 LineString 而不是 gx:Track ——
 * gx:Track 能做时间动画，但只有 Google Earth 支持，其他软件打不开。
 * 额外补起点/终点两个 Placemark，导入后一眼能看出方向。
 */
export function toKML(pts, meta = {}) {
  const list = Array.isArray(pts) ? pts : [];
  const name = xmlEscape(meta.name || 'GNSS 轨迹');

  // KML 坐标顺序是 经度,纬度[,高度]，空格或换行分隔；不带高度时不能留尾逗号
  const coordOf = (p) => (Number.isFinite(p.alt)
    ? `${num(p.lon, 7)},${num(p.lat, 7)},${num(p.alt, 1)}`
    : `${num(p.lon, 7)},${num(p.lat, 7)}`);

  const coords = list.map(coordOf).join('\n        ');

  let marks = '';
  if (list.length) {
    marks = `
    <Placemark>
      <name>起点</name>
      <Point><coordinates>${coordOf(list[0])}</coordinates></Point>
    </Placemark>`;
    if (list.length > 1) {
      marks += `
    <Placemark>
      <name>终点</name>
      <Point><coordinates>${coordOf(list[list.length - 1])}</coordinates></Point>
    </Placemark>`;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name}</name>
    <Style id="gnssTrack">
      <LineStyle>
        <color>ffe6a84e</color>
        <width>3</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${name}</name>
      <styleUrl>#gnssTrack</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>
        ${coords}
        </coordinates>
      </LineString>
    </Placemark>${marks}
  </Document>
</kml>
`;
}

/**
 * GeoJSON（RFC 7946）
 * ⚠️ 坐标数组是 [经度, 纬度, 高度]，和 GPX 的 lat/lon 属性顺序相反。
 * 这是 GIS 里最常见的低级错误来源，单测专门盯这一点。
 */
export function toGeoJSON(pts, meta = {}) {
  const list = Array.isArray(pts) ? pts : [];
  const st = trackStats(list);
  const name = meta.name || 'GNSS 轨迹';

  const pos = (p) => (Number.isFinite(p.alt)
    ? [round(p.lon, 7), round(p.lat, 7), round(p.alt, 1)]
    : [round(p.lon, 7), round(p.lat, 7)]);

  const features = [{
    type: 'Feature',
    properties: {
      name,
      points: st.count,
      distance_m: round(st.distanceM, 1) ?? 0,
      start: isoUtc(st.startT) || null,
      end: isoUtc(st.endT) || null,
      duration_s: Math.round(st.durationS),
      source: 'gnss-web-host',
      datum: 'WGS84',
    },
    geometry: { type: 'LineString', coordinates: list.map(pos) },
  }];

  if (st.count) {
    features.push({
      type: 'Feature',
      properties: { name: '起点', role: 'start' },
      geometry: { type: 'Point', coordinates: pos(list[0]) },
    });
    if (st.count > 1) {
      features.push({
        type: 'Feature',
        properties: { name: '终点', role: 'end' },
        geometry: { type: 'Point', coordinates: pos(list[st.count - 1]) },
      });
    }
  }

  return `${JSON.stringify({ type: 'FeatureCollection', features }, null, 2)}\n`;
}

export const TRACK_CSV_HEAD = [
  'index', 'time_iso', 'epoch_ms', 'lat', 'lon',
  'alt_m', 'speed_kmh', 'course_deg', 'hdop', 'fix_quality',
].join(',');

/** 轨迹 CSV：一行一个点，Excel / pandas 直接读 */
export function toTrackCSV(pts) {
  const list = Array.isArray(pts) ? pts : [];
  const rows = list.map((p, i) => [
    i + 1,
    isoUtc(p.t),
    num(p.t, 0),
    num(p.lat, 7),
    num(p.lon, 7),
    num(p.alt, 1),
    num(p.speed, 2),
    num(p.course, 1),
    num(p.hdop, 2),
    num(p.quality, 0),
  ].join(','));
  return `${TRACK_CSV_HEAD}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

/* ============================================================
   日志：NMEA 原文 / 带时间戳文本 / JSONL
   ============================================================ */

/** 纯原始语句流，可直接喂给 UPrecise、RTKLIB、GNSS Viewer 等工具 */
export function toLogNMEA(log, opts = {}) {
  const list = Array.isArray(log) ? log : [];
  const sep = opts.crlf ? '\r\n' : '\n';
  if (!list.length) return '';
  return `${list.map((e) => (typeof e === 'string' ? e : e.line)).join(sep)}${sep}`;
}

/**
 * 带时间戳文本：每行前加 ISO UTC。
 * 原始 NMEA 里只有 GGA/RMC 带 UTC，GSV/GSA 不带；
 * 排查时序问题（比如"这 3 秒为什么没收星"）必须靠主机时间对齐。
 */
export function toLogText(log) {
  const list = Array.isArray(log) ? log : [];
  if (!list.length) return '';
  return `${list.map((e) => `${isoUtc(e?.t)} ${e?.line ?? ''}`).join('\n')}\n`;
}

/** JSONL：一行一个 JSON 对象，便于程序逐行流式处理 */
export function toLogJSONL(log) {
  const list = Array.isArray(log) ? log : [];
  if (!list.length) return '';
  return `${list.map((e) => JSON.stringify({
    t: e?.t ?? null,
    iso: isoUtc(e?.t) || null,
    type: lineType(e?.line),
    line: e?.line ?? '',
  })).join('\n')}\n`;
}

/* ============================================================
   格式清单（界面据此渲染选项，避免 HTML 与逻辑两处维护）
   ============================================================ */

export const TRACK_FORMATS = [
  { id: 'gpx', name: 'GPX', ext: 'gpx', mime: 'application/gpx+xml', build: toGPX,
    note: '通用 GPS 格式，Google Earth / 奥维 / QGIS / Strava 都能导入' },
  { id: 'kml', name: 'KML', ext: 'kml', mime: 'application/vnd.google-earth.kml+xml', build: toKML,
    note: 'Google Earth 原生格式，带起点终点标记' },
  { id: 'geojson', name: 'GeoJSON', ext: 'geojson', mime: 'application/geo+json', build: toGeoJSON,
    note: 'GIS 与前端地图通用，含里程、时长等属性' },
  { id: 'csv', name: 'CSV', ext: 'csv', mime: 'text/csv', build: toTrackCSV,
    note: '一行一个点，Excel / pandas 直接分析' },
];

export const LOG_FORMATS = [
  { id: 'nmea', name: 'NMEA 原文', ext: 'nmea', mime: 'text/plain', build: toLogNMEA,
    note: '纯语句流，可回放给其他 GNSS 软件' },
  { id: 'text', name: '带时间戳文本', ext: 'txt', mime: 'text/plain', build: toLogText,
    note: '每行前加主机时间，排查时序问题用' },
  { id: 'jsonl', name: 'JSONL', ext: 'jsonl', mime: 'application/x-ndjson', build: toLogJSONL,
    note: '一行一个 JSON，便于脚本处理和统计' },
];

export function findFormat(list, id) {
  return list.find((f) => f.id === id) || list[0];
}
