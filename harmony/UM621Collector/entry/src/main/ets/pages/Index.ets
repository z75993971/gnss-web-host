/*
 * UM621A 手机采集器 —— 主界面
 *
 * 一条主线：插上板子 → 连接 → 实时看 → 自动落盘。
 *
 * 性能上的两个关键处理：
 *   1) 串口回调每几毫秒来一次，绝不能直接改 @State，否则界面卡死。
 *      回调只往字符串缓冲里塞，界面用 200ms 定时器批量刷新。
 *   2) 报文列表最多留 300 行，超了砍头。无限增长会让列表渲染越来越慢。
 */

import { usbManager } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { common, bundleManager } from '@kit.AbilityKit';
import { window, router } from '@kit.ArkUI';
import { SerialPort, DeviceBrief, DeviceDiag } from '../usb/SerialPort';
import { NmeaParser, FixSnapshot, TrailPoint, haversine, SatInfo, InsStatus, insLabel } from '../nmea/NmeaParser';
import { LogStore, TrackRow, humanSize } from '../store/LogStore';
import { DemoSource } from '../util/DemoSource';
import { DbgLog } from '../util/DbgLog';

const BAUD_LIST: number[] = [460800, 230400, 115200];
const MAX_LOG_LINES = 300;

@Entry
@Component
struct Index {
  // ---------- 连接状态 ----------
  @State connState: string = 'idle';       // idle/opening/open/error
  @State devList: DeviceBrief[] = [];
  @State curDevName: string = '';
  @State curDevProduct: string = '';
  @State portMode: string = '';
  @State baud: number = 460800;
  @State showDevPanel: boolean = false;
  @State showDiag: boolean = false;
  @State diagText: string = '';
  @State errMsg: string = '';

  // ---------- 数据 ----------
  @State fix: FixSnapshot = new FixSnapshot();
  @State logLines: string[] = [];
  @State trailCount: number = 0;
  @State rxBytes: number = 0;
  @State lineRate: number = 0;

  // ---------- 记录 ----------
  @State recording: boolean = false;
  @State recName: string = '';
  @State recSize: string = '';
  @State recPoints: number = 0;
  @State recFileSize: number = 0;

  // ---------- 界面 ----------
  @State tab: number = 0;                  // 0=仪表 1=报文
  @State cmdInput: string = '';
  @State sentMsg: string = '';
  @State demoMode: boolean = false;        // 演示模式（不插硬件，跑内置真实样本）
  @State logPath: string = '';
  @State appId: string = '';               // 应用 AppID，申请高德「HarmonyOS 平台」Key 要填

  private port: SerialPort = new SerialPort();
  private parser: NmeaParser = new NmeaParser();
  private store: LogStore = new LogStore();
  private demo: DemoSource = new DemoSource();
  private rxBuf: string = '';
  private pendingLines: string[] = [];
  private timerId: number = -1;
  private lastTrackTs: number = 0;
  private lastRateTs: number = 0;
  private lastRateBytes: number = 0;
  private lastTrailPush: number = 0;
  private lastTrailCount: number = -1;
  private scroller: Scroller = new Scroller();
  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private canvasCtx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private skySettings: RenderingContextSettings = new RenderingContextSettings(true);
  private skyCtx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.skySettings);
  private snrSettings: RenderingContextSettings = new RenderingContextSettings(true);
  private snrCtx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.snrSettings);

  aboutToAppear(): void {
    // 先把运行日志开起来。真机上出问题时 Mac 已经拔了，
    // 只剩这个文件能还原现场
    try {
      const ctx0 = this.getUIContext().getHostContext() as common.UIAbilityContext;
      DbgLog.init(ctx0);
      this.logPath = DbgLog.getPath();
      DbgLog.info('APP', '界面初始化，设备型号 SGT-AL00 / API 26');
    } catch (e) {
    }

    // 读出 AppID。申请高德「HarmonyOS 平台」类型的 Key 时要填这个
    try {
      const flag = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_SIGNATURE_INFO;
      const info = bundleManager.getBundleInfoForSelfSync(flag);
      this.appId = info.signatureInfo.appId;
      DbgLog.info('APP', 'APPID = ' + this.appId);
    } catch (e) {
      const err = e as Error;
      DbgLog.warn('APP', '读 AppID 失败：' + err.message);
    }

    this.port.onData = (chunk: Uint8Array) => {
      this.onChunk(chunk);
    };
    this.port.onError = (msg: string) => {
      DbgLog.error('USB', msg);
      this.errMsg = msg;
    };
    this.port.onClose = (reason: string) => {
      DbgLog.warn('USB', '连接关闭：' + reason);
      this.onPortClosed(reason);
    };
    // 演示模式下，数据也走同一条处理链
    this.demo.onLine = (line: string) => {
      this.rxBytes = this.rxBytes + line.length + 2;   // 让速率统计也有数
      this.handleLine(line);
    };
    this.scanDevices();
    this.timerId = setInterval(() => {
      this.tick();
    }, 200);
    // 测试时别让屏幕黑掉
    this.keepScreenOn();
  }

  aboutToDisappear(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
    this.store.stop();
    this.port.close();
  }

  private keepScreenOn(): void {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      window.getLastWindow(ctx).then((w: window.Window) => {
        w.setWindowKeepScreenOn(true);
      }).catch(() => {
      });
    } catch (e) {
    }
  }

  /* ==================== 串口数据 ==================== */

  /** 串口回调：只做最轻的活，切行塞缓冲，不碰界面状态 */
  private onChunk(chunk: Uint8Array): void {
    this.rxBytes = this.rxBytes + chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      this.rxBuf = this.rxBuf + String.fromCharCode(chunk[i]);
    }
    // 缓冲保护：没有换行的异常数据不能撑爆内存
    if (this.rxBuf.length > 131072) {
      this.rxBuf = this.rxBuf.substring(this.rxBuf.length - 32768);
    }
    let idx = this.rxBuf.indexOf('\n');
    while (idx >= 0) {
      const line = this.rxBuf.substring(0, idx).trim();
      this.rxBuf = this.rxBuf.substring(idx + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      idx = this.rxBuf.indexOf('\n');
    }
  }

  /**
   * 一条完整语句进入处理链。
   * 串口真实数据和演示模式共用这一条路，保证两边行为一致。
   */
  private handleLine(line: string): void {
    this.parser.feed(line, Date.now());
    this.store.addRaw(line);
    this.pendingLines.push(line);
    if (this.pendingLines.length > 1200) {
      this.pendingLines.splice(0, 200);
    }
  }

  /** 进入演示模式：不插硬件，跑内置的真实轨迹样本 */
  private startDemo(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!this.demo.load(ctx)) {
      this.errMsg = '演示数据加载失败，看运行日志';
      return;
    }
    // 清干净上一轮的状态
    this.parser.reset();
    this.logLines = [];
    this.pendingLines = [];
    this.rxBuf = '';
    this.rxBytes = 0;
    this.demoMode = true;
    this.connState = 'open';
    this.curDevName = '演示模式';
    this.curDevProduct = '内置真实轨迹样本（西安，150 秒）';
    this.startRecord();
    this.demo.start();
    DbgLog.info('APP', '进入演示模式');
  }

  private stopDemo(): void {
    this.demo.stop();
    this.demoMode = false;
    this.stopRecord();
    this.connState = 'idle';
    this.curDevName = '';
    this.curDevProduct = '';
    DbgLog.info('APP', '退出演示模式');
  }

  /* ==================== 地图 ==================== */

  /** 打开地图页，先把当前定位和历史轨迹推进 AppStorage */
  private openMap(): void {
    this.pushToStorage(true);
    router.pushUrl({ url: 'pages/MapPage' }).catch((e: Error) => {
      this.errMsg = '打开地图失败：' + e.message;
      DbgLog.error('APP', '打开地图页失败：' + e.message);
    });
  }

  /**
   * 把定位写进 AppStorage，地图页从那里读。
   * 高德底图是 GCJ-02，转换在 map.html 里做；
   * 这里传的始终是 WGS84 原始值。
   */
  private pushToStorage(force: boolean): void {
    if (!this.fix.hasPos) {
      return;
    }
    AppStorage.setOrCreate('fixLon', this.fix.lon);
    AppStorage.setOrCreate('fixLat', this.fix.lat);
    AppStorage.setOrCreate('fixQuality', this.fix.quality);
    AppStorage.setOrCreate('fixSpeed', isNaN(this.fix.speedKmh) ? 0 : this.fix.speedKmh);
    // NMEA 里没有水平精度字段，用 HDOP 粗估：HDOP × 5 米
    const acc = isNaN(this.fix.hdop) ? 0 : this.fix.hdop * 5;
    AppStorage.setOrCreate('fixAcc', acc);

    // 轨迹整包更新别太频繁，序列化开销不小
    const now = Date.now();
    if (force || now - this.lastTrailPush > 4000) {
      const t = this.parser.trail;
      // 点数没变就不用重新序列化
      if (force || t.length !== this.lastTrailCount) {
        this.lastTrailPush = now;
        this.lastTrailCount = t.length;
        // 必须从第一个点开始全给，不能只给最近一段。
        // 地图上要看的是「这一次采集的完整轨迹」
        const arr: number[][] = [];
        for (let i = 0; i < t.length; i++) {
          arr.push([t[i].lon, t[i].lat]);
        }
        AppStorage.setOrCreate('trailJson', JSON.stringify(arr));
      }
    }
  }

  /** 200ms 一次：批量刷新界面 */
  private tick(): void {
    const now = Date.now();
    this.fix = this.parser.snapshot(now);
    this.trailCount = this.parser.trail.length;
    // 同步给地图页（AppStorage）。没有定位时内部会直接返回
    this.pushToStorage(false);

    // 报文追加
    if (this.pendingLines.length > 0) {
      const add = this.pendingLines;
      this.pendingLines = [];
      for (let i = 0; i < add.length; i++) {
        this.logLines.push(add[i]);
      }
      if (this.logLines.length > MAX_LOG_LINES) {
        this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
      }
      if (this.tab === 1) {
        this.scroller.scrollEdge(Edge.Bottom);
      }
    }

    // 轨迹点按 1Hz 落盘
    if (this.recording && now - this.lastTrackTs >= 1000) {
      this.lastTrackTs = now;
      if (this.fix.quality > 0 && this.fix.hasPos) {
        const r = new TrackRow();
        r.utc = this.fix.utc;
        r.lat = this.fix.lat;
        r.lon = this.fix.lon;
        r.alt = this.fix.alt;
        r.quality = this.fix.quality;
        r.sats = this.fix.satsUsed;
        r.hdop = this.fix.hdop;
        r.speed = this.fix.speedKmh;
        r.course = this.fix.course;
        this.store.addTrack(r);
      }
      this.store.pump();
      this.recPoints = this.store.getTrackN();
      this.recFileSize = this.store.getBytes();
      this.recSize = humanSize(this.recFileSize);
    }

    // 速率统计
    if (now - this.lastRateTs >= 2000) {
      const dt = (now - this.lastRateTs) / 1000.0;
      if (dt > 0 && this.lastRateTs > 0) {
        this.lineRate = (this.fix.totalLines - 0) / 1.0;
        this.lineRate = Math.max(0, (this.rxBytes - this.lastRateBytes) / dt);
      }
      this.lastRateTs = now;
      this.lastRateBytes = this.rxBytes;
    }

    if (this.connState === 'open' || this.demoMode) {
      this.drawTrail();
    }
    // 星座页可见时才重绘，省电
    if (this.tab === 1) {
      this.drawSky();
      this.drawSnrBars();
    }
  }

  /* ==================== 惯导状态 ==================== */

  private insColor(): string {
    const ins = this.fix.ins;
    if (!ins.valid) {
      return '#5C6773';
    }
    if (ins.ins === 3) {
      return '#3FB950';
    }
    if (ins.ins >= 1) {
      return '#D29922';
    }
    return '#F85149';
  }

  private insText(): string {
    const ins = this.fix.ins;
    if (!ins.valid) {
      return '还没收到 SNRSTAT';
    }
    let s = insLabel(ins.ins) + ' (' + ins.ins + ')';
    if (ins.odo > 0) {
      s = s + ' · 里程计';
    }
    if (ins.install > 0) {
      s = s + ' · 安装角已标定';
    }
    return s;
  }

  /** 点一下把 APPID 复制到剪贴板，省得手抄 */
  private copyAppId(): void {
    if (this.appId.length === 0) {
      return;
    }
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.appId);
      pasteboard.getSystemPasteboard().setData(data).then(() => {
        DbgLog.info('APP', 'APPID 已复制到剪贴板');
      }).catch(() => {
      });
    } catch (e) {
      DbgLog.warn('APP', '复制 APPID 失败');
    }
  }

  /* ==================== 连接 ==================== */

  private scanDevices(): void {
    this.devList = SerialPort.listDevices();
    if (this.devList.length === 0) {
      this.errMsg = '没发现 USB 设备。检查：① 板子插好没有 ② 手机 OTG 开了没有';
    } else {
      this.errMsg = '';
    }
  }

  private async connectDev(b: DeviceBrief): Promise<void> {
    this.showDevPanel = false;
    this.connState = 'opening';
    this.errMsg = '';
    this.curDevName = b.name;
    this.curDevProduct = b.productName;

    let dev: usbManager.USBDevice | null = null;
    try {
      const list = usbManager.getDevices();
      for (let i = 0; i < list.length; i++) {
        if (list[i].name === b.name) {
          dev = list[i];
          break;
        }
      }
    } catch (e) {
      const err = e as BusinessError;
      this.errMsg = '读设备列表失败：' + err.message;
      this.connState = 'error';
      return;
    }
    if (dev === null) {
      this.errMsg = '设备已不在，可能被拔掉了';
      this.connState = 'error';
      return;
    }

    try {
      await this.port.open(dev, this.baud);
      this.portMode = this.port.getMode();
      this.connState = 'open';
      this.errMsg = '';
      // 连上就自动开始记录，不用再点一次
      this.startRecord();
    } catch (e) {
      const err = e as Error;
      this.errMsg = err.message;
      this.connState = 'error';
    }
  }

  private onPortClosed(reason: string): void {
    this.connState = 'idle';
    this.stopRecord();
    this.errMsg = '连接断开：' + reason;
  }

  private disconnect(): void {
    if (this.demoMode) {
      this.stopDemo();
      return;
    }
    this.stopRecord();
    this.port.close();
    this.connState = 'idle';
    this.curDevName = '';
    this.portMode = '';
  }

  /* ==================== 记录 ==================== */

  private startRecord(): void {
    if (this.recording) {
      return;
    }
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.store.start(ctx);
      this.recording = true;
      this.recName = this.store.getRawName();
      this.recPoints = 0;
      this.recFileSize = 0;
      this.recSize = '0 B';
      this.lastTrackTs = 0;
    } catch (e) {
      const err = e as Error;
      this.errMsg = '开始记录失败：' + err.message;
    }
  }

  private stopRecord(): void {
    if (!this.recording) {
      return;
    }
    this.store.stop();
    this.recording = false;
    this.recPoints = this.store.getTrackN();
    this.recFileSize = this.store.getBytes();
    this.recSize = humanSize(this.recFileSize);
  }

  /* ==================== 报文发送 ==================== */

  private async sendCmd(): Promise<void> {
    const t = this.cmdInput.trim();
    if (t.length === 0) {
      return;
    }
    const ok = await this.port.sendNmea(t);
    this.sentMsg = ok ? ('已发送 ' + t) : '发送失败';
  }

  /* ==================== 轨迹绘制 ==================== */

  private drawTrail(): void {
    const t = this.parser.trail;
    const w = this.canvasCtx.width;
    const h = this.canvasCtx.height;
    if (w <= 0 || h <= 0) {
      return;
    }
    this.canvasCtx.clearRect(0, 0, w, h);
    if (t.length === 0) {
      this.canvasCtx.fillStyle = '#8B949E';
      this.canvasCtx.font = '13px sans-serif';
      this.canvasCtx.textAlign = 'center';
      this.canvasCtx.fillText('等定位…', w / 2, h / 2);
      return;
    }

    let minLat = 1e9;
    let maxLat = -1e9;
    let minLon = 1e9;
    let maxLon = -1e9;
    for (let i = 0; i < t.length; i++) {
      if (t[i].lat < minLat) {
        minLat = t[i].lat;
      }
      if (t[i].lat > maxLat) {
        maxLat = t[i].lat;
      }
      if (t[i].lon < minLon) {
        minLon = t[i].lon;
      }
      if (t[i].lon > maxLon) {
        maxLon = t[i].lon;
      }
    }
    const midLat = (minLat + maxLat) / 2;
    // 经度方向按纬度收缩，否则轨迹会被横向拉宽
    let kx = Math.cos(midLat * Math.PI / 180);
    if (kx < 0.05) {
      kx = 0.05;
    }
    const spanX = (maxLon - minLon) * kx;
    const spanY = (maxLat - minLat);
    const pad = 12;
    let sc = Math.min((w - pad * 2) / Math.max(spanX, 1e-9),
      (h - pad * 2) / Math.max(spanY, 1e-9));
    if (!isFinite(sc) || sc <= 0) {
      sc = 1e6;
    }
    if (sc > 1e8) {
      sc = 1e8;
    }
    const cx = (minLon + maxLon) / 2;
    const cy = midLat;

    // 连接线画成虚线，颜色淡一点，让圆圈点成为主角
    this.canvasCtx.setLineDash([4, 4]);
    this.canvasCtx.strokeStyle = 'rgba(57,210,192,0.55)';
    this.canvasCtx.lineWidth = 1.2;
    this.canvasCtx.lineJoin = 'round';
    // 点数太多时抽样画：屏幕就这么点像素，画一万个点和画四千个点肉眼没区别，
    // 但每 200ms 重绘一次会把界面拖卡。数据本身一个不丢，文件里是完整的
    const step = t.length > 4000 ? Math.ceil(t.length / 4000) : 1;
    this.canvasCtx.beginPath();
    for (let j = 0; j < t.length; j = j + step) {
      const px = w / 2 + (t[j].lon - cx) * kx * sc;
      const py = h / 2 - (t[j].lat - cy) * sc;
      if (j === 0) {
        this.canvasCtx.moveTo(px, py);
      } else {
        this.canvasCtx.lineTo(px, py);
      }
    }
    // 补最后一个点，别让线头停在抽样位置上
    const lastIdx = t.length - 1;
    if (lastIdx > 0 && lastIdx % step !== 0) {
      this.canvasCtx.lineTo(w / 2 + (t[lastIdx].lon - cx) * kx * sc,
        h / 2 - (t[lastIdx].lat - cy) * sc);
    }
    this.canvasCtx.stroke();
    // 必须复位虚线，否则后面画圆圈也会变成虚线描边
    this.canvasCtx.setLineDash([]);

    // 每个轨迹点画一个小空心圆圈
    const dotStep = t.length > 220 ? Math.ceil(t.length / 220) : 1;
    this.canvasCtx.lineWidth = 1.2;
    this.canvasCtx.strokeStyle = '#39D2C0';
    for (let k = 0; k < t.length; k = k + dotStep) {
      const px = w / 2 + (t[k].lon - cx) * kx * sc;
      const py = h / 2 - (t[k].lat - cy) * sc;
      this.canvasCtx.beginPath();
      this.canvasCtx.arc(px, py, 2.4, 0, Math.PI * 2);
      this.canvasCtx.fillStyle = '#0B0F14';
      this.canvasCtx.fill();
      this.canvasCtx.stroke();
    }

    // 起点
    const sx = w / 2 + (t[0].lon - cx) * kx * sc;
    const sy = h / 2 - (t[0].lat - cy) * sc;
    this.canvasCtx.fillStyle = '#58A6FF';
    this.canvasCtx.beginPath();
    this.canvasCtx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    this.canvasCtx.fill();

    // 当前位置
    const ex = w / 2 + (t[t.length - 1].lon - cx) * kx * sc;
    const ey = h / 2 - (t[t.length - 1].lat - cy) * sc;
    this.canvasCtx.fillStyle = '#3FB950';
    this.canvasCtx.beginPath();
    this.canvasCtx.arc(ex, ey, 5, 0, Math.PI * 2);
    this.canvasCtx.fill();
  }

  /* ==================== 星座图 ==================== */

  private sysColor(sys: string): string {
    if (sys === 'GPS') {
      return '#3FB950';
    }
    if (sys === 'GLO') {
      return '#58A6FF';
    }
    if (sys === 'GAL') {
      return '#D29922';
    }
    if (sys === 'BDS') {
      return '#F85149';
    }
    if (sys === 'QZS') {
      return '#39D2C0';
    }
    return '#8B949E';
  }

  /**
   * 卫星天空图（极坐标）。
   * 圆心＝天顶（仰角 90°），外圈＝地平线（仰角 0°）；
   * 方位 0° 在上方＝正北，顺时针增加。
   */
  private drawSky(): void {
    const c = this.skyCtx;
    const w = c.width;
    const h = c.height;
    if (w <= 0 || h <= 0) {
      return;
    }
    c.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 20;

    // 仰角圈
    c.strokeStyle = '#1C242E';
    c.lineWidth = 1;
    for (let e = 0; e <= 90; e = e + 30) {
      const r = R * (90 - e) / 90;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();
    }
    // 十字
    c.beginPath();
    c.moveTo(cx - R, cy);
    c.lineTo(cx + R, cy);
    c.moveTo(cx, cy - R);
    c.lineTo(cx, cy + R);
    c.stroke();

    // 方位
    c.fillStyle = '#5C6773';
    c.font = '10px sans-serif';
    c.textAlign = 'center';
    c.fillText('北', cx, cy - R - 6);
    c.fillText('南', cx, cy + R + 13);
    c.fillText('东', cx + R + 9, cy + 4);
    c.fillText('西', cx - R - 9, cy + 4);

    // 卫星点
    const sats = this.fix.sats;
    for (let i = 0; i < sats.length; i++) {
      const s = sats[i];
      const el = s.elev < 0 ? 0 : (s.elev > 90 ? 90 : s.elev);
      const r = R * (90 - el) / 90;
      const a = s.azim * Math.PI / 180;
      const x = cx + r * Math.sin(a);
      const y = cy - r * Math.cos(a);
      // 点大小随 SNR 变，弱信号也画，只是更暗更小
      const base = s.snr > 0 ? s.snr : 20;
      const rad = 3 + Math.min(5, base / 12);
      c.fillStyle = this.sysColor(s.sys);
      c.globalAlpha = s.snr >= 30 ? 1 : (s.snr >= 20 ? 0.75 : 0.45);
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
      // PRN 号压在点中间
      c.fillStyle = '#0B0F14';
      c.font = 'bold 8px sans-serif';
      c.textAlign = 'center';
      c.fillText('' + s.prn, x, y + 2.5);
    }

    if (sats.length === 0) {
      c.fillStyle = '#5C6773';
      c.font = '12px sans-serif';
      c.textAlign = 'center';
      c.fillText('等卫星数据…', cx, cy);
    }
  }

  /** 每颗卫星的 SNR 柱图，按 SNR 从高到低排 */
  private drawSnrBars(): void {
    const c = this.snrCtx;
    const w = c.width;
    const h = c.height;
    if (w <= 0 || h <= 0) {
      return;
    }
    c.clearRect(0, 0, w, h);

    const padL = 24;
    const padR = 8;
    const padT = 8;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const MAX_SNR = 52;

    // 参考线
    c.strokeStyle = '#1C242E';
    c.lineWidth = 1;
    for (let v = 0; v <= MAX_SNR; v = v + 20) {
      const y = padT + plotH - (v / MAX_SNR) * plotH;
      c.beginPath();
      c.moveTo(padL, y);
      c.lineTo(w - padR, y);
      c.stroke();
      c.fillStyle = '#5C6773';
      c.font = '9px sans-serif';
      c.textAlign = 'right';
      c.fillText('' + v, padL - 4, y + 3);
    }

    const sats = this.fix.sats;
    if (sats.length === 0) {
      c.fillStyle = '#5C6773';
      c.font = '12px sans-serif';
      c.textAlign = 'center';
      c.fillText('等卫星数据…', w / 2, h / 2);
      return;
    }

    const n = sats.length;
    const slot = plotW / n;
    const barW = Math.max(2, Math.min(14, slot * 0.66));
    for (let i = 0; i < n; i++) {
      const s = sats[i];
      const v = s.snr < 0 ? 0 : (s.snr > MAX_SNR ? MAX_SNR : s.snr);
      const bh = (v / MAX_SNR) * plotH;
      const x = padL + slot * i + (slot - barW) / 2;
      const y = padT + plotH - bh;
      c.fillStyle = this.sysColor(s.sys);
      c.globalAlpha = 0.92;
      c.fillRect(x, y, barW, bh);
      c.globalAlpha = 1;
      // PRN 太密就隔一个标
      if (n <= 24 || i % 2 === 0) {
        c.fillStyle = '#5C6773';
        c.font = '8px sans-serif';
        c.textAlign = 'center';
        c.fillText('' + s.prn, x + barW / 2, h - 5);
      }
    }
  }

  /* ==================== 界面 ==================== */

  private fixColor(): string {
    if (this.fix.quality >= 2) {
      return '#3FB950';
    }
    if (this.fix.quality === 1) {
      return '#D29922';
    }
    return '#F85149';
  }

  private coordText(v: number, pos: string, neg: string): string {
    if (isNaN(v)) {
      return '—';
    }
    const hemi = v >= 0 ? pos : neg;
    return Math.abs(v).toFixed(7) + '° ' + hemi;
  }

  private numText(v: number, nd: number): string {
    if (isNaN(v) || v === undefined) {
      return '—';
    }
    return v.toFixed(nd);
  }

  private logColor(line: string): string {
    if (line.indexOf('GGA') > 0) {
      return '#7EE787';
    }
    if (line.indexOf('RMC') > 0) {
      return '#79C0FF';
    }
    if (line.indexOf('GSA') > 0) {
      return '#8B949E';
    }
    if (line.indexOf('GSV') > 0) {
      return '#6E7681';
    }
    if (line.indexOf('TXT') > 0) {
      return '#D29922';
    }
    return '#39D2C0';
  }

  build() {
    // @Entry 的 build 只能有一个根节点，所以最外层用 Stack：
    // 主界面铺满，设备选择浮层叠在上面
    Stack() {
      Column() {
      // ---------- 顶栏 ----------
      Row() {
        // 用 Row + 圆角做圆点。Circle().fill() 是 API 26 才有的，
        // 而本工程最低兼容 API 12，用它会在老设备上直接崩
        Row()
          .width(9)
          .height(9)
          .borderRadius(4.5)
          .backgroundColor(this.connState === 'open' ? '#3FB950' :
            (this.connState === 'opening' ? '#D29922' : '#F85149'))
        Text(this.connState === 'open' ? '采集中' :
          (this.connState === 'opening' ? '连接中…' : '未连接'))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor('#E6EDF3')
          .margin({ left: 8 })
        Blank()
        Text(this.connState === 'open' ? (humanSize(this.rxBytes) + ' · ' +
          this.lineRate.toFixed(0) + ' B/s') : '')
          .fontSize(11)
          .fontColor('#8B949E')
          .margin({ right: 10 })
        // 地图入口
        Row() {
          Text('地图')
            .fontSize(12)
            .fontColor('#58A6FF')
        }
        .padding({ left: 11, right: 11, top: 5, bottom: 5 })
        .backgroundColor('#1C242E')
        .borderRadius(12)
        .onClick(() => {
          this.openMap();
        })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 10 })
      .backgroundColor('#151B23')

      // ---------- 错误提示 ----------
      // 演示模式下不提示 USB 相关错误，那是正常的
      if (this.errMsg.length > 0 && !this.demoMode) {
        Row() {
          Text(this.errMsg)
            .fontSize(12)
            .fontColor('#F85149')
            .layoutWeight(1)
        }
        .width('100%')
        .padding(12)
        .backgroundColor('#2A1719')
      }

      // ---------- 定位大卡 ----------
      Column() {
        Row() {
          Text(this.fix.qualityLabel)
            .fontSize(26)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.fixColor())
          Blank()
          Text(this.fix.fixAge >= 0 && this.fix.fixAge <= 1.5 ? '刚刚' :
            (this.fix.fixAge > 0 ? this.fix.fixAge.toFixed(0) + ' 秒前' : '等首次定位'))
            .fontSize(12)
            .fontColor(this.fix.fixAge > 5 ? '#F85149' : '#8B949E')
        }
        .width('100%')
        .margin({ bottom: 6 })

        Row() {
          Text('纬度').fontSize(12).fontColor('#5C6773').width(34)
          Text(this.coordText(this.fix.lat, 'N', 'S'))
            .fontSize(18)
            .fontColor('#E6EDF3')
            .layoutWeight(1)
        }
        .width('100%')
        .margin({ bottom: 2 })

        Row() {
          Text('经度').fontSize(12).fontColor('#5C6773').width(34)
          Text(this.coordText(this.fix.lon, 'E', 'W'))
            .fontSize(18)
            .fontColor('#E6EDF3')
            .layoutWeight(1)
        }
        .width('100%')

        // 四个指标必须内联写，不能抽成 @Builder。
        // ArkUI 的 @Builder 按值传参时不会响应状态变化，
        // 抽出去之后数值会永远停在初始化那一帧（踩过：显示 0/0 和 -1.00）
        Row({ space: 6 }) {
          Column() {
            Text('' + this.fix.satsUsed + '/' + this.fix.visibleTotal)
              .fontSize(17)
              .fontWeight(FontWeight.Bold)
              .fontColor('#E6EDF3')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text('解算/可见')
              .fontSize(10)
              .fontColor('#5C6773')
              .margin({ top: 1 })
          }
          .layoutWeight(1)
          .padding({ top: 7, bottom: 7 })
          .backgroundColor('#1C242E')
          .borderRadius(8)

          Column() {
            Text(this.numText(this.fix.hdop, 2))
              .fontSize(17)
              .fontWeight(FontWeight.Bold)
              .fontColor('#E6EDF3')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text('HDOP')
              .fontSize(10)
              .fontColor('#5C6773')
              .margin({ top: 1 })
          }
          .layoutWeight(1)
          .padding({ top: 7, bottom: 7 })
          .backgroundColor('#1C242E')
          .borderRadius(8)

          Column() {
            Text(this.numText(this.fix.alt, 1))
              .fontSize(17)
              .fontWeight(FontWeight.Bold)
              .fontColor('#E6EDF3')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text('海拔 m')
              .fontSize(10)
              .fontColor('#5C6773')
              .margin({ top: 1 })
          }
          .layoutWeight(1)
          .padding({ top: 7, bottom: 7 })
          .backgroundColor('#1C242E')
          .borderRadius(8)

          Column() {
            Text(this.numText(this.fix.speedKmh, 1))
              .fontSize(17)
              .fontWeight(FontWeight.Bold)
              .fontColor('#E6EDF3')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text('速度 km/h')
              .fontSize(10)
              .fontColor('#5C6773')
              .margin({ top: 1 })
          }
          .layoutWeight(1)
          .padding({ top: 7, bottom: 7 })
          .backgroundColor('#1C242E')
          .borderRadius(8)
        }
        .width('100%')
        .margin({ top: 10 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 14, bottom: 12 })
      .backgroundColor('#151B23')

      // ---------- 轨迹 ----------
      Stack({ alignContent: Alignment.TopStart }) {
        Canvas(this.canvasCtx)
          .width('100%')
          .height(108)
          .onReady(() => {
            this.drawTrail();
          })
        Text('轨迹 · ' + this.trailCount + ' 点')
          .fontSize(10)
          .fontColor('#5C6773')
          .margin({ left: 8, top: 6 })
      }
      .width('100%')
      .height(108)
      .backgroundColor('#070A0E')

      // ---------- Tab ----------
      Row() {
        Text('仪表')
          .fontSize(13)
          .fontColor(this.tab === 0 ? '#E6EDF3' : '#8B949E')
          .fontWeight(this.tab === 0 ? FontWeight.Bold : FontWeight.Normal)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .padding({ top: 9, bottom: 9 })
          .onClick(() => {
            this.tab = 0;
          })
        Text('星座')
          .fontSize(13)
          .fontColor(this.tab === 1 ? '#E6EDF3' : '#8B949E')
          .fontWeight(this.tab === 1 ? FontWeight.Bold : FontWeight.Normal)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .padding({ top: 9, bottom: 9 })
          .onClick(() => {
            this.tab = 1;
            this.drawSky();
            this.drawSnrBars();
          })
        Text('原文')
          .fontSize(13)
          .fontColor(this.tab === 2 ? '#E6EDF3' : '#8B949E')
          .fontWeight(this.tab === 2 ? FontWeight.Bold : FontWeight.Normal)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .padding({ top: 9, bottom: 9 })
          .onClick(() => {
            this.tab = 2;
          })
      }
      .width('100%')
      .backgroundColor('#1C242E')

      // ---------- 内容区 ----------
      if (this.tab === 0) {
        Scroll() {
          Column() {
            // 星座明细
            ForEach(['GPS', 'GLO', 'GAL', 'BDS', 'QZS', 'SB'], (sys: string) => {
              if (this.fix.usedBySys.has(sys) || this.fix.visibleBySys.has(sys)) {
                Row() {
                  Text(sys)
                    .fontSize(13)
                    .fontColor('#8B949E')
                    .width(50)
                  Text((this.fix.usedBySys.get(sys) ?? 0) + ' 解算 / ' +
                    (this.fix.visibleBySys.get(sys) ?? 0) + ' 可见')
                    .fontSize(13)
                    .fontColor('#E6EDF3')
                    .layoutWeight(1)
                }
                .width('100%')
                .padding({ top: 7, bottom: 7 })
                .border({ width: { bottom: 1 }, color: '#1C242E' })
              }
            }, (sys: string) => sys)

            Row() {
              Text('SNR 均值').fontSize(13).fontColor('#8B949E').width(100)
              Text(this.numText(this.fix.snrAvg, 1) + ' dBHz')
                .fontSize(13).fontColor('#E6EDF3')
            }
            .width('100%').padding({ top: 7, bottom: 7 })

            Row() {
              Text('PDOP / VDOP').fontSize(13).fontColor('#8B949E').width(100)
              Text(this.numText(this.fix.pdop, 2) + ' / ' + this.numText(this.fix.vdop, 2))
                .fontSize(13).fontColor('#E6EDF3')
            }
            .width('100%').padding({ top: 7, bottom: 7 })

            Row() {
              Text('校验').fontSize(13).fontColor('#8B949E').width(100)
              Text('正确 ' + this.fix.ckOk + (this.fix.ckBad > 0 ? (' / 错误 ' + this.fix.ckBad) : ''))
                .fontSize(13)
                .fontColor(this.fix.ckBad > 0 ? '#F85149' : '#3FB950')
            }
            .width('100%').padding({ top: 7, bottom: 7 })

            Row() {
              Text('语句总数').fontSize(13).fontColor('#8B949E').width(100)
              Text('' + this.fix.totalLines).fontSize(13).fontColor('#E6EDF3')
            }
            .width('100%').padding({ top: 7, bottom: 7 })

            // 惯导状态，来自 $SNRSTAT
            Row() {
              Row()
                .width(7)
                .height(7)
                .borderRadius(3.5)
                .backgroundColor(this.insColor())
              Text('惯导')
                .fontSize(13)
                .fontColor('#8B949E')
                .width(38)
                .margin({ left: 6 })
              Text(this.insText())
                .fontSize(13)
                .fontColor(this.insColor())
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .width('100%').padding({ top: 7, bottom: 7 })

            // APPID：申请高德「HarmonyOS 平台」Key 时要填，点一下复制
            Row() {
              Text('APPID')
                .fontSize(13)
                .fontColor('#8B949E')
                .width(100)
              Text(this.appId.length > 0 ? this.appId : '读取中…')
                .fontSize(9)
                .fontColor('#5C6773')
                .layoutWeight(1)
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .onClick(() => {
                  this.copyAppId();
                })
            }
            .width('100%').padding({ top: 7, bottom: 7 })

            Row() {
              Text('运行日志').fontSize(13).fontColor('#8B949E').width(100)
              Text('files/logs/app.log').fontSize(11).fontColor('#5C6773').layoutWeight(1)
            }
            .width('100%').padding({ top: 7, bottom: 14 })
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 6 })
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      } else if (this.tab === 1) {
        // ---------- 星座页：天空图 + SNR 柱图 ----------
        Scroll() {
          Column() {
            Text('卫星天空图')
              .fontSize(11)
              .fontColor('#5C6773')
              .width('100%')
              .padding({ left: 4, top: 8, bottom: 4 })
            Canvas(this.skyCtx)
              .width('100%')
              .height(250)
              .backgroundColor('#070A0E')
              .borderRadius(10)
              .onReady(() => {
                this.drawSky();
              })

            Text('各卫星 SNR（dBHz）')
              .fontSize(11)
              .fontColor('#5C6773')
              .width('100%')
              .padding({ left: 4, top: 14, bottom: 4 })
            Canvas(this.snrCtx)
              .width('100%')
              .height(150)
              .backgroundColor('#070A0E')
              .borderRadius(10)
              .onReady(() => {
                this.drawSnrBars();
              })

            // 图例
            Row({ space: 12 }) {
              Row({ space: 4 }) {
                Row().width(8).height(8).borderRadius(4).backgroundColor('#3FB950')
                Text('GPS').fontSize(10).fontColor('#8B949E')
              }
              Row({ space: 4 }) {
                Row().width(8).height(8).borderRadius(4).backgroundColor('#58A6FF')
                Text('GLO').fontSize(10).fontColor('#8B949E')
              }
              Row({ space: 4 }) {
                Row().width(8).height(8).borderRadius(4).backgroundColor('#D29922')
                Text('GAL').fontSize(10).fontColor('#8B949E')
              }
              Row({ space: 4 }) {
                Row().width(8).height(8).borderRadius(4).backgroundColor('#F85149')
                Text('BDS').fontSize(10).fontColor('#8B949E')
              }
              Row({ space: 4 }) {
                Row().width(8).height(8).borderRadius(4).backgroundColor('#39D2C0')
                Text('QZS').fontSize(10).fontColor('#8B949E')
              }
              Row({ space: 4 }) {
                Row().width(8).height(8).borderRadius(4).backgroundColor('#8B949E')
                Text('SB').fontSize(10).fontColor('#8B949E')
              }
            }
            .width('100%')
            .padding({ left: 4, top: 10, bottom: 16 })
          }
          .width('100%')
          .padding({ left: 16, right: 16 })
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      } else {
        List({ scroller: this.scroller }) {
          ForEach(this.logLines, (line: string, idx: number) => {
            ListItem() {
              Text(line)
                .fontSize(11)
                .fontColor(this.logColor(line))
                .fontFamily('monospace')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
                .padding({ left: 14, right: 14, top: 2, bottom: 2 })
            }
          }, (line: string, idx: number) => idx + '_' + line)
        }
        .layoutWeight(1)
        .width('100%')
        .backgroundColor('#070A0E')
        .scrollBar(BarState.Off)
      }

      // ---------- 记录状态 ----------
      Row() {
        if (this.recording) {
          Row()
            .width(7)
            .height(7)
            .borderRadius(3.5)
            .backgroundColor('#3FB950')
        }
        Text(this.recording ? ('记录中 ' + this.recName) : '未记录')
          .fontSize(11)
          .fontColor(this.recording ? '#3FB950' : '#5C6773')
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ left: this.recording ? 6 : 0 })
        if (this.recording) {
          Text(this.recSize + ' · ' + this.recPoints + ' 点')
            .fontSize(11)
            .fontColor('#8B949E')
        }
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })
      .backgroundColor('#1C242E')

      // ---------- 底部操作 ----------
      Row({ space: 8 }) {
        Button(this.connState === 'open' ? '断开' : '连接')
          .fontSize(14)
          .layoutWeight(1)
          .height(42)
          .backgroundColor(this.connState === 'open' ? '#2A1719' : '#238636')
          .fontColor(this.connState === 'open' ? '#F85149' : '#FFFFFF')
          .onClick(() => {
            if (this.connState === 'open') {
              this.disconnect();
            } else {
              this.scanDevices();
              this.showDevPanel = true;
            }
          })

        Button(this.recording ? '停记' : '记录')
          .fontSize(14)
          .layoutWeight(1)
          .height(42)
          .enabled(this.connState === 'open')
          .backgroundColor(this.recording ? '#8B5A00' : '#1F6FEB')
          .fontColor('#FFFFFF')
          .onClick(() => {
            if (this.recording) {
              this.stopRecord();
            } else {
              this.startRecord();
            }
          })

        Button(this.demoMode ? '停演' : '演示')
          .fontSize(14)
          .layoutWeight(1)
          .height(42)
          .backgroundColor(this.demoMode ? '#5C3A00' : '#1C242E')
          .fontColor(this.demoMode ? '#D29922' : '#8B949E')
          .onClick(() => {
            if (this.demoMode) {
              this.stopDemo();
            } else {
              if (this.connState === 'open') {
                this.disconnect();
              }
              this.startDemo();
            }
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10, bottom: 16 })
      .backgroundColor('#151B23')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0B0F14')

    // ---------- 设备选择浮层 ----------
    if (this.showDevPanel) {
      Column() {
        Column() {
          Text('选择设备')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#E6EDF3')
            .margin({ bottom: 4 })
          Text('VID/PID 会显示在下面，CH343 是 1A86:55D3')
            .fontSize(11)
            .fontColor('#8B949E')
            .margin({ bottom: 12 })

          ForEach(this.devList, (b: DeviceBrief) => {
            Column() {
              Row() {
                Text(b.productName.length > 0 ? b.productName : '未命名设备')
                  .fontSize(14)
                  .fontColor('#E6EDF3')
                  .layoutWeight(1)
                Text(b.kind)
                  .fontSize(11)
                  .fontColor(b.kind.indexOf('CDC') >= 0 ? '#3FB950' : '#D29922')
              }
              .width('100%')
              Row() {
                Text(b.vendorId.toString(16).toUpperCase() + ':' +
                  b.productId.toString(16).toUpperCase())
                  .fontSize(11)
                  .fontColor('#8B949E')
                  .fontFamily('monospace')
                Text('  ' + b.note)
                  .fontSize(11)
                  .fontColor('#5C6773')
                  .layoutWeight(1)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
              .width('100%')
              .margin({ top: 3 })
            }
            .width('100%')
            .padding(12)
            .margin({ bottom: 8 })
            .backgroundColor('#1C242E')
            .borderRadius(10)
            .onClick(() => {
              this.connectDev(b);
            })
          }, (b: DeviceBrief) => b.name)

          if (this.devList.length === 0) {
            Text('一个设备都没读到。先确认手机 OTG 已开、板子已插好。')
              .fontSize(13)
              .fontColor('#D29922')
              .margin({ top: 8, bottom: 8 })
          }

          Row({ space: 8 }) {
            Button('重新扫描')
              .fontSize(13)
              .layoutWeight(1)
              .backgroundColor('#1C242E')
              .fontColor('#8B949E')
              .onClick(() => {
                this.scanDevices();
              })
            Button('关闭')
              .fontSize(13)
              .layoutWeight(1)
              .backgroundColor('#1C242E')
              .fontColor('#8B949E')
              .onClick(() => {
                this.showDevPanel = false;
              })
          }
          .width('100%')
          .margin({ top: 6 })
        }
        .width('92%')
        .padding(18)
        .backgroundColor('#151B23')
        .borderRadius(16)
      }
      .width('100%')
      .height('100%')
      .backgroundColor('rgba(0,0,0,0.7)')
      .justifyContent(FlexAlign.Center)
      .onClick(() => {
        this.showDevPanel = false;
      })
    }
    }
    .width('100%')
    .height('100%')
  }
}
