/*
 * UM621 采集器 —— 地图页
 *
 * 用 WebView 加载 rawfile/map.html，里面跑高德 JS API。
 * 数据走 AppStorage：主界面每秒写一次当前定位，这里定时读出来喂给地图。
 *
 * 为什么不用高德鸿蒙原生 SDK：
 *   原生 SDK 要「HarmonyOS 平台」类型 Key 并绑定 AppID，申请链路长；
 *   而且要装 ohpm 依赖，和 API 26 可能有适配问题。
 *   我们只需要 1Hz 位置更新 + 画轨迹，WebView 完全够用，出问题也好修。
 */

import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { DbgLog } from '../util/DbgLog';

@Entry
@Component
struct MapPage {
  private controller: webview.WebviewController = new webview.WebviewController();
  private timerId: number = -1;
  private pageReady: boolean = false;
  private lastLon: number = 0;
  private lastLat: number = 0;
  private pushedTrail: boolean = false;

  @State loadErr: string = '';
  @State followOn: boolean = true;
  @State showTools: boolean = true;

  aboutToAppear(): void {
    DbgLog.info('MAP', '进入地图页');
    // 300ms 轮询一次，比 @StorageLink 的 watch 更省心
    this.timerId = setInterval(() => {
      this.syncPos();
    }, 300);
  }

  aboutToDisappear(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
    DbgLog.info('MAP', '离开地图页');
  }

  /** 把 AppStorage 里的最新定位推给地图 */
  private syncPos(): void {
    if (!this.pageReady) {
      return;
    }
    const lon = AppStorage.get<number>('fixLon');
    const lat = AppStorage.get<number>('fixLat');
    if (lon === undefined || lat === undefined) {
      return;
    }
    if (lon === this.lastLon && lat === this.lastLat) {
      return;
    }
    this.lastLon = lon;
    this.lastLat = lat;

    const acc = AppStorage.get<number>('fixAcc') ?? 0;
    const q = AppStorage.get<number>('fixQuality') ?? 0;
    const spd = AppStorage.get<number>('fixSpeed') ?? 0;

    try {
      this.controller.runJavaScript('updatePos(' + lon + ',' + lat + ',' +
        acc + ',' + q + ',' + spd + ')');
    } catch (e) {
      const err = e as Error;
      DbgLog.warn('MAP', '更新位置失败：' + err.message);
    }
  }

  /** 首次进入把已有轨迹整批灌进去 */
  private pushTrail(): void {
    if (!this.pageReady || this.pushedTrail) {
      return;
    }
    const json = AppStorage.get<string>('trailJson');
    if (json === undefined || json.length < 3) {
      return;
    }
    try {
      this.controller.runJavaScript('setTrail(' + JSON.stringify(json) + ')');
      this.pushedTrail = true;
      DbgLog.info('MAP', '灌入历史轨迹');
    } catch (e) {
    }
  }

  private js(code: string): void {
    if (!this.pageReady) {
      return;
    }
    try {
      this.controller.runJavaScript(code);
    } catch (e) {
    }
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Web({ src: $rawfile('map.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        // 鸿蒙 WebView 默认 UA 会被高德 JS API 判定成"浏览器版本过低"，
        // 降级到兼容模式后自定义地图样式（深色）就不生效了。伪造成较新的 Chrome
        .userAgent('Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .onlineImageAccess(true)
        .mixedMode(MixedMode.All)
        .zoomAccess(false)
        .onPageEnd(() => {
          this.pageReady = true;
          DbgLog.info('MAP', '地图页面加载完成');
          // 稍等一下，等 AMap SDK 初始化完
          setTimeout(() => {
            this.pushTrail();
            this.syncPos();
          }, 800);
        })
        .onErrorReceive((e) => {
          if (e) {
            this.loadErr = '资源加载出错';
          }
        })
        .onConsole((ev) => {
          if (ev && ev.message) {
            const msg = ev.message.getMessage();
            if (msg.length > 0) {
              DbgLog.info('MAP-JS', msg);
            }
          }
          return false;
        })

      // ---------- 返回按钮 ----------
      Row() {
        Row() {
          Text('‹')
            .fontSize(26)
            .fontColor('#E6EDF3')
            .margin({ top: -3 })
          Text('返回')
            .fontSize(14)
            .fontColor('#E6EDF3')
            .margin({ left: 2 })
        }
        .padding({ left: 12, right: 14, top: 6, bottom: 6 })
        .backgroundColor('rgba(21,27,35,0.88)')
        .borderRadius(18)
        .backdropBlur(10)
        .onClick(() => {
          router.back();
        })
      }
      .margin({ left: 12, top: 10 })

      // ---------- 右下角快捷操作 ----------
      Column({ space: 8 }) {
        Column() {
          Text('回到')
            .fontSize(10)
            .fontColor('#8B949E')
          Text('当前')
            .fontSize(10)
            .fontColor('#8B949E')
        }
        .width(44)
        .height(44)
        .justifyContent(FlexAlign.Center)
        .backgroundColor('rgba(21,27,35,0.88)')
        .borderRadius(22)
        .onClick(() => {
          this.js('recenter()');
          this.followOn = true;
        })
      }
      .alignItems(HorizontalAlign.End)
      .position({ right: 12, bottom: 90 })

      if (this.loadErr.length > 0) {
        Column() {
          Text(this.loadErr)
            .fontSize(13)
            .fontColor('#F85149')
        }
        .padding(16)
        .backgroundColor('rgba(21,27,35,0.94)')
        .borderRadius(10)
        .position({ x: '50%', y: '50%' })
        .markAnchor({ x: '50%', y: '50%' })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0B0F14')
  }
}
