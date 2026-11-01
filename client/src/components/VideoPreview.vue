<script setup>
import { computed, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  emptyText: { type: String, default: '' },
  // 打开即播（预览弹窗场景）；被自动播放策略拦截时静默回退为手动播放
  autoplay: { type: Boolean, default: false },
});

const hasVideo = computed(() => !!props.src);
const displayEmptyText = computed(() => props.emptyText || t('video.empty'));
const playerRef = ref(null);
onMounted(() => {
  if (props.autoplay && playerRef.value) playerRef.value.play()?.catch?.(() => {});
});
</script>

<template>
  <div class="vp">
    <video v-if="hasVideo" ref="playerRef" :src="src" :poster="poster" controls playsinline class="player" />
    <div v-else class="vp-empty">
      <el-icon :size="40"><VideoPlay /></el-icon>
      <p>{{ displayEmptyText }}</p>
    </div>
  </div>
</template>

<style scoped>
.vp { width: 100%; aspect-ratio: 9/16; max-height: 100%; background: #000; border-radius: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.player { width: 100%; height: 100%; object-fit: contain; background: #000; }
.vp-empty { color: rgba(255,255,255,0.6); text-align: center; }
.vp-empty p { margin: 10px 0 0; font-size: 13px; }
</style>
