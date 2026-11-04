/**
 * nmea.js — NMEA-0183 协议解析核心（含和芯星通私有帧）
 * 纯逻辑，无 DOM 依赖，可在浏览器与 Node 中运行。
 *
 * 支持：
 *   NMEA-0183  GGA / RMC / GSA / GSV / VTG / GLL / ZDA / TXT
 *   Unicore   $SNRSTAT / $ODODATA / $CFGROTAT 等私有帧
 *
 * 设计说明（对标开源实现）：
 *   - GSA 按 NMEA 4.11 第 19 位「系统 ID」分星座记录（u-center / gpsd 同一处理方式）
 *   - 卫星主键带系统前缀（GP03 / GQ03），避免跨系统 PRN 撞号
 *   - GSV 按「整轮收齐再替换」更新，落山卫星自动清除
 */

export const SYS = {
  GP: { name: 'GPS',     short: 'GPS', color: '#4ea8ff' },
  GL: { name: 'GLONASS', short: 'GLO', color: '#ffd23f' },
  GA: { name: 'Galileo', short: 'GAL', color: '#b57bff' },
  GB: { name: '北斗',    short: 'BDS', color: '#ff7a45' },
  BD: { name: '北斗',    short: 'BDS', color: '#ff7a45' },
  GQ: { name: 'QZSS',    short: 'QZS', color: '#3ddc84' },
  GI: { name: 'NavIC',   short: 'IRC', color: '#ff6b9d' },
  SB: { name: 'SBAS',    short: 'SBA', color: '#00d4c8' },
  GN: { name: '组合',    short: 'MIX', color: '#8b9bb0' },
};

/**
 * SBAS 卫星号段（和芯星通私有编号）。
 * 协议原文：「SBAS 卫星号为 33~51」——注意不是 NMEA 标准的 120~158。
 * 这些卫星混在 $GPGSV 里输出，必须按编号拆出来单独标星座，
 * 否则会被当成 GPS 卫星，天空图和卫星表都会误导。
 */
const SBAS_PRN_LO = 33;
const SBAS_PRN_HI = 51;

/** NMEA 4.11 GSA 系统 ID → 星座前缀 */
const GSA_SYSID = { 1: 'GP', 2: 'GL', 3: 'GA', 4: 'GB', 5: 'GQ', 6: 'GI' };

/** 定位质量（GGA 字段 6） */
export const FIX_QUALITY = {
  0: { text: '未定位', cls: 'bad' },
  1: { text: '单点定位', cls: 'warn' },
  2: { text: '差分定位', cls: 'ok' },
  3: { text: 'PPS 定位', cls: 'ok' },
  4: { text: 'RTK 固定', cls: 'good' },
  5: { text: 'RTK 浮动', cls: 'warn' },
  6: { text: '航位推算', cls: 'warn' },
  7: { text: '手动输入', cls: 'dim' },
  8: { text: '仿真模式', cls: 'dim' },
};

/** GSA 定位模式（字段 2） */
export const FIX_TYPE = {
  1: { text: '未定位', cls: 'bad' },
  2: { text: '2D 定位', cls: 'warn' },
  3: { text: '3D 定位', cls: 'good' },
};

/** Unicore insstatus 解码（用户手册 2.2.2.4 节 SNRSTAT） */
export const INS_STATUS = {
  '-1': 'IMU 器件故障',
  0: '关闭',
  1: '初始化开始',
  2: '已知安装角',
  3: '初始化完成',
};

/** Unicore odostatus 解码 */
export const ODO_STATUS = {
  '-1': '里程计器件故障',
  0: '关闭',
  1: '刻度因数初始化',
  2: '刻度因数初始化完成',
};

/** NMEA 校验和：$ 与 * 之间所有字节异或 */
export function checksum(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c;
}

/** 校验一条语句，返回 {ok, body, hasSum} */
export function verify(line) {
  const star = line.lastIndexOf('*');
  if (star < 0) return { ok: true, body: line.slice(1), hasSum: false }; // 无校验和，放行
  const body = line.slice(1, star);
  const sum = line.slice(star + 1, star + 3).toUpperCase();
  return { ok: checksum(body).toString(16).toUpperCase().padStart(2, '0') === sum, body, hasSum: true };
}

const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
const int = (v) => (v === '' || v === undefined || v === null ? null : parseInt(v, 10));

/** ddmm.mmmm → 十进制度 */
export function parseCoord(val, hemi) {
  if (!val) return null;
  const dot = val.indexOf('.');
  if (dot < 3) return null;
  const deg = Number(val.slice(0, dot - 2));
  const min = Number(val.slice(dot - 2));
  if (!isFinite(deg) || !isFinite(min)) return null;
  let d = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') d = -d;
  return d;
}

/** 各语句解析器：返回普通对象，不需状态 */
export function parseGGA(f) {
  return {
    utc: f[1],
    lat: parseCoord(f[2], f[3]), lon: parseCoord(f[4], f[5]),
    quality: int(f[6]), sats: int(f[7]), hdop: num(f[8]),
    alt: num(f[9]), altUnit: f[10], geoid: num(f[11]),
    diffAge: num(f[13]), station: f[14],
  };
}

export function parseRMC(f) {
  return {
    utc: f[1], status: f[2],
    lat: parseCoord(f[3], f[4]), lon: parseCoord(f[5], f[6]),
    sog: num(f[7]), cog: num(f[8]),
    date: f[9], magVar: num(f[10]), mode: f[12],
  };
}

export function parseVTG(f) {
  return {
    cogT: num(f[1]), cogM: num(f[3]),
    sogN: num(f[5]), sogK: num(f[7]), mode: f[9],
  };
}

export function parseGSA(f) {
  // 12 个卫星槽位：f[3]..f[14]；f[15..17]=PDOP/HDOP/VDOP；f[18]=系统ID(NMEA4.11)
  const sats = [];
  for (let i = 3; i <= 14; i++) if (f[i]) sats.push(f[i]);
  const sysId = int(f[18]);
  return {
    mode: f[1], fix: int(f[2]), sats,
    pdop: num(f[15]), hdop: num(f[16]), vdop: num(f[17]),
    sysId, sys: GSA_SYSID[sysId] || null,
  };
}

export function parseGSV(f) {
  const total = int(f[1]), idx = int(f[2]), inView = int(f[3]);
  const sats = [];
  for (let i = 4; i + 3 < f.length + 1 && i <= f.length - 3; i += 4) {
    const prn = f[i];
    if (!prn) continue;
    sats.push({ prn, el: int(f[i + 1]), az: int(f[i + 2]), snr: int(f[i + 3]) });
  }
  return { total, idx, inView, sats };
}

export function parseTXT(f) {
  // $GNTXT,01,01,02,msg*hh
  return { numMsg: int(f[1]), msgNum: int(f[2]), type: int(f[3]), text: f.slice(4).join(',') };
}

/**
 * GNSS 会话状态：把逐条语句汇总成可视化需要的模型
 */
export class GnssState {
  constructor(opts = {}) {
    // 轨迹上限放宽到 20000 点：1Hz 下能覆盖 5 小时以上，够一次完整路测。
    // 绘图侧会做抽稀（见 app.js drawTrack），所以不担心画不动。
    this.trackLimit = opts.trackLimit ?? 20000;
    this.seriesLimit = opts.seriesLimit ?? 300;
    this.reset();
  }

  reset() {
    this.fix = null;              // GSA fix type
    this.fixQuality = null;       // GGA quality
    this.utc = null;
    this.date = null;
    this.lat = null; this.lon = null;
    this.alt = null; this.geoid = null;
    this.speedKn = null; this.speedKmh = null;
    this.course = null;
    this.pdop = null; this.hdop = null; this.vdop = null;
    this.satsUsed = 0;
    this.diffAge = null; this.station = null;

    this.sats = new Map();        // key "GP03" -> {sys, prn, el, az, snr, used}
    this.gsvCycle = new Map();    // sys -> { total, inView, parts: Map(idx -> entries) }
    this.gsaUsed = new Map();     // sys -> Set(prn)

    this.track = [];              // [{lat, lon, alt, t}]
    this.series = [];             // [{t, visible, used, hdop, snrAvg}]
    this.txt = [];                // 最近状态文本
    this.unicore = {};            // 私有帧最新值
    this.msgCount = new Map();    // 语句类型计数
    this.badChecksum = 0;
    this.lastMsgAt = 0;
    this._lastSeriesAt = 0;
  }

  /** 处理一行原始语句（不含换行） */
  ingest(rawLine) {
    const line = rawLine.trim();
    if (!line || line[0] !== '$') return null;

    const v = verify(line);
    if (!v.ok) { this.badChecksum++; return null; }

    const f = v.body.split(',');
    const head = f[0];
    const talker = head.slice(0, 2);
    const type = head.slice(2);
    const key = type === '' ? head : talker + type;

    this.msgCount.set(key, (this.msgCount.get(key) || 0) + 1);
    const now = Date.now();
    this.lastMsgAt = now;

    switch (type) {
      case 'GGA': this._gga(parseGGA(f), now); break;
      case 'RMC': this._rmc(parseRMC(f), now); break;
      case 'VTG': this._vtg(parseVTG(f)); break;
      case 'GSA': this._gsa(parseGSA(f)); break;
      case 'GSV': this._gsv(talker, parseGSV(f)); break;
      case 'TXT': this._txt(parseTXT(f)); break;
      default:
        // Unicore 私有帧（$SNRSTAT / $ODODATA / $CFGROTAT ...）
        if (head.length > 2 && !/^GN|^GP|^GL|^GA|^GB|^BD|^GQ|^GI/.test(head)) {
          this._unicore(head, f.slice(1));
        }
        break;
    }
    return key;
  }

  _gga(d, now) {
    this.utc = d.utc;
    this.fixQuality = d.quality;
    this.satsUsed = d.sats ?? 0;
    this.hdop = d.hdop ?? this.hdop;
    this.alt = d.alt;
    this.geoid = d.geoid;
    this.diffAge = d.diffAge; this.station = d.station;
    if (d.lat != null && d.lon != null && d.quality > 0) {
      this.lat = d.lat; this.lon = d.lon;
      this._pushTrack(now);
    }
    this._pushSeries(now);
  }

  _rmc(d, now) {
    this.utc = d.utc || this.utc;
    this.date = d.date || this.date;
    if (d.status === 'A') {
      if (d.lat != null && d.lon != null) { this.lat = d.lat; this.lon = d.lon; }
      this.speedKn = d.sog;
      this.speedKmh = d.sog == null ? null : d.sog * 1.852;
      this.course = d.cog;
    } else {
      this.speedKn = null; this.speedKmh = null;
    }
  }

  _vtg(d) {
    if (d.cogT != null) this.course = d.cogT;
    if (d.sogK != null) this.speedKmh = d.sogK;
    if (d.sogN != null) this.speedKn = d.sogN;
  }

  _gsa(d) {
    if (d.fix != null) this.fix = d.fix;
    if (d.pdop != null) this.pdop = d.pdop;
    if (d.hdop != null) this.hdop = d.hdop;
    if (d.vdop != null) this.vdop = d.vdop;
    // 按系统分组记录「参与解算」的 PRN，不做全局重置
    const sys = d.sys || 'GN';
    if (!this.gsaUsed.has(sys)) this.gsaUsed.set(sys, new Set());
    const set = this.gsaUsed.get(sys);
    set.clear();
    for (const p of d.sats) set.add(String(p).padStart(2, '0'));
    this._applyUsed();
  }

  _applyUsed() {
    for (const sat of this.sats.values()) {
      const set = this.gsaUsed.get(sat.sys);
      sat.used = !!(set && set.has(sat.prn));
    }
  }

  _gsv(talker, d) {
    const sys = SYS[talker] ? talker : (talker === 'BD' ? 'GB' : 'GN');
    let cyc = this.gsvCycle.get(sys);
    if (!cyc || d.idx === 1 || d.idx <= (cyc.lastIdx || 0)) {
      cyc = { total: d.total, inView: d.inView, parts: new Map() };
      this.gsvCycle.set(sys, cyc);
    }
    cyc.lastIdx = d.idx;
    cyc.total = d.total;
    cyc.inView = d.inView;
    cyc.parts.set(d.idx, d.sats);

    // 一轮收齐 → 整星座替换（落山卫星自动清除）
    if (cyc.parts.size >= cyc.total) {
      for (const [k, sat] of [...this.sats]) {
        if (sat.sys === sys) this.sats.delete(k);
        // SBAS 从 GPGSV 里拆出去单独存放，清理时也要跟着走
        else if (sys === 'GP' && sat.sys === 'SB') this.sats.delete(k);
      }
      if (cyc.inView > 0) {
        for (const part of cyc.parts.values()) {
          for (const s of part) {
            const num = Number(s.prn);
            const owner = (sys === 'GP' && num >= SBAS_PRN_LO && num <= SBAS_PRN_HI)
              ? 'SB' : sys;
            const prn = String(s.prn).padStart(2, '0');
            this.sats.set(owner + prn, {
              sys: owner, prn, el: s.el, az: s.az, snr: s.snr, used: false,
            });
          }
        }
      }
      this._applyUsed();
      this.gsvCycle.delete(sys);
    }
  }

  _txt(d) {
    if (!d.text) return;
    this.txt.push({ t: Date.now(), text: d.text });
    if (this.txt.length > 20) this.txt.shift();
  }

  _unicore(head, fields) {
    const name = head.toUpperCase();
    this.unicore[name] = fields;
    if (name === 'SNRSTAT') {
      // $SNRSTAT,<insstatus>,<odostatus>,<...>
      this.unicore.insstatus = int(fields[0]);
      this.unicore.odostatus = int(fields[1]);
    }
  }

  _pushTrack(now) {
    const last = this.track[this.track.length - 1];
    if (last && Math.abs(last.lat - this.lat) < 1e-9 && Math.abs(last.lon - this.lon) < 1e-9) return;
    this.track.push({
      lat: this.lat,
      lon: this.lon,
      alt: this.alt,
      t: now,
      // 下面四个字段绘图不读，只给导出用（GPX 的 <ele>/<hdop>、CSV 的速度列）。
      // speed/course 由 RMC/VTG 更新，可能比这一拍 GGA 晚半句，误差在 1 秒内。
      speed: this.speedKmh,
      course: this.course,
      hdop: this.hdop,
      quality: this.fixQuality,
    });
    if (this.track.length > this.trackLimit) this.track.shift();
  }

  _pushSeries(now) {
    if (now - this._lastSeriesAt < 900) return;
    this._lastSeriesAt = now;
    let visible = 0, used = 0, snrSum = 0, snrN = 0;
    for (const s of this.sats.values()) {
      visible++;
      if (s.used) used++;
      if (s.snr != null) { snrSum += s.snr; snrN++; }
    }
    this.series.push({
      t: now, visible, used,
      hdop: this.hdop, snrAvg: snrN ? snrSum / snrN : null,
    });
    if (this.series.length > this.seriesLimit) this.series.shift();
  }

  /** 各星座统计 */
  bySystem() {
    const out = new Map();
    for (const s of this.sats.values()) {
      let e = out.get(s.sys);
      if (!e) { e = { sys: s.sys, visible: 0, used: 0 }; out.set(s.sys, e); }
      e.visible++;
      if (s.used) e.used++;
    }
    return out;
  }

  /** 卫星按系统 + PRN 排序后的数组（与 u-center 的星座排列顺序一致） */
  satList() {
    const order = { GP: 0, GB: 1, GL: 2, GA: 3, GQ: 4, GI: 5, GN: 6 };
    return [...this.sats.values()].sort((a, b) => {
      const d = (order[a.sys] ?? 9) - (order[b.sys] ?? 9);
      if (d !== 0) return d;
      return Number(a.prn) - Number(b.prn);
    });
  }

  /** 导出为可直接落盘的对象快照 */
  snapshot() {
    return {
      time: new Date().toISOString(),
      fix: this.fix, fixQuality: this.fixQuality,
      lat: this.lat, lon: this.lon, alt: this.alt,
      speedKmh: this.speedKmh, course: this.course,
      pdop: this.pdop, hdop: this.hdop, vdop: this.vdop,
      satsUsed: this.satsUsed,
      visible: this.sats.size,
      ins: this.unicore.insstatus ?? null,
      odo: this.unicore.odostatus ?? null,
      satellites: this.satList(),
    };
  }
}
