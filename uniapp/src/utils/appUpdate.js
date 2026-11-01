/**
 * App 版本与更新检查（仅 APP-PLUS 生效；H5/小程序/鸿蒙各函数为 no-op）。
 * 服务端契约：GET /app/check-update?platform=android|ios&current=<versionName>
 *   → data: { hasUpdate, latest, notes, url, force }（并行任务实现，此处按契约消费）。
 * - Android：hasUpdate 时弹更新对话框（notes 展示），确认后 plus.runtime.openURL(url) 跳下载页；
 *   force=true 时对话框不可取消。
 * - iOS：不弹窗（走 App Store 更新），设置页手动检查时仅提示去商店。
 * 调用时机：App.vue startApp()（隐私同意后）静默检查 + 设置页「检查更新」入口。
 */
import i18n from '../i18n';
import { appApi } from '../api';
import { isIosApp } from './system';
import { toast } from './ui';

const t = (k, p) => i18n.global.t(k, p);

/** 当前安装包版本名（versionName，取 manifest versionName 云打包注入），取不到返回空串 */
export function getAppVersion() {
  /* #ifdef APP-PLUS */
  return new Promise((resolve) => {
    try {
      plus.runtime.getProperty(plus.runtime.appid, (info) => resolve((info && info.version) || ''));
    } catch (e) {
      resolve('');
    }
  });
  /* #endif */
  /* #ifndef APP-PLUS */
  return Promise.resolve('');
  /* #endif */
}

/** 拉取更新信息：{ hasUpdate, latest, notes, url, force, platform } | null（失败/非 App 端）。
 *  silent=true（启动期静默检查）失败不打扰；silent=false（设置页手动检查）失败提示。 */
export async function checkAppUpdate({ silent = true } = {}) {
  /* #ifndef APP-PLUS */
  return null;
  /* #endif */
  /* #ifdef APP-PLUS */
  const platform = isIosApp() ? 'ios' : 'android';
  const current = await getAppVersion();
  try {
    const data = await appApi.checkUpdate(platform, current);
    if (!data || typeof data !== 'object') {
      if (!silent) toast(t('app.update.latest'));
      return null;
    }
    return { ...data, platform };
  } catch (e) {
    if (!silent) toast(t('app.update.checkFail'));
    return null;
  }
  /* #endif */
}

/** 弹更新对话框（仅 Android 调用；force 时不可取消），确认后跳 url 下载页 */
export function promptAppUpdate(data) {
  /* #ifdef APP-PLUS */
  let content = t('app.update.found', { version: data.latest || '' });
  if (data.notes) content += `\n\n${data.notes}`;
  uni.showModal({
    title: t('app.update.title'),
    content,
    confirmText: t('app.update.update'),
    cancelText: t('app.update.later'),
    showCancel: !data.force,
    confirmColor: '#e0b64e',
    success: (r) => {
      if (r.confirm && data.url) {
        try {
          plus.runtime.openURL(data.url);
        } catch (e) {
          /* openURL 异常静默（无效链接场景） */
        }
      }
    },
  });
  /* #endif */
}
