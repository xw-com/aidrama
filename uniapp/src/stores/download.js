import { defineStore } from 'pinia';

/**
 * 「视频下载进度」弹层的全局状态：utils/download.saveVideo 触发，
 * 页面挂 <AdDownloadDialog /> 渲染。同一时刻只允许一个下载任务。
 * _cancelFn 放在模块级（非 reactive），避免 abort 句柄被 Pinia 序列化。
 */
let _cancelFn = null; // () => void 当前任务的 abort 句柄

export const useDownloadStore = defineStore('download', {
  state: () => ({
    visible: false,
    name: '', // 文件名（弹层展示用）
    progress: 0, // 0-99，完成时由 finish() 置 100 后关层
  }),
  actions: {
    start(name) {
      _cancelFn = null;
      this.visible = true;
      this.name = name;
      this.progress = 0;
    },
    setProgress(p) {
      this.progress = Math.max(this.progress, Math.min(99, Math.round(Number(p) || 0))); // 单调不减，防回跳
    },
    setCancelFn(fn) { _cancelFn = typeof fn === 'function' ? fn : null; },
    cancel() {
      const fn = _cancelFn;
      _cancelFn = null;
      if (fn) fn();
    },
    finish() {
      this.visible = false;
      _cancelFn = null;
    },
  },
});
