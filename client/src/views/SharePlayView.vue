<script setup>
/**
 * 免登录剧集分享播放页（/share/:token）
 * 移动端优先的竖屏整剧连播：scroll-snap 纵向分集 + 单一 <video> 覆盖活跃集（同一元素换 src，
 * 规避 iOS「每个 video 元素需单独手势解锁音频」；首播必须发生在大按钮 click 的同步调用栈内）。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { shareApi } from '../api';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

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

const stageRef = ref(null);
const scrollRef = ref(null);
const videoRef = ref(null);
const progressRef = ref(null);

const progressMap = new Map(); // epId -> 记忆播放位置（切回恢复）
let pendingRestore = 0;
let io = null;
let ioTimer = null;
let loadedIdx = -1;
let seeking = false;

const coverStyle = computed(() => (info.value?.cover ? { backgroundImage: `url(${info.value.cover})` } : {}));
const activeEp = computed(() => eps.value[activeIndex.value] || null);
const progressPct = computed(() => (dur.value ? `${(curTime.value / dur.value) * 100}%` : '0%'));

function fmtSec(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
const timeLabel = computed(() => `${fmtSec(curTime.value)} / ${fmtSec(dur.value || activeEp.value?.duration || 0)}`);

// ---- 初始化 ----
onMounted(async () => {
  document.addEventListener('visibilitychange', onVisChange);
  try {
    const data = await shareApi.get(String(route.params.token || ''));
    info.value = data;
    if (!data.episodes || !data.episodes.length) errorState.value = 'empty';
  } catch (err) {
    // 410 = 链接已过 24 小时有效期（后端 share.expired），区别于失效/不存在令牌
    errorState.value = err?.status === 410 ? 'expired' : 'notfound';
  } finally {
    loading.value = false;
  }
  if (!errorState.value) {
    await nextTick();
    setupObserver();
  }
});

// 活跃集判定：IntersectionObserver（threshold 0.6）+ 短 debounce，应对快速连滑
function setupObserver() {
  const root = scrollRef.value;
  if (!root || typeof IntersectionObserver === 'undefined') return;
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting && en.intersectionRatio >= 0.6) {
        const i = Number(en.target.dataset.idx);
        if (ioTimer) clearTimeout(ioTimer);
        ioTimer = setTimeout(() => setActive(i), 120);
      }
    }
  }, { root, threshold: 0.6 });
  root.querySelectorAll('.sp-section').forEach((el) => io.observe(el));
}

function setActive(i) {
  if (!(i >= 0 && i < eps.value.length) || i === activeIndex.value) return;
  // 记忆旧集进度（>3s 才记，避免刚起播就记 1~2 秒）
  const v = videoRef.value;
  const old = eps.value[activeIndex.value];
  if (v && started.value && old && v.currentTime > 3) progressMap.set(old.id, v.currentTime);
  activeIndex.value = i;
  endedAll.value = false;
  if (started.value) loadEpisode(i, true);
}

function loadEpisode(i, autoplay) {
  const v = videoRef.value;
  const ep = eps.value[i];
  if (!v || !ep) return;
  if (loadedIdx === i) {
    if (autoplay) playCurrent();
    return;
  }
  loadedIdx = i;
  pendingRestore = progressMap.get(ep.id) || 0;
  curTime.value = 0;
  dur.value = 0;
  v.src = ep.video_url; // 同源 /files/... 相对路径
  v.load();
  if (autoplay) playCurrent();
}

// iOS 手势解锁：必须在大按钮 click 的同步调用栈内执行，不得先 await/nextTick
function startPlayback() {
  started.value = true;
  loadEpisode(activeIndex.value || 0, true);
}

function playCurrent() {
  const v = videoRef.value;
  if (!v) return;
  const p = v.play();
  if (p && p.catch) {
    p.catch(() => {
      // iOS 低电量模式等拒绝有声自动播放 → 静音重试，并亮出「取消静音」按钮
      v.muted = true;
      muted.value = true;
      v.play().catch(() => {});
    });
  }
}

function togglePlay() {
  const v = videoRef.value;
  if (!v || !started.value) return;
  if (v.paused) {
    playCurrent();
    flashTap('play');
  } else {
    v.pause();
    flashTap('pause');
  }
}

function flashTap(kind) {
  tapIcon.value = kind;
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapIcon.value = ''; }, 600);
}

function toggleMute() {
  const v = videoRef.value;
  if (!v) return;
  v.muted = !v.muted;
  muted.value = v.muted;
}

// ---- video 事件 ----
function onLoadedMetadata() {
  const v = videoRef.value;
  if (!v) return;
  dur.value = v.duration || 0;
  if (pendingRestore > 0 && pendingRestore < dur.value - 1) v.currentTime = pendingRestore;
  pendingRestore = 0;
}
function onTimeUpdate() {
  const v = videoRef.value;
  if (!v || seeking) return;
  curTime.value = v.currentTime;
}
function onEnded() {
  if (activeIndex.value < eps.value.length - 1) {
    // 平滑滑到下一集，IO 接管换源续播
    const next = scrollRef.value?.querySelectorAll('.sp-section')[activeIndex.value + 1];
    next?.scrollIntoView({ behavior: 'smooth' });
  } else {
    endedAll.value = true;
  }
}
function replayAll() {
  progressMap.clear();
  endedAll.value = false;
  if (scrollRef.value) scrollRef.value.scrollTop = 0;
  activeIndex.value = 0;
  loadEpisode(0, true);
}

// ---- 进度条拖拽（pointer 事件，touch-action: none）----
function ratioFromEvent(e) {
  const el = progressRef.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
function onProgressDown(e) {
  const v = videoRef.value;
  if (!v || !v.duration) return;
  seeking = true;
  e.currentTarget.setPointerCapture?.(e.pointerId);
  curTime.value = ratioFromEvent(e) * v.duration;
}
function onProgressMove(e) {
  const v = videoRef.value;
  if (!seeking || !v?.duration) return;
  curTime.value = ratioFromEvent(e) * v.duration;
}
function onProgressUp(e) {
  const v = videoRef.value;
  if (!seeking || !v) {
    seeking = false;
    return;
  }
  seeking = false;
  v.currentTime = ratioFromEvent(e) * (v.duration || 0);
}

function onVisChange() {
  if (document.visibilityState === 'hidden') videoRef.value?.pause();
}

function goHome() {
  router.push({ path: '/' }); // 游客被守卫送去 /login，已登录进项目列表
}

onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
  if (ioTimer) clearTimeout(ioTimer);
  if (tapTimer) clearTimeout(tapTimer);
  document.removeEventListener('visibilitychange', onVisChange);
  const v = videoRef.value;
  if (v) {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
});
</script>

<template>
  <div class="share-play">
    <!-- 加载中 -->
    <div v-if="loading" class="sp-center-state">
      <span class="sp-spinner" />
    </div>

    <!-- 错误态 -->
    <div v-else-if="errorState" class="sp-center-state sp-error">
      <div class="sp-brand-line">XW.COM · AI DRAMA</div>
      <div class="sp-error-text">{{
        t(errorState === 'empty' ? 'share.play.errorEmpty' : errorState === 'expired' ? 'share.play.errorExpired' : 'share.play.errorNotFound')
      }}</div>
      <button class="sp-ghost-btn" @click="goHome">{{ t('share.play.errorAction') }}</button>
    </div>

    <!-- 播放舞台 -->
    <div v-else ref="stageRef" class="sp-stage">
      <!-- 纵向 snap 分集列表（封面背景层，兼作滑动手势接收面：video 本体 pointer-events:none） -->
      <div ref="scrollRef" class="sp-scroll">
        <section
          v-for="(ep, i) in eps"
          :key="ep.id"
          class="sp-section"
          :data-idx="i"
          :class="{ active: i === activeIndex && started }"
          @click="togglePlay"
        >
          <div class="sp-cover" :style="coverStyle" />
          <div class="sp-cover-dim" />
          <span class="sp-sec-no">{{ ep.idx }}</span>
        </section>
      </div>

      <!-- 单一 video：钉在舞台上随活跃集换源 -->
      <video
        ref="videoRef"
        class="sp-video"
        playsinline
        webkit-playsinline
        preload="auto"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @ended="onEnded"
        @waiting="buffering = true"
        @playing="buffering = false"
        @canplay="buffering = false"
      />

      <!-- 缓冲 spinner -->
      <div v-if="started && buffering && !endedAll" class="sp-center-state sp-buffering">
        <span class="sp-spinner" />
      </div>

      <!-- 点按播放/暂停的瞬时反馈 -->
      <div v-if="tapIcon" class="sp-tap" :class="tapIcon">
        <span class="sp-tap-ring">
          <el-icon v-if="tapIcon === 'play'"><VideoPlay /></el-icon>
          <el-icon v-else><VideoPause /></el-icon>
        </span>
      </div>

      <!-- 首屏起播层（兼挡住起播前的滚动） -->
      <div v-if="!started" class="sp-hero">
        <div class="sp-cover" :style="coverStyle" />
        <div class="sp-cover-dim" />
        <div class="sp-hero-body">
          <div class="sp-brand-chip">XW.COM · AI DRAMA</div>
          <!-- AIGC 标识（合规要求）：起播层与播放控件区常驻其一 -->
          <div class="sp-aigc-chip">{{ t('aigc.disclaimer') }}</div>
          <div class="sp-hero-name">《{{ info?.name }}》</div>
          <div class="sp-hero-sub">{{ t('share.play.episodeOf', { idx: eps[0]?.idx ?? 1, n: eps.length }) }}</div>
          <button class="sp-play-btn" :aria-label="t('share.play.playAll')" @click="startPlayback">
            <el-icon><VideoPlay /></el-icon>
          </button>
          <div class="sp-hero-tip">{{ t('share.play.playAll') }}</div>
        </div>
      </div>

      <!-- 顶部品牌 + 底部信息/控件（仅拦控件区点击，其余穿透给 section/video） -->
      <div v-if="started" class="sp-overlay">
        <div class="sp-top">
          <span class="sp-brand-chip">XW.COM · AI DRAMA</span>
        </div>
        <div class="sp-bottom">
          <div class="sp-meta">
            <div class="sp-ep-title">{{ activeEp?.title || info?.name }}</div>
            <div class="sp-ep-sub">{{ t('share.play.episodeOf', { idx: activeEp?.idx ?? '-', n: eps.length }) }}</div>
            <div class="sp-aigc-chip">{{ t('aigc.disclaimer') }}</div>
          </div>
          <div class="sp-ctrl">
            <span class="sp-time">{{ timeLabel }}</span>
            <div
              ref="progressRef"
              class="sp-progress"
              @pointerdown="onProgressDown"
              @pointermove="onProgressMove"
              @pointerup="onProgressUp"
              @pointercancel="onProgressUp"
            >
              <div class="sp-progress-fill" :style="{ width: progressPct }" />
            </div>
            <button
              class="sp-icon-btn"
              :aria-label="muted ? t('share.play.unmute') : t('share.play.mute')"
              :title="muted ? t('share.play.unmute') : t('share.play.mute')"
              @click="toggleMute"
            >
              <el-icon v-if="muted"><Mute /></el-icon>
              <el-icon v-else><Headset /></el-icon>
            </button>
          </div>
        </div>
      </div>

      <!-- 末集播完：重播 -->
      <div v-if="endedAll" class="sp-center-state sp-replay-layer">
        <button class="sp-ghost-btn sp-replay-btn" @click="replayAll">
          <el-icon><RefreshRight /></el-icon> {{ t('share.play.replay') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 独立全屏页：固定深色影棚配色（不依赖 --ad-* 令牌，浅色主题游客也可用） */
.share-play {
  position: relative;
  height: 100vh;
  width: 100%;
  overflow: hidden;
  background: #05070c;
  color: #fff;
}
@supports (height: 100dvh) {
  .share-play { height: 100dvh; }
}
.sp-center-state {
  position: absolute;
  inset: 0;
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
  border: 3px solid rgba(255, 255, 255, 0.18);
  border-top-color: #fff;
  animation: sp-spin 0.9s linear infinite;
}
@keyframes sp-spin { to { transform: rotate(360deg); } }

/* 错误态 */
.sp-brand-line { font-size: 12px; letter-spacing: 2px; color: rgba(255, 255, 255, 0.5); }
.sp-error-text { font-size: 16px; color: rgba(255, 255, 255, 0.9); text-align: center; padding: 0 24px; }
.sp-ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 22px;
  border-radius: var(--ad-radius-pill);
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}
.sp-ghost-btn:hover { background: rgba(255, 255, 255, 0.16); border-color: var(--ad-brand); color: var(--ad-brand); }

/* 舞台：移动端铺满，桌面端居中竖屏列 */
.sp-stage { position: relative; height: 100%; width: 100%; overflow: hidden; }

/* 纵向 snap 滚动 */
.sp-scroll {
  height: 100%;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.sp-scroll::-webkit-scrollbar { display: none; }
.sp-section {
  position: relative;
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  overflow: hidden;
}
.sp-cover {
  position: absolute;
  inset: 0;
  background: linear-gradient(160deg, #1b2436, #0a0e18) center / cover no-repeat;
}
.sp-cover-dim {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0) 40%, rgba(0, 0, 0, 0.55));
}
.sp-sec-no {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 1;
  min-width: 26px;
  padding: 3px 8px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  font-size: 12px;
  text-align: center;
  color: rgba(255, 255, 255, 0.75);
}
.sp-section.active .sp-sec-no { opacity: 0; }

/* 单一 video：钉在舞台，pointer-events 释放给下层 section（滚动/点按都走 section） */
.sp-video {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  pointer-events: none;
}

/* 缓冲层 */
.sp-buffering { z-index: 6; pointer-events: none; }

/* 点按反馈 */
.sp-tap { position: absolute; inset: 0; z-index: 7; display: flex; align-items: center; justify-content: center; pointer-events: none; }
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
.sp-tap-ring .el-icon { font-size: 34px; color: #fff; }
@keyframes sp-fade {
  0% { opacity: 0; transform: scale(0.8); }
  25% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.15); }
}

/* 首屏起播层 */
.sp-hero { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; }
.sp-hero-body { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 0 28px; text-align: center; }
.sp-brand-chip {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(6px);
  font-size: 11px;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.8);
}
.sp-hero-name { font-size: 24px; font-weight: 700; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6); }
.sp-hero-sub { font-size: 13px; color: rgba(255, 255, 255, 0.75); }

/* AIGC 标识：黑幕描金小 chip（舞台恒为深色影棚配色，取深色主题的品牌金） */
.sp-aigc-chip {
  align-self: flex-start;
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(224, 182, 78, 0.35);
  backdrop-filter: blur(6px);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: #e0b64e;
}
.sp-hero-body .sp-aigc-chip { align-self: center; }
.sp-meta .sp-aigc-chip { margin-top: 6px; align-self: flex-start; }
.sp-play-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 76px;
  height: 76px;
  margin-top: 10px;
  border: none;
  border-radius: 50%;
  background: var(--ad-brand-gradient);
  box-shadow: 0 10px 30px rgba(224, 182, 78, 0.35);
  color: var(--ad-brand-contrast);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.sp-play-btn .el-icon { font-size: 34px; }
.sp-play-btn:active { transform: scale(0.92); }
.sp-hero-tip { font-size: 12px; color: rgba(255, 255, 255, 0.65); }

/* 信息与控件 overlay：本身不拦事件，交互子元素单独开启 */
.sp-overlay { position: absolute; inset: 0; z-index: 8; pointer-events: none; display: flex; flex-direction: column; justify-content: space-between; }
.sp-top { padding: 14px; }
.sp-brand-chip { pointer-events: none; }
.sp-bottom {
  pointer-events: auto;
  padding: 26px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.7));
}
.sp-meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.sp-ep-title { font-size: 16px; font-weight: 600; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7); }
.sp-ep-sub { font-size: 12px; color: rgba(255, 255, 255, 0.7); }
.sp-ctrl { display: flex; align-items: center; gap: 10px; }
.sp-time { font-size: 11px; color: rgba(255, 255, 255, 0.75); font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.sp-progress {
  position: relative;
  flex: 1;
  height: 22px; /* 扩大热区 */
  cursor: pointer;
  touch-action: none;
}
.sp-progress::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.25);
}
.sp-progress-fill {
  position: absolute;
  left: 0;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: var(--ad-brand);
}
.sp-progress-fill::after {
  content: '';
  position: absolute;
  right: -5px;
  top: 50%;
  width: 11px;
  height: 11px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
.sp-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  cursor: pointer;
  flex: none;
}
.sp-icon-btn .el-icon { font-size: 17px; }

/* 重播层 */
.sp-replay-layer { z-index: 12; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(2px); }
.sp-replay-btn { font-size: 15px; padding: 12px 28px; }

/* 桌面端：居中竖屏列 */
@media (min-width: 1024px) {
  .share-play {
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(60% 40% at 50% 0%, var(--ad-brand-soft), transparent 70%),
      #05070c;
  }
  .sp-stage {
    width: min(420px, 100vw);
    height: min(100%, 100dvh);
    border-radius: 16px;
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.65);
  }
}
</style>
