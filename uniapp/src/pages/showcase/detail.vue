<script setup>
/**
 * 展示中心播放页（Tab1 二级）：可播分集由后端按「最新字幕版 > 最新成片 > episode.video_url」口径选出。
 * 手机版：播放器置顶（按项目画幅）→ 剧集信息 → 横向选集条 → 做同款。
 */
import { ref, computed, onMounted } from 'vue';
import { onLoad, onUnload, onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { showcaseApi, artStyleApi, requireLogin } from '../../api';
import { formatDuration } from '../../utils/format';
import { toAbsolute } from '../../utils/media';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { toastError } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import { useHarmonyVideoOrientation } from '../../composables/useHarmonyVideoOrientation';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();
// 鸿蒙端全屏方向纠正（非鸿蒙为空实现，见 composable 注释）
const hvo = useHarmonyVideoOrientation();
onUnload(() => hvo.restore());

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();

const loading = ref(false);
const item = ref(null);
const currentIdx = ref(0);
let showcaseId = null;

const artStyles = ref([]);
const narrativeTypes = ref([]);
const styleNameMap = computed(() => {
  const m = {};
  artStyles.value.forEach((s) => { m[s.key] = s.name; });
  return m;
});
const styleName = (key) => (key ? (styleNameMap.value[key] || key) : '');
const narrativeLabel = (v) => {
  if (!v) return '';
  return narrativeTypes.value.some((n) => n.key === v) ? t(`script.genre.${v}`) : v;
};

async function loadMeta() {
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
  try { narrativeTypes.value = await artStyleApi.narrativeTypes(); } catch { /* ignore */ }
}

const episodes = computed(() => item.value?.episodes || []);
const current = computed(() => episodes.value[currentIdx.value] || null);
// 画幅 → video 容器纵横比（项目画幅缺失时按 9:16 短剧常态兜底）
const aspect = computed(() => item.value?.project?.aspect_ratio || '9:16');
const aspectCss = computed(() => {
  const m = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(aspect.value);
  if (!m) return '9 / 16';
  return `${m[1]} / ${m[2]}`;
});

const videoUrl = computed(() => (current.value?.video_url ? toAbsolute(current.value.video_url) : ''));

async function load() {
  loading.value = true;
  try {
    item.value = await showcaseApi.detail(showcaseId);
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

function selectEp(i) {
  currentIdx.value = i;
}

// 播完自动连播下一集
function onEnded() {
  if (currentIdx.value < episodes.value.length - 1) selectEp(currentIdx.value + 1);
}

// 鸿蒙端：全屏方向纠正（9:16 等竖幅被原生链路转横屏后补回竖屏，见 composable 注释）
function onFsChange(e) {
  hvo.onFullscreenChange(e, aspect.value);
}

const publisherName = (p) => p?.nickname || p?.username || '-';

// 做同款：携带剧目元信息跳剧本创作（游客先引导登录，回来自动续起）
function remake() {
  const p = item.value?.project;
  const params = {
    remake: '1',
    name: (p?.name || '').slice(0, 40),
    desc: (item.value?.description || '').slice(0, 200),
    narrative: p?.narrative_type || '',
    style: p?.style || '',
    aspect: p?.aspect_ratio || '',
  };
  const qs = Object.keys(params)
    .filter((k) => params[k])
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  if (!auth.isLoggedIn) {
    requireLogin(`/pages/create/writer?${qs}`);
    return;
  }
  uni.navigateTo({ url: `/pages/create/writer?${qs}` });
}

onLoad((q) => { showcaseId = q?.id; });
onMounted(() => {
  if (!showcaseId) return;
  load();
  loadMeta();
});
// 下拉刷新：重拉项目详情与聚合统计
onPullDownRefresh(async () => {
  try { await Promise.all([load(), loadMeta()]); } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="item?.project?.name || t('showcase.title')" />

    <view v-if="loading && !item" class="ad-loading"><text>{{ t('common.loading') }}</text></view>

    <template v-if="item">
      <!-- 播放器 -->
      <view v-if="episodes.length" class="sd-player">
        <video
          v-if="videoUrl"
          :key="current?.id"
          id="sd-video"
          class="sd-video"
          :src="videoUrl"
          :poster="item.project?.cover ? toAbsolute(item.project.cover) : ''"
          :style="{ aspectRatio: aspectCss }"
          object-fit="contain"
          controls
          autoplay
          play-strategy="0"
          :direction="aspect === '16:9' ? 90 : 0"
          @fullscreenchange="onFsChange"
          @ended="onEnded"
        />
        <view class="sd-now">
          <text class="chip teal sm">{{ t('share.play.episodeOf', { idx: current?.idx, n: episodes.length }) }}</text>
          <text class="sd-now-title">{{ current?.title }}</text>
          <text class="sd-now-dur">{{ formatDuration(current?.duration) }}</text>
        </view>
      </view>
      <view v-else class="ad-empty"><text class="et">{{ t('showcase.noEpisodes') }}</text></view>

      <!-- 剧集信息 -->
      <view class="sd-hero">
        <view class="sd-name">{{ item.project?.name }}</view>
        <view class="sd-meta">
          <text class="sd-pub">{{ publisherName(item.publisher) }}</text>
          <text class="sd-sep">·</text>
          <text>{{ t('showcase.views', { n: item.view_count || 0 }) }}</text>
          <text class="sd-sep">·</text>
          <text>{{ aspect }}</text>
          <text class="sd-sep">·</text>
          <text>{{ t('showcase.episodes', { n: episodes.length }) }}</text>
        </view>
        <view v-if="styleName(item.project?.style) || narrativeLabel(item.project?.narrative_type)" class="sd-tags">
          <text v-if="styleName(item.project?.style)" class="chip gold sm">{{ styleName(item.project?.style) }}</text>
          <text v-if="narrativeLabel(item.project?.narrative_type)" class="chip sm">{{ narrativeLabel(item.project?.narrative_type) }}</text>
        </view>
        <view v-if="item.description" class="sd-desc">{{ item.description }}</view>
        <view class="mbtn sd-remake" @tap="remake">
          <m-icon name="remake" :size="16" color="#1a1205" /> {{ t('showcase.remake') }}
        </view>
      </view>

      <!-- 选集（两列网格，多行铺开） -->
      <view v-if="episodes.length" class="sd-eps-sec">
        <view class="sechead"><text class="h5">{{ t('showcase.playlist') }}</text></view>
        <view class="sd-eps">
          <view
            v-for="(ep, i) in episodes"
            :key="ep.id"
            class="sd-ep"
            :class="{ active: i === currentIdx }"
            @tap="selectEp(i)"
          >
            <text class="sd-ep-no">{{ ep.idx }}</text>
            <text class="sd-ep-title">{{ ep.title }}</text>
            <text class="sd-ep-dur">{{ formatDuration(ep.duration) }}</text>
          </view>
        </view>
      </view>
    </template>
    <AdDialog />
  </view>
</template>

<style scoped>
.ad-loading { padding: 60px 0; text-align: center; color: var(--ad-text-mut); font-size: 13px; }
.sd-player { padding: 4px 14px 0; }
.sd-video { width: 100%; background: #000; border-radius: 16px; overflow: hidden; }
.sd-now { display: flex; align-items: center; gap: 10px; padding: 10px 4px 0; }
.sd-now-title { flex: 1; min-width: 0; font-weight: 700; font-size: 13px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-now-dur { color: var(--ad-text-mut); font-size: 12px; }
.sd-hero { padding: 16px 18px 6px; }
.sd-name { font-family: var(--ad-font-serif); font-weight: 900; font-size: 22px; color: var(--ad-text); line-height: 1.3; }
.sd-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 8px; font-size: 12px; color: var(--ad-text-mut); }
.sd-pub { color: var(--ad-text-soft); }
.sd-sep { opacity: 0.5; }
.sd-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.sd-desc { margin-top: 10px; font-size: 13px; line-height: 1.7; color: var(--ad-text-soft); }
.sd-remake { margin-top: 14px; display: inline-flex; }
.sd-eps-sec { padding-bottom: 30px; }
/* 两列网格：与 .pkggrid 同法（flex-wrap + calc 半宽），mp/app 端不依赖 grid 布局 */
.sd-eps { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 8px; }
.sd-ep {
  display: flex; align-items: center; gap: 8px;
  width: calc(50% - 4px); box-sizing: border-box;
  padding: 9px 12px; border-radius: 12px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.sd-ep.active { border-color: var(--ad-brand); background: rgba(224, 182, 78, 0.12); }
.sd-ep-no {
  flex: none; min-width: 20px; height: 20px; padding: 0 3px; border-radius: 6px;
  background: var(--ad-inset); color: var(--ad-text-soft);
  font-size: 11px; font-weight: 700; text-align: center; line-height: 20px;
}
.sd-ep.active .sd-ep-no { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.sd-ep-title { flex: 1; min-width: 0; font-size: 12px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-ep-dur { flex: none; font-size: 11px; color: var(--ad-text-mut); }
</style>
