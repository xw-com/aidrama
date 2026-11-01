<script setup>
// 进入视口（提前 300px）才挂 <video>：成片/素材卡片区避免首屏几十个 video 元素
// 同时对 ~100MB mp4 发 range 请求拖垮首屏。一旦挂载不再卸载（保持播放态与缓冲）。
// 视口外仅渲染占位块，样式由使用方通过 class 控制。
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  src: { type: String, default: '' },
});

const root = ref(null);
const visible = ref(false);
let io = null;

onMounted(() => {
  if (!props.src) return;
  if (typeof IntersectionObserver === 'undefined') { visible.value = true; return; }
  io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      visible.value = true;
      io.disconnect();
    }
  }, { rootMargin: '300px' });
  io.observe(root.value);
});
onUnmounted(() => { if (io) io.disconnect(); });
</script>

<template>
  <div ref="root" class="lazy-video">
    <video v-if="visible && src" :src="src" preload="metadata" muted playsinline />
    <div v-else class="lazy-video-ph" />
  </div>
</template>

<style scoped>
.lazy-video, .lazy-video-ph { width: 100%; height: 100%; }
.lazy-video-ph { background: var(--ad-bg-soft, #f2f3f7); }
</style>
