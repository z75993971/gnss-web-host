/*
 * UM621 采集器 —— 运行日志
 *
 * 为什么要有这个：
 *   真机调试时手机插着模块板，Mac 已经被拔掉了，抓不到 hilog。
 *   出了问题只能靠 App 自己把过程记下来，事后用 hdc 拉文件看。
 *
 * 记什么：
 *   启动、USB 设备枚举（VID/PID/接口 class/端点）、打开串口每一步、
 *   控制传输返回值、错误堆栈。CDC 还是 VCP 就是靠这些判断的。
 *
 * 存哪：
 *   应用沙箱 files/logs/app.log，单文件，超过 1 MB 自动截掉前半段。
 *   电脑上用 hdc file recv 拉：
 *     hdc file recv /data/app/el2/100/base/com.zhangrui.um621collector/haps/entry/files/logs
 */

import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

const MAX_BYTES = 1024 * 1024;      // 1 MB 上限
const KEEP_BYTES = 400 * 1024;      // 截断后保留尾部

function p2(v: number): string {
  return v < 10 ? ('0' + v) : ('' + v);
}

function p3(v: number): string {
  if (v < 10) {
    return '00' + v;
  }
  return v < 100 ? ('0' + v) : ('' + v);
}

function stamp(): string {
  const d = new Date();
  return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
    p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
    '.' + p3(d.getMilliseconds());
}

export class DbgLog {
  private static fd: number = -1;
  private static path: string = '';
  private static dir: string = '';
  private static bytes: number = 0;
  private static ready: boolean = false;
  /** UTF-8 编码器，中文日志靠它才不乱码 */
  private static encoder: util.TextEncoder = new util.TextEncoder();
  /** 内存里也留最近 200 行，界面直接看，不用读文件 */
  private static recent: string[] = [];

  /** 初始化。应用启动时调一次，失败也不影响主功能。 */
  static init(ctx: common.UIAbilityContext): void {
    if (DbgLog.ready) {
      return;
    }
    try {
      DbgLog.dir = ctx.filesDir + '/logs';
      if (!fileIo.accessSync(DbgLog.dir)) {
        fileIo.mkdirSync(DbgLog.dir);
      }
      DbgLog.path = DbgLog.dir + '/app.log';

      // 太大的话先截断，避免无限增长
      try {
        const st = fileIo.statSync(DbgLog.path);
        if (st.size > MAX_BYTES) {
          const all = fileIo.readTextSync(DbgLog.path);
          const tail = all.substring(Math.max(0, all.length - KEEP_BYTES));
          const fw = fileIo.openSync(DbgLog.path,
            fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
          fileIo.writeSync(fw.fd, '\n--- 日志超过 1MB，已截断 ---\n' + tail);
          fileIo.closeSync(fw);
        }
        DbgLog.bytes = st.size;
      } catch (e) {
        // 文件还不存在，正常
      }

      DbgLog.fd = fileIo.openSync(DbgLog.path,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND).fd;
      DbgLog.ready = true;
      DbgLog.info('APP', '===== 采集器启动 =====');
    } catch (e) {
      DbgLog.ready = false;
    }
  }

  static isReady(): boolean {
    return DbgLog.ready;
  }

  static getPath(): string {
    return DbgLog.path;
  }

  static getDir(): string {
    return DbgLog.dir;
  }

  static info(tag: string, msg: string): void {
    DbgLog.write('I', tag, msg);
  }

  static warn(tag: string, msg: string): void {
    DbgLog.write('W', tag, msg);
  }

  static error(tag: string, msg: string): void {
    DbgLog.write('E', tag, msg);
  }

  private static write(level: string, tag: string, msg: string): void {
    const line = stamp() + ' [' + level + '] ' + tag + ': ' + msg;
    DbgLog.recent.push(line);
    if (DbgLog.recent.length > 200) {
      DbgLog.recent.shift();
    }
    if (!DbgLog.ready || DbgLog.fd < 0) {
      return;
    }
    try {
      const s = line + '\n';
      // 必须用 UTF-8 编码。之前用 charCodeAt & 0xFF 把中文字符打碎了，
      // 日志里全是乱码，等于白记
      const buf: Uint8Array = DbgLog.encoder.encodeInto(s);
      fileIo.writeSync(DbgLog.fd, buf.buffer);
      DbgLog.bytes = DbgLog.bytes + buf.length;
    } catch (e) {
      // 写失败不崩
    }
  }

  /** 界面里显示的最近日志 */
  static tail(n: number): string {
    const len = DbgLog.recent.length;
    const start = len > n ? (len - n) : 0;
    let s = '';
    for (let i = start; i < len; i++) {
      s = s + DbgLog.recent[i] + '\n';
    }
    return s;
  }

  static clear(): void {
    DbgLog.recent = [];
    if (DbgLog.fd >= 0) {
      try {
        fileIo.closeSync(DbgLog.fd);
      } catch (e) {
      }
    }
    DbgLog.fd = -1;
    DbgLog.ready = false;
    if (DbgLog.path.length > 0) {
      try {
        const fw = fileIo.openSync(DbgLog.path,
          fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
        fileIo.closeSync(fw);
      } catch (e) {
      }
      try {
        DbgLog.fd = fileIo.openSync(DbgLog.path,
          fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND).fd;
        DbgLog.ready = true;
        DbgLog.bytes = 0;
      } catch (e) {
      }
    }
  }
}
