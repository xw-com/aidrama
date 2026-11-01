<script setup>
/**
 * 展示中心（Tab 1，游客可看）：proposal「展示中心」1:1 —— 品牌行 / 搜索 / 叙事 chips /
 * 为你推荐（vcard 列表）。
 * 数据口径与 client ShowcaseView 一致：showcaseApi.list 分页 + 风格/叙事元数据。
 */
import { ref, computed, onMounted } from 'vue';
import { onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { showcaseApi, artStyleApi, requireLogin } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { useInvitationsStore } from '../../stores/invitations';
import { useJobsStore } from '../../stores/jobs';
import { useLocaleStore } from '../../stores/locale';
import { useThemeStore } from '../../stores/theme';
import { toAbsolute, coverPalette } from '../../utils/media';
import { formatViews } from '../../utils/format';
import { statusBarHeight } from '../../utils/system';
import { toastError } from '../../utils/ui';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdTabbar from '../../components/ad-tabbar/ad-tabbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

const { t, locale } = useI18n();
const auth = useAuthStore();
const invitations = useInvitationsStore();
const jobs = useJobsStore();
const localeStore = useLocaleStore();
const theme = useThemeStore();

const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const SIZE = 8;
const q = ref('');
const filterNarrative = ref('');

const narrativeTypes = ref([]);
const artStyles = ref([]);
const styleNameMap = computed(() => {
  const m = {};
  artStyles.value.forEach((s) => { m[s.key] = s.name; });
  return m;
});
const styleName = (key) => (key ? (styleNameMap.value[key] || key) : '');
const narrativeLabel = (v) => {
  if (!v) return '';
  return narrativeTypes.value.some((n) => n.key === v) ? t(`script.genre.${v}`) : v; // 旧值原样展示
};

const bellBadge = computed(() => jobs.activeCount + invitations.pendingCount);

const chips = computed(() => [
  { key: '', label: t('showcase.all') },
  ...narrativeTypes.value.map((n) => ({ key: n.key, label: narrativeLabel(n.key) })),
]);

// 推荐列表：全部（保持接口序）
const views = (n) => formatViews(n, localeStore.locale);

const coverSrc = (item) => {
  const c = item.project?.cover_thumb || item.project?.cover;
  return c ? toAbsolute(c) : '';
};

async function loadMeta() {
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
  try { narrativeTypes.value = await artStyleApi.narrativeTypes(); } catch { /* ignore */ }
}

async function load() {
  loading.value = true;
  try {
    const data = await showcaseApi.list({
      page: page.value,
      size: SIZE,
      q: q.value || undefined,
      narrative_type: filterNarrative.value || undefined,
    });
    list.value = page.value === 1 ? (data.list || []) : list.value.concat(data.list || []);
    total.value = data.total || 0;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

function pickChip(key) {
  if (filterNarrative.value === key) return;
  filterNarrative.value = key;
  page.value = 1;
  list.value = [];
  load();
}

function doSearch() {
  page.value = 1;
  list.value = [];
  load();
}

function openTasks() {
  if (!auth.isLoggedIn) {
    requireLogin('/pages/tasks/index');
    return;
  }
  uni.navigateTo({ url: '/pages/tasks/index' });
}

function open(item) {
  uni.navigateTo({ url: `/pages/showcase/detail?id=${item.id}` });
}

onMounted(() => {
  load();
  loadMeta();
});

onPullDownRefresh(async () => {
  page.value = 1;
  try { await load(); } finally { uni.stopPullDownRefresh(); }
});
onReachBottom(() => {
  if (loading.value || list.value.length >= total.value) return;
  page.value += 1;
  load();
});
</script>

<template>
  <view class="ad-page with-tabbar" :class="theme.rootCls">
    <!-- 品牌行 -->
    <view class="brandrow" :style="{ paddingTop: statusBarHeight() + 6 + 'px' }">
      <view class="brandmark"><m-icon name="film" :size="19" color="#0a0a0f" :sw="2" /></view>
      <text class="brandname">X<text class="bem">World</text> 短剧</text>
      <view style="flex: 1" />
      <view class="iconbtn" @tap="openTasks">
        <m-icon name="bell" :size="18" />
        <view v-if="bellBadge > 0" class="badge">{{ bellBadge > 99 ? '99+' : bellBadge }}</view>
      </view>
    </view>

    <view style="padding: 0 18px 4px">
      <view class="ptitle" style="font-size: 23px">{{ t('showcase.title') }}</view>
      <view class="psub">{{ t('showcase.subtitle') }}</view>
    </view>
    <view style="height: 13px" />

    <!-- 搜索 -->
    <view class="search">
      <m-icon name="search" :size="16" />
      <input
        v-model="q"
        class="search-input"
        :placeholder="t('showcase.searchPlaceholder')"
        placeholder-class="ad-ph"
        confirm-type="search"
        @confirm="doSearch"
      >
    </view>

    <!-- 叙事类型 chips -->
    <scroll-view scroll-x class="chips-scroll">
      <view class="chips">
        <text
          v-for="c in chips"
          :key="c.key"
          class="pchip"
          :class="{ on: filterNarrative === c.key }"
          @tap="pickChip(c.key)"
        >{{ c.label }}</text>
      </view>
    </scroll-view>

    <!-- 为你推荐 -->
    <view class="sechead"><text class="h5">{{ t('mobile.showcase.forYou') }}</text></view>
    <view v-for="item in list" :key="item.id" class="vcard" @tap="open(item)">
      <view class="art" :style="{ background: coverPalette(item.project_id) }">
        <view class="glow" />
        <image v-if="coverSrc(item)" :src="coverSrc(item)" mode="aspectFill" class="cimg" />
        <text v-else class="zi">{{ (item.project?.name || '剧')[0] }}</text>
      </view>
      <view class="vplay"><m-icon name="play" :size="18" color="#fff" /></view>
      <view class="vinfo">
        <view class="vtitle">《{{ item.project?.name }}》</view>
        <view class="vmeta">
          <text v-if="styleName(item.project?.style)" class="chip glass">{{ styleName(item.project?.style) }}</text>
          <text v-if="narrativeLabel(item.project?.narrative_type)" class="chip glass">{{ narrativeLabel(item.project?.narrative_type) }}</text>
          <text v-if="item.project?.aspect_ratio" class="chip glass">{{ item.project.aspect_ratio }} · {{ t('showcase.episodes', { n: item.episode_count ?? 0 }) }}</text>
          <text class="vnum"><m-icon name="play" :size="11" color="#e0b64e" /> {{ views(item.view_count || 0) }}</text>
        </view>
      </view>
    </view>

    <view v-if="!list.length && !loading" class="ad-empty">
      <text class="et">{{ t('showcase.empty') }}</text>
    </view>
    <view v-if="loading" class="ad-loading"><text>{{ t('common.loading') }}</text></view>
    <view v-if="!loading && list.length >= total && list.length" class="ad-endfoot"><text>{{ t('mobile.common.noMore') }}</text></view>

    <AdTabbar current="showcase" />
    <AdDialog />
  </view>
</template>

<style scoped>
.search-input { flex: 1; font-size: 13px; color: var(--ad-text); }
.chips-scroll { width: 100%; white-space: nowrap; }
.vtitle { font-size: 16px; font-weight: 800; color: #fff; }
.ad-loading { padding: 24px 0; text-align: center; color: var(--ad-text-mut); font-size: 12px; }
.ad-endfoot { padding: 14px 0 6px; text-align: center; color: var(--ad-text-mut); font-size: 11px; }
.ad-empty { padding: 60px 0; text-align: center; color: var(--ad-text-mut); font-size: 13px; }
</style>
