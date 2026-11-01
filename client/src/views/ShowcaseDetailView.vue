<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { showcaseApi, artStyleApi } from '../api';
import { formatDuration } from '../utils/format';
import EmptyState from '../components/EmptyState.vue';

// 展示中心播放页：可播分集由后端按「最新字幕版 > 最新成片 > episode.video_url」口径选出（与批量下载一致）
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const loading = ref(false);
const item = ref(null);
const currentIdx = ref(0);

// 视觉风格/叙事类型 key → 显示名（与展示列表同口径）
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

const player = ref(null);

async function load() {
  loading.value = true;
  try {
    item.value = await showcaseApi.detail(route.params.id);
  } finally {
    loading.value = false;
  }
}

function selectEp(i) {
  currentIdx.value = i;
  player.value?.play?.().catch(() => {});
}

// 播完自动连播下一集
function onEnded() {
  if (currentIdx.value < episodes.value.length - 1) selectEp(currentIdx.value + 1);
}

function publisherName(p) {
  return p?.nickname || p?.username || '-';
}

// 做同款：携带剧目元信息（名称/简介/叙事类型/风格/画幅）跳剧本创作，
// 创作页消费参数自动建「同款」草稿；游客由路由守卫带 redirect 引导登录，回来自动续起
function remake() {
  const p = item.value?.project;
  const q = {
    remake: '1',
    name: (p?.name || '').slice(0, 40),
    desc: (item.value?.description || '').slice(0, 200),
    narrative: p?.narrative_type || '',
    style: p?.style || '',
    aspect: p?.aspect_ratio || '',
  };
  Object.keys(q).forEach((k) => { if (!q[k]) delete q[k]; });
  router.push({ name: 'script-writer', query: q });
}

onMounted(() => {
  load();
  loadMeta();
});
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="sd-top">
        <el-button text @click="router.push({ name: 'showcase' })">
          <el-icon><ArrowLeft /></el-icon> {{ t('showcase.back') }}
        </el-button>
      </div>

      <template v-if="item">
        <div class="sd-hero">
          <div class="sd-title-wrap">
            <div class="ad-title-lg">{{ item.project?.name }}</div>
            <div class="sd-sub">
              <span class="sd-publisher">
                <el-icon><User /></el-icon> {{ publisherName(item.publisher) }}
              </span>
              <span class="sd-sep">·</span>
              <span><el-icon><View /></el-icon> {{ t('showcase.views', { n: item.view_count || 0 }) }}</span>
              <span class="sd-sep">·</span>
              <span class="chip mini">{{ aspect }}</span>
              <span class="sd-sep">·</span>
              <span>{{ t('showcase.episodes', { n: episodes.length }) }}</span>
              <template v-if="styleName(item.project?.style) || narrativeLabel(item.project?.narrative_type)">
                <span class="sd-sep">·</span>
                <span v-if="styleName(item.project?.style)" class="chip mini sd-tag">
                  <el-icon><Picture /></el-icon> {{ t('project.visualStyle') }} · {{ styleName(item.project?.style) }}
                </span>
                <span v-if="narrativeLabel(item.project?.narrative_type)" class="chip mini sd-tag">
                  <el-icon><Reading /></el-icon> {{ t('project.narrativeType') }} · {{ narrativeLabel(item.project?.narrative_type) }}
                </span>
              </template>
            </div>
            <p v-if="item.description" class="sd-desc">{{ item.description }}</p>
            <div class="ad-rule sd-rule" />
          </div>
          <!-- 做同款：跳剧本创作自动建同款草稿（游客点击先引导登录，回来自动续起） -->
          <el-button type="primary" size="large" class="sd-remake" @click="remake">
            <el-icon><MagicStick /></el-icon> {{ t('showcase.remake') }}
          </el-button>
        </div>

        <div v-if="episodes.length" class="sd-layout">
          <div class="sd-player ad-card">
            <video
              ref="player"
              :key="current?.id"
              :src="current?.video_url"
              :style="{ aspectRatio: aspectCss }"
              controls autoplay playsinline
              @ended="onEnded"
            ></video>
            <div class="sd-now">
              <span class="chip mini chip-accent">{{ t('share.play.episodeOf', { idx: current?.idx, n: episodes.length }) }}</span>
              <span class="sd-now-title">{{ current?.title }}</span>
              <span class="sd-now-dur">{{ formatDuration(current?.duration) }}</span>
            </div>
          </div>

          <aside class="sd-playlist ad-card">
            <div class="sd-pl-head">{{ t('showcase.playlist') }}</div>
            <div class="sd-pl-body">
              <button
                v-for="(ep, i) in episodes"
                :key="ep.id"
                class="sd-pl-item"
                :class="{ active: i === currentIdx }"
                @click="selectEp(i)"
              >
                <span class="sd-pl-no">{{ ep.idx }}</span>
                <span class="sd-pl-title">{{ ep.title }}</span>
                <span class="sd-pl-dur">{{ formatDuration(ep.duration) }}</span>
              </button>
            </div>
          </aside>
        </div>

        <EmptyState v-else icon="🎬" :title="t('showcase.noEpisodes')" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.sd-top { margin-bottom: 4px; }
/* hero：标题信息 + 右侧「做同款」主按钮（窄屏按钮换行沉底） */
.sd-hero { margin-bottom: 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.sd-title-wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.sd-rule { margin-top: 10px; max-width: 760px; }
.sd-remake { flex-shrink: 0; }
.sd-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--ad-text-muted); }
.sd-publisher { display: inline-flex; align-items: center; gap: 4px; }
.sd-sep { opacity: 0.5; }
.sd-tag { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-desc { margin: 4px 0 0; font-size: 13.5px; line-height: 1.7; color: var(--ad-text); max-width: 760px; }

.sd-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}
.sd-player { padding: 0; overflow: hidden; }
.sd-player video {
  display: block; width: 100%; max-height: 72vh;
  background: #000; margin: 0 auto;
}
/* 横版画幅不满宽高时限高即可；竖版 9:16 等比收缩由 aspect-ratio 承担 */
.sd-now {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; font-size: 13px;
}
.sd-now-title { font-weight: 700; color: var(--ad-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-now-dur { margin-left: auto; color: var(--ad-text-muted); font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; }

.sd-playlist { display: flex; flex-direction: column; max-height: 76vh; }
.sd-pl-head {
  padding: 12px 14px; font-weight: 700; font-size: 14px;
  border-bottom: 1px solid var(--ad-border);
  color: var(--ad-text-strong);
}
.sd-pl-body { overflow-y: auto; padding: 6px; }
.sd-pl-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 9px 10px; border: none; background: transparent; border-radius: var(--ad-radius-sm);
  cursor: pointer; text-align: left; font-size: 13.5px;
  color: var(--ad-text);
}
.sd-pl-item:hover { background: var(--ad-bg-soft); }
.sd-pl-item.active { background: var(--ad-brand-soft); color: var(--ad-brand-600); font-weight: 700; }
.sd-pl-no {
  flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
  background: var(--ad-bg-soft);
}
.sd-pl-item.active .sd-pl-no { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.sd-pl-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-pl-dur { flex: 0 0 auto; font-size: 12px; color: var(--ad-text-muted); font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; }

@media (max-width: 900px) {
  .sd-layout { grid-template-columns: 1fr; }
  .sd-playlist { max-height: 320px; }
}
</style>
