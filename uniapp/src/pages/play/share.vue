<script setup>
/**
 * 免登录剧集分享播放页（client SharePlayView 移植，/pages/play/share?token=）：
 * 竖屏整剧连播 —— 纵向 swiper 分集（snap 滑动）+ 活跃集单 video 换源续播；
 * 记忆每集播放位置（切回恢复）；末集播完可重播；底色/错误态随主题，画面覆盖层固定影院白。
 */
import { ref, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad, onUnload, onHide } from '@dcloudio/uni-app';
import { shareApi } from '../../api';
import { useThemeStore } from '../../stores/theme';
import { toAbsolute } from '../../utils/media';
import { useBackGuard } from '../../composables/useBackGuard';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：深链直达无上级，返回键回首页而非退出应用（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();

// ---- 数据 ----
const loading = ref(true);
const errorState = ref(''); // '' | 'notfound' | 'empty' | 'expired'
const info = ref(null); // { name, cover, aspect_ratio, episodes }
const eps = computed(() => info.value?.episodes || []);

// ---- 播放状态 ----
const started = ref(false);
const activeIndex = ref(0);
const muted = ref(false);
const buffering = ref(false);
const endedAll = ref(false);
const curTime = ref(0);
const dur = ref(0);
const tapIcon = ref(''); // '' | 'play' | 'pause'
let tapTimer = null;

const vid = 'share-play-video';
const videoEpoch = ref(0); // 重播/重载时强制重挂 video
let pendingRestore = 0;
const progressMap = new Map(); // epId -> 记忆播放位置

const coverStyle = computed(() => (info.value?.cover
  ? { backgroundImage: `url(${toAbsolute(info.value.cover)})` }
  : { background: 'linear-gradient(160deg, #1b2436, #0a0e18)' }));
const activeEp = computed(() => eps.value[activeIndex.value] || null);
const curSrc = computed(() => toAbsolute(activeEp.value?.video_url || ''));
const progressPct = computed(() => (dur.value ? Math.min(100, (curTime.value / dur.value) * 100) : 0));

function fmtSec(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
const timeLabel = computed(() => `${fmtSec(curTime.value)} / ${fmtSec(dur.value || activeEp.value?.duration || 0)}`);

function ctx() {
  return uni.createVideoContext(vid);
}

// ---- 初始化 ----
onLoad(async (q) => {
  try {
    const data = await shareApi.get(String(q?.token || ''));
    info.value = data;
    if (!data.episodes || !data.episodes.length) errorState.value = 'empty';
  } catch (err) {
    // 410 = 链接已过 24 小时有效期（后端 share.expired），区别于失效/不存在令牌
    errorState.value = err?.status === 410 ? 'expired' : 'notfound';
  } finally {
    loading.value = false;
  }
});

// iOS 手势解锁：必须在大按钮 tap 的同步调用栈内起播
function startPlayback() {
  started.value = true;
  playCurrent();
}

function playCurrent() {
  const p = ctx();
  if (!p) return;
  p.play();
}

function togglePlay() {
  if (!started.value) return;
  if (paused) {
    playCurrent();
    flashTap('play');
  } else {
    ctx().pause();
    flashTap('pause');
  }
}
// 播放态镜像：video 事件驱动（跨端无 paused 同步 API，用事件维护）
let paused = true;

function flashTap(kind) {
  tapIcon.value = kind;
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapIcon.value = ''; }, 600);
}

function toggleMute() {
  muted.value = !muted.value;
}

// ---- swiper / video 事件 ----
function onSwiperChange(e) {
  if (e.detail.source === 'touch' || e.detail.source === '') {
    setActive(e.detail.current);
  }
}
function setActive(i) {
  if (!(i >= 0 && i < eps.value.length) || i === activeIndex.value) return;
  // 记忆旧集进度（>3s 才记，避免刚起播就记 1~2 秒）
  const old = eps.value[activeIndex.value];
  if (started.value && old && curTime.value > 3) progressMap.set(old.id, curTime.value);
  activeIndex.value = i;
  endedAll.value = false;
  buffering.value = false;
  videoEpoch.value += 1; // 强制重挂 video 换源
  if (started.value) {
    const ep = eps.value[i];
    pendingRestore = progressMap.get(ep.id) || 0;
    curTime.value = 0;
    dur.value = 0;
    paused = true;
  }
}
function onLoadedMetadata(e) {
  dur.value = e.detail.duration || 0;
  buffering.value = false;
  if (pendingRestore > 0 && pendingRestore < dur.value - 1) {
    ctx().seek(pendingRestore);
    curTime.value = pendingRestore;
  }
  pendingRestore = 0;
}
function onTimeUpdate(e) {
  curTime.value = e.detail.currentTime || 0;
  if (dur.value && e.detail.duration) dur.value = e.detail.duration;
  paused = false;
}
function onEnded() {
  paused = true;
  if (activeIndex.value < eps.value.length - 1) {
    setActive(activeIndex.value + 1);
  } else {
    endedAll.value = true;
  }
}
function onPlaying() { paused = false; buffering.value = false; }
function onWaiting() { buffering.value = true; }
function onError() { buffering.value = false; paused = true; }

// slider 拖拽进度
function onSliderChanging(e) { curTime.value = (e.detail.value / 100) * (dur.value || 0); }
function onSliderChange(e) {
  const t2 = (e.detail.value / 100) * (dur.value || 0);
  ctx().seek(t2);
  curTime.value = t2;
}

function replayAll() {
  progressMap.clear();
  endedAll.value = false;
  activeIndex.value = 0;
  pendingRestore = 0;
  curTime.value = 0;
  dur.value = 0;
  videoEpoch.value += 1;
  paused = true;
  nextTick(() => playCurrent()); // :key 重挂后 video 下一帧才存在，同步 play 会落空
}

function goHome() {
  uni.reLaunch({ url: '/pages/showcase/index' }); // 游客可看的兜底首页
}

onHide(() => { ctx()?.pause(); paused = true; });
onUnload(() => { if (tapTimer) clearTimeout(tapTimer); });
</script>

<template>
  <view class="share-play" :class="theme.rootCls">
    <!-- 加载中 -->
    <view v-if="loading" class="sp-center-state">
      <view class="sp-spinner" />
    </view>

    <!-- 错误态 -->
    <view v-else-if="errorState" class="sp-center-state sp-error">
      <view class="sp-brand-line">XW.COM · AI DRAMA</view>
      <view class="sp-error-text">{{
        t(errorState === 'empty' ? 'share.play.errorEmpty' : errorState === 'expired' ? 'share.play.errorExpired' : 'share.play.errorNotFound')
      }}</view>
      <view class="sp-ghost-btn" @tap="goHome">{{ t('share.play.errorAction') }}</view>
    </view>

    <!-- 播放舞台 -->
    <view v-else class="sp-stage">
      <!-- 纵向分集滑动（封面背景层，兼作滑动手势接收面） -->
      <swiper
        class="sp-swiper"
        vertical
        :current="activeIndex"
        duration="240"
        @change="onSwiperChange"
      >
        <swiper-item v-for="(ep, i) in eps" :key="ep.id" class="sp-section" @tap="togglePlay">
          <view class="sp-cover" :style="coverStyle" />
          <view class="sp-cover-dim" />
          <text v-if="!(i === activeIndex && started)" class="sp-sec-no">{{ ep.idx }}</text>
          <!-- 活跃集唯一 video：换集重挂换源 -->
          <video
            v-if="started && i === activeIndex"
            :id="vid"
            :key="activeIndex + '-' + videoEpoch"
            class="sp-video"
            :src="curSrc"
            :muted="muted"
            :show-center-play-btn="false"
            :show-play-btn="false"
            :controls="false"
            :enable-progress-gesture="false"
            object-fit="contain"
            @loadedmetadata="onLoadedMetadata"
            @timeupdate="onTimeUpdate"
            @ended="onEnded"
            @waiting="onWaiting"
            @playing="onPlaying"
            @error="onError"
          />
        </swiper-item>
      </swiper>

      <!-- 缓冲 spinner -->
      <view v-if="started && buffering && !endedAll" class="sp-center-state sp-buffering">
        <view class="sp-spinner" />
      </view>

      <!-- 点按播放/暂停的瞬时反馈 -->
      <view v-if="tapIcon" class="sp-tap">
        <view class="sp-tap-ring">
          <m-icon v-if="tapIcon === 'play'" name="play" :size="30" color="#fff" />
          <text v-else class="sp-tap-pause">❚❚</text>
        </view>
      </view>

      <!-- 首屏起播层 -->
      <view v-if="!started" class="sp-hero">
        <view class="sp-cover" :style="coverStyle" />
        <view class="sp-cover-dim" />
        <view class="sp-hero-body">
          <view class="sp-brand-chip">XW.COM · AI DRAMA</view>
          <view class="sp-hero-name">《{{ info?.name }}》</view>
          <view class="sp-hero-sub">{{ t('share.play.episodeOf', { idx: eps[0]?.idx ?? 1, n: eps.length }) }}</view>
          <view class="sp-play-btn" @tap="startPlayback">
            <m-icon name="play" :size="32" color="#0a0a0f" />
          </view>
          <view class="sp-hero-tip">{{ t('share.play.playAll') }}</view>
        </view>
      </view>

      <!-- 底部信息/控件（仅起播后显示） -->
      <view v-if="started" class="sp-overlay">
        <view class="sp-top">
          <view class="sp-brand-chip">XW.COM · AI DRAMA</view>
        </view>
        <view class="sp-bottom">
          <view class="sp-meta">
            <view class="sp-ep-title">{{ activeEp?.title || info?.name }}</view>
            <view class="sp-ep-sub">{{ t('share.play.episodeOf', { idx: activeEp?.idx ?? '-', n: eps.length }) }}</view>
          </view>
          <view class="sp-ctrl">
            <text class="sp-time">{{ timeLabel }}</text>
            <slider
              class="sp-progress"
              :value="progressPct"
              :min="0"
              :max="100"
              :block-size="18"
              block-color="#ffffff"
              activeColor="#e0b64e"
              backgroundColor="rgba(255,255,255,0.25)"
              @changing="onSliderChanging"
              @change="onSliderChange"
            />
            <view class="sp-icon-btn" @tap="toggleMute">
              <text class="sp-mute-t">{{ muted ? '🔇' : '🔊' }}</text>
            </view>
          </view>
        </view>
      </view>

      <!-- 末集播完：重播 -->
      <view v-if="endedAll" class="sp-center-state sp-replay-layer">
        <view class="sp-ghost-btn sp-replay-btn" @tap="replayAll">↻ {{ t('share.play.replay') }}</view>
      </view>
    </view>
    <AdToast />
    <AdDialog />
  </view>
</template>

<style scoped>
/* 独立全屏播放页：底色与加载/错误态跟随主题（--ad-* 令牌）；
   播放舞台上的覆盖文字/控件全部压在画面上，固定影院白不随主题。 */
.share-play {
  position: relative;
  height: 100vh;
  width: 100%;
  overflow: hidden;
  background: var(--ad-ink);
  color: #fff;
}
.sp-center-state {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}
.sp-spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid var(--ad-line-strong);
  border-top-color: var(--ad-text);
  animation: sp-spin 0.9s linear infinite;
}
/* 缓冲 spinner 压在画面上，固定白 */
.sp-buffering .sp-spinner { border-color: rgba(255, 255, 255, 0.18); border-top-color: #fff; }
@keyframes sp-spin { to { transform: rotate(360deg); } }

/* 错误态（落在主题底色上，随主题换色） */
.sp-brand-line { font-size: 12px; letter-spacing: 2px; color: var(--ad-text-mut); }
.sp-error-text { font-size: 16px; color: var(--ad-text); text-align: center; padding: 0 24px; line-height: 1.7; }
.sp-ghost-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 22px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
.sp-error .sp-ghost-btn {
  border-color: var(--ad-line-strong);
  background: var(--ad-elev);
  color: var(--ad-text);
}

.sp-stage { position: relative; height: 100%; width: 100%; overflow: hidden; }
.sp-swiper { height: 100%; width: 100%; }
.sp-section { position: relative; height: 100%; overflow: hidden; }
.sp-cover {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(160deg, #1b2436, #0a0e18) center / cover no-repeat;
}
.sp-cover-dim {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0) 40%, rgba(0, 0, 0, 0.55));
}
.sp-sec-no {
  position: absolute;
  top: 40px;
  right: 14px;
  z-index: 1;
  min-width: 26px;
  padding: 3px 8px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  text-align: center;
  color: rgba(255, 255, 255, 0.75);
}

/* 单一 video：铺满活跃集 */
.sp-video {
  position: absolute;
  top: 0; left: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  background: #000;
}

/* 缓冲层 */
.sp-buffering { z-index: 6; }

/* 点按反馈 */
.sp-tap { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 7; display: flex; align-items: center; justify-content: center; }
.sp-tap-ring {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  animation: sp-fade 0.6s ease forwards;
}
.sp-tap-pause { font-size: 22px; color: #fff; letter-spacing: 2px; }
@keyframes sp-fade {
  0% { opacity: 0; transform: scale(0.8); }
  25% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.15); }
}

/* 首屏起播层 */
.sp-hero { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 10; display: flex; align-items: center; justify-content: center; }
.sp-hero-body { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 0 28px; text-align: center; }
.sp-brand-chip {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.4);
  font-size: 11px;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.8);
}
.sp-hero-name { font-size: 24px; font-weight: 700; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6); }
.sp-hero-sub { font-size: 13px; color: rgba(255, 255, 255, 0.75); }
.sp-play-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 76px;
  height: 76px;
  margin-top: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, #f2d489, #e0b64e 45%, #b3871f);
  box-shadow: 0 10px 30px rgba(224, 182, 78, 0.35);
}
.sp-play-btn:active { transform: scale(0.92); }
.sp-hero-tip { font-size: 12px; color: rgba(255, 255, 255, 0.65); }

/* 信息与控件 overlay */
.sp-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 8; display: flex; flex-direction: column; justify-content: space-between; }
.sp-top { padding: 40px 14px 0; }
.sp-bottom {
  padding: 26px 16px calc(16px + env(safe-area-inset-bottom));
  background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.7));
}
.sp-meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.sp-ep-title { font-size: 16px; font-weight: 600; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7); }
.sp-ep-sub { font-size: 12px; color: rgba(255, 255, 255, 0.7); }
.sp-ctrl { display: flex; align-items: center; gap: 10px; }
.sp-time { font-size: 11px; color: rgba(255, 255, 255, 0.75); font-family: monospace; white-space: nowrap; }
.sp-progress { flex: 1; margin: 0; }
.sp-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  flex: none;
}
.sp-mute-t { font-size: 15px; line-height: 1; }

/* 重播层 */
.sp-replay-layer { z-index: 12; background: rgba(0, 0, 0, 0.45); }
.sp-replay-btn { font-size: 15px; padding: 12px 28px; }
</style>
