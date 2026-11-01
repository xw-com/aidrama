<script setup>
/**
 * 全局 Tips 提示：从中上部（36vh）出现，匀速上移到顶部渐隐消失。
 * stores/dialog 的 toast 状态渲染端，随 <AdDialog /> 宿主自动携带；
 * 页面没挂宿主时须单独挂一次 <AdToast />（utils/ui.js 的 toast 才走主题化渲染）。
 */
import { useDialogStore } from '../../stores/dialog';

const dlg = useDialogStore();
</script>

<template>
  <view v-if="dlg.toastShow" :key="dlg.toastKey" class="adt-wrap">
    <view class="adt-bubble" :style="{ animationDuration: dlg.toastDuration + 'ms' }">
      <text class="adt-text">{{ dlg.toastText }}</text>
    </view>
  </view>
</template>

<style scoped>
.adt-wrap {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none; /* 提示不拦截点击 */
  z-index: 900;         /* 高于叠层弹层 .top 档 780/790 */
}
.adt-bubble {
  max-width: 76%;
  padding: 9px 18px;
  border-radius: 999px;
  background: var(--ad-elev);
  border: 1px solid var(--ad-line);
  box-shadow: var(--ad-sh-pop);
  animation-name: adtoast-fly;
  animation-timing-function: linear; /* 全程匀速上移 */
  animation-fill-mode: both;
}
.adt-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ad-text);
  text-align: center;
  word-break: break-all;
}
/* 位移整体线性（匀速）：中上部 36vh → 顶部 48px，尾段渐隐 */
@keyframes adtoast-fly {
  0%   { transform: translateY(36vh); opacity: 0; }
  7%   { opacity: 1; }
  80%  { opacity: 1; }
  100% { transform: translateY(48px); opacity: 0; }
}
</style>
