/*
 * UM621A 手机采集器 —— 日志落盘
 *
 * 设计取舍：
 *   1) 不每行 open/close 文件。USB 每秒几十条语句，那样存储会被拖死。
 *      改成常开句柄 + 内存缓冲 + 每 1 秒批量写。
 *   2) 每 2 秒 fsync 一次。掉电最多丢 2 秒数据，这是速度和安全的折中。
 *   3) 原始报文写成纯 NMEA 行，不加任何前缀。
 *      这样文件可以原样拖进电脑上的 web/ 分析面板跑诊断报告，格式零改动。
 *   4) 轨迹单独存 CSV，一行一个点，方便用 Excel / Python 直接读。
 */

import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

/** 一条轨迹记录 */
export class TrackRow {
  utc: string = '';
  lat: number = 0;
  lon: number = 0;
  alt: number = -1;
  quality: number = 0;
  sats: number = 0;
  hdop: number = -1;
  speed: number = -1;
  course: number = -1;
}

/** 两位补零 */
function p2(v: number): string {
  return v < 10 ? ('0' + v) : ('' + v);
}

/** 4 位补零 */
function p4(v: number): string {
  return v < 10 ? ('000' + v) : (v < 100 ? ('00' + v) : (v < 1000 ? ('0' + v) : ('' + v)));
}

/** 生成 20261101_130500 形式的时间戳 */
export function stamp(d: Date): string {
  return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
    '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

/** 字节数转人类可读 */
export function humanSize(bytes: number): string {
  if (bytes >= 1048576) {
    return (bytes / 1048576).toFixed(2) + ' MB';
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(0) + ' KB';
  }
  return bytes + ' B';
}

export class LogStore {
  private dir: string = '';
  private rawPath: string = '';
  private trackPath: string = '';
  private rawFd: number = -1;
  private trackFd: number = -1;
  private pending: string[] = [];
  private pendingBytes: number = 0;
  private bytes: number = 0;
  private trackN: number = 0;
  private lastSync: number = 0;
  private lastWrite: number = 0;
  private active: boolean = false;

  isActive(): boolean {
    return this.active;
  }

  getRawName(): string {
    const i = this.rawPath.lastIndexOf('/');
    return i >= 0 ? this.rawPath.substring(i + 1) : this.rawPath;
  }

  getTrackName(): string {
    const i = this.trackPath.lastIndexOf('/');
    return i >= 0 ? this.trackPath.substring(i + 1) : this.trackPath;
  }

  getBytes(): number {
    return this.bytes;
  }

  getTrackN(): number {
    return this.trackN;
  }

  getRawPath(): string {
    return this.rawPath;
  }

  getTrackPath(): string {
    return this.trackPath;
  }

  /** 开始记录。文件放在应用沙箱的 files/logs 下，不需要任何权限。 */
  start(ctx: common.UIAbilityContext): void {
    if (this.active) {
      return;
    }
    this.dir = ctx.filesDir + '/logs';
    try {
      if (!fileIo.accessSync(this.dir)) {
        fileIo.mkdirSync(this.dir);
      }
    } catch (e) {
      // 目录已存在会走到这里，忽略
    }

    const s = stamp(new Date());
    this.rawPath = this.dir + '/raw_' + s + '.nmea';
    this.trackPath = this.dir + '/track_' + s + '.csv';

    this.rawFd = fileIo.openSync(this.rawPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND).fd;
    this.trackFd = fileIo.openSync(this.trackPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND).fd;

    // CSV 表头
    const head = 'utc,lat,lon,alt_m,fix_quality,sats,hdop,speed_kmh,course_deg\n';
    this.writeFd(this.trackFd, head);

    this.bytes = 0;
    this.trackN = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.lastSync = Date.now();
    this.lastWrite = Date.now();
    this.active = true;
  }

  /** 追加一条原始报文。只进内存，由 pump() 批量落盘。 */
  addRaw(line: string): void {
    if (!this.active) {
      return;
    }
    this.pending.push(line);
    this.pendingBytes = this.pendingBytes + line.length + 2;
    // 攒够一批或者超过 0.5 秒就写
    if (this.pending.length >= 40 || (Date.now() - this.lastWrite) > 500) {
      this.pump();
    }
  }

  /** 追加一个轨迹点 */
  addTrack(r: TrackRow): void {
    if (!this.active) {
      return;
    }
    const line = r.utc + ',' + fmt(r.lat, 7) + ',' + fmt(r.lon, 7) + ',' +
      fmt(r.alt, 1) + ',' + r.quality + ',' + r.sats + ',' +
      fmt(r.hdop, 2) + ',' + fmt(r.speed, 2) + ',' + fmt(r.course, 1) + '\n';
    this.writeFd(this.trackFd, line);
    this.trackN = this.trackN + 1;
  }

  /** 定时调用：把缓冲刷出去，并定期 fsync */
  pump(): void {
    if (!this.active) {
      return;
    }
    if (this.pending.length > 0) {
      let s = '';
      for (let i = 0; i < this.pending.length; i++) {
        s = s + this.pending[i] + '\r\n';
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.writeFd(this.rawFd, s);
      this.lastWrite = Date.now();
    }
    const now = Date.now();
    if (now - this.lastSync > 2000) {
      this.lastSync = now;
      try {
        if (this.rawFd >= 0) {
          fileIo.fsyncSync(this.rawFd);
        }
        if (this.trackFd >= 0) {
          fileIo.fsyncSync(this.trackFd);
        }
      } catch (e) {
        // fsync 失败不影响继续记录
      }
    }
  }

  /** 停止记录，收尾并把所有数据刷到盘上 */
  stop(): void {
    if (!this.active) {
      return;
    }
    this.pump();
    try {
      if (this.rawFd >= 0) {
        fileIo.fsyncSync(this.rawFd);
        fileIo.closeSync(this.rawFd);
      }
      if (this.trackFd >= 0) {
        fileIo.fsyncSync(this.trackFd);
        fileIo.closeSync(this.trackFd);
      }
    } catch (e) {
      // 关闭失败不阻塞界面
    }
    this.rawFd = -1;
    this.trackFd = -1;
    this.active = false;
  }

  /** 列出历史记录文件，按时间倒序 */
  listRecords(ctx: common.UIAbilityContext): string[] {
    const out: string[] = [];
    const d = ctx.filesDir + '/logs';
    try {
      const names = fileIo.listFileSync(d);
      for (let i = 0; i < names.length; i++) {
        if (names[i].endsWith('.nmea') || names[i].endsWith('.csv')) {
          out.push(names[i]);
        }
      }
    } catch (e) {
      return out;
    }
    out.sort();
    out.reverse();
    return out;
  }

  /** 读一个记录文件的大小，列表里显示 */
  sizeOf(ctx: common.UIAbilityContext, name: string): number {
    try {
      const st = fileIo.statSync(ctx.filesDir + '/logs/' + name);
      return st.size;
    } catch (e) {
      return 0;
    }
  }

  /** 取文件真实路径，导出时用 */
  fullPath(name: string): string {
    return this.dir.length > 0 ? (this.dir + '/' + name) : (this.dir + name);
  }

  private writeFd(fd: number, s: string): void {
    if (fd < 0) {
      return;
    }
    // NMEA 全是 ASCII，直接按 charCode 转，不用 TextEncoder 省开销
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      buf[i] = s.charCodeAt(i) & 0xFF;
    }
    try {
      fileIo.writeSync(fd, buf.buffer);
      if (fd === this.rawFd) {
        this.bytes = this.bytes + buf.length;
      }
    } catch (e) {
      // 写失败（比如存储满）不崩，界面上会看到字节数不再增长
    }
  }
}

function fmt(v: number, nd: number): string {
  if (isNaN(v) || v === undefined || v === null) {
    return '';
  }
  return v.toFixed(nd);
}
