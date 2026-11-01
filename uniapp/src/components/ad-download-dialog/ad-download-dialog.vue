<script setup>
/**
 * 视频下载进度弹层（全局共用，所有视频下载走 utils/download.saveVideo 共用本弹层）：
 * 下载中展示文件名 + 进度条 + 百分比，点「取消」中断下载（任务 abort）。
 * 需在页面根 view（theme.rootCls 所在）内挂一次 <AdDownloadDialog />；
 * 挂 .top 档（780/790）盖过普通抽屉，遮罩不可点关（防误触中断），只能显式取消。
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDownloadStore } from '../../stores/download';

const { t } = useI18n();
const dl = useDownloadStore();
const pct = computed(() => Math.round(dl.progress));
</script>

<template>
  <view class="addl-wrap">
    <view class="ad-mask top" :class="{ on: dl.visible }" @touchmove.stop.prevent="() => {}" />
    <view class="addl-card" :class="{ on: dl.visible }" @touchmove.stop="() => {}">
      <text class="addl-title">{{ t('common.downloading') }}</text>
      <text class="addl-name mono">{{ dl.name }}</text>
      <view class="addl-bar">
        <view class="addl-bar-in" :style="{ width: pct + '%' }" />
      </view>
      <view class="addl-row">
        <text class="addl-pct mono">{{ pct }}%</text>
        <view class="chip glass sm" @tap="dl.cancel()">{{ t('common.cancel') }}</view>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* 居中卡片：底色/圆角/描边对齐 .ad-sheet，居中弹出而非底部抽屉 */
.addl-card {
  position: fixed;
  left: 50%;
  top: 50%;
  width: 300px;
  z-index: 790;
  background: var(--ad-panel);
  border-radius: 22px;
  border: 1px solid var(--ad-line-strong);
  padding: 20px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
  transform: translate(-50%, -50%) scale(0.92);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.addl-card.on {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, -50%) scale(1);
}
.addl-title {
  font-family: var(--ad-serif);
  font-weight: 900;
  font-size: 16px;
  color: var(--ad-text);
}
.addl-name {
  font-size: 11px;
  color: var(--ad-text-mut);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.addl-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--ad-inset);
  overflow: hidden;
}
.addl-bar-in {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #f2d489, #e0b64e);
  transition: width 0.25s ease;
}
.addl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.addl-pct {
  font-size: 13px;
  font-weight: 700;
  color: var(--ad-brand);
}
</style>
