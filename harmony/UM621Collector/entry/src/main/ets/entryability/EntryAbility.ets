/*
 * UM621A 手机采集器 —— 应用入口
 *
 * 这里做两件事：
 *   1) 加载主页面
 *   2) 申请长时任务，保证锁屏后还能继续读串口
 *
 * 长时任务为什么要：户外测试不可能一直亮屏，手机一锁屏，
 * 普通应用会被挂起，串口读取就断了。DATA_TRANSFER 模式允许后台持续传输。
 */

import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'UM621';
const DOMAIN = 0x0001;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '采集器启动');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '采集器退出');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, '页面加载失败：%{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '页面加载完成');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, '窗口销毁');
  }

  onForeground(): void {
  }

  onBackground(): void {
  }
}
