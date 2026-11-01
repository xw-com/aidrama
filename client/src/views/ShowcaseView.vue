<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { showcaseApi, artStyleApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';
import SiteFooterBar from '../components/SiteFooterBar.vue';

// 展示中心：浏览全站已发布剧目；mine 视图管理自己发布的（可下架）
const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();

const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const SIZE = 8; // 一页 8 个
const q = ref('');
const mine = ref(false);
// 分类筛选：视觉风格 / 叙事类型（跟项目实时字段走）
const filterStyle = ref('');
const filterNarrative = ref('');

// 管理员有全站展示项目的下架权（本人视图之外也能操作）
const isAdmin = computed(() => auth.isAdmin);

// 视觉风格/叙事类型 key → 显示名（与项目列表同口径：风格取注册表名，叙事复用 script.genre.* 译文）
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
  return narrativeTypes.value.some((n) => n.key === v) ? t(`script.genre.${v}`) : v; // 旧值原样展示
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
      mine: mine.value ? '1' : undefined,
      style: filterStyle.value || undefined,
      narrative_type: filterNarrative.value || undefined,
    });
    list.value = data.list || [];
    total.value = data.total || 0;
  } finally {
    loading.value = false;
  }
}

// 筛选/搜索变更：重置回第一页再拉
function applyFilter() {
  page.value = 1;
  load();
}

function search() {
  applyFilter();
}

function toggleMine(v) {
  // 「我发布的」是用户相关操作：游客先引导登录/注册（radio 不切换，回来后仍可重选）
  if (v && !auth.isLoggedIn) {
    ElMessage.info(t('auth.loginToContinue'));
    router.push({ name: 'login', query: { redirect: route.fullPath } });
    return;
  }
  mine.value = v;
  page.value = 1;
  load();
}

function open(item) {
  router.push({ name: 'showcaseDetail', params: { id: item.id } });
}

// 做同款：携带剧目元信息（名称/简介/叙事类型/风格/画幅）跳剧本创作，
// 创作页消费参数自动建「同款」草稿；游客由路由守卫带 redirect 引导登录，回来自动续起
function remake(item) {
  const q = {
    remake: '1',
    name: (item.project?.name || '').slice(0, 40),
    desc: (item.description || '').slice(0, 200),
    narrative: item.project?.narrative_type || '',
    style: item.project?.style || '',
    aspect: item.project?.aspect_ratio || '',
  };
  Object.keys(q).forEach((k) => { if (!q[k]) delete q[k]; });
  router.push({ name: 'script-writer', query: q });
}

// 下架（发布者本人或管理员；入口在 mine 视图/管理员登录态下出现）
async function unpublish(item) {
  const byAdmin = !mine.value && isAdmin.value;
  try {
    await ElMessageBox.confirm(
      byAdmin ? t('showcase.adminUnpublishConfirm') : t('showcase.unpublishConfirm'),
      t('showcase.unpublish'),
      { type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel') },
    );
  } catch { return; }
  await showcaseApi.remove(item.id);
  ElMessage.success(t('showcase.removed'));
  load();
}

function publisherName(p) {
  return p?.nickname || p?.username || '-';
}

// 封面兜底渐变（与项目列表同款）
const COVER_PALETTES = [
  'linear-gradient(135deg,#667eea,#764ba2)', 'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)', 'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)', 'linear-gradient(135deg,#30cfd0,#330867)',
];
function coverBg(id) {
  return COVER_PALETTES[((id - 1) % COVER_PALETTES.length + COVER_PALETTES.length) % COVER_PALETTES.length];
}

onMounted(() => {
  load();
  loadMeta();
});
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-flex-between ad-page-head sc-head" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg">{{ t('showcase.title') }}</div>
          <div class="ad-sub">{{ t('showcase.subtitle') }}</div>
        </div>
        <div class="ad-flex-center ad-gap-sm sc-tools">
          <el-radio-group :model-value="mine" size="default" @update:model-value="toggleMine">
            <el-radio-button :value="false">{{ t('showcase.all') }}</el-radio-button>
            <el-radio-button :value="true">{{ t('showcase.mine') }}</el-radio-button>
          </el-radio-group>
          <el-select
            v-model="filterStyle" clearable filterable
            :placeholder="t('showcase.filterStyle')" class="sc-filter"
            @change="applyFilter" @clear="applyFilter"
          >
            <el-option v-for="s in artStyles" :key="s.key" :label="s.name" :value="s.key" />
          </el-select>
          <el-select
            v-model="filterNarrative" clearable filterable
            :placeholder="t('showcase.filterNarrative')" class="sc-filter"
            @change="applyFilter" @clear="applyFilter"
          >
            <el-option v-for="n in narrativeTypes" :key="n.key" :label="narrativeLabel(n.key)" :value="n.key" />
          </el-select>
          <el-input
            v-model="q" clearable :placeholder="t('showcase.searchPlaceholder')"
            style="width: min(220px, 60vw)" @keyup.enter="search" @clear="search"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon></el-button>
        </div>
      </div>

      <div class="ad-rule sc-rule" />

      <div v-if="list.length" v-loading="loading" class="sc-grid ad-stagger">
        <div v-for="item in list" :key="item.id" class="ad-card sc-card" @click="open(item)">
          <div class="sc-cover" :style="{ background: coverBg(item.project_id) }">
            <img v-if="item.project?.cover" :src="item.project.cover_thumb || item.project.cover" loading="lazy" decoding="async" alt="" />
            <span v-else class="sc-cover-emoji">🎬</span>
            <!-- AIGC 标识：内容由 AI 生成（合规要求，封面左上角常驻） -->
            <span class="chip mini sc-aigc-chip">
              <el-icon><MagicStick /></el-icon> {{ t('aigc.disclaimer') }}
            </span>
            <!-- 画幅（屏幕画面比例），与分集数分列封面两角 -->
            <span v-if="item.project?.aspect_ratio" class="chip mini sc-ar-chip">{{ item.project.aspect_ratio }}</span>
            <span class="chip mini chip-accent sc-ep-chip">{{ t('showcase.episodes', { n: item.episode_count ?? 0 }) }}</span>
          </div>
          <div class="sc-body">
            <div class="sc-title">{{ item.project?.name }}</div>
            <div
              v-if="styleName(item.project?.style) || narrativeLabel(item.project?.narrative_type)"
              class="sc-tags"
            >
              <span v-if="styleName(item.project?.style)" class="chip mini sc-tag">
                <el-icon><Picture /></el-icon> {{ styleName(item.project?.style) }}
              </span>
              <span v-if="narrativeLabel(item.project?.narrative_type)" class="chip mini sc-tag">
                <el-icon><Reading /></el-icon> {{ narrativeLabel(item.project?.narrative_type) }}
              </span>
            </div>
            <div class="sc-desc" v-if="item.description">{{ item.description }}</div>
            <div class="sc-meta">
              <span class="sc-publisher">
                <el-icon><User /></el-icon> {{ publisherName(item.publisher) }}
              </span>
              <span class="sc-views"><el-icon><View /></el-icon> {{ item.view_count || 0 }}</span>
            </div>
            <!-- 做同款对所有访客开放（游客点击跳登录，回来自动续起）；下架仅发布者/管理员可见 -->
            <div class="sc-actions" @click.stop>
              <el-button size="small" type="primary" plain @click="remake(item)">
                <el-icon><MagicStick /></el-icon> {{ t('showcase.remake') }}
              </el-button>
              <el-button v-if="mine || isAdmin" size="small" text type="danger" @click="unpublish(item)">
                <el-icon><Delete /></el-icon> {{ t('showcase.unpublish') }}
              </el-button>
            </div>
          </div>
        </div>
      </div>

      <EmptyState v-else-if="!loading" :title="mine ? t('showcase.emptyMine') : t('showcase.empty')" :description="mine ? t('showcase.emptyMineTip') : ''" />

      <div v-if="total > SIZE" class="sc-pager">
        <el-pagination
          background layout="prev, pager, next" :total="total"
          :page-size="SIZE" :current-page="page"
          @current-change="(p) => { page = p; load(); }"
        />
      </div>

      <!-- 页脚：版权 + 协议链接 + ICP 备案（备案号取 VITE_ICP_NO，留空隐藏） -->
      <SiteFooterBar />
    </div>
  </div>
</template>

<style scoped>
.sc-head { margin-bottom: 0; }
.sc-rule { margin-bottom: 18px; }
.sc-tools { flex-wrap: wrap; }
/* 分类筛选下拉：窄屏收窄 */
.sc-filter { width: min(170px, 44vw); }
.sc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 18px;
}
.sc-card {
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.sc-card:hover { transform: translateY(-2px); box-shadow: var(--ad-shadow-hover); }
.sc-cover {
  position: relative;
  aspect-ratio: 16 / 10;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.sc-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sc-cover-emoji { font-size: 40px; filter: drop-shadow(var(--ad-shadow-md)); }
/* AIGC 标识 chip：封面左上角，黑幕描金保证任意封面上的可读性 */
.sc-aigc-chip {
  position: absolute;
  top: 10px;
  left: 10px;
  max-width: calc(100% - 20px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(0, 0, 0, 0.55);
  border-color: transparent;
  color: #e0b64e;
  backdrop-filter: blur(6px);
}
.sc-ep-chip { position: absolute; right: 10px; bottom: 10px; }
/* 画幅 chip：封面左下角，与右下角分集数对角排布 */
.sc-ar-chip { position: absolute; left: 10px; bottom: 10px; }
.sc-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 6px; }
.sc-title {
  font-weight: 700; font-size: 15px; color: var(--ad-text-strong);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sc-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.sc-tag {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sc-desc {
  font-size: var(--ad-fz-xs); color: var(--ad-text-soft); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 0;
}
.sc-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--ad-fz-xs); color: var(--ad-text-muted); }
.sc-publisher, .sc-views { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.sc-views { font-variant-numeric: tabular-nums; }
.sc-publisher { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sc-pager { display: flex; justify-content: center; margin-top: 22px; }

@media (max-width: 768px) {
  .sc-grid { grid-template-columns: repeat(auto-fill, minmax(min(230px, 44vw), 1fr)); gap: 12px; }
}
</style>
