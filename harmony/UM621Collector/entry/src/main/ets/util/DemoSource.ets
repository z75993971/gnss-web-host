/*
 * UM621 采集器 —— 演示数据源
 *
 * 干什么：
 *   不插任何硬件，从内置的 demo.nmea 里按真实速率喂 NMEA 语句，
 *   走完整条处理链（解析 → 界面 → 轨迹 → 落盘）。
 *
 * 为什么要：
 *   真机调试时手机插着模块板，Mac 已经拔了，抓不到日志。
 *   有演示模式就能随时验证解析逻辑、界面渲染、文件写入是否正常，
 *   不用反复插拔硬件。也方便演示给别人看。
 *
 * 数据来源：
 *   web/samples 里 2026-11-01 实机录制的真实 NMEA，裁了 150 秒。
 *   所以演示出来的轨迹是真的西安街头轨迹，不是假数据。
 */

import { common } from '@kit.AbilityKit';
import { DbgLog } from '../util/DbgLog';

/** 每行之间的间隔（毫秒）。真实设备约 16 行/秒，所以 62ms 一行 */
const LINE_INTERVAL_MS = 62;

export class DemoSource {
  private lines: string[] = [];
  private idx: number = 0;
  private timerId: number = -1;
  private running: boolean = false;
  private loaded: boolean = false;

  /** 每喂一行调一次 */
  public onLine: (line: string) => void = (line: string) => {
  };

  isRunning(): boolean {
    return this.running;
  }

  /** 一共多少行，界面用来显示进度 */
  total(): number {
    return this.lines.length;
  }

  current(): number {
    return this.idx;
  }

  /** 从 rawfile 加载演示数据。加载失败返回 false。 */
  load(ctx: common.UIAbilityContext): boolean {
    if (this.loaded) {
      return true;
    }
    try {
      const data: Uint8Array = ctx.resourceManager.getRawFileContentSync('demo.nmea');
      if (data.length === 0) {
        DbgLog.error('DEMO', 'demo.nmea 是空的');
        return false;
      }
      // 分块转字符串，比逐字节拼接快得多（144KB 数据）
      const CHUNK = 8192;
      const parts: string[] = [];
      for (let i = 0; i < data.length; i = i + CHUNK) {
        const end = Math.min(i + CHUNK, data.length);
        let seg = '';
        for (let j = i; j < end; j++) {
          seg = seg + String.fromCharCode(data[j]);
        }
        parts.push(seg);
      }
      const text = parts.join('');
      const raw = text.split('\n');
      const out: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k].trim();
        if (l.length > 0 && l.charAt(0) === '$') {
          out.push(l);
        }
      }
      this.lines = out;
      this.loaded = out.length > 0;
      DbgLog.info('DEMO', '演示数据加载完成，' + out.length + ' 条语句，约 ' +
        Math.round(out.length * LINE_INTERVAL_MS / 1000) + ' 秒');
      return this.loaded;
    } catch (e) {
      const err = e as Error;
      DbgLog.error('DEMO', '加载 demo.nmea 失败：' + err.message);
      return false;
    }
  }

  /** 开始按真实速率喂数据，放完自动从头循环 */
  start(): void {
    if (this.running || this.lines.length === 0) {
      return;
    }
    this.running = true;
    this.idx = 0;
    DbgLog.info('DEMO', '演示模式开始');
    this.timerId = setInterval(() => {
      if (!this.running) {
        return;
      }
      if (this.idx >= this.lines.length) {
        this.idx = 0;                       // 循环播放
        DbgLog.info('DEMO', '演示数据播放完一轮，从头循环');
      }
      const line = this.lines[this.idx];
      this.idx = this.idx + 1;
      this.onLine(line);
    }, LINE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
    if (this.running) {
      DbgLog.info('DEMO', '演示模式停止，已播放 ' + this.idx + ' 条');
    }
    this.running = false;
  }
}
