<script setup>
/**
 * 资产库（client workspace/AssetLibrary.vue 移植，移动端单列）：
 * 5 类资产页签 + 搜索 + 分页 + 勾选批量；AI 提取 / 单个生图 / 润色提示词 / 批量生图
 * / 批量润色 / 自定义角色创建，全部走 useCostAction 统一「模型+价格」确认页。
 * 资产编辑（表单/音色/服饰）为独立页 pages/workspace/asset-edit（完整资产对象经
 * EventChannel 推送）；上传（主图 / 视频 / 参考图）走 uni.chooseImage/chooseVideo
 * + assetApi.uploadXxx(aid, filePath)。任务进度由 jobs store 轮询驱动。
 */
import { ref, computed, watch } from 'vue';
import { onLoad, onShow, onUnload, onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { assetApi, projectApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useJobsStore } from '../../stores/jobs';
import { useThemeStore } from '../../stores/theme';
import { can } from '../../utils/perms';
import { toAbsolute } from '../../utils/media';
import { formatDuration } from '../../utils/format';
import { toast, toastError, confirm, selectSheet } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import VideoPlayerPopup from '../../components/video-player-popup/video-player-popup.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const { runJob, runJobs } = useCostAction();
const jobs = useJobsStore();
const theme = useThemeStore();

let pid = null; // 项目 id（/pages/workspace/assets?pid=xxx，进入后不变）
const project = ref(null);
const assets = ref([]);
const episodes = ref([]);
const loading = ref(false);

// 团队共享权限：资产管理（手工 CRUD/上传/服饰/参考图）与 AI 生成（提取/生图/润色）
const canEditAsset = computed(() => can(project.value, 'asset.edit'));
const canGen = computed(() => can(project.value, 'ai.generate'));

const tabs = computed(() => [
  { key: 'character', label: t('asset.type.character') },
  { key: 'scene', label: t('asset.type.scene') },
  { key: 'prop', label: t('asset.type.prop') },
  { key: 'material', label: t('asset.type.material') },
  { key: 'video', label: t('asset.type.video') },
]);
const currentTabLabel = computed(() => {
  const hit = tabs.value.find((x) => x.key === activeTab.value);
  return hit?.label || t('asset.type.default');
});

const activeTab = ref('character');

// 任务驱动的 busy 状态（轮询自动更新）
const extractJob = computed(() => (pid ? jobs.activeOf('asset_extract', Number(pid)) : null));
const isGenerating = (a) => !!jobs.activeOf('asset_image', a.id);
const isBusyPrompt = (a) => !!jobs.activeOf('asset_prompt', a.id);

const counts = computed(() => {
  const m = { character: 0, scene: 0, prop: 0, material: 0, video: 0 };
  assets.value.forEach((a) => { m[a.kind] = (m[a.kind] || 0) + 1; });
  return m;
});

// 搜索（名称/别名/描述，大小写不敏感）+ 按 id 倒序
const keyword = ref('');
const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return assets.value
    .filter((a) => a.kind === activeTab.value)
    .filter((a) => {
      if (!kw) return true;
      if (String(a.name || '').toLowerCase().includes(kw)) return true;
      if (Array.isArray(a.aliases) && a.aliases.some((al) => String(al || '').toLowerCase().includes(kw))) return true;
      return String(a.description || '').toLowerCase().includes(kw);
    })
    .sort((a, b) => b.id - a.id);
});

// 分页（展示层切片；勾选与批量操作仍基于整个 tab 的 list）
const pageSize = 8;
const page = ref(1);
const total = computed(() => list.value.length);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const pagedList = computed(() => {
  const start = (page.value - 1) * pageSize;
  return list.value.slice(start, start + pageSize);
});

// 勾选（按 id 维护，仅作用于当前 tab）
const selectedIds = ref(new Set());
const isSelected = (a) => selectedIds.value.has(a.id);
function toggleSelect(a, val) {
  const next = new Set(selectedIds.value);
  val ? next.add(a.id) : next.delete(a.id);
  selectedIds.value = next;
}
const tabSelectedCount = computed(() => list.value.filter((a) => isSelected(a)).length);
const pageSelectedCount = computed(() => pagedList.value.filter((a) => isSelected(a)).length);
// 全选作用于「当前页」；批量润色提示词仍汇总整个 tab 的勾选项
const allSelected = computed(() => pagedList.value.length > 0 && pagedList.value.every((a) => isSelected(a)));
function toggleAll(val) {
  const next = new Set(selectedIds.value);
  pagedList.value.forEach((a) => (val ? next.add(a.id) : next.delete(a.id)));
  selectedIds.value = next;
}

// 当前页未生成图片的资产
const ungeneratedList = computed(() => pagedList.value.filter((a) => a.status !== 'done' && !isGenerating(a)));
const ungeneratedSelectedCount = computed(() => ungeneratedList.value.filter((a) => isSelected(a)).length);
const allUngeneratedSelected = computed(() => ungeneratedList.value.length > 0 && ungeneratedList.value.every((a) => isSelected(a)));
function toggleUngenerated(val) {
  const next = new Set(selectedIds.value);
  ungeneratedList.value.forEach((a) => (val ? next.add(a.id) : next.delete(a.id)));
  selectedIds.value = next;
}

const imgSrc = (a) => toAbsolute(a.thumb_url || a.image_url || '');
const refOf = (a) => a?.meta?.referenceImage || '';
const refAbs = (u) => toAbsolute(u || '');
const durationText = (a) => {
  const d = Number(a.meta?.duration);
  if (!Number.isFinite(d) || d <= 0) return '';
  return formatDuration(d);
};

// 图片预览（同 tab 有图资产连成一组，左右滑动查看；预览用原图非缩略图）
const fullSrc = (a) => toAbsolute(a.image_url || '');
function previewImage(a) {
  if (!a.image_url) return;
  const urls = list.value.filter((x) => x.image_url).map((x) => fullSrc(x));
  const i = urls.indexOf(fullSrc(a));
  uni.previewImage({ urls, current: i > -1 ? i : 0 });
}
async function load() {
  loading.value = true;
  try {
    // 资产列表与项目详情分开兜底：详情挂了（如接口异常）只提示，不再拖垮整个资产页
    const [rows, p] = await Promise.all([
      assetApi.list(pid),
      projectApi.get(pid).catch((e) => { toastError(e); return null; }),
    ]);
    assets.value = rows;
    if (p) {
      project.value = p;
      episodes.value = p.episodes || [];
    }
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

// ============ AI 提取（先选分集，再针对该集提取，已存在略过） ============
const extractShow = ref(false);
const extractEpisodeId = ref(null);
const episodeNames = computed(() => episodes.value.map((ep) => t('asset.episodeLabel', { idx: ep.idx, title: ep.title })));
const episodeIndex = computed(() => Math.max(0, episodes.value.findIndex((ep) => ep.id === extractEpisodeId.value)));
function openExtract() {
  if (!episodes.value.length) { toast(t('asset.noEpisode'), 'error'); return; }
  extractEpisodeId.value = episodes.value[0].id;
  extractShow.value = true;
}
// 分集下拉（selectSheet 底部选择面板，弃用原生 picker）；extractEpOpen 驱动箭头朝向（关=向下，开=向上）
const extractEpOpen = ref(false);
async function pickExtractEpisode() {
  extractEpOpen.value = true;
  try {
    const k = await selectSheet({
      title: t('asset.extract.dialogTitle'),
      items: episodes.value.map((ep) => ({ key: String(ep.id), label: t('asset.episodeLabel', { idx: ep.idx, title: ep.title }) })),
      current: extractEpisodeId.value != null ? String(extractEpisodeId.value) : '',
    });
    if (k !== null) extractEpisodeId.value = Number(k) || null;
  } finally {
    extractEpOpen.value = false;
  }
}
async function doExtract() {
  const eid = extractEpisodeId.value;
  if (!eid) { toast(t('asset.pleaseSelectEpisode'), 'error'); return; }
  extractShow.value = false;
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => assetApi.extractEpisodeEstimate(pid, eid, sel),
    createFor: (sel) => assetApi.extractEpisode(pid, eid, sel),
    title: t('asset.extract.title'), desc: t('asset.extract.desc'), confirmText: t('asset.extract.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') load(); },
  });
}

// ============ 单个生图（异步任务；确认页内可管理参考图） ============
async function genImage(asset) {
  await runJob({
    modelType: 'image',
    hideResolution: true, // 生图接口只消费 modelConfigId，分辨率档位不参与估价/生成，不展示
    estimateFor: (sel) => assetApi.genImageEstimate(asset.id, sel),
    createFor: (sel) => assetApi.genImage(asset.id, sel),
    title: t('asset.genImage.title'), desc: t('asset.genImage.desc', { name: asset.name }), confirmText: t('asset.gen.confirm'),
    // 参考图（图生图）：确认页内展示/添加/移除，回调负责持久化并同步卡片
    allowReferenceImage: true,
    referenceImage: refOf(asset),
    uploadReferenceImage: async (filePath) => {
      const updated = await assetApi.uploadReferenceImage(asset.id, filePath);
      patchAsset(updated);
      return refOf(updated);
    },
    removeReferenceImage: async () => {
      const updated = await assetApi.update(asset.id, { reference_image: null });
      patchAsset(updated);
      return '';
    },
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.asset) {
        const i = assets.value.findIndex((x) => x.id === asset.id);
        if (i > -1) assets.value[i] = j.result.asset;
      }
    },
  });
}

// ============ 单个 AI 润色提示词（异步任务） ============
async function genPrompt(asset) {
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => assetApi.genPromptEstimate(asset.id, sel),
    createFor: (sel) => assetApi.genPrompt(asset.id, sel),
    allowRequirement: true,
    title: t('asset.genPrompt.title'), desc: t('asset.genPrompt.desc', { name: asset.name }), confirmText: t('asset.gen.confirm'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.asset) {
        const i = assets.value.findIndex((x) => x.id === asset.id);
        if (i > -1) assets.value[i] = j.result.asset;
      }
    },
  });
}

// ============ 批量（共享一次模型选择 + 汇总扣费确认，任务依次提交） ============
// 有勾选则只生成勾选项（允许对已生成的重生成），否则生成整个 tab 的未生成；均排除生成中的
const batchImageTargets = computed(() => {
  if (tabSelectedCount.value) return list.value.filter((a) => isSelected(a) && !isGenerating(a));
  return list.value.filter((a) => a.status !== 'done' && !isGenerating(a));
});

async function genAllCurrent() {
  const targets = batchImageTargets.value;
  if (!targets.length) { toast(t('asset.noMoreToGenerate'), 'error'); return; }
  await runJobs({
    modelType: 'image',
    hideResolution: true, // 同 genImage：生图接口不消费分辨率档位
    items: targets.map((a) => ({
      estimateFor: (sel) => assetApi.genImageEstimate(a.id, sel),
      createFor: (sel) => assetApi.genImage(a.id, sel),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.asset) {
          const i = assets.value.findIndex((x) => x.id === a.id);
          if (i > -1) assets.value[i] = j.result.asset;
        }
      },
    })),
    title: t('asset.batchGenImage.title'), desc: t('asset.batchGenImage.desc', { count: targets.length }), confirmText: t('asset.batchGen.confirm'),
  });
}

async function genPromptSelected() {
  const targets = list.value.filter((a) => isSelected(a) && !isBusyPrompt(a));
  if (!targets.length) { toast(t('asset.pleaseSelectForPrompt'), 'error'); return; }
  await runJobs({
    modelType: 'text',
    items: targets.map((a) => ({
      estimateFor: (sel) => assetApi.genPromptEstimate(a.id, sel),
      createFor: (sel) => assetApi.genPrompt(a.id, sel),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.asset) {
          const i = assets.value.findIndex((x) => x.id === a.id);
          if (i > -1) assets.value[i] = j.result.asset;
        }
      },
    })),
    title: t('asset.batchGenPrompt.title'), desc: t('asset.batchGenPrompt.desc', { count: targets.length }), confirmText: t('asset.batchGen.confirm'), allowRequirement: true,
  });
}

// ============ 参考图管理（图生图蓝本） ============
const refEditing = ref(null);
const refShow = ref(false);
const refUrlInput = ref('');
const refUploading = ref(false);
function openRefDialog(a) {
  refEditing.value = a;
  refUrlInput.value = '';
  refShow.value = true;
}
function patchAsset(updated) {
  const i = assets.value.findIndex((x) => x.id === updated.id);
  if (i > -1) assets.value[i] = { ...assets.value[i], ...updated }; // 合并保留 costume_count 等列表附加字段
  if (refEditing.value && refEditing.value.id === updated.id) refEditing.value = { ...refEditing.value, ...updated };
}
function pickRefImage() {
  if (!refEditing.value) return;
  uni.chooseImage({
    count: 1,
    success: async (res) => {
      const f = (res.tempFiles && res.tempFiles[0]) || {};
      if (f.size && f.size / 1024 / 1024 >= 10) { toast(t('asset.upload.tooLarge'), 'error'); return; }
      refUploading.value = true;
      try {
        const updated = await assetApi.uploadReferenceImage(refEditing.value.id, res.tempFilePaths[0]);
        patchAsset(updated);
        refUrlInput.value = '';
        toast(t('asset.ref.uploaded'), 'success');
      } catch { /* http 层已提示 */ } finally { refUploading.value = false; }
    },
  });
}
async function applyRefUrl() {
  if (!refEditing.value) return;
  const url = refUrlInput.value.trim();
  if (!url) return;
  try {
    const updated = await assetApi.update(refEditing.value.id, { reference_image: url });
    patchAsset(updated);
    toast(t('asset.ref.set'), 'success');
  } catch { /* http 层已提示 */ }
}
async function removeRef() {
  if (!refEditing.value) return;
  try {
    const updated = await assetApi.update(refEditing.value.id, { reference_image: null });
    patchAsset(updated);
    refUrlInput.value = '';
    toast(t('asset.ref.removed'), 'success');
  } catch { /* http 层已提示 */ }
}

// ============ 上传主图 / 视频（不经过 AI，直接用作资产图片/视频素材） ============
const imgUploadingId = ref(null);
const vidUploadingId = ref(null);
function pickImageFor(a) {
  if (!canEditAsset.value) return;
  uni.chooseImage({
    count: 1,
    success: async (res) => {
      const f = (res.tempFiles && res.tempFiles[0]) || {};
      if (f.size && f.size / 1024 / 1024 >= 10) { toast(t('asset.upload.tooLarge'), 'error'); return; }
      imgUploadingId.value = a.id;
      try {
        const updated = await assetApi.uploadImage(a.id, res.tempFilePaths[0]);
        patchAsset(updated);
        toast(t('asset.image.uploaded'), 'success');
      } catch { /* http 层已提示 */ } finally { imgUploadingId.value = null; }
    },
  });
}
function pickVideoFor(a) {
  if (!canEditAsset.value) return;
  uni.chooseVideo({
    success: async (res) => {
      const size = Number(res.size || (res.tempFile && res.tempFile.size) || 0);
      if (size && size / 1024 / 1024 >= 200) { toast(t('asset.upload.videoTooLarge'), 'error'); return; }
      const filePath = res.tempFilePath;
      if (!filePath) return;
      vidUploadingId.value = a.id;
      try {
        const updated = await assetApi.uploadVideo(a.id, filePath);
        patchAsset(updated);
        toast(t('asset.video.uploaded'), 'success');
      } catch { /* http 层已提示 */ } finally { vidUploadingId.value = null; }
    },
  });
}

// ============ 视频转图片关键帧（素材 tab 专属：同步均匀抽帧，视频用完即删） ============
const kfShow = ref(false);
const kfFile = ref(null); // { path, name }
const kfName = ref('');
const kfCount = ref(6);
const kfSubmitting = ref(false);
function openKeyframesDialog() {
  kfFile.value = null;
  kfName.value = '';
  kfCount.value = 6;
  kfSubmitting.value = false;
  kfShow.value = true;
}
function pickKfVideo() {
  uni.chooseVideo({
    success: (res) => {
      const size = Number(res.size || (res.tempFile && res.tempFile.size) || 0);
      if (size && size / 1024 / 1024 >= 200) { toast(t('asset.upload.videoTooLarge'), 'error'); return; }
      if (!res.tempFilePath) return;
      const name = res.name || (res.tempFile && res.tempFile.name) || 'video.mp4';
      kfFile.value = { path: res.tempFilePath, name };
    },
  });
}
async function submitKeyframes() {
  if (!kfFile.value) { toast(t('asset.keyframes.noVideo'), 'error'); return; }
  const name = kfName.value.trim();
  if (!name) { toast(t('asset.keyframes.nameRequired'), 'error'); return; }
  kfSubmitting.value = true;
  try {
    const rows = await assetApi.createKeyframes(pid, { filePath: kfFile.value.path, name, count: kfCount.value });
    assets.value.push(...rows);
    activeTab.value = 'material'; // 产物固定为素材类型：切到素材页签直观确认（watch 会重置页码）
    kfShow.value = false;
    toast(t('asset.keyframes.created', { count: rows.length }), 'success');
  } catch { /* http 层已提示 */ } finally { kfSubmitting.value = false; }
}

// ============ 视频预览（卡片封面/播放角标 → 全屏弹层） ============
const playerShow = ref(false);
const playerUrl = ref('');
const playerTitle = ref('');
function openVideoPreview(a) {
  const url = a.meta?.videoUrl;
  if (!url) return;
  playerUrl.value = toAbsolute(url);
  playerTitle.value = a.name;
  playerShow.value = true;
}

// ============ 编辑资产：独立页（pages/workspace/asset-edit），完整资产对象经 EventChannel 推送 ============
function startEdit(a) {
  uni.navigateTo({
    url: `/pages/workspace/asset-edit?pid=${pid}&aid=${a.id}`,
    success: (res) => res.eventChannel.emit('asset', a),
  });
}
async function removeAsset(a) {
  const ok = await confirm({ title: t('common.tip'), content: t('asset.delete.confirm', { name: a.name }), confirmText: t('common.delete') });
  if (!ok) return;
  try {
    await assetApi.remove(a.id);
    assets.value = assets.value.filter((x) => x.id !== a.id);
    toast(t('common.deleteSuccess'), 'success');
  } catch { /* http 层已提示 */ }
}
// 新建资产：跳独立编辑页（不再预建占位资产，编辑页保存时才真正 create）
function createAsset() {
  uni.navigateTo({ url: `/pages/workspace/asset-edit?pid=${pid}&kind=${activeTab.value}` });
}

// ============ 音色选择（仅角色）：迁至 pages/workspace/asset-edit ============

// ============ 自定义角色创建：独立页（pages/workspace/char-create），任务建立后回列表 ============
function openCreator() {
  uni.navigateTo({ url: `/pages/workspace/char-create?pid=${pid}` });
}

// ============ 状态角标 / 空态 / 下一步 ============
function statusInfo(a) {
  if (isGenerating(a)) return { text: t('asset.status.generating'), cls: 'warn' };
  switch (a.status) {
    case 'generating': return { text: t('asset.status.generating'), cls: 'warn' };
    case 'queued': return { text: t('asset.status.queued'), cls: '' };
    case 'failed': return { text: t('asset.status.failed'), cls: 'bad' };
    case 'done': return { text: t('asset.status.done'), cls: 'ok' };
    default: return { text: a.status, cls: '' };
  }
}

// 空状态主按钮：视频 tab 走「创建资产」（asset.edit），其余走「AI 提取」（ai.generate）
const emptyActionLabel = computed(() => {
  if (activeTab.value === 'video') return canEditAsset.value ? `${t('common.create')}${currentTabLabel.value}` : '';
  return canGen.value ? t('asset.extract.button') : '';
});
function onEmptyAction() {
  if (activeTab.value === 'video') createAsset();
  else openExtract();
}

// 下一步 → 分集视频（无分集时提示先去剧本大纲）
function goNext() {
  if (!episodes.value.length) { toast(t('asset.noEpisode'), 'error'); return; }
  uni.navigateTo({ url: `/pages/workspace/episodes?pid=${pid}` });
}

// 切换分类回到第一页；资产增删导致页数减少时收回越界页码
watch(activeTab, () => { page.value = 1; });
watch(keyword, () => { page.value = 1; });
watch(pageCount, () => { if (page.value > pageCount.value) page.value = pageCount.value; });

onLoad((q) => {
  pid = (q && (q.pid || q.id)) || null;
  // 深链预选资产类型页签（任务中心资产生图「查看结果」按 result.asset.kind 跳入）
  const kind = q && q.kind;
  if (kind && tabs.value.some((tb) => tb.key === kind)) activeTab.value = kind;
  load();
  // 自定义角色页（char-create）/ 资产编辑页（asset-edit）保存后广播 → 重拉列表
  uni.$on('assets:reload', load);
});
onUnload(() => { uni.$off('assets:reload', load); });
onShow(() => { jobs.fetchAll(); });
// 下拉刷新：重拉资产库 + 任务状态
onPullDownRefresh(async () => {
  try {
    jobs.fetchAll();
    await load();
  } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page as-page" :class="theme.rootCls">
    <AdNavbar :title="t('workspace.step.assetLibrary')">
      <template #right>
        <view v-if="canEditAsset" class="chip glass" @tap="createAsset">
          <m-icon name="plus" :size="13" :sw="2" />
          <text>{{ t('common.create') }}</text>
        </view>
      </template>
    </AdNavbar>

    <!-- 分类页签（含数量，换行平铺不横滚） -->
    <view class="as-tabs">
      <view class="as-tabs-in">
        <view v-for="tb in tabs" :key="tb.key" class="pchip" :class="{ on: activeTab === tb.key }" @tap="activeTab = tb.key">
          <text>{{ tb.label }}</text>
          <text class="as-tab-cnt mono">{{ counts[tb.key] || 0 }}</text>
        </view>
      </view>
    </view>

    <!-- 搜索 -->
    <view class="search as-search">
      <m-icon name="search" :size="15" />
      <input v-model="keyword" :placeholder="t('asset.search.placeholder')" placeholder-class="ad-ph" confirm-type="search" />
    </view>

    <!-- 动作条（每行 3 个，网格排布不横滚） -->
    <view class="as-acts">
      <view class="as-acts-in">
        <view v-if="canGen" class="pchip" :class="{ dim: !tabSelectedCount }" @tap="genPromptSelected">
          <m-icon name="spark" :size="13" />
          <text>{{ t('asset.batchGenPrompt.button') }}</text>
          <text v-if="tabSelectedCount" class="as-act-n">({{ tabSelectedCount }})</text>
        </view>
        <!-- 视频资产封面由视频首帧生成，无生图概念；AI 提取也不产出视频 -->
        <view v-if="activeTab !== 'video' && canGen" class="pchip" @tap="genAllCurrent">
          <m-icon name="remake" :size="13" />
          <text>{{ t('asset.batchGenImage.button') }}</text>
          <text v-if="batchImageTargets.length" class="as-act-n">({{ batchImageTargets.length }})</text>
        </view>
        <!-- 视频转关键帧：产物固定进「素材」页签，入口仅在该页签展示 -->
        <view v-if="activeTab === 'material' && canEditAsset" class="pchip" @tap="openKeyframesDialog">
          <m-icon name="film" :size="13" />
          <text>{{ t('asset.keyframes.button') }}</text>
        </view>
        <view v-if="activeTab === 'character' && canGen" class="pchip" @tap="openCreator">
          <m-icon name="user" :size="13" />
          <text>{{ t('charCreator.button') }}</text>
        </view>
        <view v-if="activeTab !== 'video' && canGen" class="pchip on" @tap="openExtract">
          <m-icon name="spark" :size="13" />
          <text>{{ t('asset.extract.button') }}</text>
        </view>
      </view>
    </view>

    <!-- 提取进度 -->
    <view v-if="extractJob" class="card as-job">
      <view class="as-job-head">
        <view class="pulse" />
        <text class="as-job-title">{{ extractJob.stage || t('asset.job.queued') }}</text>
        <text class="as-job-pct mono">{{ extractJob.progress || 0 }}%</text>
      </view>
      <view class="as-job-bar"><view class="as-job-bar-in" :style="{ width: (extractJob.progress || 0) + '%' }" /></view>
    </view>

    <!-- 选择条：全选（当前页）/ 全选未生成 -->
    <view v-if="list.length" class="as-selbar">
      <view class="pchip" :class="{ on: allSelected }" @tap="toggleAll(!allSelected)">
        <view class="ck" :class="{ on: allSelected }">
          <m-icon v-if="allSelected" name="check" :size="11" color="#1d1503" :sw="3" />
        </view>
        <text>{{ t('asset.selectAll') }} {{ pageSelectedCount }}/{{ pagedList.length }}</text>
      </view>
      <view v-if="activeTab !== 'video' && ungeneratedList.length" class="pchip" :class="{ on: allUngeneratedSelected }" @tap="toggleUngenerated(!allUngeneratedSelected)">
        <view class="ck" :class="{ on: allUngeneratedSelected }">
          <m-icon v-if="allUngeneratedSelected" name="check" :size="11" color="#1d1503" :sw="3" />
        </view>
        <text>{{ t('asset.selectAllUngenerated') }} {{ ungeneratedSelectedCount }}/{{ ungeneratedList.length }}</text>
      </view>
    </view>

    <!-- 加载中 -->
    <view v-if="loading && !assets.length" class="as-loading"><text>{{ t('common.loading') }}</text></view>

    <!-- 资产列表（当前页） -->
    <view class="as-list">
      <view v-for="a in pagedList" :key="a.id" class="card as-card">
        <!-- 缩略图区 -->
        <view class="as-thumb">
          <template v-if="a.kind === 'video'">
            <template v-if="a.meta && a.meta.videoUrl">
              <image v-if="a.image_url" :src="imgSrc(a)" mode="aspectFill" class="as-thumb-img" @tap="openVideoPreview(a)" />
              <view v-else class="as-thumb-empty" @tap="openVideoPreview(a)"><m-icon name="video" :size="26" /></view>
              <view class="as-play" @tap.stop="openVideoPreview(a)"><m-icon name="play" :size="20" color="#fff" /></view>
              <text v-if="durationText(a)" class="as-dur mono">{{ durationText(a) }}</text>
              <view v-if="canEditAsset" class="as-swap" @tap.stop="pickVideoFor(a)">
                <m-icon v-if="vidUploadingId === a.id" name="clock" :size="12" color="#fff" />
                <m-icon v-else name="upload" :size="12" color="#fff" />
              </view>
            </template>
            <view v-else-if="canEditAsset" class="as-upzone" @tap="pickVideoFor(a)">
              <m-icon name="video" :size="22" />
              <text class="as-upzone-t">{{ vidUploadingId === a.id ? t('asset.uploading') : t('asset.uploadVideo') }}</text>
            </view>
            <view v-else class="as-thumb-empty"><m-icon name="video" :size="26" /></view>
          </template>
          <template v-else>
            <image v-if="a.image_url" :src="imgSrc(a)" mode="aspectFill" class="as-thumb-img" @tap="previewImage(a)" />
            <view v-else-if="!isGenerating(a) && canEditAsset" class="as-upzone" @tap="pickImageFor(a)">
              <m-icon name="upload" :size="22" />
              <text class="as-upzone-t">{{ imgUploadingId === a.id ? t('asset.uploading') : t('asset.uploadImage') }}</text>
            </view>
            <view v-else-if="isGenerating(a)" class="as-thumb-empty"><view class="pulse" /></view>
            <view v-else class="as-thumb-empty"><m-icon name="remake" :size="24" /></view>
            <view v-if="a.image_url && canEditAsset" class="as-swap" @tap.stop="pickImageFor(a)">
              <m-icon v-if="imgUploadingId === a.id" name="clock" :size="12" color="#fff" />
              <m-icon v-else name="upload" :size="12" color="#fff" />
            </view>
          </template>
          <text v-if="a.kind === 'character' && a.role_tag" class="as-role">{{ a.role_tag }}</text>
          <view v-if="a.kind !== 'video' && canEditAsset" class="as-ref" :class="{ set: !!refOf(a) }" @tap.stop="openRefDialog(a)">
            <image v-if="refOf(a)" :src="refAbs(refOf(a))" mode="aspectFill" class="as-ref-img" />
            <m-icon v-else name="plus" :size="13" color="#fff" :sw="2" />
          </view>
        </view>

        <!-- 信息区 -->
        <view class="as-info">
          <view class="as-info-top">
            <view class="ckhit" @tap="toggleSelect(a, !isSelected(a))">
              <view class="ck" :class="{ on: isSelected(a) }">
                <m-icon v-if="isSelected(a)" name="check" :size="11" color="#1d1503" :sw="3" />
              </view>
            </view>
            <text class="as-name">{{ a.name }}</text>
            <text v-if="a.kind === 'character'" class="as-ccnt">{{ t('asset.costumeCount', { n: a.costume_count || 0 }) }}</text>
            <text class="chip as-status" :class="statusInfo(a).cls">{{ statusInfo(a).text }}</text>
          </view>
          <text class="as-desc">{{ a.description || t('asset.noDesc') }}</text>
        </view>

        <!-- 操作区 -->
        <view class="as-ops">
          <view v-if="canGen" class="op soft" :class="{ dis: isBusyPrompt(a) }" @tap="!isBusyPrompt(a) && genPrompt(a)">
            <m-icon name="spark" :size="13" />
            <text>{{ isBusyPrompt(a) ? t('asset.status.generating') : (a.prompt ? t('asset.regeneratePrompt') : t('asset.generatePrompt')) }}</text>
          </view>
          <view v-if="a.kind !== 'video' && canGen" class="op soft" :class="{ dis: isGenerating(a) }" @tap="!isGenerating(a) && genImage(a)">
            <m-icon name="remake" :size="13" />
            <text>{{ isGenerating(a) ? t('asset.status.generating') : (a.image_url ? t('asset.regenerateImage') : t('asset.generateImage')) }}</text>
          </view>
        </view>
        <view class="as-ops">
          <view v-if="canEditAsset" class="op ghost" @tap="startEdit(a)">
            <m-icon name="set" :size="13" />
            <text>{{ t('common.edit') }}</text>
          </view>
          <view v-if="canEditAsset" class="op ghost danger" @tap="removeAsset(a)">
            <m-icon name="trash" :size="13" />
            <text>{{ t('common.delete') }}</text>
          </view>
        </view>
      </view>

      <!-- 新建卡片（仅在最后一页展示） -->
      <view v-if="!loading && page >= pageCount && canEditAsset" class="card as-new" @tap="createAsset">
        <m-icon name="plus" :size="26" :sw="2" />
        <text class="as-new-t">{{ t('asset.goCreate') }}</text>
        <text class="as-new-s">{{ t('common.create') }}{{ currentTabLabel }}</text>
      </view>

      <!-- 空态 -->
      <view v-if="!loading && !list.length && keyword.trim()" class="card ad-empty as-empty">
        <text class="as-empty-ic">🔍</text>
        <text class="as-empty-t">{{ t('asset.search.noResult') }}</text>
        <text class="as-empty-d">{{ t('asset.search.noResultDesc', { kw: keyword.trim() }) }}</text>
      </view>
      <view v-else-if="!loading && !list.length" class="card ad-empty as-empty">
        <text class="as-empty-ic">🎭</text>
        <text class="as-empty-t">{{ t('asset.empty.title', { type: currentTabLabel }) }}</text>
        <text class="as-empty-d">{{ t('asset.empty.desc') }}</text>
        <view v-if="emptyActionLabel" class="mbtn sm as-empty-btn" @tap="onEmptyAction">{{ emptyActionLabel }}</view>
      </view>
    </view>

    <!-- 分页 -->
    <view v-if="list.length && pageCount > 1" class="as-pager">
      <view class="pchip" :class="{ dim: page <= 1 }" @tap="page > 1 && (page -= 1)">
        <m-icon name="left" :size="13" />
      </view>
      <text class="as-pager-num mono">{{ page }} / {{ pageCount }}</text>
      <view class="pchip" :class="{ dim: page >= pageCount }" @tap="page < pageCount && (page += 1)">
        <m-icon name="right" :size="13" />
      </view>
    </view>

    <!-- 底部提示 + 下一步 -->
    <view class="card as-tipbar">
      <text class="as-tip-text">{{ t('asset.tip.applyToSeries') }}</text>
      <view class="mbtn as-tip-next" @tap="goNext">
        <text>{{ t('asset.next') }}</text>
        <m-icon name="right" :size="14" :sw="2" />
      </view>
    </view>

    <!-- 参考图弹层 -->
    <AdSheet v-model:show="refShow" :title="t('asset.ref.dialogTitle', { name: refEditing ? refEditing.name : '' })">
      <view v-if="refEditing" class="as-refbody">
        <text class="as-reftip">{{ t('asset.ref.tip') }}</text>
        <view class="as-refprev">
          <!-- 不用 <image>：uni-h5 的 image 组件在异步换图后偶发不刷新背景（onload 回调不触发重渲染），改 view+内联背景，各端一致 -->
          <view
            v-if="refOf(refEditing)"
            class="as-refprev-img"
            :style="{ backgroundImage: `url('${refAbs(refOf(refEditing))}')`, backgroundSize: 'cover', backgroundPosition: 'center' }"
          />
          <view v-else class="as-refprev-empty">
            <m-icon name="remake" :size="24" />
            <text>{{ t('asset.ref.notSet') }}</text>
          </view>
        </view>
        <view class="mbtn soft" :class="{ dis: refUploading }" @tap="!refUploading && pickRefImage()">
          <m-icon name="upload" :size="14" />
          <text>{{ t('asset.uploadImage') }}</text>
        </view>
        <text class="as-refsep">{{ t('asset.ref.pasteOr') }}</text>
        <view class="as-inline">
          <input v-model="refUrlInput" class="ad-input as-inline-in" :maxlength="500" :placeholder="t('asset.ref.urlPlaceholder')" placeholder-class="ad-ph" />
          <view class="mbtn soft sm as-inline-btn" :class="{ dis: !refUrlInput.trim() }" @tap="applyRefUrl">{{ t('asset.ref.useUrl') }}</view>
        </view>
        <view v-if="refOf(refEditing)" class="mbtn danger sm as-refrm" @tap="removeRef">{{ t('asset.ref.remove') }}</view>
        <view class="mbtn as-refdone" @tap="refShow = false">{{ t('asset.done') }}</view>
      </view>
    </AdSheet>

    <!-- 选择分集提取资产 -->
    <AdSheet v-model:show="extractShow" :title="t('asset.extract.dialogTitle')">
      <view class="as-extract">
        <text class="as-sub">{{ t('asset.extract.dialogDesc') }}</text>
        <view class="as-picker" @tap="pickExtractEpisode">
          <text class="as-picker-val">{{ episodeNames[episodeIndex] || t('asset.extract.episodePlaceholder') }}</text>
          <m-icon :name="extractEpOpen ? 'up' : 'down'" :size="15" />
        </view>
        <view class="as-sheet-foot">
          <view class="mbtn ghost" @tap="extractShow = false">{{ t('common.cancel') }}</view>
          <view class="mbtn" :class="{ dis: !extractEpisodeId }" @tap="doExtract">{{ t('asset.next') }}</view>
        </view>
      </view>
    </AdSheet>

    <!-- 视频转图片关键帧 -->
    <AdSheet v-model:show="kfShow" :title="t('asset.keyframes.title')">
      <view class="as-kf">
        <text class="as-sub">{{ t('asset.keyframes.desc') }}</text>
        <view class="ad-field">
          <view class="as-fl">{{ t('asset.keyframes.videoLabel') }}</view>
          <view class="mbtn ghost as-kf-pick" @tap="pickKfVideo">
            <m-icon name="film" :size="14" />
            <text class="as-kf-name">{{ kfFile ? kfFile.name : t('asset.keyframes.pickVideo') }}</text>
          </view>
        </view>
        <view class="ad-field">
          <view class="as-fl">{{ t('asset.keyframes.name') }}</view>
          <input v-model="kfName" class="ad-input" :maxlength="128" :placeholder="t('asset.keyframes.namePlaceholder')" placeholder-class="ad-ph" />
        </view>
        <view class="ad-field">
          <view class="as-fl">{{ t('asset.keyframes.count') }}</view>
          <view class="as-stepper">
            <view class="as-step-btn" @tap="kfCount = Math.max(1, kfCount - 1)"><text>−</text></view>
            <text class="as-step-val mono">{{ kfCount }}</text>
            <view class="as-step-btn" @tap="kfCount = Math.min(50, kfCount + 1)"><text>+</text></view>
          </view>
        </view>
        <view class="as-sheet-foot">
          <view class="mbtn ghost" :class="{ dis: kfSubmitting }" @tap="kfShow = false">{{ t('common.cancel') }}</view>
          <view class="mbtn" :class="{ dis: kfSubmitting || !kfFile || !kfName.trim() }" @tap="submitKeyframes">{{ t('asset.keyframes.submit') }}</view>
        </view>
      </view>
    </AdSheet>


    <!-- 统一「模型+价格」确认页（本页挂一份） + 全屏视频播放弹层 -->
    <GenConfirmSheet />
    <VideoPlayerPopup v-model:show="playerShow" :url="playerUrl" :title="playerTitle" :aspect="project?.aspect_ratio || ''" />
  <AdDialog />
  </view>
</template>

<style scoped>
.as-page { padding-bottom: 40px; }
.as-sub { font-size: 12px; line-height: 1.7; color: var(--ad-text-mut); }
.as-loading { padding: 40px 0; text-align: center; font-size: 13px; color: var(--ad-text-mut); }

/* 分类页签（换行平铺，禁止横向滚动） */
.as-tabs { padding: 0 0 12px; }
.as-tabs-in { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px; }
.as-tab-cnt { margin-left: 5px; font-size: 10.5px; opacity: 0.7; }
.as-search { margin-bottom: 12px; color: var(--ad-text-mut); }

/* 动作条（每行 3 个的网格，禁止横向滚动） */
.as-acts { padding: 0 0 14px; }
.as-acts-in { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 0 18px; }
.as-acts .pchip { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; min-width: 0; }
.as-acts .pchip text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-acts .pchip.dim { opacity: 0.4; }
.as-act-n { font-size: 10.5px; opacity: 0.8; }

/* 提取进度 */
.as-job { padding: 13px 15px; }
.as-job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.as-job-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 700; color: var(--ad-text); }
.as-job-pct { font-size: 11px; color: var(--ad-brand); }
.as-job-bar { height: 4px; border-radius: 3px; background: var(--ad-line); overflow: hidden; }
.as-job-bar-in { height: 100%; border-radius: 3px; background: var(--ad-brand-gradient); transition: width 0.4s; }

/* 选择条 */
.as-selbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 12px; }
.as-selbar .pchip { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; }
.ck {
  width: 19px; height: 19px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--ad-line-strong); background: var(--ad-inset);
  display: flex; align-items: center; justify-content: center;
}
.ck.on { background: var(--ad-brand); border-color: var(--ad-brand); }
.ckhit { padding: 9px; margin: -9px; display: flex; } /* 扩大勾选热区到 ~40px */

/* 资产卡片 */
.as-list { display: flex; flex-direction: column; }
.as-card { border-radius: 18px; }
.as-thumb { position: relative; width: 100%; height: 0; padding-bottom: 56%; background: var(--ad-inset); overflow: hidden; }
.as-thumb-img { position: absolute; top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; }
.as-thumb-empty {
  position: absolute; top: 0; right: 0; bottom: 0; left: 0;
  display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut);
}
.as-upzone {
  position: absolute; inset: 8px; border-radius: 12px;
  border: 1.5px dashed var(--ad-line-strong); background: var(--ad-inset);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  color: var(--ad-brand);
}
.as-upzone-t { font-size: 13px; font-weight: 700; color: var(--ad-text); }
.as-upzone-h { font-size: 11px; color: var(--ad-text-mut); }
.as-play {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 48px; height: 48px; border-radius: 50%;
  background: rgba(10, 10, 15, 0.55); border: 1px solid rgba(255, 255, 255, 0.3);
  display: flex; align-items: center; justify-content: center;
}
.as-dur {
  position: absolute; right: 8px; bottom: 8px;
  padding: 1px 7px; border-radius: 6px; font-size: 10.5px; font-weight: 700;
  background: rgba(5, 5, 9, 0.72); color: #fff;
}
.as-swap {
  position: absolute; left: 8px; bottom: 8px; width: 30px; height: 30px; border-radius: 9px;
  background: rgba(5, 5, 9, 0.62); border: 1px solid rgba(255, 255, 255, 0.2);
  display: flex; align-items: center; justify-content: center;
}
.as-role {
  position: absolute; top: 8px; left: 8px;
  padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
  background: rgba(52, 211, 153, 0.9); color: #04211c;
}
.as-ref {
  position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; border-radius: 9px; overflow: hidden;
  background: rgba(5, 5, 9, 0.62); border: 1px solid rgba(255, 255, 255, 0.2);
  display: flex; align-items: center; justify-content: center;
}
.as-ref.set { border-color: rgba(224, 182, 78, 0.8); }
.as-ref-img { width: 100%; height: 100%; }

.as-info { padding: 11px 14px 4px; }
.as-info-top { display: flex; align-items: center; gap: 8px; }
.as-name { flex: 1; min-width: 0; font-size: 14px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-ccnt {
  flex: none; font-size: 10.5px; line-height: 1.5; padding: 1px 7px; border-radius: 999px;
  background: rgba(224, 182, 78, 0.13); color: var(--ad-brand); white-space: nowrap;
}
.as-status { flex: none; }
.as-desc {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 12px; line-height: 1.6; color: var(--ad-text-mut); margin-top: 5px;
}

/* 操作区（两行各两枚，触控目标 38px+） */
.as-ops { display: flex; gap: 8px; padding: 6px 12px 0; }
.as-ops:last-child { padding-bottom: 12px; }
.op {
  flex: 1; min-height: 38px; border-radius: 11px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 12px; font-weight: 600;
}
.op.soft { background: var(--ad-inset); color: var(--ad-text); border: 1px solid var(--ad-line); }
.op.ghost { background: transparent; color: var(--ad-text-soft); border: 1px solid var(--ad-line); }
.op.ghost.danger { color: var(--ad-danger); }
.op.dis { opacity: 0.45; }

/* 新建卡片 / 空态 */
.as-new {
  border-style: dashed; border-radius: 18px; min-height: 150px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
  color: var(--ad-brand);
}
.as-new-t { font-size: 14px; font-weight: 700; color: var(--ad-text-mut); margin-top: 3px; }
.as-new-s { font-size: 11.5px; color: var(--ad-text-mut); }
.as-empty { border-radius: 18px; }
.as-empty-ic { font-size: 38px; line-height: 1; margin-bottom: 12px; }
.as-empty-t { font-size: 16px; font-weight: 700; color: var(--ad-text); margin-bottom: 6px; }
.as-empty-d { font-size: 12px; line-height: 1.7; color: var(--ad-text-mut); }
.as-empty-btn { margin-top: 14px; min-width: 160px; }

/* 分页 */
.as-pager { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 16px 18px 0; }
.as-pager .pchip { display: inline-flex; align-items: center; justify-content: center; min-width: 62px; min-height: 38px; }
.as-pager .pchip.dim { opacity: 0.4; }
.as-pager-num { font-size: 12px; color: var(--ad-text-mut); }

/* 底部提示 + 下一步 */
.as-tipbar { padding: 15px 16px; display: flex; flex-direction: column; gap: 12px; border-radius: 18px; }
.as-tip-text { font-size: 12px; line-height: 1.7; color: var(--ad-text-mut); }
.as-tip-next { height: 46px; font-size: 15px; }

/* 弹层内公共 */
.as-fl { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--ad-text); margin-bottom: 8px; }
.as-req { color: var(--ad-danger); }
.as-optional {
  font-size: 10.5px; font-weight: 500; color: var(--ad-text-mut);
  padding: 1px 8px; border-radius: 999px; background: var(--ad-inset);
}
.as-sheet-foot { display: flex; gap: 10px; padding-top: 14px; }
.as-sheet-foot .mbtn { flex: 1; }
.as-inline { display: flex; align-items: center; gap: 8px; }
.as-inline-in { flex: 1; }
.as-inline-btn { flex: none; min-width: 76px; height: 44px; }
.as-picker {
  height: 44px; padding: 0 14px; border-radius: 13px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  color: var(--ad-text-mut);
}
.as-picker-val { flex: 1; min-width: 0; font-size: 13.5px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 参考图弹层 */
.as-refbody { display: flex; flex-direction: column; }
.as-reftip { font-size: 12px; line-height: 1.7; color: var(--ad-text-mut); margin-bottom: 12px; }
.as-refprev {
  position: relative; /* 子元素绝对定位铺满：容器高度全靠 padding-bottom 撑出（内容区高 0），普通流内 height:100% 会算成 0 而不可见 */
  width: 100%; height: 0; padding-bottom: 56%; border-radius: 12px; overflow: hidden;
  background: var(--ad-inset); border: 1px solid var(--ad-line); margin-bottom: 14px;
}
.as-refprev-img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.as-refprev-empty {
  position: absolute; top: 0; left: 0; width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
  font-size: 12px; color: var(--ad-text-mut);
}
.as-refsep { font-size: 11.5px; color: var(--ad-text-mut); text-align: center; padding: 13px 0 9px; }
.as-refrm { margin-top: 14px; }
.as-refdone { margin-top: 10px; }

/* 关键帧 */
.as-kf { display: flex; flex-direction: column; }
.as-kf-pick { min-height: 44px; }
.as-kf-name { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-stepper { display: flex; align-items: center; gap: 12px; }
.as-step-btn {
  width: 38px; height: 38px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; color: var(--ad-text);
}
.as-step-val { min-width: 44px; text-align: center; font-size: 14px; font-weight: 700; color: var(--ad-brand); }

/* 自定义角色 */
/* 提取弹层 */
.as-extract { display: flex; flex-direction: column; gap: 12px; }
</style>
