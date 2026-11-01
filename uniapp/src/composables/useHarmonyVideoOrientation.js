/**
 * 鸿蒙端视频全屏方向纠正。
 *
 * 背景：DCloud 鸿蒙运行时的视频全屏链路会无条件把窗口转成横屏（video 的 direction
 * 属性与 requestFullScreen({direction}) 在鸿蒙端均无效；JS 层也没有任何方向 API），
 * 9:16 等竖幅视频点全屏会被横放。
 *
 * 对策：监听 video 的 fullscreenchange，在其后补发原生方向申请
 * （UTS 插件 aidrama-screen-orientation → window.setPreferredOrientation）：
 * - 16:9 画幅：跟随横屏（与原生一致）
 * - 其余画幅：立即补竖屏 + 每 500ms 轮询补发 8 秒，压住可能延迟落地的原生横屏申请
 * - 退出全屏 / 弹层关闭 / 页面卸载：恢复竖屏并停止轮询
 *
 * 非鸿蒙平台为空实现，调用方无需条件编译。
 */
/* #ifdef APP-HARMONY */
import { setScreenOrientation } from '../uni_modules/aidrama-screen-orientation';
/* #endif */

export function useHarmonyVideoOrientation() {
  /* #ifdef APP-HARMONY */
  let pollTimer = null;
  function applyOrientation(o) {
    try {
      setScreenOrientation(o);
    } catch (e) {
      console.warn('[hvo] setOrientation failed', e);
    }
  }
  function startPoll(o) {
    stopPoll();
    let n = 0;
    pollTimer = setInterval(() => {
      n += 1;
      if (n > 16) { stopPoll(); return; }
      applyOrientation(o);
    }, 500);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function onFullscreenChange(e, aspect) {
    try { console.log('[hvo] fullscreenchange', JSON.stringify(e && e.detail)); } catch (err) { /* ignore */ }
    const d = (e && e.detail) || {};
    if (d.fullScreen === false) {
      stopPoll();
      applyOrientation('portrait');
      return;
    }
    if (aspect === '16:9') {
      applyOrientation('landscape');
      return;
    }
    // 9:16/1:1：立即纠正 + 轮询压住原生横屏申请
    applyOrientation('portrait');
    startPoll('portrait');
  }
  function restore() {
    stopPoll();
    applyOrientation('portrait');
  }
  return { onFullscreenChange, restore };
  /* #endif */

  /* #ifndef APP-HARMONY */
  return {
    onFullscreenChange() { /* 非鸿蒙：direction 属性由端上处理 */ },
    restore() {},
  };
  /* #endif */
}
