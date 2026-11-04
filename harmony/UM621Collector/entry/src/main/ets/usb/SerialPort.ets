/*
 * UM621A 手机采集器 —— USB 串口驱动
 *
 * 板载芯片是 CH343（沁恒）。它有两种工作模式：
 *   1) CDC-ACM 模式：设备以标准 USB 通信类枚举，用标准类请求就能设波特率。
 *      模块板出厂就是这个模式 —— 证据是 macOS 免驱直接认成 /dev/cu.usbmodem*。
 *   2) VCP 模式（厂商自定义）：需要写 CH343 私有寄存器。
 *      鸿蒙上没有这颗芯片的驱动，只能用户态手写，风险高。
 *
 * 所以这里优先走 CDC-ACM。如果枚举出来是厂商自定义类，界面会明确提示，
 * 不会静默失败 —— 第一次上机最怕的就是"什么都不发生"。
 *
 * 关键 API（严格按官方 .d.ts 写，别凭记忆改）：
 *   USBEndpoint.direction : 0 = OUT（主机→设备），0x80 = IN（设备→主机）
 *   USBEndpoint.type      : 2 = 批量传输
 *   usbControlTransfer 的参数类型是 USBDeviceRequestParams（不是废弃的 USBControlParams）
 */

import { usbManager } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DbgLog } from '../util/DbgLog';

/** CDC 通信接口类号 */
const CLS_CDC_COMM = 2;
/** CDC 数据接口类号 */
const CLS_CDC_DATA = 10;
/** 厂商自定义类（CH343 的 VCP 模式走这里） */
const CLS_VENDOR = 0xFF;
/** 批量传输端点类型 */
const EP_BULK = 2;
/** 端点方向：设备到主机 */
const DIR_IN = 0x80;

/** bmRequestType 常用组合：主机→设备 | 类请求 | 接收者是接口 */
const BM_OUT_CLASS_IFACE = 0x21;
/** 设备→主机 | 类请求 | 接收者是接口 */
const BM_IN_CLASS_IFACE = 0xA1;

/** CDC 类请求码 */
const CDC_SET_LINE_CODING = 0x20;
const CDC_GET_LINE_CODING = 0x21;
const CDC_SET_CONTROL_LINE_STATE = 0x22;

/** 沁恒的 USB 厂商号 */
const VID_WCH = 0x1A86;

export class DeviceBrief {
  name: string = '';
  vendorId: number = 0;
  productId: number = 0;
  productName: string = '';
  manufacturerName: string = '';
  serial: string = '';
  /** 'CDC' 标准通信类 / 'VCH' 厂商自定义 / '???' 认不出 */
  kind: string = '';
  /** 人类可读的一句话说明 */
  note: string = '';
}

export class IfaceInfo {
  id: number = 0;
  clazz: number = 0;
  subClass: number = 0;
  protocol: number = 0;
  alt: number = 0;
  endpoints: string[] = [];
}

/** 设备结构诊断信息，第一次上机排错用 */
export class DeviceDiag {
  name: string = '';
  vid: string = '';
  pid: string = '';
  product: string = '';
  manufacturer: string = '';
  serial: string = '';
  deviceClass: number = 0;
  configs: number = 0;
  ifaces: IfaceInfo[] = [];
}

function hex4(v: number): string {
  let s: string = v.toString(16).toUpperCase();
  while (s.length < 4) {
    s = '0' + s;
  }
  return '0x' + s;
}

/** 判断某个接口是不是带批量端点的数据接口 */
function hasBulk(iface: usbManager.USBInterface): boolean {
  for (let i = 0; i < iface.endpoints.length; i++) {
    if (iface.endpoints[i].type === EP_BULK) {
      return true;
    }
  }
  return false;
}

export class SerialPort {
  private pipe: usbManager.USBDevicePipe | null = null;
  private inEp: usbManager.USBEndpoint | null = null;
  private outEp: usbManager.USBEndpoint | null = null;
  private claimed: usbManager.USBInterface[] = [];
  private reading: boolean = false;
  private devName: string = '';
  private mode: string = '';
  private cdcIndex: number = -1;

  /** 收到数据回调，chunk 是有效长度的拷贝 */
  public onData: (chunk: Uint8Array) => void = (chunk: Uint8Array) => {};
  /** 出错回调 */
  public onError: (msg: string) => void = (msg: string) => {};
  /** 连接断开回调 */
  public onClose: (reason: string) => void = (reason: string) => {};

  isOpen(): boolean {
    return this.pipe !== null;
  }

  getMode(): string {
    return this.mode;
  }

  /* ==================== 设备枚举 ==================== */

  /** 列出当前插着的所有 USB 设备，并标注可用性 */
  static listDevices(): DeviceBrief[] {
    const out: DeviceBrief[] = [];
    let devices: usbManager.USBDevice[] = [];
    try {
      devices = usbManager.getDevices();
    } catch (e) {
      return out;
    }
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];
      const b = new DeviceBrief();
      b.name = d.name;
      b.vendorId = d.vendorId;
      b.productId = d.productId;
      b.productName = d.productName;
      b.manufacturerName = d.manufacturerName;
      b.serial = d.serial;
      const k = SerialPort.classify(d);
      b.kind = k[0];
      b.note = k[1];
      out.push(b);
    }
    return out;
  }

  /** 判断设备类型，返回 [类型标记, 说明] */
  private static classify(d: usbManager.USBDevice): string[] {
    let hasComm = false;
    let hasData = false;
    let hasVendor = false;
    const cfg = d.configs.length > 0 ? d.configs[0] : null;
    if (cfg !== null) {
      for (let i = 0; i < cfg.interfaces.length; i++) {
        const it = cfg.interfaces[i];
        if (it.clazz === CLS_CDC_COMM) {
          hasComm = true;
        } else if (it.clazz === CLS_CDC_DATA) {
          hasData = true;
        } else if (it.clazz === CLS_VENDOR) {
          hasVendor = true;
        }
      }
    }
    if (hasComm && hasData) {
      const tag = d.vendorId === VID_WCH ? 'CDC/CH34x' : 'CDC';
      return [tag, '标准串口，可以直接用'];
    }
    if (hasVendor) {
      if (d.vendorId === VID_WCH) {
        return ['VCP/CH34x', '沁恒自定义模式，本 App 需额外初始化，可能不通'];
      }
      return ['厂商自定义', '非标准串口，大概率不支持'];
    }
    return ['其他', '没有串口端点'];
  }

  /** 导出设备结构，界面里展示，排错用 */
  static diagnose(devName: string): DeviceDiag {
    const r = new DeviceDiag();
    let devices: usbManager.USBDevice[] = [];
    try {
      devices = usbManager.getDevices();
    } catch (e) {
      return r;
    }
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];
      if (d.name !== devName) {
        continue;
      }
      r.name = d.name;
      r.vid = hex4(d.vendorId);
      r.pid = hex4(d.productId);
      r.product = d.productName;
      r.manufacturer = d.manufacturerName;
      r.serial = d.serial;
      r.deviceClass = d.clazz;
      r.configs = d.configs.length;
      if (d.configs.length > 0) {
        const cfg = d.configs[0];
        for (let j = 0; j < cfg.interfaces.length; j++) {
          const it = cfg.interfaces[j];
          const info = new IfaceInfo();
          info.id = it.id;
          info.clazz = it.clazz;
          info.subClass = it.subClass;
          info.protocol = it.protocol;
          info.alt = it.alternateSetting;
          for (let k = 0; k < it.endpoints.length; k++) {
            const ep = it.endpoints[k];
            const dir = ep.direction === DIR_IN ? 'IN' : 'OUT';
            const ty = ep.type === EP_BULK ? 'BULK' : ('T' + ep.type);
            info.endpoints.push(`${dir}/${ty} addr=${ep.address} max=${ep.maxPacketSize}`);
          }
          r.ifaces.push(info);
        }
      }
      break;
    }
    return r;
  }

  /* ==================== 打开 / 关闭 ==================== */

  /**
   * 打开串口。
   * @param dev    目标设备
   * @param baud   波特率，UM621A 默认 460800
   */
  async open(dev: usbManager.USBDevice, baud: number): Promise<void> {
    DbgLog.info('USB', '======== 打开串口 ========');
    DbgLog.info('USB', '设备 ' + dev.name + '  VID=' + hex4(dev.vendorId) +
      ' PID=' + hex4(dev.productId));
    DbgLog.info('USB', '产品名 "' + dev.productName + '"  厂商 "' +
      dev.manufacturerName + '"  序列号 ' + dev.serial);
    DbgLog.info('USB', '目标波特率 ' + baud);

    // 1) 申请授权。插上设备后第一次会弹系统框，用户点"允许"即可
    if (!usbManager.hasRight(dev.name)) {
      DbgLog.info('USB', '没有授权，发起 requestRight（会弹系统框）');
      const ok: boolean = await usbManager.requestRight(dev.name);
      DbgLog.info('USB', '授权结果 ' + ok);
      if (!ok) {
        DbgLog.error('USB', '用户拒绝了 USB 授权');
        throw new Error('你拒绝了 USB 授权，无法打开串口');
      }
    } else {
      DbgLog.info('USB', '已有授权，跳过授权弹窗');
    }

    // 2) 建立数据管道
    this.pipe = usbManager.connectDevice(dev);
    this.devName = dev.name;
    DbgLog.info('USB', 'connectDevice 成功 bus=' + this.pipe.busNum +
      ' addr=' + this.pipe.devAddress);

    if (dev.configs.length === 0) {
      DbgLog.error('USB', '设备没有配置描述符');
      this.cleanup();
      throw new Error('设备没有配置描述符，读不到接口信息');
    }
    const cfg = dev.configs[0];

    // 把整个接口结构 dump 出来。第一次上机排错全靠这段
    DbgLog.info('USB', '配置数 ' + dev.configs.length + '，第 1 个配置有 ' +
      cfg.interfaces.length + ' 个接口');
    for (let c = 0; c < cfg.interfaces.length; c++) {
      const it0 = cfg.interfaces[c];
      let eps = '';
      for (let e = 0; e < it0.endpoints.length; e++) {
        const ep0 = it0.endpoints[e];
        eps = eps + '[addr=' + ep0.address + ' dir=' +
          (ep0.direction === DIR_IN ? 'IN' : 'OUT') + ' type=' + ep0.type +
          ' max=' + ep0.maxPacketSize + ']';
      }
      DbgLog.info('USB', '  接口#' + it0.id + ' class=' + it0.clazz +
        ' sub=' + it0.subClass + ' proto=' + it0.protocol +
        ' alt=' + it0.alternateSetting + ' 端点:' + (eps.length > 0 ? eps : '无'));
    }

    // 3) 区分 CDC 和厂商自定义
    let commIface: usbManager.USBInterface | null = null;
    let dataIface: usbManager.USBInterface | null = null;
    let vendorIface: usbManager.USBInterface | null = null;

    for (let i = 0; i < cfg.interfaces.length; i++) {
      const it = cfg.interfaces[i];
      if (it.clazz === CLS_CDC_COMM) {
        commIface = it;
      } else if (it.clazz === CLS_CDC_DATA) {
        dataIface = it;
      } else if (it.clazz === CLS_VENDOR && hasBulk(it)) {
        vendorIface = it;
      }
    }
    DbgLog.info('USB', '识别结果：CDC通信接口=' + (commIface !== null ? '有' : '无') +
      ' CDC数据接口=' + (dataIface !== null ? '有' : '无') +
      ' 厂商接口=' + (vendorIface !== null ? '有' : '无'));

    if (commIface !== null && dataIface !== null) {
      // ---- 标准 CDC-ACM ----
      this.mode = 'CDC';
      this.cdcIndex = commIface.id;
      this.claim(commIface);
      this.claim(dataIface);
      this.pickEndpoints(dataIface);
      await this.cdcSetup(baud, commIface.id);
    } else if (vendorIface !== null) {
      // ---- 厂商自定义（CH343 的 VCP 模式）----
      this.mode = 'VCP';
      this.claim(vendorIface);
      this.pickEndpoints(vendorIface);
      // 这种模式下没有标准类请求可用，只能直连收发。
      // CH343 上电默认波特率通常不是 460800，所以很可能收到乱码。
      // 这里不假装成功，交给界面提示用户。
      throw new Error(
        '这块板子是 CH343 的厂商自定义模式（VCP），不是标准 CDC。\n' +
        '鸿蒙没有这颗芯片的驱动，App 无法设置波特率。\n' +
        '请把这个提示发给我，我来加 CH343 私有初始化。'
      );
    } else {
      this.cleanup();
      throw new Error('这个设备没有可用的串口端点');
    }

    if (this.inEp === null) {
      DbgLog.error('USB', '找不到数据接收端点（IN），无法读取');
      this.cleanup();
      throw new Error('找不到数据接收端点');
    }

    DbgLog.info('USB', '端点选定：IN addr=' + this.inEp.address +
      ' / OUT ' + (this.outEp !== null ? ('addr=' + this.outEp.address) : '无'));
    DbgLog.info('USB', '模式 ' + this.mode + '，串口就绪，进入读取循环');

    // 4) 启动读取循环
    this.reading = true;
    this.loop();
  }

  /** 声明接口并记下来，关闭时统一释放 */
  private claim(iface: usbManager.USBInterface): void {
    const pipe = this.pipe;
    if (pipe === null) {
      return;
    }
    usbManager.claimInterface(pipe, iface, true);
    this.claimed.push(iface);
  }

  /** 从接口里挑出批量端点：一个读一个写 */
  private pickEndpoints(iface: usbManager.USBInterface): void {
    this.inEp = null;
    this.outEp = null;
    let inAddr: number = -1;
    let outAddr: number = -1;
    for (let i = 0; i < iface.endpoints.length; i++) {
      const ep = iface.endpoints[i];
      if (ep.type !== EP_BULK) {
        continue;
      }
      if (ep.direction === DIR_IN && inAddr < 0) {
        this.inEp = ep;
        inAddr = ep.address;
      } else if (ep.direction !== DIR_IN && outAddr < 0) {
        this.outEp = ep;
        outAddr = ep.address;
      }
    }
  }

  /** CDC 标准类请求：置 DTR/RTS + 设置 8N1 与波特率 */
  private async cdcSetup(baud: number, commIfaceId: number): Promise<void> {
    // DTR + RTS 置位。不拉这两根线，有些板子不会往外发数据
    await this.ctrlOut(BM_OUT_CLASS_IFACE, CDC_SET_CONTROL_LINE_STATE, 0x0003,
      commIfaceId, new Uint8Array(0));

    // SET_LINE_CODING 的载荷是 7 字节：波特率 4 字节小端 + 停止位 + 校验 + 数据位
    const lc = new Uint8Array(7);
    lc[0] = baud & 0xFF;
    lc[1] = (baud >> 8) & 0xFF;
    lc[2] = (baud >> 16) & 0xFF;
    lc[3] = (baud >>> 24) & 0xFF;
    lc[4] = 0;   // 1 位停止位
    lc[5] = 0;   // 无校验
    lc[6] = 8;   // 8 位数据位
    await this.ctrlOut(BM_OUT_CLASS_IFACE, CDC_SET_LINE_CODING, 0, commIfaceId, lc);
  }

  /** 回读当前串口参数，十六进制显示，用来确认波特率真的设进去了 */
  async readLineCoding(): Promise<string> {
    const pipe = this.pipe;
    if (pipe === null) {
      return '未连接';
    }
    const buf = new Uint8Array(7);
    const p: usbManager.USBDeviceRequestParams = {
      bmRequestType: BM_IN_CLASS_IFACE,
      bRequest: CDC_GET_LINE_CODING,
      wValue: 0,
      wIndex: this.cdcIndex,
      wLength: 7,
      data: buf
    };
    try {
      const n = await usbManager.usbControlTransfer(pipe, p, 1000);
      if (n < 7) {
        return `回读失败（只拿到 ${n} 字节）`;
      }
      const baud = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
      return `波特率 ${baud} · 停止位 ${buf[4] + 1} · 校验 ${buf[5]} · 数据位 ${buf[6]}`;
    } catch (e) {
      const err = e as BusinessError;
      return `回读异常：${err.message}`;
    }
  }

  /** 主机→设备的类请求 */
  private async ctrlOut(bm: number, req: number, value: number,
                        index: number, data: Uint8Array): Promise<number> {
    const pipe = this.pipe;
    if (pipe === null) {
      throw new Error('设备未连接');
    }
    const p: usbManager.USBDeviceRequestParams = {
      bmRequestType: bm,
      bRequest: req,
      wValue: value,
      wIndex: index,
      wLength: data.length,
      data: data
    };
    try {
      return await usbManager.usbControlTransfer(pipe, p, 1000);
    } catch (e) {
      const err = e as BusinessError;
      throw new Error(`控制传输失败(code=${err.code})：${err.message}`);
    }
  }

  /* ==================== 读写 ==================== */

  /** 读取循环：一直挂着等数据，超时就重试 */
  private async loop(): Promise<void> {
    const buf = new Uint8Array(4096);
    while (this.reading) {
      const pipe = this.pipe;
      const ep = this.inEp;
      if (pipe === null || ep === null) {
        break;
      }
      try {
        const n: number = await usbManager.bulkTransfer(pipe, ep, buf, 200);
        if (n > 0) {
          // 必须拷贝出去，buf 下一轮会被复用
          const chunk = buf.slice(0, n);
          this.onData(chunk);
        } else {
          // 超时返回 <=0 属于正常，喘口气继续
          await this.sleep(10);
        }
      } catch (e) {
        const err = e as BusinessError;
        // 超时类错误不当故障处理
        const code = err.code === undefined ? 0 : err.code;
        if (code === 0 || code === 3600001 || code === 401) {
          await this.sleep(20);
          continue;
        }
        if (this.reading) {
          this.reading = false;
          this.onError(`读取中断：code=${code} ${err.message}`);
          this.onClose('读取中断');
        }
        return;
      }
    }
  }

  /** 发送数据（下发配置命令用） */
  async write(data: Uint8Array): Promise<number> {
    const pipe = this.pipe;
    const ep = this.outEp;
    if (pipe === null || ep === null) {
      return -1;
    }
    try {
      return await usbManager.bulkTransfer(pipe, ep, data, 1000);
    } catch (e) {
      const err = e as BusinessError;
      this.onError(`发送失败：${err.message}`);
      return -1;
    }
  }

  /** 发一条 NMEA 命令，自动补校验和与回车换行 */
  async sendNmea(body: string): Promise<boolean> {
    let s = body.trim();
    if (s.startsWith('$')) {
      s = s.substring(1);
    }
    const star = s.indexOf('*');
    if (star >= 0) {
      s = s.substring(0, star);
    }
    let cs = 0;
    for (let i = 0; i < s.length; i++) {
      cs = cs ^ s.charCodeAt(i);
    }
    let hex = cs.toString(16).toUpperCase();
    if (hex.length < 2) {
      hex = '0' + hex;
    }
    const line = '$' + s + '*' + hex + '\r\n';
    const bytes = new Uint8Array(line.length);
    for (let i = 0; i < line.length; i++) {
      bytes[i] = line.charCodeAt(i) & 0xFF;
    }
    const n = await this.write(bytes);
    return n > 0;
  }

  /** 关闭串口，释放接口与管道 */
  close(): void {
    this.reading = false;
    // 给读循环一点时间退出，避免释放时还在传输
    setTimeout(() => {
      this.cleanup();
    }, 120);
  }

  private cleanup(): void {
    const pipe = this.pipe;
    if (pipe !== null) {
      for (let i = 0; i < this.claimed.length; i++) {
        try {
          usbManager.releaseInterface(pipe, this.claimed[i]);
        } catch (e) {
          // 释放失败不影响后续
        }
      }
      try {
        usbManager.closePipe(pipe);
      } catch (e) {
        // 已经关了
      }
    }
    this.claimed = [];
    this.pipe = null;
    this.inEp = null;
    this.outEp = null;
    this.mode = '';
    this.cdcIndex = -1;
    this.reading = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }
}
