<script setup>
/** 自定义导航栏（navigationStyle: custom 全局生效）：状态栏占位 + 返回 + 衬线标题 + 右侧插槽 */
import { ref, onMounted } from 'vue';
import { backToParent } from '../../utils/back';
import { statusBarHeight, navBarContentHeight, navBarRightPad } from '../../utils/system';

const props = defineProps({
  title: { type: String, default: '' },
  back: { type: Boolean, default: true },
  // false：只抛 @back 不导航（全屏弹层内复用导航栏时用，如 video-player-popup——back 语义是关层而非退页）
  autoBack: { type: Boolean, default: true },
});
const emit = defineEmits(['back']);
// 首帧就取真实状态栏高（statusBarHeight 为同步读取）：初始 0 再 onMounted 撑高会造成
// 布局两帧跳变——App 端原生 video/地图层按首帧 rect 定位，二次撑高不重同步就错位留缝
const sbH = ref(0);
try { sbH.value = statusBarHeight(); } catch (e) { /* 启动极早期 API 未就绪，onMounted 再取 */ }
// 微信小程序端：内容行与胶囊垂直居中、右侧插槽让位（见 utils/system.capsuleFit）
const barH = ref(navBarContentHeight());
const rightPad = ref(navBarRightPad());
onMounted(() => {
  try {
    sbH.value = statusBarHeight();
    barH.value = navBarContentHeight();
    rightPad.value = navBarRightPad();
  } catch (e) { /* H5 无状态栏 */ }
});
function goBack() {
  emit('back');
  if (props.autoBack) backToParent(); // 与系统返回键同规则：只回父级一层，不越级回祖父
}
</script>

<template>
  <view class="anb" :style="{ paddingTop: sbH + 'px' }">
    <view class="anb-bar" :style="{ height: barH + 'px', paddingRight: rightPad + 'px' }">
      <view class="anb-side">
        <view v-if="back" class="iconbtn" @tap="goBack"><m-icon name="left" :size="19" /></view>
        <slot name="left" />
      </view>
      <view class="anb-title">{{ title }}</view>
      <view class="anb-side anb-right"><slot name="right" /></view>
    </view>
  </view>
</template>

<style scoped>
.anb {
  position: sticky;
  top: 0;
  z-index: 90;
  background: var(--ad-nav-bg);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
}
.anb-bar {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 8px;
}
/* 左槽 min-width 自适应：只放返回键时仍占 84px 与右槽对称；左插槽有内容（如弹层删除钮）时随内容加宽，标题 flex:1 让位 */
.anb-side { min-width: 84px; display: flex; align-items: center; }
/* 右槽自适应：内容（如弹层里审阅钮+iOS 全屏钮并排）可超 84px 定宽——加宽而不压缩，
   标题 flex:1 自动让位；min-width 保空槽/小内容时仍与左槽对称、标题居中 */
.anb-right { justify-content: flex-end; width: auto; min-width: 84px; flex: none; }
.anb-title {
  flex: 1;
  text-align: center;
  font-family: var(--ad-font-serif);
  font-weight: 700;
  font-size: 16px;
  color: var(--ad-text);
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
