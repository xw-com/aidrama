<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { projectApi, artStyleApi } from '../../api';
import ScriptOutline from './ScriptOutline.vue';
import AssetLibrary from './AssetLibrary.vue';
import EpisodeList from './EpisodeList.vue';
import SubtitleSettingsDialog from '../../components/SubtitleSettingsDialog.vue';
import MemberManagerDialog from '../../components/MemberManagerDialog.vue';
import { can, isOwner } from '../../utils/perms';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const projectId = computed(() => route.params.id);

const steps = computed(() => [
  { key: '1', label: t('workspace.step.scriptOutline'), icon: 'Document' },
  { key: '2', label: t('workspace.step.assetLibrary'), icon: 'FolderOpened' },
  { key: '3', label: t('workspace.step.episodes'), icon: 'Film' },
]);
const activeStep = ref(route.query.step || '1');
const project = ref(null);
const assetCount = ref(0);
const loading = ref(false);

async function loadProject() {
  loading.value = true;
  try {
    // 详情接口已附 asset_count/asset_counts 聚合，不再为数个数拉全量资产列表（含 prompt/meta 大字段）
    project.value = await projectApi.get(projectId.value);
    assetCount.value = project.value?.asset_count || 0;
    // 仅当用户未显式指定 step 时，按模块状态自动选默认页（避免覆盖手动跳转 / 刷新 / 子组件 @reload）
    if (!route.query.step) {
      const step = pickDefaultStep();
      activeStep.value = step;
      router.replace({ query: { step } });
    }
  } catch (err) {
    // 被移出项目 / 项目已删除：错误提示已由 http 层弹出，这里引导回项目列表
    if (err?.status === 403 || err?.status === 404) router.replace('/projects');
  } finally {
    loading.value = false;
  }
}

// ===== 团队共享：本项目身份与权限（project 自带 my_role / my_permissions） =====
const amOwner = computed(() => isOwner(project.value));
const canSettings = computed(() => can(project.value, 'project.settings'));
const memberDialogVisible = ref(false);

// 完成态
const hasEpisodes = computed(() => (project.value?.episodes?.length || 0) > 0);
const hasAssets = computed(() => assetCount.value > 0);
const hasVideo = computed(() => (project.value?.episodes || []).some((e) => ['video', 'done'].includes(e.status)));

const stepDone = computed(() => ({
  '1': hasEpisodes.value,
  '2': hasAssets.value,
  '3': hasVideo.value,
}));

// 默认步骤：第一个尚未完成的；三者皆完成则停在「分集视频」
function pickDefaultStep() {
  const done = stepDone.value;
  if (!done['1']) return '1';   // 剧本大纲尚未拆出分集
  if (!done['2']) return '2';   // 资产库尚无资产
  return '3';                    // 剧本与资产就绪 → 进入分集视频
}

function gotoStep(key) {
  activeStep.value = key;
  router.replace({ query: { step: key } });
}
function nextStep() {
  const idx = steps.value.findIndex((s) => s.key === activeStep.value);
  if (idx < steps.value.length - 1) gotoStep(steps.value[idx + 1].key);
}

watch(() => route.query.step, (v) => { if (v) activeStep.value = v; });
watch(projectId, loadProject);
onMounted(() => {
  loadProject();
  loadStyles();
});
onUnmounted(() => {});

const currentComp = computed(() => {
  if (activeStep.value === '1') return ScriptOutline;
  if (activeStep.value === '2') return AssetLibrary;
  return EpisodeList;
});

// ===== 美术风格：解析风格中文名 + 顶栏快捷切换 =====
const artStyles = ref([]);
const styleNameMap = computed(() => {
  const m = {};
  artStyles.value.forEach((s) => { m[s.key] = s.name; });
  return m;
});
// 顶栏展示用：key 命中则用中文名，否则退回原值
const styleDisplayName = computed(() => styleNameMap.value[project.value?.style] || project.value?.style || '');
async function loadStyles() {
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
}

// 风格选择弹窗：写实 / 动漫 两个大类页签
const STYLE_CATEGORIES = computed(() => [
  { value: 'realistic', label: t('workspace.style.categoryRealistic') },
  { value: 'anime', label: t('workspace.style.categoryAnime') },
]);
const activeCategory = ref('anime');
const pendingStyle = ref('');
const categoryOf = (key) => artStyles.value.find((s) => s.key === key)?.category || 'anime';
const stylesByCategory = computed(() => {
  const groups = { realistic: [], anime: [] };
  artStyles.value.forEach((s) => { (groups[s.category] || groups.anime).push(s); });
  return groups;
});
const styleCategories = computed(() =>
  STYLE_CATEGORIES.value.map((c) => ({ ...c, count: (stylesByCategory.value[c.value] || []).length })),
);
// 切换大类页签：当前待选风格不在新分组时，自动落到该分组首个（保持可见高亮）
function onCategoryChange(name) {
  const group = stylesByCategory.value[name] || [];
  if (group.length && !group.some((s) => s.key === pendingStyle.value)) pendingStyle.value = group[0].key;
}
const styleDialogVisible = ref(false);
const styleSaving = ref(false);
// 风格大图预览（缩略图右上角小按钮触发，不改变待选风格）
const stylePreviewUrl = ref('');
function openStylePreview(url) { stylePreviewUrl.value = url; }
function openStyleDialog() {
  pendingStyle.value = project.value?.style || '';
  activeCategory.value = categoryOf(pendingStyle.value);
  styleDialogVisible.value = true;
}
async function applyStyle() {
  if (!pendingStyle.value || pendingStyle.value === project.value?.style) {
    styleDialogVisible.value = false;
    return;
  }
  styleSaving.value = true;
  try {
    await projectApi.update(projectId.value, { style: pendingStyle.value });
    styleDialogVisible.value = false;
    ElMessage.success(t('workspace.style.updated'));
    await loadProject();
  } catch {
    ElMessage.error(t('workspace.style.updateFailed'));
  } finally {
    styleSaving.value = false;
  }
}

// ===== 项目全局字幕设置：顶栏快捷入口（对本项目所有分集的字幕烧录生效） =====
const subtitleSettingsVisible = ref(false);
const hasCustomSubtitle = computed(() => {
  const sub = project.value?.settings?.subtitle;
  return !!(sub && Object.keys(sub).length);
});

// ===== 画面比例：顶栏快捷切换 =====
const aspects = computed(() => [
  { value: '9:16', label: t('workspace.aspect.vertical'), w: 9, h: 16 },
  { value: '16:9', label: t('workspace.aspect.horizontal'), w: 16, h: 9 },
  { value: '1:1', label: t('workspace.aspect.square'), w: 1, h: 1 },
]);
const aspectVisible = ref(false);
const aspectSaving = ref(false);
const SHAPE_MAX = 13; // chip 内迷你比例形的最大边长（px）
// 按真实宽高比绘制矩形，直观体现画面形状
function shapeStyle(ar) {
  const a = aspects.value.find((x) => x.value === ar);
  if (!a) return {};
  if (a.w >= a.h) return { width: SHAPE_MAX + 'px', height: Math.round((SHAPE_MAX * a.h) / a.w) + 'px' };
  return { height: SHAPE_MAX + 'px', width: Math.round((SHAPE_MAX * a.w) / a.h) + 'px' };
}
async function changeAspect(value) {
  aspectVisible.value = false;
  if (value === project.value?.aspect_ratio) return;
  aspectSaving.value = true;
  try {
    await projectApi.update(projectId.value, { aspect_ratio: value });
    ElMessage.success(t('workspace.aspect.updated'));
    await loadProject();
  } catch {
    ElMessage.error(t('workspace.aspect.updateFailed'));
  } finally {
    aspectSaving.value = false;
  }
}
</script>

<template>
  <div v-loading="loading" class="workspace">
    <!-- 项目工具条 + 步骤导航（单行） -->
    <div class="ws-topbar">
      <div class="ws-left">
        <span class="ws-name">{{ project?.name || '...' }}</span>
        <!-- 团队共享：成员看到的共享标注（项目由 owner 创建并邀请加入） -->
        <span v-if="project && !amOwner" class="chip chip-shared" :title="t('team.sharedTitle')">
          <el-icon><Share /></el-icon> {{ t('team.shared') }}
        </span>
        <!-- 比例 / 风格 / 字幕设置 chip：需 project.settings 权限；无权限时退化为只读展示 -->
        <el-popover v-if="project?.aspect_ratio && canSettings" v-model:visible="aspectVisible" placement="bottom-start" :width="252" trigger="click" popper-class="asp-popper">
          <template #reference>
            <span
              class="chip chip-accent chip-editable"
              :class="{ saving: aspectSaving }"
              :title="t('workspace.aspect.clickToEdit')"
            >
              <span class="chip-shape" :style="shapeStyle(project.aspect_ratio)"></span>
              {{ project.aspect_ratio }}
              <el-icon class="chip-cue"><EditPen /></el-icon>
            </span>
          </template>
          <div class="asp-pop">
            <div class="asp-pop-title">{{ t('workspace.aspect.title') }}</div>
            <div class="asp-pop-grid">
              <button
                v-for="a in aspects"
                :key="a.value"
                type="button"
                class="asp-pop-item"
                :class="{ active: a.value === project?.aspect_ratio }"
                @click="changeAspect(a.value)"
              >
                <span class="chip-shape is-lg" :style="shapeStyle(a.value)"></span>
                <span class="asp-pop-label">{{ a.label }}</span>
                <span class="asp-pop-val">{{ a.value }}</span>
              </button>
            </div>
          </div>
        </el-popover>
        <span v-else-if="project?.aspect_ratio" class="chip chip-accent" :title="t('team.permNeeded', { perm: t('team.perms.projectSettings') })">
          <span class="chip-shape" :style="shapeStyle(project.aspect_ratio)"></span>
          {{ project.aspect_ratio }}
        </span>
        <span
          v-if="project?.style"
          class="chip"
          :class="[{ saving: styleSaving }, canSettings ? 'chip-editable' : '']"
          :title="canSettings ? `${styleDisplayName} · ${t('workspace.style.clickToEdit')}` : t('team.permNeeded', { perm: t('team.perms.projectSettings') })"
          @click="canSettings && openStyleDialog()"
        >
          {{ styleDisplayName }}
          <el-icon v-if="canSettings" class="chip-cue"><EditPen /></el-icon>
        </span>
        <span
          class="chip"
          :class="canSettings ? 'chip-editable' : ''"
          :title="canSettings ? t('project.subtitleSettings.chip') : t('team.permNeeded', { perm: t('team.perms.projectSettings') })"
          @click="canSettings && (subtitleSettingsVisible = true)"
        >
          {{ t('project.subtitleSettings.chip') }}
          <span v-if="hasCustomSubtitle" class="chip-dot"></span>
          <el-icon v-if="canSettings" class="chip-cue"><EditPen /></el-icon>
        </span>
        <!-- 成员管理入口：仅 owner -->
        <span v-if="amOwner" class="chip chip-editable" :title="t('team.manageMembers')" @click="memberDialogVisible = true">
          <el-icon><User /></el-icon> {{ t('team.members') }}
        </span>
      </div>

      <!-- 步骤导航：分段式，当前步骤醒目高亮 -->
      <nav class="ws-nav">
        <button
          v-for="s in steps"
          :key="s.key"
          class="ws-nav-item"
          :class="{
            active: s.key === activeStep,
            done: stepDone[s.key] && s.key !== activeStep,
          }"
          @click="gotoStep(s.key)"
        >
          <span class="wn-dot">
            <el-icon v-if="stepDone[s.key]" class="wn-check"><Select /></el-icon>
            <span v-else>{{ steps.findIndex(x => x.key === s.key) + 1 }}</span>
          </span>
          <span class="wn-label">{{ s.label }}</span>
        </button>
      </nav>
    </div>

    <!-- 步骤内容 -->
    <div class="ws-body">
      <component
        :is="currentComp"
        :project="project"
        :project-id="projectId"
        @reload="loadProject"
        @next="nextStep"
      />
    </div>

    <!-- 视觉风格快捷切换弹窗 -->
    <el-dialog
      v-model="styleDialogVisible"
      :title="t('workspace.style.title')"
      width="min(720px, 94vw)"
      top="8vh"
      append-to-body
      class="style-dlg"
    >
      <div class="ad-sub style-dlg-hint">{{ t('workspace.style.hint') }}</div>
      <el-tabs v-model="activeCategory" class="style-tabs" @tab-change="onCategoryChange">
        <el-tab-pane
          v-for="cat in styleCategories"
          :key="cat.value"
          :name="cat.value"
          :label="`${cat.label} · ${cat.count}`"
        >
          <div class="style-grid">
            <div
              v-for="s in stylesByCategory[cat.value]"
              :key="s.key"
              class="style-card"
              :class="{ active: pendingStyle === s.key }"
              @click="pendingStyle = s.key"
            >
              <div class="style-thumb">
                <img :src="s.thumbnailUrl" :alt="s.name" loading="lazy" />
                <button
                  type="button"
                  class="style-preview"
                  :title="t('style.preview')"
                  :aria-label="t('style.preview')"
                  @click.stop="openStylePreview(s.previewUrl)"
                >
                  <el-icon><ZoomIn /></el-icon>
                </button>
                <transition name="fade-check">
                  <div v-if="pendingStyle === s.key" class="style-check">
                    <el-icon><Check /></el-icon>
                  </div>
                </transition>
              </div>
              <div class="style-name" :title="s.name">{{ s.name }}</div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="styleDialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="styleSaving" @click="applyStyle">{{ t('workspace.style.apply') }}</el-button>
      </template>
    </el-dialog>

    <!-- 风格大图预览 -->
    <el-image-viewer
      v-if="stylePreviewUrl"
      :url-list="[stylePreviewUrl]"
      hide-on-click-modal
      teleported
      @close="stylePreviewUrl = ''"
    />

    <!-- 项目全局字幕设置弹窗 -->
    <SubtitleSettingsDialog
      v-model="subtitleSettingsVisible"
      :project-id="projectId"
      :aspect-ratio="project?.aspect_ratio || '9:16'"
      :subtitle="project?.settings?.subtitle || null"
      @updated="loadProject"
    />

    <!-- 成员管理（团队共享，owner 专属） -->
    <MemberManagerDialog v-model="memberDialogVisible" :project-id="projectId" @changed="loadProject" />
  </div>
</template>

<style scoped>
.workspace { min-height: 100vh; background: var(--ad-bg-soft); display: flex; flex-direction: column; }

/* 顶部工具条 + 步骤导航（单行） */
.ws-topbar {
  position: sticky;
  top: var(--ad-topbar-h);
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 24px;
  background: var(--ad-bg-elevated);
  border-bottom: 1px solid var(--ad-border);
}
.ws-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ws-name { font-size: 15px; font-weight: 700; color: var(--ad-text); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 步骤导航：分段式 */
.ws-nav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: var(--ad-bg-soft);
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius-pill, 999px);
  flex: 0 0 auto;
}
.ws-nav-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  border: none;
  background: transparent;
  border-radius: 999px;
  color: var(--ad-text-muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.18s, background 0.18s, box-shadow 0.18s;
  white-space: nowrap;
}
.ws-nav-item:hover { color: var(--ad-text); }

/* 已完成步骤 */
.ws-nav-item.done { color: var(--ad-text-soft); }
.ws-nav-item.done .wn-dot { border-color: var(--ad-success); color: var(--ad-success); }

/* 当前步骤：醒目品牌色高亮 */
.ws-nav-item.active {
  color: var(--ad-brand);
  background: var(--ad-bg-elevated);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.ws-nav-item.active .wn-dot {
  background: var(--ad-brand);
  border-color: var(--ad-brand);
  color: var(--ad-brand-contrast);
}

/* 序号圆点 */
.wn-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  border: 1.5px solid var(--ad-border-strong);
  background: var(--ad-bg-elevated);
  font-size: 11px;
  font-weight: 700;
  flex: 0 0 auto;
  transition: all 0.18s;
}
.wn-check { font-size: 12px; }
.wn-label { letter-spacing: 0.2px; }

.ws-body { flex: 1; padding: 0; }

@media (max-width: 860px) {
  .ws-topbar { padding: 10px 16px; gap: 10px; flex-wrap: wrap; }
  /* 左组放不下时换行：比例/风格芯片落到项目名下方第二行，避免一行挤爆 */
  .ws-left { flex-wrap: wrap; row-gap: 6px; }
  .ws-name { max-width: 140px; }
  /* 窄屏保留步骤文字：放不下时整个导航换行到下一行，条目内文字过长也可折行 */
  .ws-nav { flex-wrap: wrap; }
  .ws-nav-item { padding: 7px 10px; white-space: normal; text-align: left; }
}
@media (max-width: 560px) {
  .ws-nav { padding: 3px; }
  .ws-nav-item { padding: 6px 8px; gap: 6px; }
  .wn-dot { width: 18px; height: 18px; font-size: 10px; }
}

/* ===== 可编辑 chip：顶栏风格 / 比例快捷入口 ===== */
.chip-editable {
  cursor: pointer;
  max-width: 200px;
  transition: background 0.18s, color 0.18s, box-shadow 0.18s, opacity 0.18s;
}
.chip-editable:hover {
  background: var(--ad-brand-soft);
  color: var(--ad-brand);
  border-color: transparent;
  box-shadow: 0 2px 8px var(--ad-brand-soft);
}
/* 团队共享：成员视角的共享标注 chip */
.chip-shared {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ad-brand);
  font-weight: 600;
}
.chip-shared .el-icon { font-size: 13px; }
/* chip 内迷你比例形：按真实宽高比绘制的矩形 */
.chip-shape {
  display: inline-block;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  flex: 0 0 auto;
  opacity: 0.85;
}
.chip-shape.is-lg { width: 22px; height: 22px; opacity: 1; }
.chip-cue { font-size: 11px; opacity: 0.55; transition: opacity 0.18s; }
.chip-editable:hover .chip-cue { opacity: 1; }
.chip-editable.saving { opacity: 0.6; pointer-events: none; }
/* 字幕 chip：已自定义字幕样式时的小圆点标识 */
.chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ad-accent); display: inline-block; flex: 0 0 auto; }

/* ===== 视觉风格切换弹窗（写实/动漫页签 + 缩略图网格） ===== */
.style-dlg-hint { margin: -4px 0 12px; font-size: 12px; }
/* 页签：软底容器 + 选中态实心品牌色胶囊 */
.style-tabs :deep(.el-tabs__header) {
  margin: 0 0 14px;
  background: var(--ad-brand-soft);
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius);
  padding: 5px;
}
.style-tabs :deep(.el-tabs__nav-wrap)::after { background: transparent; }
.style-tabs :deep(.el-tabs__nav) { border: none !important; gap: 4px; }
.style-tabs :deep(.el-tabs__active-bar) { display: none; }
.style-tabs :deep(.el-tabs__item) {
  height: 40px; line-height: 40px; font-size: 15px; font-weight: 700;
  padding: 0 26px !important; margin: 0 !important;
  color: var(--ad-text-soft); border: none !important;
  border-radius: var(--ad-radius-sm);
  transition: color 0.18s, background 0.18s, box-shadow 0.18s;
}
.style-tabs :deep(.el-tabs__item:hover) { color: var(--ad-text); }
.style-tabs :deep(.el-tabs__item.is-active) {
  color: var(--ad-brand-contrast);
  background: var(--ad-brand);
  box-shadow: 0 6px 16px var(--ad-brand-soft);
}
.style-tabs :deep(.el-tabs__item.is-active:hover) { color: var(--ad-brand-contrast); }
.style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(177px, 1fr));
  gap: 12px; width: 100%;
  max-height: 56vh; overflow-y: auto; padding: 2px;
}
.style-card {
  cursor: pointer;
  border: 2px solid var(--ad-border);
  border-radius: var(--ad-radius);
  overflow: hidden;
  background: var(--ad-bg-elevated);
  transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
}
.style-card:hover {
  border-color: var(--ad-border-strong);
  transform: translateY(-2px);
  box-shadow: var(--ad-shadow-hover);
}
.style-card.active {
  border-color: var(--ad-accent);
  box-shadow: 0 0 0 3px var(--ad-brand-soft-2);
}
.style-thumb { position: relative; width: 100%; aspect-ratio: 4 / 3; background: var(--ad-bg-soft); overflow: hidden; }
.style-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.3s; }
.style-card:hover .style-thumb img { transform: scale(1.05); }
/* 大图预览小按钮（右上角，常驻可点；不改变待选风格） */
.style-preview {
  position: absolute; top: 6px; right: 6px;
  width: 24px; height: 24px; border: none; border-radius: 50%;
  background: rgba(15, 18, 34, 0.55); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  transition: background 0.18s, transform 0.18s;
}
.style-preview:hover { background: var(--ad-accent); transform: scale(1.08); }
.style-check {
  position: absolute; top: 6px; left: 6px;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--ad-accent); color: var(--ad-accent-contrast);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}
.style-name {
  padding: 8px 8px 9px; font-size: 13px; font-weight: 600; color: var(--ad-text);
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fade-check-enter-active, .fade-check-leave-active { transition: opacity 0.15s, transform 0.15s; }
.fade-check-enter-from, .fade-check-leave-to { opacity: 0; transform: scale(0.6); }
</style>

<!-- 气泡浮层被 teleport 到 body，需放在非 scoped 块中 -->
<style>
.asp-popper.el-popover.el-popper { padding: 14px 14px 12px; }
.asp-pop-title { font-size: 13px; font-weight: 700; color: var(--ad-text); margin-bottom: 10px; }
.asp-pop-grid { display: flex; gap: 10px; }
.asp-pop-item {
  flex: 1; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  padding: 12px 6px 10px;
  border: 2px solid var(--ad-border);
  border-radius: var(--ad-radius);
  background: var(--ad-bg-elevated);
  color: var(--ad-text);
  transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
}
.asp-pop-item:hover {
  border-color: var(--ad-border-strong);
  transform: translateY(-2px);
  box-shadow: var(--ad-shadow-hover);
}
.asp-pop-item.active {
  border-color: var(--ad-accent);
  box-shadow: 0 0 0 3px var(--ad-brand-soft-2);
}
.asp-pop-item .chip-shape {
  border-color: var(--ad-text-muted);
  width: 22px; height: 22px;
}
.asp-pop-item.active .chip-shape { border-color: var(--ad-accent); }
.asp-pop-label { font-size: 13px; font-weight: 600; }
.asp-pop-val { font-size: 11px; }
</style>
