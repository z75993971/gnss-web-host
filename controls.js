/**
 * controls.js — 控制中心
 *
 * 两种工作模式，按识别到的设备切换：
 *   标准 NMEA     —— 通用文本命令（MediaTek $PMTK / u-blox $PUBX,40），不发私有协议
 *   和芯星通 Unicore —— $CFG* / $PDTINFO / $SNRSTAT 全套配置
 *
 * Unicore 命令来源：《UFirebird 标准定位产品协议规范》与《UFirebird 组合导航产品协议规范》
 * （已归档于 知识库/原始资料/）。所有参数格式按规范原文，不做臆测。
 *
 * 覆盖：
 *   输出与协议  CFGNMEA / CFGMSG / CFGPRT
 *   星座与频点  CFGSYS
 *   组合导航    CFGINS / CFGROTAT / CFGODOFWD / CFGDYN / CFGGEOID
 *   授时与干扰  CFGTP / CFGCWOUT
 *   系统        PDTINFO / CFGSAVE / CFGCLR / RESET
 */

import { checksum } from './nmea.js';
import { describeMsgs } from './ntrip.js';
import { GENERIC_GROUPS, genericCommand, VENDOR, VENDOR_LABEL } from './vendor.js';

/* ============================================================
   0. 协议常量
   ============================================================ */

/** CFGSYS 位定义（双频组合开关） */
export const SYS_BITS = [
  { bit: 0, key: 'gpsL1', label: 'GPS L1C/A', on: true },
  { bit: 2, key: 'gpsL5', label: 'GPS L5', on: true },
  { bit: 4, key: 'bdsB1I', label: '北斗 B1I', on: true },
  { bit: 6, key: 'bdsB2a', label: '北斗 B2a', on: true },
  { bit: 8, key: 'gloL1', label: 'GLONASS L1', on: true },
  { bit: 12, key: 'galE1', label: 'Galileo E1', on: true },
  { bit: 14, key: 'galE5a', label: 'Galileo E5a', on: true },
  { bit: 16, key: 'qzsL1', label: 'QZSS L1', on: true },
  { bit: 18, key: 'qzsL5', label: 'QZSS L5', on: true },
  { bit: 20, key: 'sbas', label: 'SBAS', on: false },
  { bit: 24, key: 'navicL5', label: 'NavIC L5', on: false },
];

/** CFGMSG class 0：NMEA 语句 */
export const NMEA_MSGS = [
  { id: 0, name: 'GGA' }, { id: 1, name: 'GLL' }, { id: 2, name: 'GSA' },
  { id: 3, name: 'GSV' }, { id: 4, name: 'RMC' }, { id: 5, name: 'VTG' },
  { id: 6, name: 'ZDA' }, { id: 7, name: 'GST' },
];

/** CFGMSG class 2：组合导航语句 */
export const INS_MSGS = [
  { id: 1, name: 'SNRSTAT' }, { id: 2, name: 'NAVATT' }, { id: 4, name: 'INSPVA' },
];

/** CFGSAVE / CFGCLR 位定义 */
export const SAVE_BITS = [
  { bit: 0, name: '串口配置 (CFGPRT)' },
  { bit: 1, name: '语句配置 (CFGMSG/CFGNMEA)' },
  { bit: 2, name: '定位配置 (CFGNAV)' },
  { bit: 3, name: '授时配置 (CFGTP)' },
  { bit: 4, name: '星座配置 (CFGSYS)' },
  { bit: 6, name: 'EM 配置' },
  { bit: 7, name: '动态配置 (CFGDYN)' },
  { bit: 8, name: '低功耗配置' },
];

/* ============================================================
   1. 工具
   ============================================================ */

/** 组装带校验和的命令（不含 \r\n，由发送层补） */
export function cmd(body) {
  return `$${body}*${checksum(body).toString(16).toUpperCase().padStart(2, '0')}`;
}

/** 十进制 → Unicore 十六进制格式（h1F） */
export function toHex(n) {
  return 'h' + Math.max(0, Math.round(n)).toString(16).toUpperCase();
}

/** h1F / 1F → 十进制 */
export function fromHex(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/^[hH]/, '');
  const v = parseInt(t, 16);
  return Number.isFinite(v) ? v : null;
}

/** 位集合 → 掩码 */
export function maskFromBits(bits) {
  let m = 0;
  for (const b of bits) m |= 2 ** b;
  return m;
}

/** 掩码 → 位集合 */
export function bitsFromMask(mask) {
  const out = [];
  for (let b = 0; b < 32; b++) if (mask & (2 ** b)) out.push(b);
  return out;
}

/** 星座勾选状态 → CFGSYS 掩码 */
export function sysMaskFrom(checkedKeys) {
  const bits = SYS_BITS.filter((s) => checkedKeys.includes(s.key)).map((s) => s.bit);
  return maskFromBits(bits);
}

/* ============================================================
   2. 面板 HTML
   ============================================================ */

const row = (label, body, note) => `
  <div class="ctl-row">
    <div class="ctl-label">${label}</div>
    <div class="ctl-body">${body}</div>
    ${note ? `<div class="ctl-note">${note}</div>` : ''}
  </div>`;

const seg = (name, opts) => `
  <div class="seg" data-seg="${name}">${opts
    .map((o) => `<button data-val="${o.v}"${o.on ? ' class="on"' : ''}>${o.t}</button>`)
    .join('')}</div>`;

const TAB_OUT = `
  ${row('NMEA 版本 / 频率',
    `${seg('nmeaVer', [{ v: 'h30', t: '3.0' }, { v: 'h51', t: '4.1（含北斗）', on: true }])}
     ${seg('nmeaRate', [{ v: '0', t: '1 Hz' }, { v: '1', t: '5 Hz' }, { v: '2', t: '10 Hz', on: true }])}
     <button class="mini primary" data-act="setNmea">下发</button>`,
    '两个参数必须一起下发（$CFGNMEA 一条命令同时设版本与频率）。5 Hz 需要串口 ≥115200，10 Hz 需要 460800；上调前先确认设备当前波特率。')}

  ${row('NMEA 语句',
    `<div class="chips" id="msgChips">${NMEA_MSGS
      .map((m) => `<button class="chip on" data-cls="0" data-id="${m.id}">${m.name}</button>`)
      .join('')}</div>`,
    '点一下即下发 $CFGMSG,0,&lt;id&gt;,0|1，绿色为开启。')}

  ${row('组合导航语句',
    `<div class="chips" id="insChips">${INS_MSGS
      .map((m) => `<button class="chip${m.name === 'SNRSTAT' ? ' on' : ''}" data-cls="2" data-id="${m.id}">${m.name}</button>`)
      .join('')}</div>
     <button class="mini" data-act="queryInsMsg">查询</button>`,
    'SNRSTAT 是惯导/里程计状态来源，关掉后左下角状态面板会失去数据。')}

  ${row('命令回显',
    `${seg('echoState', [{ v: '0', t: '关', on: true }, { v: '1', t: '开' }])}
     <button class="mini primary" data-act="setEcho">下发</button>`,
    '开启后接收机会回显 #你发送的命令，便于确认指令是否被接收。')}

  ${row('串口配置',
    `<select id="prtPort"><option value="1">串口 1（主口 / USB）</option><option value="2">串口 2</option></select>
     <select id="prtBaud">
       <option>9600</option><option>115200</option><option>230400</option>
       <option selected>460800</option>
     </select>
     <button class="mini" data-act="queryPrt">查询</button>
     <button class="mini danger" data-act="setPrt">下发</button>`,
    '⚠️ 改波特率后当前连接会立即失效，需要在上位机里换成新波特率重新连接。协议位（含 MEMS 输入）自动沿用回读值，不会被覆盖。')}
`;

const TAB_SYS = `
  <div class="ctl-note" style="margin-bottom:10px">
    勾选需要的星座与频点，生成 $CFGSYS 位掩码下发。<b>接收机收到该命令会自动复位</b>，重新出星约需 30 秒。
  </div>
  <div class="sys-grid">
    ${SYS_BITS.map((s) => `
      <label class="check"><input type="checkbox" data-sys="${s.key}" data-bit="${s.bit}"${s.on ? ' checked' : ''}>
        ${s.label}<span class="bit">bit${s.bit}</span></label>`).join('')}
  </div>
  ${row('当前掩码',
    `<code id="sysMaskView">h55155</code>
     <button class="mini" data-act="applyDefaultSys">恢复默认双频</button>
     <button class="mini primary" data-act="setSys">应用并复位</button>`,
    '默认 h55155 = GPS/北斗/GLONASS/Galileo/QZSS 全双频，不开 SBAS 与 NavIC。')}
  <div class="ctl-note">
    <b>常用组合</b>：
    <button class="mini" data-act="presetSys" data-val="gpsOnly">仅 GPS 双频</button>
    <button class="mini" data-act="presetSys" data-val="noGlo">关闭 GLONASS</button>
    <button class="mini" data-act="presetSys" data-val="lowPower">低功耗（单频）</button>
  </div>
`;

const TAB_INS = `
  <div class="ctl-note" style="margin-bottom:10px">
    组合导航配置。改完必须 <b>$CFGSAVE</b> 才写入 Flash，否则断电丢失。
  </div>

  ${row('工作模式',
    `<select id="insMode">
       <option value="0">0 · 关闭（纯 GNSS 输出）</option>
       <option value="1" selected>1 · 车载模式（默认）</option>
       <option value="2">2 · 手持模式</option>
     </select>
     <select id="insImu"><option value="0">IMU 关</option><option value="1" selected>内置 IMU</option></select>
     <select id="insOdo"><option value="0">里程计关</option><option value="1" selected>内置脉冲计数</option></select>
     <select id="insMap"><option value="0" selected>地图匹配关</option><option value="4">地图匹配（UART）</option></select>
     <button class="mini primary" data-act="setIns">下发</button>`,
    '手持模式适合步行/骑行；车载模式启用非完好性约束，收敛更快。')}

  ${row('安装角',
    `<input type="number" id="rotX" value="0" min="0" max="36000" step="1" title="X 轴 0.01°">
     <input type="number" id="rotY" value="0" min="0" max="36000" step="1" title="Y 轴 0.01°">
     <input type="number" id="rotZ" value="0" min="0" max="36000" step="1" title="Z 轴 0.01°">
     ${seg('rotMode', [{ v: '2', t: '自动识别', on: true }, { v: '0', t: '手工输入' }])}
     <button class="mini primary" data-act="setRot">下发</button>`,
    '三个数字单位为 0.01°，即 9000 = 90°。自动模式不用填角度，行驶中自行收敛；手工模式角度误差需在 10° 内。')}

  ${row('里程计方向',
    `${seg('odoFwd', [{ v: '1', t: '高电平前进', on: true }, { v: '0', t: '低电平前进' }])}
     <button class="mini primary" data-act="setOdoFwd">下发</button>`,
    '接反了会导致组合导航把前进算成倒车，轨迹直接往反方向跑。')}

  ${row('动态模型',
    `<select id="dynModel"><option value="0" selected>便携</option><option value="1">静态</option></select>
     <input type="number" id="dynThresh" value="0" min="0" max="65535" step="10" title="静态保持门限 cm/s">
     <span class="unit">cm/s</span>
     <button class="mini primary" data-act="setDyn">下发</button>`,
    '静态门限设为 0 表示关闭静态保持；车载一般设 0，静态观测墩设 30~50 cm/s。')}

  ${row('高程基准',
    `${seg('geoid', [{ v: '1', t: '海拔高', on: true }, { v: '0', t: '椭球高' }])}
     <button class="mini primary" data-act="setGeoid">下发</button>`,
    '海拔高 = 椭球高 − 高程异常。国内用户通常要海拔高。')}

  ${row('查询全部',
    `<button class="mini" data-act="queryIns">CFGINS</button>
     <button class="mini" data-act="queryRot">CFGROTAT</button>
     <button class="mini" data-act="queryOdo">CFGODOFWD</button>
     <button class="mini" data-act="queryDyn">CFGDYN</button>
     <button class="mini" data-act="queryGeoid">CFGGEOID</button>`)}
`;

const TAB_MISC = `
  ${row('PPS 授时脉冲',
    `${seg('ppsEn', [{ v: '1', t: '开启', on: true }, { v: '0', t: '关闭' }])}
     <input type="number" id="ppsLen" value="500000" min="1" max="999999" step="1000" title="脉宽 μs">
     <span class="unit">μs 脉宽</span>
     <button class="mini primary" data-act="setTp">下发</button>`,
    '周期固定 1 s。脉宽不能超过 999999 μs。默认 500000 = 高电平 0.5 s。')}

  ${row('PPS 细节',
    `${seg('ppsEdge', [{ v: '0', t: '上升沿对齐', on: true }, { v: '1', t: '下降沿对齐' }])}
     ${seg('ppsAlways', [{ v: '0', t: '仅授时有效时输出', on: true }, { v: '1', t: '总是输出' }])}
     <input type="number" id="ppsAntDelay" value="0" min="-32768" max="32767" title="天线延迟 ns">
     <span class="unit">天线延迟 ns</span>`,
    '上升沿对齐是授时惯例。天线延迟用于补偿馈线时延，普通使用填 0。')}

  ${row('干扰检测',
    `${seg('cwout', [{ v: '0', t: '关闭', on: true }, { v: '1', t: '输出 CWOUT' }])}
     <button class="mini primary" data-act="setCwout">下发</button>`,
    '开启后会周期性输出 $CWOUT 干扰检测语句，可用于排查射频干扰。')}

  ${row('查询',
    `<button class="mini" data-act="queryTp">CFGTP</button>
     <button class="mini" data-act="queryCwout">CFGCWOUT</button>`)}
`;

const TAB_SYSINFO = `
  ${row('读取设备配置',
    `<button class="mini primary" data-act="readAll">读取当前配置</button>
     <span class="unit">连接后会自动读取一次</span>`,
    '把模块里实际生效的配置读回来并填进各页签。<b>强烈建议先读再改</b> —— 界面默认值不等于你的设备当前状态，盲目下发会覆盖原有配置。')}

  ${row('设备信息',
    `<button class="mini" data-act="queryPdt">PDTINFO</button>
     <button class="mini" data-act="queryVersion">查询固件版本</button>`,
    'PDTINFO 返回产品型号、硬件版本、固件版本、序列号。')}

  ${row('保存配置',
    `<div class="chips" id="saveChips">${SAVE_BITS
      .map((b) => `<button class="chip on" data-savebit="${b.bit}" title="${b.name}">${b.name.split(' ')[0]}</button>`)
      .join('')}</div>
     <button class="mini primary" data-act="saveCfg">写入 Flash</button>`,
    '⚠️ 下发后 1 秒内不要断电，否则配置可能损坏并回落出厂值。')}

  ${row('复位接收机',
    `<button class="mini" data-act="resetHot">热启动</button>
     <button class="mini" data-act="resetWarm">温启动</button>
     <button class="mini danger" data-act="resetCold">冷启动</button>`,
    '冷启动 $RESET,0,h85 会清空星历，首次定位需 30~60 秒。热启动 h00 保留星历，最快恢复。')}

  ${row('恢复出厂',
    `<button class="mini danger" data-act="clearCfg">CFGCLR 全部配置</button>`,
    '⚠️ 同时清除 RAM 与 Flash 配置，复位后生效。波特率、语句、星座全部回默认，谨慎使用。')}
`;

/* ============================================================
   辅助定位（A-GNSS）
   ------------------------------------------------------------
   协议里跟辅助定位直接相关的只有三条指令，全部来自
   《UFirebird 标准定位产品协议规范》1.4.2.11 ~ 1.4.2.13：
     $AIDTIME  注入 UTC 时间辅助
     $AIDPOS   注入位置辅助（NMEA 度分格式，椭球高）
     $AIDINFO  查询辅助数据状态（各系统星历接收/可用位图 + Atype）
   规范原文另有一句关键说明：A-GNSS 辅助数据通过 RTCM3.2 协议下发，
   也就是说星历级的辅助走的是 RTCM 通道，不是这两条 NMEA 指令。
   ============================================================ */

/** 十进制度 → NMEA 度分格式（ddmm.mmmm / dddmm.mmmm） */
export function nmeaCoord(v, degDigits) {
  const abs = Math.abs(Number(v));
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return String(deg).padStart(degDigits, '0') + min.toFixed(6).padStart(9, '0');
}

/** 位图中 1 的个数 */
function popcount(hex) {
  const s = String(hex || '').trim().replace(/^[hH]/, '');
  if (!s) return 0;
  let v;
  try { v = BigInt('0x' + s); } catch { return 0; }
  let n = 0;
  while (v > 0n) { n += Number(v & 1n); v >>= 1n; }
  return n;
}

/** Atype 辅助类型位解码 */
export function decodeAtype(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return [];
  const out = [];
  if (v & 0x01) out.push('GPS 星历辅助');
  if (v & 0x02) out.push('BDS 星历辅助');
  if (v & 0x04) out.push('GAL 星历辅助');
  if (v & 0x08) out.push('GLO 星历辅助');
  if (v & 0x10) out.push('辅助位置有效');
  if (v & 0x20) out.push('正在使用辅助位置');
  if (v & 0x100) out.push('辅助时间有效');
  if (v & 0x200) out.push('正在使用辅助时间');
  return out;
}

/**
 * 解析 $AIDINFO 应答。
 * $AIDINFO,GPSRS,GPSUS,BDSRS,BDSUS,GALRS,GALUS,GLORS,GLOUS,Atype,...
 * RS = 收到且校验通过的星历位图，US = 星历有效且可用于定位的位图。
 */
export function parseAidinfo(fields) {
  if (!Array.isArray(fields) || fields.length < 9) return null;
  const num = (s) => {
    const t = String(s || '').trim();
    if (!t) return 0;
    return popcount(t);
  };
  return {
    gps: { rs: num(fields[0]), us: num(fields[1]) },
    bds: { rs: num(fields[2]), us: num(fields[3]) },
    gal: { rs: num(fields[4]), us: num(fields[5]) },
    glo: { rs: num(fields[6]), us: num(fields[7]) },
    atype: Number(fields[8]) || 0,
  };
}

const AID_SYS = [
  { key: 'gps', name: 'GPS' },
  { key: 'bds', name: '北斗' },
  { key: 'gal', name: 'Galileo' },
  { key: 'glo', name: 'GLONASS' },
];

const TAB_AID = `
  ${row('时间辅助 $AIDTIME',
    `<span class="aid-clock" id="aidClock">—</span>
     <button class="mini primary" data-act="aidTime">注入当前时间</button>`,
    '把主机 UTC 时间灌给接收机，省掉从导航电文里解时间的步骤。冷启动时能明显压缩首次定位时间。')}

  ${row('位置辅助 $AIDPOS',
    `<input type="number" id="aidLat" step="0.000001" placeholder="纬度" title="十进制度">
     <input type="number" id="aidLon" step="0.000001" placeholder="经度" title="十进制度">
     <input type="number" id="aidAlt" step="0.1" placeholder="椭球高 m" title="椭球高，米">
     <button class="mini" data-act="aidUseLast">用上次定位</button>
     <button class="mini primary" data-act="aidPos">注入位置</button>`,
    '位置只需粗到百米级就够用，作用是让接收机知道去哪儿搜星。高程填椭球高，不是海拔。')}

  ${row('星历状态 $AIDINFO',
    `<button class="mini primary" data-act="aidInfo">查询辅助数据状态</button>
     <span class="unit" id="aidAtype">—</span>`,
    '读取各系统星历的接收位图与可用位图，能直接看出"星历齐不齐、辅助有没有生效"。')}

  <div class="aid-grid" id="aidGrid">${
    AID_SYS.map((s) => `
      <div class="aid-item" data-aidsys="${s.key}">
        <div class="aid-name">${s.name}<span class="aid-tag" id="aidUsed_${s.key}">—</span></div>
        <div class="aid-bar"><i id="aidBar_${s.key}" style="width:0%"></i></div>
        <div class="aid-num" id="aidNum_${s.key}">未查询</div>
      </div>`).join('')
  }</div>

  ${row('自动辅助',
    `${seg('aidAuto', [{ v: '0', t: '关闭', on: true }, { v: '1', t: '连接后自动注入' }])}`,
    '开启后每次连上设备，先灌一次时间和上次位置。位置是上次会话留下的，跨城市使用前记得先更新。')}

  ${row('说明',
    `<span class="unit">本模块的 A-GNSS 星历辅助走 RTCM3.2 通道，需要额外数据源</span>`,
    `协议规范写明「A-GNSS 辅助定位数据通过 RTCM3.2 协议」。所以这里的时间/位置辅助只能缩短冷启动，
     真正把星历塞进去要让模块从串口收 RTCM3.2 星历帧（Message 1019/1020/1042/1045 等）——
     这个通路在「差分 / NTRIP」页签里，需要外部数据源。产品简介把 A-GNSS 标了星号，
     意味着只有特定固件版本支持，本机是否支持要看 $AIDINFO 的 Atype 位有没有报出来。`)}
`;

/* ============================================================
   差分 / NTRIP
   ------------------------------------------------------------
   模块侧依据：《UFirebird 标准定位产品协议规范》$CFGPRT 的 inProto 位定义
     bit0 UNICORE / bit5 RTCM2.3 / bit7 RTCM3.2 / bit9 里程计 / bit10 MEMS
   本机实测回读值是 H481 = bit0 + bit7 + bit10，也就是 RTCM3.2 输入已经开着，
   差分数据从串口灌进去就能被接收。
   但 GGA 的定位状态字段只定义到 2（伪距差分），没有 RTK 的 4/5，
   所以解算上限是伪距差分，拿不到固定解。这一点在界面上必须写清楚。
   ============================================================ */

const TAB_DIFF = `
  ${row('NTRIP 服务',
    `<input type="text" id="ntHost" value="rtk.ntrip.qxwz.com" placeholder="caster 地址" style="width:170px">
     <input type="number" id="ntPort" value="8002" placeholder="端口" style="width:64px">
     <input type="text" id="ntMount" value="AUTO" placeholder="挂载点" style="width:72px">`,
    `千寻知寸 FindCM 的参数：<code>rtk.ntrip.qxwz.com</code>，端口 8002 对应 WGS84（2005.0 历元），
     8001 是 ITRF2008、8003 是 CGCS2000，挂载点填 <code>AUTO</code>。
     选 WGS84 那档，模块输出的就是 WGS84，省一次基准转换。`)}

  ${row('账号',
    `<input type="text" id="ntUser" placeholder="差分账号" style="width:150px">
     <input type="password" id="ntPass" placeholder="密码" style="width:130px">
     <button class="mini primary" data-act="ntripConnect">连接</button>
     <button class="mini" data-act="ntripDisconnect">断开</button>`,
    '账号密码只留在内存里，不写 localStorage，也不落盘。连上之后 caster 会回一个流。')}

  ${row('RTCM 转发',
    `${seg('ntFwd', [{ v: '1', t: '写入串口', on: true }, { v: '0', t: '只接收不转发' }])}
     <span class="unit" id="ntState">未连接</span>`,
    '本机 $CFGPRT 回读为 <code>H481</code>，bit7（RTCM3.2 输入）已开，收到的差分数据直接写串口即可。')}

  <div class="nt-stats" id="ntStats">
    <div class="nt-cell"><b id="ntBytes">0</b><span>已收 RTCM</span></div>
    <div class="nt-cell"><b id="ntFwd">0</b><span>已写入串口</span></div>
    <div class="nt-cell"><b id="ntAge">—</b><span>距上次数据</span></div>
    <div class="nt-cell"><b id="ntGga">—</b><span>GGA 回传</span></div>
  </div>
  <div class="nt-msgs" id="ntMsgs"><span class="dim">消息类型统计会在收到数据后出现</span></div>

  ${row('能力边界（重要）',
    `<span class="unit">该模块不是 RTK 模块</span>`,
    `<b>这个模块解不出厘米级。</b>依据有两条：一是产品手册标称平面精度 1.5 m CEP（双频四系统开阔天空），
     没有 RTK 指标；二是协议规范的 GGA 定位状态字段只定义到
     <code>0 无效 / 1 单点 / 2 伪距差分</code>，没有 NMEA 里 RTK 固定解（4）和浮动解（5）的取值。
     <br><br>
     所以接千寻 FindCM 能拿到的最好结果是<b>伪距差分</b>，实际改善通常是从米级到亚米级，达不到厘米级。
     要厘米级必须换支持载波相位解算的 RTK 模块（如和芯星通 UM980/UM981 系列，或 u-blox ZED-F9P），
     换完之后这套 NTRIP 通道可以原样复用，不用改代码。`)}
`;

/**
 * 标准 NMEA 模式下的页签。
 *
 * 这一页不是"降级凑数"：NMEA-0183 标准里确实没有配置通道，谁要是把 $CFG* 发给
 * u-blox 模块，最好的结果是没反应，最坏的结果是模块把 $ 开头的垃圾当命令解析。
 * 所以这里只放各家族公开的文本命令，外加一句"没有应答不等于失败"的说明。
 */
const TAB_GENERIC = `
  ${row('当前设备',
    `<span class="chip on" id="genDevTag">标准 NMEA</span>
     <span class="dim" id="genDevHint"></span>
     <button class="mini" data-act="probeUnicore" title="发一条只读的 $PDTINFO，和芯星通设备会应答">探测是否支持 Unicore</button>`,
    '本工具靠被动观察识别设备：收到 $PDTINFO / $CFG* 才认定和芯星通，否则一律按标准 NMEA 处理，不对陌生设备发私有命令。')}

  ${GENERIC_GROUPS.map((g) => row(`${g.family} 文本命令`,
    g.items.map((it) => `<button class="mini" data-act="sendRaw" data-val="${it.body}">${it.label}</button>`).join(''),
    g.hint)).join('')}

  ${row('发出去的原文',
    `<code class="gen-echo" id="genEcho">—</code>`,
    '点上面的按钮，带校验和的完整语句会显示在这里，可以直接复制到别的工具里对照。这些命令大多没有应答，判断是否生效要看右边语句有没有变化。')}
`;

const TABS = [
  { id: 'generic', name: '通用 NMEA', html: TAB_GENERIC, v: VENDOR.NMEA },
  { id: 'out', name: '输出与协议', html: TAB_OUT, v: VENDOR.UNICORE },
  { id: 'sys', name: '星座与频点', html: TAB_SYS, v: VENDOR.UNICORE },
  { id: 'ins', name: '组合导航', html: TAB_INS, v: VENDOR.UNICORE },
  { id: 'aid', name: '辅助定位', html: TAB_AID, v: VENDOR.UNICORE },
  { id: 'diff', name: '差分 / NTRIP', html: TAB_DIFF, v: VENDOR.UNICORE },
  { id: 'misc', name: '授时与干扰', html: TAB_MISC, v: VENDOR.UNICORE },
  { id: 'sysinfo', name: '系统', html: TAB_SYSINFO, v: VENDOR.UNICORE },
];

/* ============================================================
   3. 面板构建与事件
   ============================================================ */

export class ControlCenter {
  /**
   * @param {HTMLElement} root 面板容器
   * @param {{send:(cmd:string)=>void, toast:(msg:string,ms?:number)=>void,
   *          isConnected:()=>boolean, setVendorMode?:(v:string)=>void}} io
   */
  constructor(root, io) {
    this.root = root;
    this.io = io;
    this.resp = [];
    this.active = 'out';
    this.vendor = VENDOR.NMEA;  // 实际生效的厂商模式，由 setVendor 更新
    this.prtCfg = {};        // 各串口的 inProto / outProto 回读值，下发时原样保留
    this.lastPos = null;     // 上次定位，用于位置辅助
    this.render();
    // 辅助定位页的卫星钟，只在页签打开时更新
    this.clockTimer = setInterval(() => {
      if (this.active === 'aid') this.tickClock();
    }, 1000);
  }

  render() {
    this.root.innerHTML = `
      <div class="ctl-vendor">
        <span class="ctl-vendor-tag" id="ctlDevName">未连接设备</span>
        <span class="dim">设备类型</span>
        ${seg('vendor', [
          { v: VENDOR.AUTO, t: '自动', on: true },
          { v: VENDOR.NMEA, t: '标准 NMEA' },
          { v: VENDOR.UNICORE, t: 'Unicore' },
        ])}
        <span class="spacer" style="flex:1"></span>
      </div>
      <div class="ctl-grid">
        <div class="ctl-tabs">
          ${TABS.map((t) => `<button data-tab="${t.id}" data-v="${t.v}"${t.id === this.active ? ' class="on"' : ''}>${t.name}</button>`).join('')}
        </div>
        <div class="ctl-panes">
          ${TABS.map((t) => `<div class="ctl-pane${t.id === this.active ? ' on' : ''}" data-pane="${t.id}" data-v="${t.v}">${t.html}</div>`).join('')}
        </div>
        <div class="ctl-resp">
          <div class="ctl-resp-head">
            <span>设备响应</span>
            <button class="mini" data-act="clearResp">清空</button>
          </div>
          <div class="ctl-resp-body" id="ctlRespBody"><div class="dim">等待命令响应…</div></div>
        </div>
      </div>`;

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => {
      if (e.target.matches('input[data-sys]')) this.syncSysMask();
    });
    this.syncSysMask();
    this.setVendor({ mode: this.io.vendorMode ? this.io.vendorMode() : VENDOR.AUTO, vendor: this.vendor });
  }

  /**
   * 切换厂商模式：只改「显示哪些页签」，不改任何设备状态。
   * @param {{mode?:string, vendor:string, label?:string}} st
   */
  setVendor(st) {
    const s = st || {};
    const mode = s.mode || VENDOR.AUTO;
    this.vendor = s.vendor === VENDOR.UNICORE ? VENDOR.UNICORE : VENDOR.NMEA;

    // 模式按钮跟随用户选择（自动模式下高亮「自动」）
    const box = this.root.querySelector('.seg[data-seg="vendor"]');
    if (box) {
      box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === mode));
    }
    const tag = this.root.querySelector('#ctlDevName');
    if (tag) tag.textContent = s.label || (this.vendor === VENDOR.UNICORE ? '和芯星通设备' : '标准 NMEA 设备');
    // 通用页里单独标注设备自报的身份，避免「模式=Unicore」和「设备=Unicore」看混
    const hint = this.root.querySelector('#genDevHint');
    if (hint) {
      const auto = s.label && s.label !== '标准 NMEA' ? `设备自报：${s.label}` : '';
      hint.textContent = auto;
    }

    // 页签与面板按模式显隐
    this.root.querySelectorAll('.ctl-tabs button').forEach((b) => { b.hidden = b.dataset.v !== this.vendor; });
    this.root.querySelectorAll('.ctl-pane').forEach((p) => { p.hidden = p.dataset.v !== this.vendor; });

    // 当前页签属于另一套模式时，切到本模式的第一个页签
    const cur = this.root.querySelector(`.ctl-tabs button[data-tab="${this.active}"]`);
    if (!cur || cur.hidden) {
      const first = [...this.root.querySelectorAll('.ctl-tabs button')].find((b) => !b.hidden);
      if (first) this.show(first.dataset.tab);
    }
  }

  /** 切换页签 */
  show(tab) {
    this.active = tab || this.active;
    this.root.querySelectorAll('.ctl-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === this.active);
    });
    this.root.querySelectorAll('.ctl-pane').forEach((p) => {
      p.classList.toggle('on', p.dataset.pane === this.active);
    });
    if (this.active === 'aid') this.refreshAid();
    if (this.active === 'diff' && this.io.ntrip) this.io.ntrip.refreshStatus();
  }

  /* ---------- 辅助定位 ---------- */

  /** 切到辅助定位页时刷新时钟和上次位置 */
  refreshAid() {
    const p = this.io.getPos && this.io.getPos();
    if (p && p.lat != null) this.lastPos = p;
    this.tickClock();
  }

  tickClock() {
    const el = this.root.querySelector('#aidClock');
    if (!el) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    el.textContent = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  }

  /* ---------- 差分 / NTRIP ---------- */

  setNtState(text, cls) {
    const el = this.root.querySelector('#ntState');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ok', cls === 'ok');
    el.classList.toggle('bad', cls === 'bad');
  }

  /** 渲染 NTRIP 状态：字节数、延迟、消息类型分布 */
  renderNtrip(st) {
    if (!st) return;
    const pick = (id) => this.root.querySelector('#' + id);
    const set = (id, v) => { const e = pick(id); if (e) e.textContent = v; };

    set('ntBytes', fmtBytes(st.bytes));
    set('ntFwd', fmtBytes(st.forwarded || 0));
    set('ntAge', st.lastDataAgo == null ? '—' : `${st.lastDataAgo.toFixed(1)} s`);
    set('ntGga', st.ggaAgo == null ? '—' : `${st.ggaAgo.toFixed(1)} s`);

    const box = pick('ntMsgs');
    if (box) {
      const list = describeMsgs(st.msgs);
      box.innerHTML = list.length
        ? list.map((m) => `<span class="nt-chip"><b>${m.id}</b>${m.name ? ' ' + m.name : ''}<i>×${m.n}</i></span>`).join('')
        : '<span class="dim">还没收到 RTCM 数据</span>';
    }

    if (st.error) this.setNtState('中断：' + st.error, 'bad');
    else if (st.connected) this.setNtState(`已连接 ${(st.info && st.info.mount) || ''}`, 'ok');
    else this.setNtState('未连接', '');
  }

  /** 把 $AIDINFO 的位图渲染成每系统一条进度 */  renderAid(info) {
    if (!info) return;
    // 各系统在轨可用星数上限（用于画进度条，取常见值即可）
    const CAP = { gps: 32, bds: 46, gal: 30, glo: 24 };
    for (const s of AID_SYS) {
      const v = info[s.key] || { rs: 0, us: 0 };
      const cap = CAP[s.key] || 32;
      const bar = this.root.querySelector(`#aidBar_${s.key}`);
      const num = this.root.querySelector(`#aidNum_${s.key}`);
      const tag = this.root.querySelector(`#aidUsed_${s.key}`);
      if (bar) {
        bar.style.width = Math.min(100, (v.us / cap) * 100).toFixed(0) + '%';
        bar.classList.toggle('ok', v.us >= cap * 0.6);
      }
      if (num) num.textContent = `收到 ${v.rs} · 可用 ${v.us}`;
      if (tag) {
        tag.textContent = v.us ? `${v.us}★` : '无星历';
        tag.classList.toggle('ok', v.us > 0);
      }
    }
    const at = this.root.querySelector('#aidAtype');
    if (at) {
      const flags = decodeAtype(info.atype);
      at.textContent = flags.length ? `Atype=0x${info.atype.toString(16)}：${flags.join('、')}` : `Atype=0x${info.atype.toString(16)}：无辅助生效`;
    }
  }

  segValue(name) {
    const box = this.root.querySelector(`.seg[data-seg="${name}"]`);
    if (!box) return null;
    const on = box.querySelector('button.on');
    return on ? on.dataset.val : null;
  }

  setSeg(name, val) {
    const box = this.root.querySelector(`.seg[data-seg="${name}"]`);
    if (!box) return;
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === String(val)));
  }

  checkedSys() {
    return [...this.root.querySelectorAll('input[data-sys]')]
      .filter((c) => c.checked)
      .map((c) => c.dataset.sys);
  }

  syncSysMask() {
    const mask = sysMaskFrom(this.checkedSys());
    const el = this.root.querySelector('#sysMaskView');
    if (el) el.textContent = toHex(mask);
    return mask;
  }

  setSysChecked(keys) {
    this.root.querySelectorAll('input[data-sys]').forEach((c) => {
      c.checked = keys.includes(c.dataset.sys);
    });
    this.syncSysMask();
  }

  /**
   * 收到一行数据：记录设备应答，并把 CFG* 回读值填回界面。
   * 这一步是必要的 —— 用户手册里没有的默认值（比如 MEMS 输入位、手持/车载模式、
   * 高程基准）如果拿界面默认值直接下发，会把模块原有配置覆盖掉。
   */
  pushResponse(line) {
    const body = line.replace(/^\$/, '').split('*')[0];
    const parts = body.split(',');
    const name = (parts[0] || '').toUpperCase();
    const f = parts.slice(1);

    // PMTK 的应答是 $PMTK001,<命令号>,<结果>，只来一条，不会刷屏；
    // $PUBX,00 是每秒一次的位置输出，混进来会把响应区冲掉，所以不收。
    if (name.startsWith('CFG') || name.startsWith('PMTK')
      || ['PDTINFO', 'FAIL', 'OK', 'RESET', 'ANTSTAT', 'LSF', 'CWOUT', 'VER', 'AIDINFO'].includes(name)) {
      this.resp.push(line);
      if (this.resp.length > 160) this.resp.shift();
      const box = this.root.querySelector('#ctlRespBody');
      if (box) {
        box.innerHTML = this.resp.slice(-80)
          .map((s) => `<div class="${/^\$FAIL/.test(s) ? 'bad' : ''}">${escapeHtml(s)}</div>`)
          .join('');
        box.scrollTop = box.scrollHeight;
      }
    }

    if (name === 'AIDINFO') this.renderAid(parseAidinfo(f));
    if (name.startsWith('CFG')) this.applyReadback(name, f);
  }

  /** 回读值 → 界面控件 */
  applyReadback(name, f) {
    // select 遇到规范里没有的取值时补一个选项，保证「原样保留」而不是被清空
    const sel = (id, v) => {
      const el = this.root.querySelector('#' + id);
      if (!el || v == null || v === '') return;
      const s = String(v);
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === s)) {
        const o = document.createElement('option');
        o.value = s;
        o.textContent = `${s} · 设备当前值`;
        el.appendChild(o);
      }
      el.value = s;
    };
    const inp = (id, v) => {
      const el = this.root.querySelector('#' + id);
      if (el && v != null && v !== '') el.value = String(v);
    };

    switch (name) {
      case 'CFGPRT': {
        // $CFGPRT,<port>,<reserved>,<baud>,<inProto>,<outProto>
        const port = Number(f[0]);
        if (port !== 1 && port !== 2) break;
        this.prtCfg[port] = { inProto: f[3] || null, outProto: f[4] || null };
        sel('prtPort', port);
        sel('prtBaud', f[2]);
        break;
      }
      case 'CFGSYS': {
        const mask = fromHex(f[0]);
        if (mask == null) break;
        const bits = bitsFromMask(mask);
        this.setSysChecked(SYS_BITS.filter((s) => bits.includes(s.bit)).map((s) => s.key));
        break;
      }
      case 'CFGINS':
        // $CFGINS,mode,ImusrcType,OdosrcType,MapsrcType
        sel('insMode', f[0]); sel('insImu', f[1]); sel('insOdo', f[2]); sel('insMap', f[3]);
        break;
      case 'CFGROTAT':
        inp('rotX', f[0]); inp('rotY', f[1]); inp('rotZ', f[2]); this.setSeg('rotMode', f[3]);
        break;
      case 'CFGODOFWD': this.setSeg('odoFwd', f[0]); break;
      case 'CFGDYN': sel('dynModel', f[1]); inp('dynThresh', f[2]); break;
      case 'CFGGEOID': this.setSeg('geoid', f[0]); break;
      case 'CFGCWOUT': this.setSeg('cwout', f[0]); break;
      case 'CFGTP': {
        inp('ppsLen', f[1]);
        const flag = Number(f[2]) || 0;
        this.setSeg('ppsEn', flag & 1 ? '1' : '0');
        this.setSeg('ppsEdge', flag & 2 ? '1' : '0');
        this.setSeg('ppsAlways', flag & 4 ? '1' : '0');
        inp('ppsAntDelay', f[3]);
        break;
      }
      case 'CFGNMEA': {
        const ver = String(f[0] || '').replace(/^[hH]/, '').toLowerCase();
        if (ver) this.setSeg('nmeaVer', 'h' + ver);
        this.setSeg('nmeaRate', f[1]);
        break;
      }
      default: break;
    }
  }

  /** 一次性读取全部可读配置（全部是只读查询，不改任何状态） */
  queryAll(silent) {
    if (this.vendor !== VENDOR.UNICORE) {
      if (!silent) this.toast('当前是标准 NMEA 模式，设备没有可回读的配置项', 3400);
      return;
    }
    const list = ['PDTINFO', 'CFGPRT,1', 'CFGSYS', 'CFGINS', 'CFGROTAT',
      'CFGODOFWD', 'CFGDYN', 'CFGGEOID', 'CFGTP', 'CFGNMEA'];
    for (const c of list) this.io.send(cmd(c));
    if (!silent) this.toast('已发起配置读取，回读值会填回各页签', 3400);
  }

  /**
   * 只发一条 $PDTINFO。
   * 自动识别模式下先用它探一下 —— 和芯星通设备会回型号和固件，其他设备一般静默。
   * 比一上来就甩十条 $CFG* 查询干净：陌生设备不会被灌一堆它不认识的命令。
   */
  probe() {
    this.io.send(cmd('PDTINFO'));
  }

  clearResp() {
    this.resp = [];
    const body = this.root.querySelector('#ctlRespBody');
    if (body) body.innerHTML = '<div class="dim">等待命令响应…</div>';
  }

  onClick(e) {
    const tabBtn = e.target.closest('.ctl-tabs button');
    if (tabBtn) { this.show(tabBtn.dataset.tab); return; }

    const segBtn = e.target.closest('.seg button');
    if (segBtn) {
      const box = segBtn.parentElement;
      box.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
      segBtn.classList.add('on');
      // 厂商模式是界面开关，交给主程序记住并重算页签，不是设备命令
      if (box.dataset.seg === 'vendor' && this.io.setVendorMode) {
        this.io.setVendorMode(segBtn.dataset.val);
      }
      if (box.dataset.seg === 'ppsEn' || box.dataset.seg === 'ppsAlways' || box.dataset.seg === 'ppsEdge') {
        // PPS 三个开关联动，不单独下发，等用户点「下发」
      }
      return;
    }

    const chip = e.target.closest('.chip');
    if (chip) {
      const on = !chip.classList.contains('on');
      chip.classList.toggle('on', on);
      if (chip.dataset.savebit != null) return;      // 保存掩码，等点写入
      if (chip.dataset.sys) { this.syncSysMask(); return; } // 星座勾选
      this.send(cmd(`CFGMSG,${chip.dataset.cls},${chip.dataset.id},${on ? 1 : 0}`));
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) { this.runAction(act.dataset.act, act.dataset.val); return; }
  }

  runAction(act, val) {
    const v = (id) => {
      const el = this.root.querySelector('#' + id);
      return el ? el.value : '';
    };
    const num = (id, d = 0) => {
      const n = Number(v(id));
      return Number.isFinite(n) ? n : d;
    };

    switch (act) {
      /* ---------- 输出与协议 ---------- */
      case 'setNmea':
        this.send(cmd(`CFGNMEA,${this.segValue('nmeaVer') || 'h51'},${this.segValue('nmeaRate') || '0'}`));
        this.toast('已下发 NMEA 版本与频率，需 $CFGSAVE 才会持久化');
        break;
      case 'setEcho':
        this.send(cmd(`CFGMSG,6,2,${this.segValue('echoState') || '0'}`));
        break;
      case 'queryInsMsg':
        this.send(cmd('CFGMSG,2,1'));
        break;
      case 'queryPrt':
        this.send(cmd(`CFGPRT,${v('prtPort') || 1}`));
        break;
      case 'setPrt': {
        const port = Number(v('prtPort') || 1);
        const baud = v('prtBaud') || '115200';
        const kept = this.prtCfg[port] || {};
        // 关键：协议位必须沿用回读值。inProto 的 bit10 是 MEMS 输入，
        // 组合导航靠它吃 IMU 数据，用界面默认值覆盖会让惯导失效。
        const inProto = kept.inProto || 'h481';
        const outProto = kept.outProto || 'hA3';
        if (!kept.inProto) {
          this.toast('尚未读到该串口当前协议位，将按实测默认值下发，建议先点「读取当前配置」', 5200);
        }
        if (!confirm(`即将把串口 ${port} 改为 ${baud} bps。\n协议位保持不变：in=${inProto} out=${outProto}\n\n下发后本连接立即失效，需要在上位机里切换波特率重连。\n继续？`)) return;
        this.send(cmd(`CFGPRT,${port},h0,${baud},${inProto},${outProto}`));
        this.toast('已下发串口配置，请立刻切到新波特率重连', 6000);
        break;
      }

      /* ---------- 星座 ---------- */
      case 'setSys': {
        const mask = this.syncSysMask();
        if (!confirm(`即将下发 $CFGSYS,${toHex(mask)}\n接收机会自动复位，重新出星约需 30 秒。\n\n继续？`)) return;
        this.send(cmd(`CFGSYS,${toHex(mask)}`));
        this.toast('已下发星座配置，接收机复位中…', 5000);
        break;
      }
      case 'applyDefaultSys':
        this.setSysChecked(SYS_BITS.filter((s) => s.on).map((s) => s.key));
        break;
      case 'presetSys': {
        const all = SYS_BITS.filter((s) => s.on).map((s) => s.key);
        if (val === 'gpsOnly') this.setSysChecked(['gpsL1', 'gpsL5']);
        if (val === 'noGlo') this.setSysChecked(all.filter((k) => k !== 'gloL1'));
        if (val === 'lowPower') this.setSysChecked(['gpsL1', 'bdsB1I', 'gloL1', 'galE1']);
        break;
      }

      /* ---------- 组合导航 ---------- */
      case 'setIns':
        this.send(cmd(`CFGINS,${v('insMode') || 1},${v('insImu') || 1},${v('insOdo') || 1},${v('insMap') || 0}`));
        break;
      case 'setRot':
        this.send(cmd(`CFGROTAT,${num('rotX')},${num('rotY')},${num('rotZ')},${this.segValue('rotMode') || 2}`));
        this.toast('已下发安装角配置');
        break;
      case 'setOdoFwd':
        this.send(cmd(`CFGODOFWD,${this.segValue('odoFwd') || 1}`));
        break;
      case 'setDyn':
        this.send(cmd(`CFGDYN,h03,${v('dynModel') || 0},${num('dynThresh')}`));
        break;
      case 'setGeoid':
        this.send(cmd(`CFGGEOID,${this.segValue('geoid') || 1}`));
        break;
      case 'queryIns': this.send(cmd('CFGINS')); break;
      case 'queryRot': this.send(cmd('CFGROTAT')); break;
      case 'queryOdo': this.send(cmd('CFGODOFWD')); break;
      case 'queryDyn': this.send(cmd('CFGDYN')); break;
      case 'queryGeoid': this.send(cmd('CFGGEOID')); break;

      /* ---------- 授时 ---------- */
      case 'setTp': {
        const flag = (this.segValue('ppsEn') === '1' ? 1 : 0) * 1
          + (this.segValue('ppsEdge') === '1' ? 2 : 0)
          + (this.segValue('ppsAlways') === '1' ? 4 : 0);
        this.send(cmd(`CFGTP,1000000,${clampInt(num('ppsLen', 500000), 1, 999999)},${flag},${clampInt(num('ppsAntDelay', 0), -32768, 32767)},0,0`));
        break;
      }
      case 'setCwout':
        this.send(cmd(`CFGCWOUT,${this.segValue('cwout') || 0}`));
        break;
      case 'queryTp': this.send(cmd('CFGTP')); break;
      case 'queryCwout': this.send(cmd('CFGCWOUT')); break;

      /* ---------- 标准 NMEA ---------- */
      case 'sendRaw': {
        // val 是命令正文（不含 $ 和校验和），校验和在这里现算，避免手抄出错
        const line = genericCommand(String(val || ''));
        if (!val) return;
        this.send(line);
        const echo = this.root.querySelector('#genEcho');
        if (echo) echo.textContent = line;
        this.toast('已发送，这类命令通常没有应答，看语句有没有变化', 3200);
        break;
      }
      case 'probeUnicore':
        this.send(cmd('PDTINFO'));
        this.toast('已发送 $PDTINFO。和芯星通设备会回型号与固件版本，其他设备一般静默', 4200);
        break;

      /* ---------- 系统 ---------- */
      case 'readAll': this.queryAll(); break;
      case 'queryPdt': this.send(cmd('PDTINFO')); break;
      case 'queryVersion': this.send(cmd('CFGPRT,1')); this.send(cmd('CFGSYS')); break;
      case 'saveCfg': {
        const bits = [...this.root.querySelectorAll('[data-savebit]')]
          .filter((c) => c.classList.contains('on'))
          .map((c) => Number(c.dataset.savebit));
        if (!bits.length) { this.toast('至少选一项要保存的配置'); return; }
        const mask = maskFromBits(bits);
        if (!confirm(`即将写入 Flash：$CFGSAVE,${toHex(mask)}\n下发后 1 秒内不要断电。\n\n继续？`)) return;
        this.send(cmd(`CFGSAVE,${toHex(mask)}`));
        this.toast('已下发保存命令，请勿断电', 5000);
        break;
      }
      case 'resetHot':
        if (confirm('热启动 $RESET,0,h00：保留星历，定位可快速恢复。继续？')) this.send(cmd('RESET,0,h00'));
        break;
      case 'resetWarm':
        if (confirm('温启动 $RESET,0,h01：清除位置与时间，需重新收敛。继续？')) this.send(cmd('RESET,0,h01'));
        break;
      case 'resetCold':
        if (confirm('冷启动 $RESET,0,h85：清空星历，首次定位需 30~60 秒。继续？')) this.send(cmd('RESET,0,h85'));
        break;
      case 'clearCfg':
        if (confirm('恢复出厂 $CFGCLR：串口、语句、星座配置全部回到默认，复位后生效。\n\n这个操作不可撤销，确定继续？')) {
          this.send(cmd('CFGCLR'));
          this.toast('已下发恢复出厂配置', 5000);
        }
        break;
      /* ---------- 差分 / NTRIP ---------- */
      case 'ntripConnect': {
        const cfg = {
          host: v('ntHost').trim(),
          port: Number(v('ntPort')) || 8002,
          mount: v('ntMount').trim() || 'AUTO',
          user: v('ntUser').trim(),
          pass: v('ntPass'),
        };
        if (!cfg.host) { this.toast('先填 caster 地址'); break; }
        if (!cfg.user || !cfg.pass) { this.toast('先填差分账号和密码'); break; }
        if (!this.io.ntrip) { this.toast('差分模块没初始化'); break; }
        this.setNtState('连接中…', '');
        this.io.ntrip.setForward(this.segValue('ntFwd') !== '0');
        this.io.ntrip.connect(cfg).then((r) => {
          if (r.ok) this.setNtState('已连接 ' + cfg.mount, 'ok');
          else this.setNtState('连接失败', 'bad');
        });
        break;
      }
      case 'ntripDisconnect':
        if (this.io.ntrip) this.io.ntrip.disconnect();
        this.setNtState('未连接', '');
        break;

      /* ---------- 辅助定位 ---------- */
      case 'aidTime': {
        const d = new Date();
        const t = `AIDTIME,${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()},`
          + `${d.getUTCHours()},${d.getUTCMinutes()},${d.getUTCSeconds()},${d.getUTCMilliseconds()}`;
        this.send(cmd(t));
        this.toast('已注入 UTC 时间辅助', 3000);
        break;
      }
      case 'aidUseLast': {
        const p = this.io.getPos && this.io.getPos();
        const store = this.lastPos || (p && p.lat != null ? p : null);
        if (!store) { this.toast('还没有定位过，先手动填纬度经度'); return; }
        const el = (id) => this.root.querySelector('#' + id);
        if (el('aidLat')) el('aidLat').value = store.lat.toFixed(6);
        if (el('aidLon')) el('aidLon').value = store.lon.toFixed(6);
        if (el('aidAlt')) el('aidAlt').value = (store.alt != null ? store.alt : 0).toFixed(1);
        break;
      }
      case 'aidPos': {
        const lat = Number(v('aidLat'));
        const lon = Number(v('aidLon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          this.toast('纬度或经度不合法'); return;
        }
        const alt = Number(v('aidAlt'));
        const body = `AIDPOS,${nmeaCoord(lat, 2)},${lat >= 0 ? 'N' : 'S'},`
          + `${nmeaCoord(lon, 3)},${lon >= 0 ? 'E' : 'W'},${Number.isFinite(alt) ? alt.toFixed(3) : '0.000'}`;
        this.send(cmd(body));
        this.toast('已注入位置辅助', 3000);
        break;
      }
      case 'aidInfo': this.send(cmd('AIDINFO')); break;
      case 'clearResp': this.clearResp(); break;
      default: break;
    }
  }

  send(c) {
    if (!this.io.isConnected()) { this.toast('未连接串口，命令未发送'); return; }
    this.io.send(c);
  }

  toast(msg, ms) { this.io.toast(msg, ms); }
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 字节数转可读字符串 */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(2)} MB`;
}
