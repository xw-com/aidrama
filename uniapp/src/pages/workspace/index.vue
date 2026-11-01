<script setup>
/**
 * 项目工作台（client WorkspaceView 移植，移动端改为概览导航页）：
 * 项目名 + 比例/风格/字幕 chip（可点编辑，需 project.settings 权限）+ 成员管理（owner）
 * + 三步卡片（剧本大纲/资产库/分集与成片，带完成态）。
 * 详情接口 lean 化：只给 has_script/content_length/asset_count 聚合，不再下发大字段。
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad, onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { projectApi, artStyleApi } from '../../api';
import { can, isOwner } from '../../utils/perms';
import { useThemeStore } from '../../stores/theme';
import { toast } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import ArtStylePicker from '../../components/art-style-picker/art-style-picker.vue';
import SubtitleSettingsSheet from '../../components/subtitle-settings-sheet/subtitle-settings-sheet.vue';
import MemberManagerSheet from '../../components/member-manager-sheet/member-manager-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();

const projectId = ref(null);
const project = ref(null);
const loading = ref(false);

// 三步卡片（完成态取自项目聚合字段）
const hasEpisodes = computed(() => (project.value?.episodes?.length || 0) > 0);
const hasAssets = computed(() => (project.value?.asset_count || 0) > 0);
const hasVideo = computed(() => (project.value?.episodes || []).some((e) => ['video', 'done'].includes(e.status)));
const stepDone = computed(() => ({ 1: hasEpisodes.value, 2: hasAssets.value, 3: hasVideo.value }));

const STEP_CARDS = computed(() => [
  { key: '1', label: t('workspace.step.scriptOutline'), desc: t('mobile.ws.stepOutlineDesc'), icon: 'spark', url: (pid) => `/pages/workspace/outline?pid=${pid}` },
  { key: '2', label: t('workspace.step.assetLibrary'), desc: t('mobile.ws.stepAssetsDesc'), icon: 'drop', url: (pid) => `/pages/workspace/assets?pid=${pid}` },
  { key: '3', label: t('workspace.step.episodes'), desc: t('mobile.ws.stepEpisodesDesc'), icon: 'film', url: (pid) => `/pages/workspace/episodes?pid=${pid}` },
]);

async function loadProject() {
  if (!projectId.value) return;
  loading.value = true;
  try {
    project.value = await projectApi.get(projectId.value);
  } catch (err) {
    // 被移出项目 / 项目已删除：http 层已提示，回项目列表
    if (err?.status === 403 || err?.status === 404) uni.redirectTo({ url: '/pages/projects/index' });
  } finally {
    loading.value = false;
  }
}

// ===== 团队共享身份 =====
const amOwner = computed(() => isOwner(project.value));
const canSettings = computed(() => can(project.value, 'project.settings'));

// ===== 画面比例 =====
const aspects = computed(() => [
  { value: '9:16', label: t('workspace.aspect.vertical') },
  { value: '16:9', label: t('workspace.aspect.horizontal') },
  { value: '1:1', label: t('workspace.aspect.square') },
]);
const aspectShow = ref(false);
const aspectSaving = ref(false);
async function changeAspect(value) {
  aspectShow.value = false;
  if (!value || value === project.value?.aspect_ratio) return;
  aspectSaving.value = true;
  try {
    await projectApi.update(projectId.value, { aspect_ratio: value });
    toast(t('workspace.aspect.updated'), 'success');
    await loadProject();
  } catch {
    toast(t('workspace.aspect.updateFailed'), 'error');
  } finally {
    aspectSaving.value = false;
  }
}

// ===== 美术风格 =====
const artStyles = ref([]);
const styleNameMap = computed(() => {
  const m = {};
  artStyles.value.forEach((s) => { m[s.key] = s.name; });
  return m;
});
const styleDisplayName = computed(() => styleNameMap.value[project.value?.style] || project.value?.style || '');
const styleShow = ref(false);
const pendingStyle = ref('');
const pendingAspect = ref('');
async function loadStyles() {
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
}
function openStyleSheet() {
  pendingStyle.value = project.value?.style || '';
  pendingAspect.value = project.value?.aspect_ratio || '9:16';
  styleShow.value = true;
}
const styleSaving = ref(false);
async function applyStyle() {
  if (!pendingStyle.value || pendingStyle.value === project.value?.style) {
    styleShow.value = false;
    return;
  }
  styleSaving.value = true;
  try {
    await projectApi.update(projectId.value, { style: pendingStyle.value });
    styleShow.value = false;
    toast(t('workspace.style.updated'), 'success');
    await loadProject();
  } catch {
    toast(t('workspace.style.updateFailed'), 'error');
  } finally {
    styleSaving.value = false;
  }
}

// ===== 字幕设置 / 成员管理 =====
const subtitleShow = ref(false);
const memberShow = ref(false);
const hasCustomSubtitle = computed(() => {
  const sub = project.value?.settings?.subtitle;
  return !!(sub && Object.keys(sub).length);
});

function gotoStep(step) {
  uni.navigateTo({ url: step.url(projectId.value) });
}

onLoad((q) => {
  projectId.value = q?.pid || q?.id || null;
  // 兜底：深链/返回重建丢参时不再渲染死页，直接回项目列表（同下方 403/404 处理）
  if (!projectId.value) uni.redirectTo({ url: '/pages/projects/index' });
});
onShow(() => { loadProject(); loadStyles(); });
// 下拉刷新：重拉项目概览 + 风格列表
onPullDownRefresh(async () => {
  try { await Promise.all([loadProject(), loadStyles()]); } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="project?.name || t('workspace.title')" />

    <!-- 项目概要 + 设置 chips -->
    <view class="card wsh">
      <view class="wsh-top">
        <text class="wsh-name">{{ project?.name || '...' }}</text>
        <text v-if="project && !amOwner" class="chip gold sm">{{ t('team.shared') }}</text>
      </view>
      <view class="wsh-chips">
        <!-- 比例 -->
        <view v-if="project?.aspect_ratio && canSettings" class="chip glass sm" @tap="aspectShow = true">
          <text class="mono">{{ project.aspect_ratio }}</text>
          <text class="wsh-cue">✎</text>
        </view>
        <text v-else-if="project?.aspect_ratio" class="chip glass sm mono">{{ project.aspect_ratio }}</text>
        <!-- 风格 -->
        <view v-if="project?.style && canSettings" class="chip glass sm" @tap="openStyleSheet">
          <text>{{ styleDisplayName }}</text>
          <text class="wsh-cue">✎</text>
        </view>
        <text v-else-if="project?.style" class="chip glass sm">{{ styleDisplayName }}</text>
        <!-- 字幕 -->
        <view class="chip glass sm" @tap="canSettings && (subtitleShow = true)">
          <text>{{ t('project.subtitleSettings.chip') }}</text>
          <view v-if="hasCustomSubtitle" class="wsh-dot" />
          <text v-if="canSettings" class="wsh-cue">✎</text>
        </view>
        <!-- 成员管理（owner） -->
        <view v-if="amOwner" class="chip glass sm" @tap="memberShow = true">
          <m-icon name="user" :size="12" />
          <text>{{ t('team.members') }}</text>
        </view>
      </view>
      <!-- 创作进度概要 -->
      <view class="wsh-stats">
        <view class="wsh-stat"><text class="wsh-num mono">{{ project?.episodes?.length || 0 }}</text><text class="wsh-lab">{{ t('outline.episodesScript') }}</text></view>
        <view class="wsh-stat"><text class="wsh-num mono">{{ project?.asset_count || 0 }}</text><text class="wsh-lab">{{ t('workspace.step.assetLibrary') }}</text></view>
        <view class="wsh-stat"><text class="wsh-num mono">{{ (project?.episodes || []).filter((e) => ['video', 'done'].includes(e.status)).length }}</text><text class="wsh-lab">{{ t('mobile.ws.filmsCount') }}</text></view>
      </view>
    </view>

    <!-- 三步卡片 -->
    <view class="secttitle">{{ t('mobile.ws.flowTitle') }}</view>
    <view
      v-for="(s, i) in STEP_CARDS"
      :key="s.key"
      class="card wstep"
      :class="{ done: stepDone[s.key] }"
      @tap="gotoStep(s)"
    >
      <view class="wstep-ico" :class="{ gold: stepDone[s.key] }">
        <m-icon :name="s.icon" :size="20" :sw="1.9" />
      </view>
      <view class="wstep-main">
        <text class="wstep-lab">{{ i + 1 }}. {{ s.label }}</text>
        <text class="wstep-desc">{{ s.desc }}</text>
      </view>
      <view v-if="stepDone[s.key]" class="wstep-done"><m-icon name="check" :size="13" :sw="2.4" /></view>
      <text class="wstep-arr">▸</text>
    </view>

    <view style="height: 30px" />

    <!-- 比例切换弹层 -->
    <AdSheet v-model:show="aspectShow" :title="t('workspace.aspect.title')">
      <view class="aspgrid">
        <view
          v-for="a in aspects"
          :key="a.value"
          class="aspitem"
          :class="{ on: a.value === project?.aspect_ratio }"
          @tap="changeAspect(a.value)"
        >
          <view class="aspshape" :class="'a' + a.value.replace(':', '')" />
          <text class="asplab">{{ a.label }}</text>
          <text class="aspval mono">{{ a.value }}</text>
        </view>
      </view>
      <view v-if="aspectSaving" class="aspsaving"><text>{{ t('common.saving') }}</text></view>
    </AdSheet>

    <!-- 风格切换弹层 -->
    <AdSheet v-model:show="styleShow" :title="t('workspace.style.title')">
      <view class="stysheet">
        <text class="styhint">{{ t('workspace.style.hint') }}</text>
        <scroll-view scroll-y class="stylist">
          <ArtStylePicker v-model="pendingStyle" v-model:aspect="pendingAspect" :default-style="project?.style || 'realpeople_modern_city'" />
        </scroll-view>
        <view class="mbtn sm styapply" :class="{ dis: styleSaving }" @tap="applyStyle">{{ t('workspace.style.apply') }}</view>
      </view>
    </AdSheet>

    <!-- 字幕设置 / 成员管理 -->
    <SubtitleSettingsSheet
      v-model:show="subtitleShow"
      :project-id="projectId"
      :aspect-ratio="project?.aspect_ratio || '9:16'"
      :subtitle="project?.settings?.subtitle || null"
      @updated="loadProject"
    />
    <MemberManagerSheet v-model:show="memberShow" :project-id="projectId" @changed="loadProject" />
  <AdDialog />
  </view>
</template>

<style scoped>
.wsh { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.wsh-top { display: flex; align-items: center; gap: 8px; }
.wsh-name { font-family: var(--ad-serif); font-size: 19px; font-weight: 800; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsh-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.wsh-cue { font-size: 10px; opacity: 0.55; margin-left: 3px; }
.wsh-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ad-accent); }
.wsh-stats { display: flex; gap: 8px; }
.wsh-stat { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 4px; border: 1px solid var(--ad-line); border-radius: 11px; }
.wsh-num { font-size: 19px; font-weight: 800; color: var(--ad-brand); }
.wsh-lab { font-size: 10px; color: var(--ad-text-mut); }

.secttitle { font-family: var(--ad-serif); font-size: 15px; font-weight: 700; color: var(--ad-text); margin: 20px 4px 12px; }
.wstep { display: flex; align-items: center; gap: 12px; padding: 14px 14px; }
.wstep-ico {
  width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(224, 182, 78, 0.1); border: 1px solid rgba(224, 182, 78, 0.3);
  color: var(--ad-brand);
}
.wstep-ico.gold { background: linear-gradient(135deg, #f2d489, #e0b64e 45%, #b3871f); border-color: transparent; color: #0a0a0f; }
.wstep-main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wstep-lab { font-size: 15px; font-weight: 700; color: var(--ad-text); }
.wstep-desc { font-size: 11px; color: var(--ad-text-mut); }
.wstep-done { flex-shrink: 0; color: var(--ad-accent); }
.wstep-arr { color: var(--ad-text-mut); font-size: 13px; flex-shrink: 0; }

.aspgrid { display: flex; gap: 10px; padding: 4px 0 8px; }
.aspitem {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
  padding: 16px 6px 12px; border: 2px solid var(--ad-line); border-radius: 14px; background: var(--ad-inset);
}
.aspitem.on { border-color: var(--ad-accent); }
.aspshape { border: 2px solid var(--ad-text-mut); border-radius: 3px; }
.aspshape.a916 { width: 22px; height: 39px; }
.aspshape.a169 { width: 39px; height: 22px; }
.aspshape.a11 { width: 28px; height: 28px; }
.aspitem.on .aspshape { border-color: var(--ad-accent); }
.asplab { font-size: 13px; font-weight: 600; color: var(--ad-text); }
.aspval { font-size: 11px; color: var(--ad-text-mut); }
.aspsaving { text-align: center; font-size: 12px; color: var(--ad-text-mut); padding: 6px 0; }

.stysheet { display: flex; flex-direction: column; gap: 10px; }
.styhint { font-size: 12px; color: var(--ad-text-mut); }
.stylist { max-height: 56vh; }
.styapply { display: flex; align-items: center; justify-content: center; }
</style>
