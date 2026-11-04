/**
 * vendor.js — 厂商适配层
 *
 * 这个工具的主干是标准 NMEA-0183，任何吐 NMEA 的接收机都能直接用：天空图、载噪比、
 * 轨迹、时序、导出、日志分析都不依赖具体型号。
 *
 * 差异只出在「下行配置」上：NMEA-0183 只有输出、没有配置通道，想改语句开关和频率
 * 必须走芯片厂商自己的命令。所以这里把配置能力单独抽一层：
 *
 *   nmea     标准 NMEA —— 只读 + 通用文本命令（MediaTek $PMTK / u-blox $PUBX,40）
 *   unicore  和芯星通   —— $CFG* / $PDTINFO / $SNRSTAT，完整控制中心
 *
 * 识别全部靠被动观察，不主动探测：收到 $PDTINFO 或 $CFG* 就认定 Unicore，
 * 收到 $PMTK / $PUBX 记下芯片家族。没有证据就一律按标准 NMEA 处理，
 * 绝不对陌生设备发私有命令。
 */

import { checksum } from './nmea.js';

export const VENDOR = {
  AUTO: 'auto',
  NMEA: 'nmea',
  UNICORE: 'unicore',
};

export const VENDOR_LABEL = {
  [VENDOR.AUTO]: '自动识别',
  [VENDOR.NMEA]: '标准 NMEA',
  [VENDOR.UNICORE]: '和芯星通 Unicore',
};

/** 拼一条带校验和的 NMEA 文本命令（校验和是两位十六进制大写，不是十进制） */
export function genericCommand(body) {
  const cs = checksum(body).toString(16).toUpperCase().padStart(2, '0');
  return `$${body}*${cs}`;
}

/**
 * 通用 NMEA 设备的可用命令。
 *
 * 只有文本命令，没有 UBX 二进制帧 —— 后者需要独立的帧解析与收发通道，本版本不做，
 * 与其给个半残的实现，不如在文档里写清楚。
 */
export const GENERIC_GROUPS = [
  {
    family: 'MediaTek',
    hint: 'MT33xx / AG3335 / AG3352 等。PMTK 命令没有应答，下发后看语句是否变化。',
    items: [
      { label: '1 Hz', body: 'PMTK220,1000' },
      { label: '5 Hz', body: 'PMTK220,200' },
      { label: '10 Hz', body: 'PMTK220,100' },
      { label: '六句全开', body: 'PMTK314,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0' },
      { label: '只留 GGA/RMC/GSA/GSV', body: 'PMTK314,0,1,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0' },
    ],
  },
  {
    family: 'u-blox',
    hint: 'M8 / M9 / M10 / F9P 等。$PUBX,40 一次只改一条语句，第四列是 UART1 频率。',
    items: [
      { label: 'GGA 1 Hz', body: 'PUBX,40,GGA,0,1,0,0,0' },
      { label: 'RMC 1 Hz', body: 'PUBX,40,RMC,0,1,0,0,0' },
      { label: 'GSA 1 Hz', body: 'PUBX,40,GSA,0,1,0,0,0' },
      { label: 'GSV 1 Hz', body: 'PUBX,40,GSV,0,1,0,0,0' },
      { label: 'GGA 5 Hz', body: 'PUBX,40,GGA,0,5,0,0,0' },
      { label: '全部关掉', body: 'PUBX,40,GGA,0,0,0,0,0' },
    ],
  },
];

/**
 * 被动识别设备类型。
 *
 * 只认「有明确证据」的私有语句：一条 $PDTINFO 或 $CFGPRT 比几十条 NMEA 更有说服力。
 * 没有任何私有语句时保持标准 NMEA，避免把普通模块当成 Unicore 设备乱发命令。
 */
export class VendorDetector {
  constructor() {
    this.vendor = VENDOR.NMEA;
    this.model = '';
    this.firmware = '';
    this.family = '';       // MediaTek / u-blox，仅用于顶栏显示
    this.nmeaLines = 0;
  }

  /** 喂一行原始语句；返回值表示「识别结果有变化」 */
  feed(line) {
    if (!line || line[0] !== '$') return false;
    const body = line.slice(1).split('*')[0];
    const name = (body.split(',')[0] || '').toUpperCase();
    const before = this.signature();

    if (name === 'PDTINFO') {
      const f = body.split(',').slice(1);
      this.vendor = VENDOR.UNICORE;
      if (f[0]) this.model = f[0];
      // $PDTINFO,<产品>,<系统>,<硬件版本>,<固件版本>,<序列号>,<ID>
      if (f[3]) this.firmware = f[3];
    } else if (/^CFG[A-Z]+$/.test(name) || name === 'AIDINFO' || name === 'SNRSTAT') {
      // 能回这些语句的设备，一定是和芯星通的固件
      this.vendor = VENDOR.UNICORE;
    } else if (name === 'PMTK') {
      this.family = 'MediaTek';
    } else if (name === 'PUBX') {
      this.family = 'u-blox';
    } else {
      this.nmeaLines++;
    }

    return this.signature() !== before;
  }

  /** 换一块板子重新开始识别，别把上一台的结论带过来 */
  reset() {
    this.vendor = VENDOR.NMEA;
    this.model = '';
    this.firmware = '';
    this.family = '';
    this.nmeaLines = 0;
  }

  signature() {
    return `${this.vendor}|${this.model}|${this.firmware}|${this.family}`;
  }

  /** 顶栏与面板上显示的名字 */
  get label() {
    if (this.vendor === VENDOR.UNICORE) {
      // 没读到 $PDTINFO 时只知道是 Unicore 系固件，不编型号
      const m = this.model || '和芯星通 Unicore';
      return this.firmware ? `${m} · ${this.firmware}` : m;
    }
    return this.family ? `标准 NMEA · ${this.family}` : '标准 NMEA';
  }

  /** 是否已经能确认厂商（用来决定要不要发查询命令） */
  get confident() {
    return this.vendor === VENDOR.UNICORE || this.nmeaLines >= 60;
  }
}

/**
 * 把「用户选择的模式」和「实际识别结果」合成真正生效的厂商。
 * 用户选了标准 NMEA 就不能被自动识别翻回 Unicore —— 手动优先。
 */
export function resolveVendor(mode, detected) {
  if (mode === VENDOR.AUTO) return detected || VENDOR.NMEA;
  return mode;
}
