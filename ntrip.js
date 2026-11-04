/**
 * ntrip.js — NTRIP 差分数据客户端
 *
 * 为什么不在浏览器里直连 caster：
 *   NTRIP 是带 Authorization 头的 HTTP 流，跨域请求会先发 OPTIONS 预检，
 *   而 caster 基本都不回 CORS 头，浏览器会直接拦掉。所以真正的 TCP 连接
 *   放在本地服务 server.py 里做，页面只跟 127.0.0.1 通信，同一个源，无跨域问题。
 *
 * 数据流：caster --TCP--> server.py 缓冲 --HTTP轮询--> 本模块 --串口--> 模块
 *       模块 --GGA--> 本模块 --HTTP--> server.py --> caster（VRS 必须靠它定位）
 */

/** 轮询间隔：caster 一般 1Hz 推改正数，250ms 足够及时又不至于把本地服务打满 */
const PULL_MS = 250;
const STATUS_MS = 1000;
/** GGA 回传节流。千寻要求 10s 内至少一次，2s 一次既稳又不浪费 */
const GGA_MS = 2000;

export class NtripClient {
  /**
   * @param {{writeBytes:(u:Uint8Array)=>Promise<void>, getGga:()=>string|null,
   *          onStatus:(s:object)=>void, toast:(m:string,ms?:number)=>void}} io
   */
  constructor(io) {
    this.io = io;
    this.active = false;
    this.forward = true;
    this.timer = null;
    this.statusTimer = null;
    this.lastGga = 0;
    this.bytesIn = 0;       // 本会话写进串口的字节数
    this.lastStatus = null;
    this._pulling = false;
  }

  /** 建立连接。成功返回 {ok, status}，失败返回 {ok:false, error} */
  async connect(cfg) {
    this.disconnect(true);
    try {
      const r = await fetch('/api/ntrip/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const j = await r.json();
      if (!j.ok) {
        this.io.toast(j.error || '连接失败', 6000);
        return j;
      }
      this.active = true;
      this.bytesIn = 0;
      this.startLoops();
      return j;
    } catch (e) {
      this.io.toast('连不上本地服务：' + e.message, 5000);
      return { ok: false, error: e.message };
    }
  }

  /** 断开 */
  async disconnect(silent) {
    this.stopLoops();
    this.active = false;
    try { await fetch('/api/ntrip/disconnect', { method: 'POST' }); } catch { /* 忽略 */ }
    if (!silent) this.io.toast('差分连接已断开', 2600);
  }

  setForward(on) {
    this.forward = !!on;
  }

  startLoops() {
    this.stopLoops();
    this.timer = setInterval(() => this.pull(), PULL_MS);
    this.statusTimer = setInterval(() => this.refreshStatus(), STATUS_MS);
    this.refreshStatus();
  }

  stopLoops() {
    if (this.timer) clearInterval(this.timer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.timer = null;
    this.statusTimer = null;
  }

  /** 取回缓冲区里的 RTCM，写进串口 */
  async pull() {
    if (!this.active || this._pulling) return;
    this._pulling = true;
    try {
      const r = await fetch('/api/ntrip/pull', { cache: 'no-store' });
      if (!r.ok) return;
      const buf = await r.arrayBuffer();
      if (!buf.byteLength) return;
      if (this.forward) {
        await this.io.writeBytes(new Uint8Array(buf));
        this.bytesIn += buf.byteLength;
      }
    } catch { /* 网络抖动忽略，下一轮再来 */ } finally {
      this._pulling = false;
    }
  }

  async refreshStatus() {
    try {
      const r = await fetch('/api/ntrip/status', { cache: 'no-store' });
      const j = await r.json();
      this.lastStatus = { ...j, forwarded: this.bytesIn };
      if (!j.connected && this.active) {
        // 服务端已经掉线，本地状态跟着清掉，否则界面会一直显示"已连接"
        this.active = false;
        this.stopLoops();
      }
      this.io.onStatus(this.lastStatus);
    } catch { /* 忽略 */ }
  }

  /** 把模块吐出来的 GGA 转给 caster。VRS 网络靠它决定给哪片天顶的改正数。 */
  feedGga(line) {
    if (!this.active) return;
    const now = performance.now();
    if (now - this.lastGga < GGA_MS) return;
    this.lastGga = now;
    fetch('/api/ntrip/gga', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line }),
    }).catch(() => {});
  }
}

/* ============================================================
   RTCM3 消息类型含义（界面展示用）
   ============================================================ */
export const RTCM_NAMES = {
  1005: '基站坐标', 1006: '基站坐标+高', 1007: '天线描述', 1033: '接收机/天线信息',
  1074: 'GPS MSM4', 1075: 'GPS MSM5', 1077: 'GPS MSM7',
  1084: 'GLO MSM4', 1085: 'GLO MSM5', 1087: 'GLO MSM7',
  1094: 'GAL MSM4', 1095: 'GAL MSM5', 1097: 'GAL MSM7',
  1114: 'QZS MSM4', 1115: 'QZS MSM5', 1117: 'QZS MSM7',
  1124: 'BDS MSM4', 1125: 'BDS MSM5', 1127: 'BDS MSM7',
  1019: 'GPS 星历', 1020: 'GLO 星历', 1042: 'BDS 星历', 1045: 'GAL 星历', 1046: 'GAL 星历',
  1230: 'GLONASS 码偏差', 1029: 'UTC 参数', 1013: '系统时间偏移',
};

/** 把服务端统计的消息表按数量排序，转成可渲染的数组 */
export function describeMsgs(msgs) {
  return Object.entries(msgs || {})
    .map(([id, n]) => ({ id: Number(id), n, name: RTCM_NAMES[id] || '' }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
}
