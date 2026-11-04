/*
 * UM621A 手机采集器 —— NMEA 解析
 *
 * 从 collector.py 移植过来，几个实测踩过的坑必须保留：
 *   1) UM621A 每秒发 5 条 GSA，一条只列本星座，第 19 字段是系统 ID。
 *      必须按星座分别记，否则后一句会把前面的星座全清掉。
 *   2) SBAS 用 33~51 号（和芯星通私有编号），混在 $GPGSV 里输出。
 *      按 talker 归星座会误判成 GPS，必须按编号段拆出来。
 *   3) HDOP = 99.99 是占位符，不是真实值，显示时要剔除。
 */

/** 轨迹点：时间戳 + 经纬度 */
export class TrailPoint {
  t: number = 0;
  lat: number = 0;
  lon: number = 0;
}

/** 一颗卫星 */
export class SatInfo {
  /** 星座：GPS/GLO/GAL/BDS/QZS/SB */
  sys: string = '';
  prn: number = 0;
  /** 仰角 0~90 度 */
  elev: number = 0;
  /** 方位角 0~359 度 */
  azim: number = 0;
  /** 信噪比 dBHz，0 表示没报 */
  snr: number = 0;
  /** 最后一次出现的时间戳（毫秒） */
  seenAt: number = 0;
  /** 是否参与当前解算（来自 GSA） */
  used: boolean = false;
}

/** 惯导状态，来自 $SNRSTAT,insstatus,odostatus,InstallState,mapstat */
export class InsStatus {
  /** 是否收到过该语句 */
  valid: boolean = false;
  /** 惯导状态：-1 IMU异常 / 0 未启动 / 1~2 对准中 / 3 组合导航 / 4 纯惯导 */
  ins: number = 0;
  /** 里程计：0 无 / 1 有 */
  odo: number = 0;
  /** 安装角标定：0 未标定 / 1 已标定 */
  install: number = 0;
  /** 地图匹配状态 */
  map: number = 0;
}

/** 惯导状态码转中文。映射依据协议格式 + 实测（静止时恒为 1，校准完成为 3） */
export function insLabel(v: number): string {
  if (v === -1) {
    return 'IMU异常';
  }
  if (v === 0) {
    return '未启动';
  }
  if (v === 1) {
    return '对准中';
  }
  if (v === 2) {
    return '精对准';
  }
  if (v === 3) {
    return '组合导航';
  }
  if (v === 4) {
    return '纯惯导';
  }
  return '未知(' + v + ')';
}

/** 给界面用的定位快照 */
export class FixSnapshot {
  lat: number = 0;
  lon: number = 0;
  hasPos: boolean = false;
  // 用 NaN 表示"没有值"，界面统一显示成 —。
  // 之前用 -1 当哨兵值，结果界面上显示出 -1.00 / -1.0 这种鬼东西
  alt: number = NaN;
  quality: number = 0;
  qualityLabel: string = '无定位';
  satsUsed: number = 0;
  satsUsedSum: number = 0;
  visibleTotal: number = 0;
  hdop: number = NaN;
  pdop: number = NaN;
  vdop: number = NaN;
  speedKmh: number = NaN;
  course: number = NaN;
  utc: string = '';
  date: string = '';
  mode: string = '';
  fixAge: number = -1;
  snrAvg: number = NaN;
  ckOk: number = 0;
  ckBad: number = 0;
  totalLines: number = 0;
  trailN: number = 0;
  /** 各星座解算数，键是 GPS/GLO/GAL/BDS/QZS/SB */
  usedBySys: Map<string, number> = new Map<string, number>();
  visibleBySys: Map<string, number> = new Map<string, number>();
  /** 当前可见卫星明细，按 SNR 从高到低排好序 */
  sats: SatInfo[] = [];
  /** 惯导状态 */
  ins: InsStatus = new InsStatus();
}

const SYS_BY_TALKER: Map<string, string> = (() => {
  const m = new Map<string, string>();
  m.set('GP', 'GPS');
  m.set('GL', 'GLO');
  m.set('GA', 'GAL');
  m.set('GB', 'BDS');
  m.set('BD', 'BDS');
  m.set('GQ', 'QZS');
  m.set('GI', 'NAV');
  return m;
})();

/** NMEA 4.11 的 GSA 系统 ID 映射 */
const SYS_BY_ID: Map<number, string> = (() => {
  const m = new Map<number, string>();
  m.set(1, 'GPS');
  m.set(2, 'GLO');
  m.set(3, 'GAL');
  m.set(4, 'BDS');
  m.set(5, 'QZS');
  m.set(6, 'NAV');
  return m;
})();

const SBAS_PRN_MIN = 33;
const SBAS_PRN_MAX = 51;

/** GGA 定位质量 → 中文 */
function fixLabel(q: number): string {
  if (q === 0) {
    return '无定位';
  }
  if (q === 1) {
    return '单点';
  }
  if (q === 2) {
    return '伪距差分';
  }
  if (q === 4) {
    return 'RTK固定';
  }
  if (q === 5) {
    return 'RTK浮动';
  }
  if (q === 6) {
    return '航位推算';
  }
  return '未知(' + q + ')';
}

/** ddmm.mmmm 转十进制度 */
function dmToDeg(dm: string, hemi: string): number {
  if (dm.length === 0) {
    return NaN;
  }
  const v = parseFloat(dm);
  if (isNaN(v)) {
    return NaN;
  }
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let out = deg + min / 60.0;
  if (hemi === 'S' || hemi === 'W') {
    out = -out;
  }
  return out;
}

/** 安全转数字，空串返回 NaN */
function num(s: string): number {
  if (s === undefined || s === null || s.length === 0) {
    return NaN;
  }
  return parseFloat(s);
}

/** 两点球面距离（米） */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000.0;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 校验 $...*HH 的异或值。返回 1 正确 / 0 错误 / -1 无校验段 */
export function checkSum(line: string): number {
  const star = line.indexOf('*');
  if (star < 0 || star === 0) {
    return -1;
  }
  if (line.length < star + 3) {
    return -1;
  }
  const want = parseInt(line.substring(star + 1, star + 3), 16);
  if (isNaN(want)) {
    return -1;
  }
  let got = 0;
  for (let i = 1; i < star; i++) {
    got = got ^ line.charCodeAt(i);
  }
  return got === want ? 1 : 0;
}

export class NmeaParser {
  private lat: number = NaN;
  private lon: number = NaN;
  private alt: number = NaN;
  private quality: number = 0;
  private satsGga: number = 0;
  private hdop: number = NaN;
  private pdop: number = NaN;
  private vdop: number = NaN;
  private speedKmh: number = NaN;
  private course: number = NaN;
  private utc: string = '';
  private date: string = '';
  private mode: string = '';
  private lastFixTs: number = 0;
  private ckOk: number = 0;
  private ckBad: number = 0;
  private total: number = 0;
  private usedBySys: Map<string, number> = new Map<string, number>();
  private visibleBySys: Map<string, number> = new Map<string, number>();
  private snrBySys: Map<string, number[]> = new Map<string, number[]>();
  /** 卫星明细，键是「星座_PRN」，比如 GPS_05 */
  private sats: Map<string, SatInfo> = new Map<string, SatInfo>();
  private insStatus: InsStatus = new InsStatus();

  /** 完整轨迹，只在 quality>0 时增长 */
  trail: TrailPoint[] = [];

  /** 最近一条语句类型，界面滚动区上色用 */
  lastKind: string = '';

  /**
   * 喂一条语句。
   * @param line 完整 NMEA 语句（不含换行）
   * @param ts   本地时间戳（毫秒）
   */
  feed(line: string, ts: number): void {
    if (line.length === 0 || line.charAt(0) !== '$') {
      return;
    }
    this.total = this.total + 1;

    const ck = checkSum(line);
    if (ck === 1) {
      this.ckOk = this.ckOk + 1;
    } else if (ck === 0) {
      this.ckBad = this.ckBad + 1;
    }

    let body = line.substring(1);
    const star = body.indexOf('*');
    if (star >= 0) {
      body = body.substring(0, star);
    }
    const f = body.split(',');
    if (f.length < 2) {
      return;
    }
    const tag = f[0];
    if (tag.length < 4) {
      return;
    }
    // 标准 NMEA 是「2 字符 talker + 3 字符类型」（$GNGGA → GGA），
    // 但和芯星通的私有语句没有 talker（$SNRSTAT → 整串就是类型），要分开判断。
    // 直接 substring(2) 会把 SNRSTAT 切成 RSTAT，永远匹配不上
    let kind = tag;
    const pre2 = tag.substring(0, 2).toUpperCase();
    if (tag.length >= 5 && (SYS_BY_TALKER.has(pre2) || pre2 === 'GN')) {
      kind = tag.substring(2);
    }
    this.lastKind = kind;

    if (kind === 'GGA') {
      this.onGga(f, ts);
    } else if (kind === 'RMC') {
      this.onRmc(f);
    } else if (kind === 'GSA') {
      this.onGsa(f);
    } else if (kind === 'GSV') {
      this.onGsv(f, tag, ts);
    } else if (kind === 'SNRSTAT') {
      this.onSnrStat(f);
    }
  }

  /** $SNRSTAT,insstatus,odostatus,InstallState,mapstat */
  private onSnrStat(f: string[]): void {
    if (f.length < 5) {
      return;
    }
    const a = parseInt(f[1]);
    const b = parseInt(f[2]);
    const c = parseInt(f[3]);
    const d = parseInt(f[4]);
    if (!isNaN(a)) {
      this.insStatus.ins = a;
    }
    if (!isNaN(b)) {
      this.insStatus.odo = b;
    }
    if (!isNaN(c)) {
      this.insStatus.install = c;
    }
    if (!isNaN(d)) {
      this.insStatus.map = d;
    }
    this.insStatus.valid = true;
  }

  private onGga(f: string[], ts: number): void {
    if (f.length < 12) {
      return;
    }
    this.utc = f[1];
    const la = dmToDeg(f[2], f[3]);
    const lo = dmToDeg(f[4], f[5]);
    if (!isNaN(la) && !isNaN(lo)) {
      this.lat = la;
      this.lon = lo;
    }
    const q = parseInt(f[6]);
    this.quality = isNaN(q) ? 0 : q;
    const su = parseInt(f[7]);
    this.satsGga = isNaN(su) ? 0 : su;
    const h = num(f[8]);
    // 99.99 是占位符，不是真值
    this.hdop = (isNaN(h) || h >= 99.0) ? NaN : h;
    this.alt = num(f[9]);

    if (this.quality > 0 && !isNaN(this.lat) && !isNaN(this.lon)) {
      this.lastFixTs = ts;
      // 轨迹去重：离上一点不到 0.6 米就不记，否则静止时会刷一堆重复点
      if (this.trail.length === 0) {
        const p = new TrailPoint();
        p.t = ts;
        p.lat = this.lat;
        p.lon = this.lon;
        this.trail.push(p);
      } else {
        const last = this.trail[this.trail.length - 1];
        const d = haversine(last.lat, last.lon, this.lat, this.lon);
        if (d > 0.6 || (ts - last.t) > 5000) {
          const p = new TrailPoint();
          p.t = ts;
          p.lat = this.lat;
          p.lon = this.lon;
          this.trail.push(p);
        }
      }
    }
  }

  private onRmc(f: string[]): void {
    if (f.length < 10) {
      return;
    }
    this.date = f[9];
    if (f[2] === 'A') {
      const la = dmToDeg(f[3], f[4]);
      const lo = dmToDeg(f[5], f[6]);
      if (!isNaN(la)) {
        this.lat = la;
      }
      if (!isNaN(lo)) {
        this.lon = lo;
      }
    }
    const knots = num(f[7]);
    if (!isNaN(knots)) {
      this.speedKmh = knots * 1.852;
    }
    this.course = num(f[8]);
  }

  private onGsa(f: string[]): void {
    if (f.length < 18) {
      return;
    }
    this.mode = f[2];
    const p = num(f[15]);
    const h = num(f[16]);
    const v = num(f[17]);
    if (!isNaN(p)) {
      this.pdop = p;
    }
    if (!isNaN(h) && h < 99.0) {
      this.hdop = h;
    }
    if (!isNaN(v)) {
      this.vdop = v;
    }
    // 系统 ID 在索引 18（NMEA 4.11）
    let sid = 0;
    if (f.length > 18 && f[18].length > 0) {
      const t = parseInt(f[18]);
      if (!isNaN(t)) {
        sid = t;
      }
    }
    const name = SYS_BY_ID.get(sid);
    if (name === undefined) {
      return;
    }
    let n = 0;
    for (let i = 3; i < 15; i++) {
      if (f[i].length > 0) {
        n = n + 1;
      }
    }
    this.usedBySys.set(name, n);
  }

  private onGsv(f: string[], tag: string, ts: number): void {
    if (f.length < 4) {
      return;
    }
    const talker = tag.substring(0, 2).toUpperCase();
    let visible = parseInt(f[3]);
    if (isNaN(visible)) {
      visible = 0;
    }
    const name = SYS_BY_TALKER.get(talker);
    const sysName = name === undefined ? talker : name;

    // SBAS 混在 $GPGSV 里，按编号段拆出来
    if (talker === 'GP') {
      let sbas = 0;
      for (let i = 4; i + 3 < f.length; i = i + 4) {
        const prn = parseInt(f[i]);
        if (!isNaN(prn) && prn >= SBAS_PRN_MIN && prn <= SBAS_PRN_MAX) {
          sbas = sbas + 1;
        }
      }
      if (sbas > 0) {
        this.visibleBySys.set('SB', sbas);
        visible = visible - sbas;
      }
    }
    this.visibleBySys.set(sysName, visible > 0 ? visible : 0);

    let arr = this.snrBySys.get(sysName);
    if (arr === undefined) {
      arr = [];
      this.snrBySys.set(sysName, arr);
    }
    for (let i = 4; i + 3 < f.length; i = i + 4) {
      const prn = parseInt(f[i]);
      if (isNaN(prn)) {
        continue;
      }
      const isSbas = (talker === 'GP' && prn >= SBAS_PRN_MIN && prn <= SBAS_PRN_MAX);
      const snr = num(f[i + 3]);
      if (!isSbas && !isNaN(snr) && snr > 0) {
        arr.push(snr);
      }

      // ---- 记下这颗卫星，供天空图和 SNR 柱图用 ----
      const sName = isSbas ? 'SB' : sysName;
      const key = sName + '_' + prn;
      let sat = this.sats.get(key);
      if (sat === undefined) {
        sat = new SatInfo();
        sat.sys = sName;
        sat.prn = prn;
        this.sats.set(key, sat);
      }
      const elev = num(f[i + 1]);
      const azim = num(f[i + 2]);
      sat.elev = isNaN(elev) ? 0 : elev;
      sat.azim = isNaN(azim) ? 0 : azim;
      // 99 是占位符，不是真实 SNR
      sat.snr = (isNaN(snr) || snr >= 99) ? 0 : snr;
      sat.seenAt = ts;
    }
    // 只留最近一轮，别无限涨
    if (arr.length > 120) {
      arr.splice(0, arr.length - 120);
    }
  }

  /** 生成界面快照 */
  snapshot(now: number): FixSnapshot {
    const s = new FixSnapshot();
    s.lat = this.lat;
    s.lon = this.lon;
    s.hasPos = !isNaN(this.lat) && !isNaN(this.lon);
    s.alt = this.alt;
    s.quality = this.quality;
    s.qualityLabel = fixLabel(this.quality);
    s.satsUsed = this.satsGga;
    let sum = 0;
    this.usedBySys.forEach((v: number) => {
      sum = sum + v;
    });
    s.satsUsedSum = sum;
    let vis = 0;
    this.visibleBySys.forEach((v: number) => {
      vis = vis + v;
    });
    s.visibleTotal = vis;
    s.hdop = this.hdop;
    s.pdop = this.pdop;
    s.vdop = this.vdop;
    s.speedKmh = this.speedKmh;
    s.course = this.course;
    s.utc = this.utc;
    s.date = this.date;
    s.mode = this.mode;
    s.fixAge = this.lastFixTs > 0 ? (now - this.lastFixTs) / 1000.0 : -1;
    s.ckOk = this.ckOk;
    s.ckBad = this.ckBad;
    s.totalLines = this.total;
    s.trailN = this.trail.length;

    let snrSum = 0;
    let snrCnt = 0;
    this.snrBySys.forEach((arr: number[]) => {
      for (let i = 0; i < arr.length; i++) {
        snrSum = snrSum + arr[i];
        snrCnt = snrCnt + 1;
      }
    });
    s.snrAvg = snrCnt > 0 ? snrSum / snrCnt : NaN;

    this.usedBySys.forEach((v: number, k: string) => {
      s.usedBySys.set(k, v);
    });
    this.visibleBySys.forEach((v: number, k: string) => {
      s.visibleBySys.set(k, v);
    });

    // 卫星明细：只保留最近 6 秒出现过的（GSV 一圈大概 1 秒），按 SNR 降序
    const list: SatInfo[] = [];
    this.sats.forEach((v: SatInfo) => {
      if (now - v.seenAt < 6000) {
        const c = new SatInfo();
        c.sys = v.sys;
        c.prn = v.prn;
        c.elev = v.elev;
        c.azim = v.azim;
        c.snr = v.snr;
        c.seenAt = v.seenAt;
        c.used = v.used;
        list.push(c);
      }
    });
    list.sort((a: SatInfo, b: SatInfo) => b.snr - a.snr);
    s.sats = list;

    // 惯导状态
    const insCopy = new InsStatus();
    insCopy.valid = this.insStatus.valid;
    insCopy.ins = this.insStatus.ins;
    insCopy.odo = this.insStatus.odo;
    insCopy.install = this.insStatus.install;
    insCopy.map = this.insStatus.map;
    s.ins = insCopy;

    return s;
  }

  reset(): void {
    this.lat = NaN;
    this.lon = NaN;
    this.alt = NaN;
    this.quality = 0;
    this.satsGga = 0;
    this.hdop = NaN;
    this.pdop = NaN;
    this.vdop = NaN;
    this.speedKmh = NaN;
    this.course = NaN;
    this.utc = '';
    this.date = '';
    this.mode = '';
    this.lastFixTs = 0;
    this.ckOk = 0;
    this.ckBad = 0;
    this.total = 0;
    this.usedBySys.clear();
    this.visibleBySys.clear();
    this.snrBySys.clear();
    this.sats.clear();
    this.insStatus = new InsStatus();
    this.trail = [];
  }
}
