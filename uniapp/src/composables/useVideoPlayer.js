import { ref } from 'vue';

/**
 * 全屏播放弹层状态（配合 video-player-popup 组件）：
 * const { play, playerShow, playerUrl, playerTitle, playerAspect } = useVideoPlayer();
 * 模板：<VideoPlayerPopup v-model:show="playerShow" :url="playerUrl" :title="playerTitle" :aspect="playerAspect" />
 */
export function useVideoPlayer() {
  const playerShow = ref(false);
  const playerUrl = ref('');
  const playerTitle = ref('');
  const playerAspect = ref('');

  function play({ url, title = '', aspect = '' }) {
    if (!url) return;
    playerUrl.value = url;
    playerTitle.value = title;
    if (aspect) playerAspect.value = aspect;
    playerShow.value = true;
  }

  return { play, playerShow, playerUrl, playerTitle, playerAspect };
}
