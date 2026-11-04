/**
 * selftest.mjs — 解析器单测（node selftest.mjs）
 * 用合成帧验证：校验和、经纬度、GSA 分系统、GSV 老化、跨系统撞号、私有帧
 */
import { GnssState, checksum, parseCoord, INS_STATUS } from './nmea.js';
import { wgs84ToGcj02, gcj02ToWgs84, outOfChina, haversine } from './map.js';
import {
  SYS_BITS, NMEA_MSGS, sysMaskFrom, maskFromBits, bitsFromMask, toHex, fromHex, cmd,
  nmeaCoord, parseAidinfo, decodeAtype,
} from './controls.js';
import {
  isoUtc, xmlEscape, csvEscape, lineType, trackStats, sliceByTime, byteLen,
  toGPX, toKML, toGeoJSON, toTrackCSV, TRACK_CSV_HEAD,
  toLogNMEA, toLogText, toLogJSONL, TRACK_FORMATS, LOG_FORMATS, findFormat,
  haversine as haveDist,
} from './export.js';
import {
  parseFile, sniffFormat, parseGPX, parseKML, parseGeoJSON, parseTrackCSV,
  deriveTimesFromNMEA, fillForwardTimes,
} from './import.js';
import {
  median, percentile, downsample, analyzeTrack, analyzeLog, correlate,
  diagnose, score, verdict, analyzeAll, TH,
} from './analyze.js';
import { toReportHTML, toReportMD, toIssuesCSV, REPORT_FORMATS, reportFilename } from './report.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}

/** 给语句体补上 $ 与 *hh */
function frame(body) {
  return '$' + body + '*' + checksum(body).toString(16).toUpperCase().padStart(2, '0');
}
/** 造 GSA：12 个卫星槽位 + PDOP/HDOP/VDOP + 系统 ID */
function gsa(mode, fix, sats, sysId, dop = [1.8, 1.2, 1.3]) {
  const slots = [...sats, ...Array(12 - sats.length).fill('')].join(',');
  return frame(`GNGSA,${mode},${fix},${slots},${dop.join(',')},${sysId}`);
}
function gsv(talker, total, idx, inView, sats) {
  const body = sats.map(s => `${s.prn},${s.el ?? ''},${s.az ?? ''},${s.snr ?? ''}`).join(',');
  return frame(`${talker}GSV,${total},${idx},${String(inView).padStart(2, '0')}${body ? ',' + body : ''}`);
}

console.log('一、基础解析');
ok('校验和计算 GGA', checksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,') === 0x47,
   '得到 ' + checksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,').toString(16));
ok('ddmm.mmmm 北纬', Math.abs(parseCoord('3410.0000', 'N') - 34.1666667) < 1e-5);
ok('ddmm.mmmm 西经取负', parseCoord('10853.0000', 'W') < 0);
ok('空值返回 null', parseCoord('', 'N') === null);

console.log('\n二、GGA / RMC 状态汇总');
{
  const st = new GnssState();
  st.ingest(frame('GNGGA,093045.00,3409.8412,N,10853.1800,E,1,24,1.29,473.8,M,-8.1,M,,'));
  st.ingest(frame('GNRMC,093045.00,A,3409.8412,N,10853.1800,E,0.42,187.3,011126,,,A'));
  ok('GGA 纬度', Math.abs(st.lat - 34.16402) < 1e-4, st.lat);
  ok('GGA 经度', Math.abs(st.lon - 108.8863) < 1e-4, st.lon);
  ok('海拔 473.8', st.alt === 473.8);
  ok('定位质量 1', st.fixQuality === 1);
  ok('参与解算 24', st.satsUsed === 24, st.satsUsed);
  ok('HDOP 1.29', st.hdop === 1.29);
  ok('RMC 换算节→km/h', Math.abs(st.speedKmh - 0.42 * 1.852) < 1e-9, st.speedKmh);
  ok('航向 187.3', st.course === 187.3);
  ok('写入轨迹', st.track.length === 1);
}

console.log('\n三、GSA 按系统 ID 分星座标记（NMEA 4.11）');
{
  const st = new GnssState();
  // 先建星座
  st.ingest(gsv('GP', 1, 1, 3, [
    { prn: 18, el: 10, az: 179, snr: 50 },
    { prn: 28, el: 33, az: 223, snr: 40 },
    { prn: 31, el: 4, az: 221, snr: 35 }]));
  st.ingest(gsv('GB', 1, 1, 2, [
    { prn: 37, el: 21, az: 190, snr: 42 },
    { prn: 27, el: 8, az: 208, snr: 36 }]));
  st.ingest(gsv('GQ', 1, 1, 2, [
    { prn: 3, el: 25, az: 160, snr: 51 },
    { prn: 2, el: 12, az: 133, snr: 47 }]));
  // 三条 GSA，各自带系统 ID
  st.ingest(gsa('A', 3, ['18', '28', '31'], 1));
  st.ingest(gsa('A', 3, ['37', '27'], 4));
  st.ingest(gsa('A', 3, ['03', '02'], 5));

  const usedOf = (sys) => [...st.sats.values()].filter(s => s.sys === sys && s.used).length;
  ok('GPS 参与解算 3 颗', usedOf('GP') === 3, usedOf('GP'));
  ok('北斗参与解算 2 颗', usedOf('GB') === 2, usedOf('GB'));
  ok('QZSS 参与解算 2 颗', usedOf('GQ') === 2, usedOf('GQ'));
  ok('3D 定位', st.fix === 3);
  ok('VDOP 1.3', st.vdop === 1.3);
}

console.log('\n四、跨系统 PRN 撞号不互相覆盖');
{
  const st = new GnssState();
  st.ingest(gsv('GP', 1, 1, 1, [{ prn: 3, el: 30, az: 100, snr: 44 }]));
  st.ingest(gsv('GQ', 1, 1, 1, [{ prn: 3, el: 60, az: 200, snr: 38 }]));
  ok('GP03 存在', st.sats.has('GP03'));
  ok('GQ03 存在', st.sats.has('GQ03'));
  ok('两者仰角不同', st.sats.get('GP03').el !== st.sats.get('GQ03').el);
  ok('总数 2 颗', st.sats.size === 2, st.sats.size);
}

console.log('\n五、GSV 整轮替换与落山清理');
{
  const st = new GnssState();
  st.ingest(gsv('GP', 1, 1, 3, [
    { prn: 1, el: 10, az: 10, snr: 40 },
    { prn: 2, el: 20, az: 20, snr: 41 },
    { prn: 3, el: 30, az: 30, snr: 42 }]));
  ok('首轮 3 颗', st.sats.size === 3, st.sats.size);
  st.ingest(gsv('GP', 1, 1, 2, [
    { prn: 1, el: 11, az: 11, snr: 45 },
    { prn: 5, el: 40, az: 100, snr: 46 }]));
  ok('次轮替换为 2 颗', st.sats.size === 2, st.sats.size);
  ok('旧星 2/3 已清除', !st.sats.has('GP02') && !st.sats.has('GP03'));
  ok('新星 5 已加入', st.sats.has('GP05'));
  ok('SNR 已更新', st.sats.get('GP01').snr === 45);

  st.ingest(gsv('GP', 1, 1, 0, []));
  ok('0 颗可见时清空', st.sats.size === 0, st.sats.size);
}

console.log('\n六、GSV 多分片合并');
{
  const st = new GnssState();
  st.ingest(gsv('GB', 2, 1, 5, [
    { prn: 1, el: 10, az: 10, snr: 40 }, { prn: 2, el: 20, az: 20, snr: 41 },
    { prn: 3, el: 30, az: 30, snr: 42 }, { prn: 4, el: 40, az: 40, snr: 43 }]));
  ok('分片未收齐时不生效', st.sats.size === 0, st.sats.size);
  st.ingest(gsv('GB', 2, 2, 5, [{ prn: 5, el: 50, az: 50, snr: 44 }]));
  ok('收齐后 5 颗', st.sats.size === 5, st.sats.size);
}

console.log('\n七、Unicore 私有帧');
{
  const st = new GnssState();
  st.ingest(frame('SNRSTAT,1,1,0,2'));
  ok('insstatus 解析为 1', st.unicore.insstatus === 1, st.unicore.insstatus);
  ok('odostatus 解析为 1', st.unicore.odostatus === 1);
  ok('惯导状态文案', INS_STATUS[1] === '初始化开始');
  st.ingest(frame('ODODATA,120,0.5,1.2'));
  ok('ODODATA 已记录', Array.isArray(st.unicore.ODODATA) && st.unicore.ODODATA.length === 3);
}

console.log('\n八、异常输入健壮性');
{
  const st = new GnssState();
  ok('空行不报错', st.ingest('') === null);
  ok('非 $ 开头丢弃', st.ingest('garbage data') === null);
  ok('错误校验和被计数', (st.ingest('$GPGGA,1,2*FF'), st.badChecksum) === 1, st.badChecksum);
  st.ingest(frame('GNGGA,093045.00,,,,,0,00,99.99,,,,,,'));
  ok('0 星 0 质量时不写轨迹', st.track.length === 0, st.track.length);
  ok('无定位时经纬度为 null', st.lat === null);
}

console.log('\n九、统计与快照');
{
  const st = new GnssState();
  st.ingest(gsv('GP', 1, 1, 2, [{ prn: 1, el: 10, az: 10, snr: 40 }, { prn: 2, el: 20, az: 20, snr: 30 }]));
  st.ingest(gsv('GB', 1, 1, 1, [{ prn: 7, el: 30, az: 30, snr: 50 }]));
  st.ingest(gsa('A', 3, ['01'], 1));
  const by = st.bySystem();
  ok('GPS 可见 2', by.get('GP').visible === 2);
  ok('北斗可见 1', by.get('GB').visible === 1);
  ok('GPS 参与 1', by.get('GP').used === 1);
  const snap = st.snapshot();
  ok('快照含 3 颗卫星', snap.satellites.length === 3, snap.satellites.length);
  ok('satList 按系统排序', snap.satellites[0].sys === 'GP');
  ok('消息计数已统计', st.msgCount.get('GPGSV') === 1);
}

console.log('\n十、坐标转换（WGS84 → GCJ-02）');
{
  // 天安门附近：WGS84 → GCJ-02 应偏移约 +0.0014° 纬、+0.0063° 经
  const wLat = 39.908692, wLon = 116.397477;
  const [gLat, gLon] = wgs84ToGcj02(wLat, wLon);
  ok('北纬偏移在合理区间', gLat - wLat > 0.0004 && gLat - wLat < 0.004, (gLat - wLat).toFixed(6));
  ok('东经偏移在合理区间', gLon - wLon > 0.002 && gLon - wLon < 0.012, (gLon - wLon).toFixed(6));

  // 反解回到原文（迭代 6 次，误差应 < 1e-6 度 ≈ 0.1 m）
  const [rLat, rLon] = gcj02ToWgs84(gLat, gLon);
  ok('反解回 WGS84 纬度', Math.abs(rLat - wLat) < 1e-6, Math.abs(rLat - wLat));
  ok('反解回 WGS84 经度', Math.abs(rLon - wLon) < 1e-6, Math.abs(rLon - wLon));

  // 境外不偏移（东京、苏黎世）
  ok('东京判定为境外', outOfChina(35.68, 139.76));
  const [tLat, tLon] = wgs84ToGcj02(35.68, 139.76);
  ok('境外坐标原样返回', tLat === 35.68 && tLon === 139.76);
  const [zLat] = wgs84ToGcj02(47.37, 8.54);
  ok('苏黎世不偏移', zLat === 47.37);
  ok('西安判定为境内', !outOfChina(34.164, 108.886));

  // 空值不炸
  const [nLat, nLon] = wgs84ToGcj02(null, null);
  ok('空值返回空值', nLat === null && nLon === null);

  // haversine 标定：纬度差 1 度 ≈ 111.2 km
  const d = haversine(34.0, 108.0, 35.0, 108.0);
  ok('haversine 1° 纬度 ≈ 111 km', d > 110000 && d < 112000, Math.round(d));
}

console.log('\n十一、CFGSYS 位掩码');
{
  const defaults = SYS_BITS.filter((s) => s.on).map((s) => s.key);
  const mask = sysMaskFrom(defaults);
  ok('默认双频掩码 = h55155', toHex(mask) === 'h55155', toHex(mask));
  ok('默认掩码十进制 348501', mask === 348501, mask);
  ok('默认含 9 个频点', bitsFromMask(mask).length === 9, bitsFromMask(mask).length);

  ok('仅 GPS 双频 = h5', toHex(sysMaskFrom(['gpsL1', 'gpsL5'])) === 'h5', toHex(sysMaskFrom(['gpsL1', 'gpsL5'])));
  ok('单 GPS L1 = h1', toHex(sysMaskFrom(['gpsL1'])) === 'h1');
  ok('单 BDS B1I = h10', toHex(sysMaskFrom(['bdsB1I'])) === 'h10');
  ok('加 SBAS = bit20', toHex(sysMaskFrom(['gpsL1', 'sbas'])) === 'h100001');
  ok('NavIC bit24', toHex(sysMaskFrom(['navicL5'])) === 'h1000000');
  ok('空选 = h0', toHex(sysMaskFrom([])) === 'h0');

  // 往返一致
  const round = bitsFromMask(mask).reduce((a, b) => a + 2 ** b, 0);
  ok('掩码往返一致', round === mask);

  ok('hex 解析 h55155', fromHex('h55155') === 348501);
  ok('hex 解析大小写', fromHex('H1f') === 31);
  ok('CFGSAVE h1F = 31', maskFromBits([0, 1, 2, 3, 4]) === 31);
}

console.log('\n十二、命令组装');
{
  const c1 = cmd('CFGSAVE,h1F');
  ok('命令以 $ 开头', c1.startsWith('$CFGSAVE,h1F*'));
  const body = c1.slice(1, c1.lastIndexOf('*'));
  const sum = c1.slice(c1.lastIndexOf('*') + 1);
  ok('校验和正确', checksum(body).toString(16).toUpperCase().padStart(2, '0') === sum, sum);

  // 每条 NMEA 语句开关命令都要能组出来且校验和自洽
  let allOk = true;
  for (const m of NMEA_MSGS) {
    for (const rate of [0, 1]) {
      const c = cmd(`CFGMSG,0,${m.id},${rate}`);
      const b = c.slice(1, c.lastIndexOf('*'));
      const s = c.slice(c.lastIndexOf('*') + 1);
      if (checksum(b).toString(16).toUpperCase().padStart(2, '0') !== s) allOk = false;
    }
  }
  ok('8 条 NMEA 开关命令校验和全部正确', allOk);

  ok('CFGROTAT 自动模式', cmd('CFGROTAT,0,0,0,2') === '$CFGROTAT,0,0,0,2*' + checksum('CFGROTAT,0,0,0,2').toString(16).toUpperCase().padStart(2, '0'));
  ok('CFGTP 六参数', cmd('CFGTP,1000000,500000,1,0,0,0').startsWith('$CFGTP,1000000,500000,1,0,0,0*'));
}

/* ============================================================
   十三、辅助定位（AGPS）
   ============================================================ */
console.log('\n十三、辅助定位 AGPS');
{
  // 十进制度 → NMEA 度分，格式必须和协议例子逐字一致
  ok('纬度 40.037165 → 4002.229900', nmeaCoord(40.037165, 2) === '4002.229900', nmeaCoord(40.037165, 2));
  ok('经度 116.301614 → 11618.096840', nmeaCoord(116.301614, 3) === '11618.096840', nmeaCoord(116.301614, 3));
  ok('整数纬度补零 34 → 3400.000000', nmeaCoord(34, 2) === '3400.000000', nmeaCoord(34, 2));
  ok('南纬取绝对值  -33.5 → 3330.000000', nmeaCoord(-33.5, 2) === '3330.000000');

  // AIDINFO 位图解析：每个字段是十六进制位图，1 的个数 = 收到/可用的卫星数
  // 003FFFFFF7 = 3(2位) + FFFFFF(24位) + 7(3位) = 29 颗
  const info = parseAidinfo(['003FFFFFF7', 'FF', '1F0', '3', '', '', 'C0000000', '', '7']);
  ok('GPS 收到星历 29 颗', info.gps.rs === 29, String(info.gps.rs));
  ok('GPS 可用星历 8 颗', info.gps.us === 8, String(info.gps.us));
  ok('BDS 收到星历 5 颗', info.bds.rs === 5, String(info.bds.rs));
  ok('BDS 可用星历 2 颗', info.bds.us === 2, String(info.bds.us));
  ok('空字段不炸、按 0 处理', info.gal.rs === 0 && info.gal.us === 0);
  ok('GLONASS 位图 2 颗', info.glo.rs === 2, String(info.glo.rs));
  ok('Atype 解析为 7', info.atype === 7);

  // Atype 位解码
  const flags = decodeAtype(7);
  ok('Atype=7 → GPS/BDS/GAL 星历辅助', flags.length === 3 && flags[0].includes('GPS'), flags.join('|'));
  ok('Atype 位置辅助位 bit4/bit5', decodeAtype(0x30).length === 2);
  ok('Atype 时间辅助位 bit8/bit9', decodeAtype(0x300).length === 2);
  ok('Atype=0 无辅助', decodeAtype(0).length === 0);

  // 参数不足时返回 null，避免把残缺应答画成 0 颗
  ok('字段不足返回 null', parseAidinfo(['1', '2']) === null);

  // AIDPOS 组包：符号位和度分格式都要对
  const lat = 34.1640755, lon = 108.8865508;
  const body = `AIDPOS,${nmeaCoord(lat, 2)},${lat >= 0 ? 'N' : 'S'},${nmeaCoord(lon, 3)},${lon >= 0 ? 'E' : 'W'},473.800`;
  ok('AIDPOS 组包格式', body === 'AIDPOS,3409.844530,N,10853.193048,E,473.800', body);
  ok('AIDPOS 校验和自洽', (() => {
    const c = cmd(body);
    const b = c.slice(1, c.lastIndexOf('*'));
    return checksum(b).toString(16).toUpperCase().padStart(2, '0') === c.slice(c.lastIndexOf('*') + 1);
  })());
  // AIDTIME 用 UTC，字段顺序 year,month,day,hour,minute,second,millisecond
  ok('AIDTIME 七字段', cmd('AIDTIME,2026,11,1,2,21,24,120').startsWith('$AIDTIME,2026,11,1,2,21,24,120*'));
}

/* ============================================================
   十四、SBAS 从 GPGSV 中拆出（和芯星通私有编号 33~51）
   ============================================================ */
console.log('\n十四、SBAS 星座拆分');
{
  const st = new GnssState();
  // 和芯星通把 SBAS 卫星混在 $GPGSV 里，编号 33~51（不是 NMEA 标准的 120~158）
  st.ingest(gsv('GP', 1, 1, 3, [
    { prn: 10, el: 63, az: 165, snr: 41 },   // GPS
    { prn: 33, el: 35, az: 210, snr: 44 },   // SBAS 下界
    { prn: 51, el: 28, az: 150, snr: 39 },   // SBAS 上界
  ]));
  const list = st.satList();
  ok('SBAS 单独成组', list.filter((s) => s.sys === 'SB').length === 2,
     `SB 组 ${list.filter((s) => s.sys === 'SB').length} 颗`);
  ok('33 号归 SBAS', list.some((s) => s.sys === 'SB' && s.prn === '33'));
  ok('51 号归 SBAS', list.some((s) => s.sys === 'SB' && s.prn === '51'));
  ok('GPS 未被并吞', list.filter((s) => s.sys === 'GP').length === 1);
  ok('GPS 组里不残留 33 号', !list.some((s) => s.sys === 'GP' && s.prn === '33'));

  // 边界检查：32 属 GPS，52 越界不能被划进 SBAS
  const st2 = new GnssState();
  st2.ingest(gsv('GP', 1, 1, 2, [
    { prn: 32, el: 63, az: 2, snr: 40 },
    { prn: 52, el: 20, az: 100, snr: 30 },
  ]));
  ok('32 号仍是 GPS', st2.satList().some((s) => s.sys === 'GP' && s.prn === '32'));
  ok('52 号不划入 SBAS', !st2.satList().some((s) => s.sys === 'SB'));

  // 落山清理：下一轮 GPGSV 若不含 SBAS，旧条目必须消失
  st.ingest(gsv('GP', 1, 1, 1, [{ prn: 10, el: 63, az: 165, snr: 41 }]));
  ok('SBAS 落山后自动清除', st.satList().filter((s) => s.sys === 'SB').length === 0);

  // 北斗的 GBGSV 里 33~51 是真北斗星，绝不能被误判成 SBAS
  const st3 = new GnssState();
  st3.ingest(gsv('GB', 1, 1, 2, [
    { prn: 37, el: 53, az: 210, snr: 44 },
    { prn: 41, el: 27, az: 130, snr: 39 },
  ]));
  ok('北斗 37/41 不被误判为 SBAS', st3.satList().filter((s) => s.sys === 'SB').length === 0);
  ok('北斗 37/41 保持 BDS', st3.satList().filter((s) => s.sys === 'GB').length === 2);
}

/* ============================================================
   十五、导出格式（GPX / KML / GeoJSON / CSV / 日志三态）
   ============================================================ */
console.log('\n十五、导出格式');

const T0 = Date.UTC(2026, 10, 1, 3, 22, 56);   // 2026-11-01T03:22:56Z
const T1 = T0 + 10000;

const PTS = [
  { lat: 34.1640755, lon: 108.8865508, alt: 473.8, t: T0, speed: 12.5, course: 87.3, hdop: 1.29, quality: 1 },
  { lat: 34.1650755, lon: 108.8865508, alt: 474.2, t: T1, speed: 20.0, course: 88.0, hdop: 1.10, quality: 1 },
];

{
  /* ---- 通用工具 ---- */
  ok('isoUtc 输出标准格式', isoUtc(T0) === '2026-11-01T03:22:56.000Z', isoUtc(T0));
  ok('isoUtc 非法值给空串', isoUtc(null) === '' && isoUtc(NaN) === '');

  ok('xmlEscape 转义五个字符',
    xmlEscape('a&b<c>d"e\'f') === 'a&amp;b&lt;c&gt;d&quot;e&apos;f',
    xmlEscape('a&b<c>d"e\'f'));

  ok('csvEscape 普通值不加引号', csvEscape('abc') === 'abc');
  ok('csvEscape 含逗号加引号', csvEscape('a,b') === '"a,b"');
  ok('csvEscape 引号翻倍', csvEscape('a"b') === '"a""b"');
  ok('csvEscape null 给空串', csvEscape(null) === '');

  ok('lineType 取校验和前类型', lineType('$GNGSA,A,3*4F') === 'GNGSA', lineType('$GNGSA,A,3*4F'));
  ok('lineType 无逗号也取得到', lineType('$SNRSTAT*1A') === 'SNRSTAT');
  ok('lineType 非 $ 开头返回空', lineType('hello') === '');

  ok('byteLen ASCII 逐字节', byteLen('abc') === 3);
  ok('byteLen 中文按 3 字节', byteLen('中') === 3, String(byteLen('中')));

  /* ---- 几何统计 ---- */
  const d = haveDist(34.164, 108.886, 34.165, 108.886);
  ok('纬度 0.001° 约 111 米', Math.abs(d - 111.19) < 0.6, d.toFixed(2));

  const st = trackStats(PTS);
  ok('统计点数', st.count === 2);
  ok('统计里程', Math.abs(st.distanceM - 111.19) < 0.6, st.distanceM.toFixed(2));
  ok('统计时长 10 秒', st.durationS === 10, String(st.durationS));
  ok('统计最高速度', st.maxSpeed === 20, String(st.maxSpeed));
  const stEmpty = trackStats([]);
  ok('空轨迹统计全零且不抛异常',
    stEmpty.count === 0 && stEmpty.distanceM === 0 && stEmpty.startT === null);

  ok('sliceByTime 0 返回全部', sliceByTime(PTS, 0, T1 + 300).length === 2);
  ok('sliceByTime 只留最近 0.3 秒', sliceByTime(PTS, 0.005, T1 + 300).length === 1,
    String(sliceByTime(PTS, 0.005, T1 + 300).length));

  /* ---- GPX ---- */
  const gpx = toGPX(PTS, { name: 'A&B<测试>', exportedAt: T0 });
  ok('GPX 根元素与命名空间', gpx.includes('<gpx version="1.1"') && gpx.includes('topografix.com/GPX/1/1'));
  ok('GPX 名称做了 XML 转义', gpx.includes('A&amp;B&lt;测试&gt;'));
  ok('GPX trkpt 带 lat/lon 属性',
    /<trkpt lat="34\.1640755" lon="108\.8865508">/.test(gpx), gpx.match(/<trkpt[^>]*>/)?.[0]);
  ok('GPX 含 ele 与 hdop', gpx.includes('<ele>473.8</ele>') && gpx.includes('<hdop>1.29</hdop>'));
  ok('GPX 时间符合 ISO 8601',
    /<time>2026-11-01T03:22:56\.000Z<\/time>/.test(gpx));
  ok('GPX 速度航向进 extensions',
    gpx.includes('<extensions><speed>12.50</speed><course>87.3</course></extensions>'));
  ok('GPX 空轨迹仍是完整文档',
    toGPX([]).includes('</gpx>') && toGPX([]).includes('<trkseg>'));

  /* ---- KML ---- */
  const kml = toKML(PTS);
  ok('KML 根元素', kml.includes('<kml xmlns="http://www.opengis.net/kml/2.2">'));
  ok('KML 坐标是 经度,纬度,高度',
    kml.includes('108.8865508,34.1640755,473.8'), '坐标顺序可能反了');
  ok('KML 含起点终点共 3 个 Placemark',
    (kml.match(/<Placemark>/g) || []).length === 3,
    String((kml.match(/<Placemark>/g) || []).length));
  const kmlNoAlt = toKML([{ lat: 34, lon: 108 }]);
  ok('KML 无海拔时不带尾逗号',
    kmlNoAlt.includes('108.0000000,34.0000000') && !kmlNoAlt.includes('108.0000000,34.0000000,'));
  ok('KML 空轨迹不抛异常', toKML([]).includes('</kml>'));

  /* ---- GeoJSON ---- */
  const gj = JSON.parse(toGeoJSON(PTS));
  ok('GeoJSON 是 FeatureCollection', gj.type === 'FeatureCollection');
  const c0 = gj.features[0].geometry.coordinates[0];
  ok('GeoJSON 坐标顺序 [经度,纬度,高度]',
    c0[0] === 108.8865508 && c0[1] === 34.1640755 && c0[2] === 473.8,
    JSON.stringify(c0));
  ok('GeoJSON 起点终点各一个 Feature', gj.features.length === 3, String(gj.features.length));
  ok('GeoJSON 带里程与时长属性',
    Math.abs(gj.features[0].properties.distance_m - 111.2) < 0.6
    && gj.features[0].properties.duration_s === 10);
  ok('GeoJSON 标注了 WGS84 基准', gj.features[0].properties.datum === 'WGS84');
  ok('GeoJSON 空轨迹仍可解析', JSON.parse(toGeoJSON([])).features.length === 1);

  /* ---- 轨迹 CSV ---- */
  const csv = toTrackCSV(PTS);
  const rows = csv.trim().split('\n');
  ok('CSV 表头与常量一致', rows[0] === TRACK_CSV_HEAD);
  ok('CSV 行数 = 点数 + 表头', rows.length === 3, String(rows.length));
  ok('CSV 首列是序号，第二列是 ISO 时间',
    /^1,2026-11-01T03:22:56\.000Z,/.test(rows[1]), rows[1]);
  ok('CSV 空轨迹只有表头', toTrackCSV([]).trim().split('\n').length === 1);

  /* ---- 日志三态 ---- */
  const LOG = [
    { t: T0, line: '$GNGGA,032256.00,3409.84453,N,10853.19305,E,1,30,1.12,473.8,M,-8.1,M,,*4F' },
    { t: T1, line: '$SNRSTAT,1,1,0,2*1A' },
  ];
  ok('NMEA 原样逐行拼接', toLogNMEA(LOG) === `${LOG[0].line}\n${LOG[1].line}\n`);
  ok('NMEA 可选 CRLF', toLogNMEA(LOG, { crlf: true }).includes('\r\n'));
  ok('文本格式每行加 ISO 时间',
    toLogText(LOG).startsWith('2026-11-01T03:22:56.000Z $GNGGA'), toLogText(LOG).slice(0, 40));
  const jl = toLogJSONL(LOG).trim().split('\n').map((l) => JSON.parse(l));
  ok('JSONL 每行独立可解析', jl.length === 2);
  ok('JSONL type 字段正确', jl[0].type === 'GNGGA' && jl[1].type === 'SNRSTAT');
  ok('JSONL 保留毫秒时间戳', jl[0].t === T0 && jl[0].iso === '2026-11-01T03:22:56.000Z');
  ok('空日志三种格式都返回空串',
    toLogNMEA([]) === '' && toLogText([]) === '' && toLogJSONL([]) === '');

  /* ---- 格式注册表 ---- */
  ok('轨迹格式共 4 种', TRACK_FORMATS.length === 4, String(TRACK_FORMATS.length));
  ok('日志格式共 3 种', LOG_FORMATS.length === 3, String(LOG_FORMATS.length));
  ok('findFormat 按 id 命中', findFormat(TRACK_FORMATS, 'kml').ext === 'kml');
  ok('findFormat 未知 id 回退第一项', findFormat(TRACK_FORMATS, '不存在').id === 'gpx');
  ok('每个格式都有扩展名与 MIME', [...TRACK_FORMATS, ...LOG_FORMATS]
    .every((f) => f.ext && f.mime && f.note));

  // 空数据不得让任何一种格式崩掉 —— 导出面板在没定位时也会调 build
  let threw = [];
  for (const f of [...TRACK_FORMATS, ...LOG_FORMATS]) {
    try { f.build([], {}); } catch (e) { threw.push(f.id); }
  }
  ok('七种格式空数据均不抛异常', threw.length === 0, threw.join(','));
}

/* ============================================================
   十六、导出 → 读回：闭环
   ------------------------------------------------------------
   上位机导出的东西必须能被自己读回来。这节不测「格式对不对」，
   测的是「导出去再读进来，数据还在不在」。
   ============================================================ */
const TB = Date.UTC(2026, 10, 1, 1, 30, 0);

function pt(lat, lon, t, extra = {}) {
  return {
    lat, lon,
    alt: extra.alt ?? 400,
    t,
    speed: extra.speed ?? null,
    course: extra.course ?? null,
    hdop: extra.hdop ?? 1.2,
    quality: extra.quality ?? 1,
  };
}

function entry(t, line) { return { t, line }; }

/** 造一条 GGA，只关心 quality / sats / hdop */
function ggaLine(q, latStr, lonStr, sats = 12, hdop = 1.1) {
  return frame(`GNGGA,000000.00,${latStr},N,${lonStr},E,${q},${String(sats).padStart(2, '0')},${hdop},400.0,M,-8.1,M,,`);
}

console.log('\n十六、导出 → 读回闭环');
{
  const pts = [
    pt(34.1640, 108.8860, TB),
    pt(34.1645, 108.8868, TB + 1000, { alt: 401.5, speed: 42.3, course: 91.2, hdop: 1.33 }),
    pt(34.1651, 108.8879, TB + 2000, { alt: 402, speed: 40.1, course: 88.7 }),
  ];

  /* ---- 轨迹四种格式 ---- */
  const gpxBack = parseFile('t.gpx', toGPX(pts));
  ok('GPX 读回：格式识别', gpxBack.format === 'gpx' && gpxBack.kind === 'track');
  ok('GPX 读回：点数一致', gpxBack.points.length === 3, String(gpxBack.points.length));
  ok('GPX 读回：经纬度误差 < 1e-6', Math.abs(gpxBack.points[1].lat - pts[1].lat) < 1e-6
    && Math.abs(gpxBack.points[1].lon - pts[1].lon) < 1e-6);
  ok('GPX 读回：时间精确到毫秒', gpxBack.points[1].t === TB + 1000, String(gpxBack.points[1].t));
  ok('GPX 读回：海拔', Math.abs(gpxBack.points[1].alt - 401.5) < 0.05, String(gpxBack.points[1].alt));
  ok('GPX 读回：扩展里的速度与航向', Math.abs(gpxBack.points[1].speed - 42.3) < 0.01
    && Math.abs(gpxBack.points[1].course - 91.2) < 0.01);
  ok('GPX 读回：HDOP', Math.abs(gpxBack.points[1].hdop - 1.33) < 0.005);

  const kmlBack = parseFile('t.kml', toKML(pts));
  ok('KML 读回：格式识别', kmlBack.format === 'kml');
  ok('KML 读回：点数一致', kmlBack.points.length === 3, String(kmlBack.points.length));
  ok('KML 读回：经纬度没写反', Math.abs(kmlBack.points[0].lat - 34.1640) < 1e-6
    && Math.abs(kmlBack.points[0].lon - 108.8860) < 1e-6,
    `${kmlBack.points[0].lat},${kmlBack.points[0].lon}`);
  ok('KML 读回：Point 标记不混进轨迹', kmlBack.points.length === 3);
  ok('KML 无时间序列会给出提示', kmlBack.warnings.some((w) => /时间/.test(w)));

  const geoBack = parseFile('t.geojson', toGeoJSON(pts));
  ok('GeoJSON 读回：格式识别', geoBack.format === 'geojson');
  ok('GeoJSON 读回：只取 LineString', geoBack.points.length === 3, String(geoBack.points.length));
  ok('GeoJSON 读回：坐标顺序 [lon,lat]', Math.abs(geoBack.points[0].lat - 34.1640) < 1e-6
    && Math.abs(geoBack.points[0].lon - 108.8860) < 1e-6);

  const csvBack = parseFile('t.csv', toTrackCSV(pts));
  ok('CSV 读回：格式识别', csvBack.format === 'trackcsv');
  ok('CSV 读回：点数一致', csvBack.points.length === 3);
  ok('CSV 读回：时间从 epoch_ms 还原', csvBack.points[1].t === TB + 1000, String(csvBack.points[1].t));
  ok('CSV 读回：速度列', Math.abs(csvBack.points[1].speed - 42.3) < 0.01);

  /* ---- 日志三种格式 ---- */
  const logArr = [
    entry(TB, ggaLine(1, '3409.84000', '10853.16000')),
    entry(TB + 500, frame('GNRMC,013000.50,A,3409.84000,N,10853.16000,E,0.5,90.0,011126,,,A')),
    entry(TB + 1000, ggaLine(1, '3409.84010', '10853.16010')),
  ];

  const nmeaBack = parseFile('l.nmea', toLogNMEA(logArr));
  ok('NMEA 读回：条数一致', nmeaBack.entries.length === 3, String(nmeaBack.entries.length));
  ok('NMEA 读回：RMC 的日期 + UTC 还原出绝对时间', nmeaBack.entries[1].t === TB + 500,
    String(nmeaBack.entries[1].t));

  const txtBack = parseFile('l.txt', toLogText(logArr));
  ok('带时间戳文本读回：条数一致', txtBack.entries.length === 3);
  ok('带时间戳文本读回：时间精确', txtBack.entries[1].t === TB + 500, String(txtBack.entries[1].t));
  ok('带时间戳文本读回：语句体不含时间前缀',
    txtBack.entries[1].line.startsWith('$GNRMC'));

  const jsonlBack = parseFile('l.jsonl', toLogJSONL(logArr));
  ok('JSONL 读回：条数一致', jsonlBack.entries.length === 3);
  ok('JSONL 读回：毫秒时间', jsonlBack.entries[2].t === TB + 1000);
  ok('JSONL 读回：语句原样', jsonlBack.entries[2].line === logArr[2].line);
}

/* ============================================================
   十七、格式嗅探与容错
   ============================================================ */
console.log('\n十七、格式嗅探与容错');
{
  ok('嗅探 GPX', sniffFormat('a.xml', '<?xml version="1.0"?><gpx version="1.1"></gpx>') === 'gpx');
  ok('嗅探 KML', sniffFormat('a.txt', '<?xml version="1.0"?><kml xmlns="x"></kml>') === 'kml');
  ok('嗅探 GeoJSON', sniffFormat('a.txt', '{"type":"FeatureCollection","features":[]}') === 'geojson');
  ok('嗅探 JSONL', sniffFormat('a.txt', '{"t":1,"line":"$GNGGA"}\n{"t":2,"line":"$GNGGA"}') === 'jsonl');
  ok('嗅探 NMEA', sniffFormat('a.txt',
    '$GNGGA,1,,,,,1,08,1.0,0,M,0,M,,\n$GNRMC,1,A,,,,,,,,\n') === 'nmea');
  ok('嗅探带时间戳日志', sniffFormat('a.txt',
    '2026-11-01T01:30:00Z $GNGGA,1,,,,,1,08,1.0,0,M,0,M,,\n'
    + '2026-11-01T01:30:01Z $GNRMC,1,A,,,,,,,,\n') === 'logtext');
  ok('嗅探轨迹 CSV', sniffFormat('a.txt', 'index,lat,lon,alt_m\n1,34.1,108.8,400\n') === 'trackcsv');
  ok('无法识别时返回 unknown', sniffFormat('a.bin', '随便什么东西') === 'unknown');

  /* ---- CSV 列序打乱也能读 ---- */
  const shuffled = 'lon,lat,elevation,time\n108.8860,34.1640,400,2026-11-01T01:30:00Z\n';
  const sh = parseTrackCSV(shuffled);
  ok('CSV 列序打乱仍能定位 lat/lon', sh.points.length === 1 && Math.abs(sh.points[0].lat - 34.164) < 1e-6);
  ok('CSV 认 elevation 当海拔', Math.abs(sh.points[0].alt - 400) < 0.01);

  /* ---- 坏数据不能整份失败 ---- */
  const dirtyGpx = `<?xml version="1.0"?><gpx><trk><trkseg>
    <trkpt lat="34.1" lon="108.8"><ele>400</ele></trkpt>
    <trkpt lat="abc" lon="108.8"/>
    <trkpt lat="34.2" lon="108.9"/>
  </trkseg></trk></gpx>`;
  const dg = parseGPX(dirtyGpx);
  ok('GPX 跳过非法经纬度', dg.points.length === 2, String(dg.points.length));
  ok('GPX 支持自闭合 trkpt', dg.points[1].lat === 34.2);

  const badCsv = 'lat,lon\n34.1,108.8\n,x\n34.2,108.9\n';
  ok('CSV 跳过坏行', parseTrackCSV(badCsv).points.length === 2);
  ok('GeoJSON 语法错误不抛异常',
    parseGeoJSON('{坏掉的').warnings.some((w) => /JSON/.test(w)));

  /* ---- (0,0) 是占位符，不是坐标 ---- */
  const zero = parseTrackCSV('lat,lon\n0,0\n34.1,108.8\n');
  ok('排除 (0,0) 占位点', zero.points.length === 1);

  /* ---- 时间前向补齐 ---- */
  const gapLog = [
    entry(null, frame('GPGSV,1,1,04,05,45,120,42')),
    entry(TB, frame('GNGGA,013000.00,3409.8400,N,10853.1600,E,1,08,1.1,400,M,0,M,,')),
    entry(null, frame('SNRSTAT,1,0,0,2')),
  ];
  fillForwardTimes(gapLog);
  ok('开头缺时间的语句取首个已知时间', gapLog[0].t === TB);
  ok('中间缺时间的语句沿用上一条', gapLog[2].t === TB);

  /* ---- 跨 UTC 零点 ---- */
  const cross = [
    entry(null, frame('GNRMC,235959.00,A,3409.8400,N,10853.1600,E,0.5,90,011126,,,A')),
    entry(null, frame('GNGGA,235959.50,,,,,1,08,1.1,400,M,0,M,,')),
    entry(null, frame('GNGGA,000000.50,,,,,1,08,1.1,400,M,0,M,,')),
  ];
  deriveTimesFromNMEA(cross);
  ok('跨零点时间递增', cross[2].t > cross[0].t,
    `${cross[0].t} → ${cross[2].t}`);
  ok('跨零点相差 1.5 秒（不是倒退 24 小时）', cross[2].t - cross[0].t === 1500,
    String(cross[2].t - cross[0].t));
}

/* ============================================================
   十八、分析：缺口归因
   ============================================================ */
console.log('\n十八、轨迹缺口归因');
{
  ok('median 偶数个取中位', median([1, 2, 3, 4]) === 2.5);
  ok('median 空数组返回 null', median([]) === null);
  ok('percentile 0 是最小值', percentile([5, 1, 9], 0) === 1);
  ok('percentile 1 是最大值', percentile([5, 1, 9], 1) === 9);
  ok('downsample 不超过上限', downsample(Array.from({ length: 1000 }, (_, i) => i), 100).length === 100);
  ok('downsample 保留首尾', (() => {
    const a = downsample(Array.from({ length: 1000 }, (_, i) => i), 10);
    return a[0] === 0 && a[a.length - 1] === 999;
  })());

  /* ---- 大位移缺口 ---- */
  const fastGap = [
    pt(34.0, 108.9, TB), pt(34.0001, 108.9, TB + 1000),
    pt(34.0002, 108.9, TB + 2000), pt(34.0003, 108.9, TB + 3000),
    pt(34.0023, 108.9, TB + 56000),
  ];
  const aFast = analyzeTrack(fastGap);
  ok('识别出采样缺口', aFast.gaps.length === 1, String(aFast.gaps.length));
  ok('缺口时长正确', aFast.gaps[0].dtS === 53, String(aFast.gaps[0].dtS));
  ok('缺口距离 > 200m', aFast.gaps[0].distM > 200, String(aFast.gaps[0].distM));

  /* ---- 无日志：成因未知 ---- */
  correlate(aFast, null);
  ok('无日志时标为原因未定', aFast.gaps[0].kind === 'unknown', aFast.gaps[0].kind);

  /* ---- 有日志但整段没有语句 → 链路 ---- */
  const silentLog = analyzeLog([
    ...Array.from({ length: 4 }, (_, i) => entry(TB + i * 1000, ggaLine(1, '3400.00000', '10854.00000'))),
    ...Array.from({ length: 5 }, (_, i) => entry(TB + 56000 + i * 1000, ggaLine(1, '3400.14000', '10854.00000'))),
  ]);
  correlate(aFast, silentLog);
  ok('日志同时中断 → 判为链路问题', aFast.gaps[0].kind === 'link', aFast.gaps[0].kind);
  ok('链路问题给出的是接线/供电方向建议',
    /USB|供电|串口/.test(aFast.gaps[0].cause), aFast.gaps[0].cause.slice(0, 40));

  /* ---- 日志有数据但一直没定位 → 定位丢失 ---- */
  const lostLog = analyzeLog([
    ...Array.from({ length: 4 }, (_, i) => entry(TB + i * 1000, ggaLine(1, '3400.00000', '10854.00000'))),
    ...Array.from({ length: 50 }, (_, i) => entry(TB + 4000 + i * 1000, ggaLine(0, '', '', 0, 99.99))),
    ...Array.from({ length: 5 }, (_, i) => entry(TB + 56000 + i * 1000, ggaLine(1, '3400.14000', '10854.00000'))),
  ]);
  const aLost = analyzeTrack(fastGap.slice());
  correlate(aLost, lostLog);
  ok('日志有数据但 quality=0 → 判为定位丢失', aLost.gaps[0].kind === 'lost', aLost.gaps[0].kind);
  ok('定位丢失的成因指向遮挡/多路径', /遮挡|多路径|天空/.test(aLost.gaps[0].cause));

  /* ---- 原地不动 56 秒 ---- */
  const stillTrack = [
    pt(34.0, 108.9, TB), pt(34.0, 108.9, TB + 1000),
    pt(34.0, 108.9, TB + 2000), pt(34.0, 108.9, TB + 3000),
    pt(34.00001, 108.9, TB + 56000),
  ];
  const aStill = analyzeTrack(stillTrack);
  ok('静止也会产生「缺口」候选', aStill.gaps.length === 1);
  const stillLog = analyzeLog(
    Array.from({ length: 60 }, (_, i) => entry(TB + i * 1000, ggaLine(1, '3400.00000', '10854.00000'))),
  );
  correlate(aStill, stillLog);
  ok('位移很小 + 日志定位正常 → 判为静止停留', aStill.gaps[0].kind === 'static', aStill.gaps[0].kind);
  ok('静止停留的解释里明确「不是丢数据」', /不是丢数据|正常现象/.test(aStill.gaps[0].cause));

  /* ---- 日志正常定位、位置在动，但轨迹少了这段 ---- */
  const movingLog = analyzeLog([
    ...Array.from({ length: 4 }, (_, i) => entry(TB + i * 1000,
      ggaLine(1, `3400.${String(i).padStart(5, '0')}`, '10854.00000'))),
    ...Array.from({ length: 55 }, (_, i) => entry(TB + 4000 + i * 1000,
      ggaLine(1, `3400.${String(40 + i).padStart(5, '0')}`, '10854.00000'))),
  ]);
  const aUnrec = analyzeTrack(fastGap.slice());
  correlate(aUnrec, movingLog);
  ok('日志正常但轨迹缺段 → 判为记录侧问题', aUnrec.gaps[0].kind === 'unrecorded', aUnrec.gaps[0].kind);
  ok('记录侧问题指向缓冲上限/时间裁剪', /缓冲|裁剪/.test(aUnrec.gaps[0].cause));
}

/* ============================================================
   十九、分析：跳点、漂移、日志统计
   ============================================================ */
console.log('\n十九、跳点、漂移与日志统计');
{
  /* ---- 一次「飞出去又回来」只报一条 ---- */
  const jumpTrack = [];
  for (let i = 0; i <= 30; i++) {
    const jitter = i === 20 ? 0.0006 : 0;   // 第 20 点北跳约 67m
    jumpTrack.push(pt(34.0 + i * 0.0001 + jitter, 108.9, TB + i * 1000));
  }
  const aJump = analyzeTrack(jumpTrack);
  ok('跳点合并成一条', aJump.jumps.length === 1, String(aJump.jumps.length));
  ok('跳点位移 > 50m', aJump.jumps[0].distM > 50, String(aJump.jumps[0].distM));
  ok('跳点标记为折返尖峰', aJump.jumps[0].kind === 'spike', aJump.jumps[0].kind);

  /* ---- 静止漂移：绕圈 90 秒 ---- */
  const driftTrack = [];
  for (let i = 0; i <= 90; i++) {
    const ang = (i / 120) * 2 * Math.PI;
    const r = 9;
    driftTrack.push(pt(
      34.0 + (r * Math.cos(ang)) / 111320,
      108.9 + (r * Math.sin(ang)) / (111320 * Math.cos(34 * Math.PI / 180)),
      TB + i * 1000,
    ));
  }
  const aDrift = analyzeTrack(driftTrack);
  ok('识别出静止漂移', aDrift.drifts.length >= 1, String(aDrift.drifts.length));
  ok('漂移半径 > 6m', aDrift.drifts[0].radiusM > TH.driftRadiusM, String(aDrift.drifts[0]?.radiusM));
  ok('漂移段平均速度 < 5 km/h', aDrift.speed.avgMv < 5, String(aDrift.speed.avgMv));

  /* ---- 直线行驶不该误报漂移 ---- */
  const drive = [];
  for (let i = 0; i <= 60; i++) drive.push(pt(34.0 + i * 0.0003, 108.9, TB + i * 1000));
  ok('正常行驶不产生漂移误报', analyzeTrack(drive).drifts.length === 0);

  /* ---- 日志统计 ---- */
  const logLines = [];
  for (let i = 0; i <= 30; i++) {
    logLines.push(entry(TB + i * 1000, ggaLine(i === 10 ? 0 : 1, '3400.00000', '10854.00000',
      i === 10 ? 0 : 12, i === 10 ? 99.99 : 1.1)));
  }
  const aLog = analyzeLog(logLines);
  ok('日志条数统计', aLog.count === 31, String(aLog.count));
  ok('句率计算', Math.abs(aLog.ratePerSec - 1) < 0.05, String(aLog.ratePerSec));
  ok('质量分段数', aLog.fixSegments.length === 3, String(aLog.fixSegments.length));
  ok('未定位累计 1 秒', aLog.qualityTime.find((q) => q.q === 0)?.seconds <= 1);
  ok('99.99 的 HDOP 被当作占位符剔除',
    aLog.gga.filter((g) => g.quality === 0).every((g) => g.hdop == null));

  /* ---- 校验和错误统计 ---- */
  const badChecksum = [
    entry(TB, frame('GNGGA,013000.00,3409.8400,N,10853.1600,E,1,08,1.1,400,M,0,M,,')),
    entry(TB + 1000, '$GNGGA,013001.00,3409.8400,N,10853.1600,E,1,08,1.1,400,M,0,M,,*00'),
  ];
  const aBad = analyzeLog(badChecksum);
  ok('校验错误被计数', aBad.badChecksum === 1, String(aBad.badChecksum));
  ok('校验错误率', Math.abs(aBad.badPct - 50) < 0.01, String(aBad.badPct));

  /* ---- 缺语句检测 ---- */
  const onlyGga = analyzeLog([entry(TB, ggaLine(1, '3400.00000', '10854.00000'))]);
  ok('缺 GSV 会被指出来', onlyGga.missingTypes.some((m) => m.type === 'GSV'));
  ok('有 GGA 时不报缺 GGA', !onlyGga.missingTypes.some((m) => m.type === 'GGA'));
}

/* ============================================================
   二十、评分、结论与报告
   ============================================================ */
console.log('\n二十、评分、结论与报告');
{
  const ptsOk = [];
  for (let i = 0; i <= 120; i++) ptsOk.push(pt(34.0 + i * 0.0002, 108.9 + i * 0.0001, TB + i * 1000));
  const logOk = analyzeLog(
    Array.from({ length: 121 }, (_, i) => entry(TB + i * 1000, ggaLine(1, '3400.00000', '10854.00000'))),
  );
  const trackOk = analyzeTrack(ptsOk);

  const scOk = score(trackOk, logOk);
  ok('满分场景评级 A', scOk.grade === 'A', `${scOk.grade} ${scOk.overall}`);
  ok('各项维度都在 0~100', scOk.dims.every((d) => d.value >= 0 && d.value <= 100));
  ok('四项维度齐全', scOk.dims.length === 4, String(scOk.dims.length));

  const { issues: issOk } = diagnose(trackOk, logOk);
  const vdOk = verdict(trackOk, logOk, scOk, issOk);
  ok('干净数据不出现严重问题', vdOk.usable === true);
  ok('结论里带评级与分数', /评级 A/.test(vdOk.headline), vdOk.headline);
  ok('干净数据结论不提「不可采信」', !/不可直接采信/.test(vdOk.headline));

  /* ---- 有链路断流时，结论不能既给 A 又说不可采信 ---- */
  const badLog = analyzeLog([
    ...Array.from({ length: 20 }, (_, i) => entry(TB + i * 1000, ggaLine(1, '3400.00000', '10854.00000'))),
    ...Array.from({ length: 20 }, (_, i) => entry(TB + 600000 + i * 1000, ggaLine(1, '3400.00000', '10854.00000'))),
  ]);
  const scBad = score(trackOk, badLog);
  const { issues: issBad } = diagnose(trackOk, badLog);
  const vdBad = verdict(trackOk, badLog, scBad, issBad);
  ok('严重断流会拉低链路完整性', scBad.dims.find((d) => d.id === 'link').value < 50,
    String(scBad.dims.find((d) => d.id === 'link').value));
  ok('低分时结论明确不可采信', /不可直接采信|不具备/.test(vdBad.headline), vdBad.headline);

  /* ---- 报告三种格式 ---- */
  const file = {
    name: 'demo.gpx', format: 'gpx', kind: 'track', points: ptsOk,
    entries: [], meta: {}, warnings: [], bytes: 1000,
  };
  const model = analyzeAll([file]);
  const html = toReportHTML(model);
  ok('HTML 报告是完整文档', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  ok('HTML 报告可编辑', html.includes('contenteditable="true"'));
  ok('HTML 报告含结论', html.includes('评级'));
  ok('HTML 报告含打印样式', html.includes('@media print'));
  ok('HTML 报告内嵌轨迹图', html.includes('<svg'));

  const md = toReportMD(model);
  ok('Markdown 报告有标题', md.startsWith('# GNSS'));
  ok('Markdown 报告有结论段', md.includes('## 结论'));
  ok('Markdown 报告有问题清单段', md.includes('## 问题清单'));

  const csv = toIssuesCSV(model);
  const csvLines = csv.trim().split('\n');
  ok('CSV 有表头', csvLines[0].startsWith('id,level,code'));
  ok('CSV 每行列数一致', csvLines.every((l) => l.split(',').length >= 12),
    String(csvLines.length));

  /* ---- XSS：设备文本消息里的尖括号必须被转义 ---- */
  const evilLog = analyzeLog([
    entry(TB, frame('GNTXT,01,01,02,<script>alert(1)</script>')),
    entry(TB + 1000, ggaLine(1, '3400.00000', '10854.00000')),
  ]);
  const evilModel = analyzeAll([{
    name: 'evil.nmea', format: 'nmea', kind: 'log', points: [],
    entries: [], meta: {}, warnings: [], bytes: 100,
  }]);
  evilModel.log = evilLog;
  const { issues: evilIssues } = diagnose(null, evilLog);
  evilModel.issues = evilIssues;
  evilModel.counts = { bad: 0, warn: 0, info: evilIssues.length };
  const evilHtml = toReportHTML(evilModel);
  ok('Markdown 有问题时输出表格', toReportMD(evilModel).includes('| 级别 |'));
  ok('报告转义了设备文本里的尖括号',
    !evilHtml.includes('<script>alert(1)</script>') && evilHtml.includes('&lt;script&gt;'));

  ok('报告格式注册表 3 种', REPORT_FORMATS.length === 3);
  ok('报告文件名带扩展名', reportFilename(model, 'html').endsWith('.html'));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);