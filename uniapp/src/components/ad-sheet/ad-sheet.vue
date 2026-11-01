<script setup>
/**
 * 通用底部抽屉（ad.scss 的 .ad-mask/.ad-sheet 令牌），v-model:show 控制显隐。
 * 始终挂载、靠 .on 切换动画（与 proposal 一致）；重内容请配合外层 v-if 使用。
 */
import { computed } from 'vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '' },
  closable: { type: Boolean, default: true },
  // 叠层档（.ad-mask.top/.ad-sheet.top 780/790）：在另一只抽屉之上打开时显式压过基础档
  // 750/760，不依赖 DOM 挂载顺序；传 'max' 走顶档（.max 980/990），压过全屏播放器
  // VideoPlayerPopup 900 等最高层宿主（见 ad.scss 层级注释）
  top: { type: [Boolean, String], default: false },
});
const emit = defineEmits(['update:show', 'close', 'opened']);
// 层级类名：true→top 叠层档；'max'→max 顶档（互斥，单类挂载）
const layerCls = computed(() => (props.top === 'max' ? 'max' : props.top ? 'top' : ''));
function close() {
  if (!props.closable) return;
  emit('update:show', false);
  emit('close');
}
</script>

<template>
  <view class="ad-sheet-wrap">
    <view class="ad-mask" :class="[{ on: show }, layerCls]" @tap="close" @touchmove.stop.prevent="() => {}" />
    <view class="ad-sheet" :class="[{ on: show }, layerCls]" @touchmove.stop="() => {}">
      <view class="grab" @tap="close" />
      <view v-if="title" class="ash-title">{{ title }}</view>
      <!-- 内容区独立滚动：见 ad.scss .ash-body 注释（超高内容内滚，不穿透背后的页面） -->
      <view class="ash-body">
        <slot />
      </view>
    </view>
  </view>
</template>

<style scoped>
.ash-title {
  font-family: var(--ad-font-serif);
  font-weight: 900;
  font-size: 18px;
  color: var(--ad-text);
  padding: 2px 0 10px;
}
</style>
