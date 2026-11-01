<script setup>
/**
 * 图标组件（docs/mobile-ui-proposal.html 的描边图标，easycom 自动注册）。
 * - H5 / App：内联 svg（currentColor 继承文字色）
 * - 小程序：view + CSS mask-image（base64 svg 作蒙版 + background-color 上色）。
 *   不用 image 组件：其对 svg/base64 的支持随基础库和平台波动，真机常不渲染。
 *   mask 方案下颜色来自 background-color，默认 currentColor，与 H5 行为一致。
 */
import { computed } from 'vue';
import { ICONS, svgMarkup, b64 } from '../../utils/icons';

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 20 },
  color: { type: String, default: '' }, // 不传则两端都继承文字色（currentColor）
  sw: { type: [Number, String], default: 1.7 }, // 描边宽度
});

const known = computed(() => !!ICONS[props.name]);
const dim = computed(() => `${props.size}px`);

/* #ifndef MP */
const inner = computed(() => svgMarkup(props.name, { size: props.size, sw: props.sw, color: props.color || 'currentColor' }));
/* #endif */

/* #ifdef MP */
const maskStyle = computed(() => {
  if (!known.value) return '';
  const svg = svgMarkup(props.name, { size: 24, color: '#000', sw: props.sw });
  const url = `url("data:image/svg+xml;base64,${b64(svg)}")`;
  // 键名直接用 kebab-case：uni-mp-vue 的 hyphenate(/\B([A-Z])/g) 会把
  // WebkitMaskImage 错转成 "webkit-mask-image"（缺前导短横线），导致蒙版失效。
  return {
    width: dim.value,
    height: dim.value,
    'background-color': props.color || 'currentColor',
    '-webkit-mask-image': url,
    'mask-image': url,
    '-webkit-mask-size': '100% 100%',
    'mask-size': '100% 100%',
    '-webkit-mask-repeat': 'no-repeat',
    'mask-repeat': 'no-repeat',
  };
});
/* #endif */
</script>

<template>
  <view v-if="known" class="mi">
    <!-- #ifndef MP -->
    <view class="mi-raw" v-html="inner" />
    <!-- #endif -->
    <!-- #ifdef MP -->
    <view class="mi-mask" :style="maskStyle" />
    <!-- #endif -->
  </view>
</template>

<style scoped>
.mi { display: inline-flex; flex: none; align-items: center; justify-content: center; overflow: hidden; }
.mi-raw { display: flex; line-height: 0; }
.mi-raw :deep(svg), .mi-raw svg { display: block; }
.mi-mask { display: block; }
</style>
