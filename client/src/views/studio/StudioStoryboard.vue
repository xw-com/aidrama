<script setup>
/**
 * 创作台 · 分镜页签。分镜卡网格（关键帧/标题/本镜剧本/状态）+ 编辑抽屉 + 批量进度横幅。
 * 生成/批量/合成入口在 Ribbon；单镜生成、润色、编辑、上传、剪辑在卡片上。
 */
import { inject, ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { storyboardApi, assetApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import VideoPreview from '../../components/VideoPreview.vue';
import EmptyState from '../../components/EmptyState.vue';

const { t } = useI18n();
const ctx = inject('studio');
// 顶层解构（模板内 ref 自动解包）
const { st, jobs, curEpisode, batchJob, batchCJob, composeJob, canGen, canEditAsset, canEditStoryboard, actGenStoryboard } = ctx;
const { runJob } = useCostAction();

const segments = computed(() => st.segments);
const shotTag = (s) => `${curEpisode.value?.title || t('storyboard.episodeN', { n: curEpisode.value?.idx || '?' })} · ${s.shot_no || ('#' + s.idx)}`;
const normTrans = (v) => (!v || v === 'auto' ? 'cut' : v);
const TRANSITIONS = ['cut', 'dissolve', 'fade', 'fadeblack', 'fadewhite', 'slideleft', 'slideright', 'wipeleft', 'wiperight', 'circleopen', 'circleclose', 'radial', 'pixelize'];

// ---------- 分镜列表（本地全量、不分页） ----------
// 切集：清空勾选；回顶动画推迟到新集分镜落位的那次更新播放（fetch 期间旧列表保持原位不动）；
// 不在顶部时以 smooth 动画滑回（瞬跳显闪），已在顶部则不动；
// 8s 内没等到换新（加载失败）则丢弃标记，防止之后的批量轮询误触发回顶
let topPendingAt = 0;
watch(() => st.curEid, () => { st.sbSel.clear(); topPendingAt = Date.now(); });
watch(segments, () => {
  if (!topPendingAt) return;
  const due = Date.now() - topPendingAt < 8000;
  topPendingAt = 0;
  if (!due) return;
  const el = document.querySelector('.sbd');
  if (el && el.scrollTop > 0) el.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------- 卡片勾选（批量按钮按勾选范围执行；存于 st.sbSel 供 Ribbon 读取） ----------
const selCount = computed(() => st.sbSel.size);
const allSel = computed(() => segments.value.length > 0 && selCount.value >= segments.value.length);
function toggleSel(s, val) {
  val ? st.sbSel.add(s.id) : st.sbSel.delete(s.id);
}
function toggleAllSel(val) {
  st.sbSel.clear();
  if (val) st.segments.forEach((s) => st.sbSel.add(s.id));
}
// 全选无视频：与全选同口径作用于全部分镜，仅勾选未生成视频的镜头
const noVideoSegs = computed(() => segments.value.filter((s) => !s.video_url));
const noVideoAllSel = computed(() => noVideoSegs.value.length > 0 && noVideoSegs.value.every((s) => st.sbSel.has(s.id)));
function toggleNoVideoSel(val) {
  noVideoSegs.value.forEach((s) => (val ? st.sbSel.add(s.id) : st.sbSel.delete(s.id)));
}

// ---------- 只显示未审阅：过滤出「已生成视频且未审阅」的卡片（审阅工作流逐镜过片；仅视图过滤，不影响全选口径） ----------
const onlyUnreviewed = ref(false);
const unreviewedSegs = computed(() => segments.value.filter((s) => s.video_url && !s.reviewed_at));
const shownSegments = computed(() => (onlyUnreviewed.value ? unreviewedSegs.value : segments.value));

// ---------- 资产速查（编辑抽屉的本镜资产块） ----------
const KIND_ICON = { character: 'User', scene: 'Picture', prop: 'Box', material: 'Files', video: 'VideoPlay' };
const assetById = computed(() => new Map(st.assets.map((a) => [a.id, a])));
const kindOf = (id) => assetById.value.get(id)?.kind || r2k(id);
const nameOf = (id) => assetById.value.get(id)?.name || '';
// 角色缩略图跟随本集服饰覆盖（costumeOverrideMap 在下方服饰配置块；渲染期才取值，无先后问题）
const thumbOf = (id) => {
  const a = assetById.value.get(id);
  if (!a) return '';
  const c = a.kind === 'character' ? costumeOverrideMap.value[a.id] : null;
  return (c?.thumb_url || c?.image_url) || a.thumb_url || a.image_url || '';
};
// refs 里 name 兜底（资产被删时仍可显示）；kind 用 ref.type 兜底
function r2k(id) { return editForm.asset_refs.find((r) => r.id === id)?.type || 'material'; }

// ---------- 批量进度（派生自批量 Job meta，重进页面可恢复） ----------
const batchProgress = computed(() => ({
  index: batchJob.value?.meta?.index || 0,
  total: batchJob.value?.meta?.total || 0,
  running: !!batchJob.value,
}));
const batchConcurrentProgress = computed(() => ({
  done: batchCJob.value?.meta?.done || 0,
  total: batchCJob.value?.meta?.total || 0,
  running: !!batchCJob.value,
}));

// ---------- 任务面板跳转聚焦：滚动到目标分镜卡并高亮（信号来自 StudioView.gotoTask） ----------
const focusSegId = ref(null);
watch(() => st.focus, async (f) => {
  if (!f?.segmentId) return;
  if (!segments.value.some((s) => String(s.id) === String(f.segmentId))) return;
  await nextTick();
  const el = document.querySelector(`.sbd [data-seg-id="${f.segmentId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focusSegId.value = f.segmentId;
  setTimeout(() => { if (String(focusSegId.value) === String(f.segmentId)) focusSegId.value = null; }, 3900);
});

// ---------- 行内忙碌 ----------
const uploadingMap = ref({});
const segEditBusy = (s) => jobs.items.some((j) => j.type === 'video_edit' && String(j.ref_id) === String(s.id) && j.meta?.editSource === 'segment' && (j.status === 'pending' || j.status === 'running'));
const isBusy = (s) => !!(jobs.activeOf('segment_generate', s.id) || jobs.activeOf('segment_video', s.id) || jobs.activeOf('segment_erase_subtitle', s.id) || segEditBusy(s)
  || ((batchJob.value || batchCJob.value) && s.status === 'generating') || uploadingMap.value[s.id]);
// 生成视频专属忙碌（去掉上传/擦字幕/剪辑）：生成按钮据此显示「生成中」态
const isGenVideoBusy = (s) => !!(jobs.activeOf('segment_generate', s.id) || jobs.activeOf('segment_video', s.id)
  || ((batchJob.value || batchCJob.value) && s.status === 'generating'));
const isBusyPrompt = (s) => !!jobs.activeOf('segment_prompt', s.id);

function patchSegment(updated) {
  const i = st.segments.findIndex((x) => x.id === updated.id);
  if (i > -1) st.segments[i] = updated;
}

// ---------- 单镜生成视频 / 润色提示词 ----------
const videoModelId = ref(null);
const videoResolution = ref(null);
async function genVideo(s) {
  if (isBusy(s)) return;
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: (sel) => storyboardApi.genEstimate(s.id, sel),
    createFor: (sel) => storyboardApi.generateVideo(s.id, sel),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    title: t('storyboard.genVideoTitle'), desc: t('storyboard.genVideoDesc', { name: shotTag(s) }), confirmText: t('storyboard.generate'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.segment) patchSegment(j.result.segment);
    },
  });
}
async function genPrompt(s) {
  if (isBusyPrompt(s)) return;
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => storyboardApi.genPromptEstimate(s.id, sel),
    createFor: (sel) => storyboardApi.genPrompt(s.id, sel),
    allowRequirement: true,
    title: t('storyboard.genPromptTitle'), desc: t('storyboard.genPromptDesc', { name: shotTag(s) }), confirmText: t('storyboard.generate'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.segment) patchSegment(j.result.segment);
    },
  });
}

// ---------- 取消批量 ----------
async function cancelBatch() {
  const j = batchJob.value || batchCJob.value;
  if (!j) return;
  try {
    await ElMessageBox.confirm(t('storyboard.cancelBatchConfirm'), t('common.tip'), { type: 'warning' });
  } catch { return; }
  try { await jobs.cancel(j.id); } catch { /* http 层已提示 */ }
}

// ---------- 编辑抽屉 ----------
const editing = ref(false);
const editForm = reactive({ id: null, scene_script: '', video_prompt: '', duration: 5, transition: 'cut', asset_refs: [] });
function startEdit(s) {
  editForm.id = s.id;
  editForm.scene_script = s.scene_script || '';
  editForm.video_prompt = s.video_prompt || '';
  editForm.duration = s.duration || 5;
  editForm.transition = normTrans(s.transition);
  editForm.asset_refs = (s.asset_refs || []).map((r) => ({ ...r }));
  editing.value = true;
}
// 本镜资产增删：抽屉内即改 editForm.asset_refs，随「保存」提交（服务端归一化）
function removeRef(id) {
  editForm.asset_refs = editForm.asset_refs.filter((r) => r.id !== id);
}
function addRef(a) {
  if (editForm.asset_refs.some((r) => r.id === a.id)) return;
  editForm.asset_refs.push({ type: a.kind, id: a.id, name: a.name });
}

// 从资产库添加（缩略图点选）
const pickerOpen = ref(false);
const pickerQ = ref('');
const pickableAssets = computed(() => {
  const q = pickerQ.value.trim().toLowerCase();
  return st.assets
    .filter((a) => !editForm.asset_refs.some((r) => r.id === a.id))
    .filter((a) => !q || String(a.name || '').toLowerCase().includes(q));
});

// 资产预览（大窗口：视频走 VideoPreview，图片走原图）
const assetPreview = reactive({ open: false, kind: '', name: '', url: '', poster: '' });
const previewableOf = (id) => {
  const a = assetById.value.get(id);
  if (!a) return null;
  if (a.kind === 'video' && a.meta?.videoUrl) return { kind: 'video', url: a.meta.videoUrl, poster: a.image_url || '', name: a.name };
  // 大图同样跟随服饰覆盖：缩略已换成服饰图、点开仍是角色默认图会很突兀
  const c = a.kind === 'character' ? costumeOverrideMap.value[a.id] : null;
  const url = (c && c.image_url) || a.image_url;
  if (url) return { kind: 'image', url, poster: '', name: a.name };
  return null;
};
function previewRef(id) {
  const p = previewableOf(id);
  if (!p) return;
  Object.assign(assetPreview, p, { open: true });
}
async function saveEdit() {
  const s = st.segments.find((x) => x.id === editForm.id);
  if (!s) return;
  try {
    const { id, ...payload } = editForm;
    const updated = await storyboardApi.updateSegment(id, payload);
    patchSegment(updated);
    editing.value = false;
    ElMessage.success(t('common.saveSuccess'));
  } catch { /* http 层已提示 */ }
}

// ---------- 上传视频 / 删除视频 / 删除分镜 ----------
const uploadInputRef = ref(null);
let uploadTargetId = null;
function pickUpload(s) {
  uploadTargetId = s.id;
  uploadInputRef.value?.click();
}
async function onUploadFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !uploadTargetId) return;
  uploadingMap.value = { ...uploadingMap.value, [uploadTargetId]: true };
  try {
    const updated = await storyboardApi.uploadVideo(uploadTargetId, file);
    patchSegment(updated);
    ElMessage.success(t('common.saveSuccess'));
  } catch { /* http 层已提示 */ } finally {
    uploadingMap.value = { ...uploadingMap.value, [uploadTargetId]: false };
    uploadTargetId = null;
  }
}
async function deleteVideo(s) {
  // 预览窗内删除当前镜：先记下本镜在预览队列中的位置，删除刷新后自动切到下一镜（同队列口径）
  const inPreview = previewVisible.value && previewSeg.value?.id === s.id;
  const prevPos = inPreview ? previewIdx.value : -1;
  try {
    await ElMessageBox.confirm(t('storyboard.deleteVideoConfirm'), t('storyboard.deleteVideoTitle'), { type: 'warning' });
  } catch { return; }
  try {
    await storyboardApi.deleteVideo(s.id);
    await ctx.refreshSegments();
    // 预览内删除：本镜已被刷出队列，同位置滑入的就是下一镜；已是最后一镜退到上一镜，队列空了收起预览
    if (inPreview) {
      const queue = segments.value.filter((x) => x.video_url && (!onlyUnreviewed.value || !x.reviewed_at));
      const next = queue[Math.min(prevPos, queue.length - 1)];
      if (next && next.id !== s.id) previewSeg.value = next;
      else previewVisible.value = false;
    }
  } catch { /* http 层已提示 */ }
}
async function deleteSegment(s) {
  try {
    await ElMessageBox.confirm(t('storyboard.deleteSegmentConfirm', { name: shotTag(s) }), t('storyboard.deleteSegmentTitle'), { type: 'warning' });
  } catch { return; }
  try {
    await storyboardApi.deleteSegment(s.id);
    await ctx.refreshSegments();
    st.sbSel.delete(s.id);
  } catch { /* http 层已提示 */ }
}

// ---------- 预览（大窗口，与 EpisodeList 同一窗口口径） ----------
const previewSeg = ref(null);
const previewVisible = ref(false);
// 视频区按项目画幅动态适配（至少一边撑满）：--pv-ar 交给弹窗内 .vp 的 aspect-ratio
const previewAspect = computed(() => String(st.project?.aspect_ratio || '9:16').replace(':', ' / '));

// 上一镜/下一镜：仅在已生成视频的分镜间切换（预览入口只对有视频的卡片开放，导航保持同一口径）；
// 开着「只显示未审阅」时队列随过滤收窄，但当前这镜刚被审阅后仍须留在队尾，否则序号失效、箭头消失、断在半路
const previewables = computed(() => segments.value.filter((s) => s.video_url
  && (!onlyUnreviewed.value || !s.reviewed_at || s.id === previewSeg.value?.id)));
const previewIdx = computed(() => (previewSeg.value ? previewables.value.findIndex((s) => s.id === previewSeg.value.id) : -1));
const hasPrevSeg = computed(() => previewIdx.value > 0);
const hasNextSeg = computed(() => previewIdx.value > -1 && previewIdx.value < previewables.value.length - 1);
function switchPreview(dir) {
  const next = previewables.value[previewIdx.value + dir];
  if (next) previewSeg.value = next;
}
// 预览开着时 ←/→ 键同箭头按钮；焦点在播放器内时让位给原生的快进快退；关闭即摘监听
function onPreviewKeydown(e) {
  if (e.target?.closest?.('.vp')) return;
  if (e.key === 'ArrowLeft' && hasPrevSeg.value) switchPreview(-1);
  else if (e.key === 'ArrowRight' && hasNextSeg.value) switchPreview(1);
}
watch(previewVisible, (v) => {
  if (v) window.addEventListener('keydown', onPreviewKeydown);
  else window.removeEventListener('keydown', onPreviewKeydown);
});
onUnmounted(() => window.removeEventListener('keydown', onPreviewKeydown));

// ---------- 审阅（预览窗口按钮直达；已审卡片叠「已审」角标） ----------
// 已审态再点 = 取消审阅；换视频（重新生成/上传/剪辑写回/擦字幕）后服务端自动重置为未审
const reviewBusy = ref(false);
async function toggleReview(s) {
  if (!s?.video_url || !canEditStoryboard.value || reviewBusy.value) return;
  reviewBusy.value = true;
  try {
    const updated = await storyboardApi.reviewSegment(s.id, !s.reviewed_at);
    patchSegment(updated);
    // patchSegment 是整对象替换：预览窗还持着旧行引用，不同步的话按钮状态停在旧值（连点判断也基于旧值）
    if (previewSeg.value?.id === updated.id) previewSeg.value = updated;
    ElMessage.success(t(updated.reviewed_at ? 'episode.videos.reviewDone' : 'episode.videos.reviewUndone'));
  } catch { /* http 层已提示 */ } finally {
    reviewBusy.value = false;
  }
}

// ---------- 分镜卡按项目画幅渲染：缩略图比例跟项目走，列宽按 √画幅比缩放使各画幅面积相当 ----------
// 以竖屏 9:16、列宽 188px 为面积基准（188×334≈6.3万px²）：横屏 16:9 → 334px，方图 1:1 → 251px
const segAspect = computed(() => String(st.project?.aspect_ratio || '9:16').replace(':', ' / '));
const segColMin = computed(() => {
  const [w, h] = String(st.project?.aspect_ratio || '9:16').split(':').map(Number);
  const r = w > 0 && h > 0 ? w / h : 9 / 16;
  return Math.round(Math.min(400, Math.max(140, 188 * (4 / 3) * Math.sqrt(r))));
});
function openPreview(s) {
  previewSeg.value = s;
  previewVisible.value = true;
}

// ---------- 在线剪辑（seg-<id> 分镜接源；导出写回后由消息/轮询补位） ----------
function openVideoEditor(s) {
  if (!s?.video_url || isBusy(s)) return;
  window.open(`/editor/video/seg-${s.id}`, `aieditor_seg_${s.id}`)?.focus();
}
function onEditorMessage(e) {
  if (e.origin !== window.location.origin) return;
  const d = e.data;
  if (!d || d.type !== 'aieditor:exported' || !d.segment_id) return;
  if (d.segment) patchSegment(d.segment);
  else ctx.refreshSegments();
}
onMounted(() => { window.addEventListener('message', onEditorMessage); prefetchCostumeCfg(); });
onUnmounted(() => window.removeEventListener('message', onEditorMessage));

// ---------- 按集角色服饰（与 workspace StoryboardEditor 同款窗口） ----------
const costumeCfg = reactive({
  open: false,
  loading: false,
  saving: false,
  rows: [], // [{ asset_id, name, costume_id, costumes:[{id,name,image_url,is_default}] }]
  showAll: false, // false=仅本集出现的角色；true=本项目全部角色
});
// 本集 asset_refs 中出现的资产 id（用于「仅本集」过滤）
const episodeAssetIds = computed(() => {
  const ids = new Set();
  for (const s of segments.value) {
    for (const r of (s.asset_refs || [])) {
      if (r && r.id != null) ids.add(Number(r.id));
    }
  }
  return ids;
});
const costumeCfgRows = computed(() => {
  if (costumeCfg.showAll) return costumeCfg.rows;
  const ids = episodeAssetIds.value;
  return costumeCfg.rows.filter((r) => ids.has(Number(r.asset_id)));
});
// 本镜资产面板角色图的服饰覆盖：assetId -> 本集选中服饰（未配置则无条目，用角色默认图）
const costumeOverrideMap = computed(() => {
  const m = {};
  for (const row of costumeCfg.rows) {
    if (!row.costume_id) continue;
    const c = (row.costumes || []).find((x) => x.id === row.costume_id);
    if (c && c.image_url) m[row.asset_id] = c;
  }
  return m;
});
// 静默预取本集服饰配置：编辑抽屉里角色缩略/大图据此跟随服饰覆盖（失败不阻塞，回退角色默认图）
async function prefetchCostumeCfg() {
  if (!st.curEid) return;
  try {
    const rows = await assetApi.episodeCostumeConfig(st.curEid);
    costumeCfg.rows = Array.isArray(rows) ? rows : [];
  } catch { /* 忽略 */ }
}
watch(() => st.curEid, () => prefetchCostumeCfg());
// 角色行的预览图：默认服饰图，否则首张服饰图
function rowDefaultImg(row) {
  const list = row?.costumes || [];
  const def = list.find((c) => c.is_default) || list[0];
  return def?.thumb_url || def?.image_url || '';
}
// 弹窗里点缩略图预览大图：独立 viewer，翻页范围=该角色的全部服饰原图
const costumePreview = reactive({ open: false, list: [], index: 0 });
function previewCostumeCfg(row, c) {
  if (!c?.image_url) return;
  const list = (row?.costumes || []).filter((x) => x.image_url).map((x) => x.image_url);
  costumePreview.list = list.length ? list : [c.image_url];
  const i = costumePreview.list.indexOf(c.image_url);
  costumePreview.index = i > -1 ? i : 0;
  costumePreview.open = true;
}
async function openCostumeConfig() {
  costumeCfg.open = true;
  costumeCfg.loading = true;
  costumeCfg.showAll = false;
  try {
    const rows = await assetApi.episodeCostumeConfig(st.curEid);
    costumeCfg.rows = Array.isArray(rows) ? rows : [];
  } catch (e) {
    ElMessage.error(e?.message || t('errors.requestFailed'));
  } finally {
    costumeCfg.loading = false;
  }
}
async function saveCostumeConfig() {
  costumeCfg.saving = true;
  try {
    const configs = costumeCfg.rows.map((r) => ({ asset_id: r.asset_id, costume_id: r.costume_id || null }));
    await assetApi.saveEpisodeCostumeConfig(st.curEid, configs);
    ElMessage.success(t('asset.costumeConfig.saved'));
    costumeCfg.open = false;
  } catch (e) {
    ElMessage.error(e?.message || t('errors.requestFailed'));
  } finally {
    costumeCfg.saving = false;
  }
}

const stats = computed(() => ({
  total: segments.value.length,
  withVideo: segments.value.filter((s) => s.video_url).length,
  noPrompt: segments.value.filter((s) => !s.video_prompt).length,
}));
</script>

<template>
  <div class="sbd">
    <!-- 隐藏的上传输入 -->
    <input ref="uploadInputRef" type="file" accept="video/*" style="display: none;" @change="onUploadFile" />

    <!-- 集摘要 + 全选 -->
    <div v-if="segments.length" class="sb-summary">
      <span class="sb-ep"><el-icon><Film /></el-icon>{{ t('script.episodeTitleShort', { idx: curEpisode?.idx ?? '?' }) }}<template v-if="curEpisode?.title"> · {{ curEpisode.title }}</template></span>
      <span class="ad-sub ad-muted">{{ t('studio.sb.summary', stats) }}</span>
      <el-checkbox
        class="sb-selall"
        :model-value="allSel"
        :indeterminate="selCount > 0 && !allSel"
        @change="toggleAllSel"
      >
        {{ t('studio.sb.selectAll') }}<template v-if="selCount"> · {{ selCount }}</template>
      </el-checkbox>
      <!-- 全选无视频：选中未生成视频的分镜（全部镜头口径，与全选一致）；全部已生成时禁用 -->
      <el-checkbox
        class="sb-selnovideo"
        :model-value="noVideoAllSel"
        :indeterminate="!noVideoAllSel && noVideoSegs.some((s) => st.sbSel.has(s.id))"
        :disabled="!noVideoSegs.length"
        @change="toggleNoVideoSel"
      >
        {{ t('studio.sb.selectNoVideo') }}
      </el-checkbox>
      <!-- 只显示未审阅：网格过滤出已生成视频且未审的卡片（审阅完一镜即从网格消失）；全部审完后不置灰，留勾可自行取消 -->
      <el-checkbox v-model="onlyUnreviewed" class="sb-onlyunreviewed">
        {{ t('studio.sb.onlyUnreviewed') }}<template v-if="unreviewedSegs.length"> · {{ unreviewedSegs.length }}</template>
      </el-checkbox>
      <!-- 按集角色服饰：打开与 workspace 分镜编辑器同款的服饰配置窗口 -->
      <el-button v-if="canEditAsset" size="small" class="sb-costume" @click="openCostumeConfig">
        <el-icon><Brush /></el-icon>&nbsp;{{ t('asset.costumeConfig.button') }}
      </el-button>
    </div>

    <!-- 批量进度横幅 -->
    <div v-if="batchProgress.running || batchConcurrentProgress.running" class="sb-banner">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span class="sb-banner-label">
        {{ batchProgress.running ? t('storyboard.serialGenerating') : t('storyboard.concurrentGenerating') }}
      </span>
      <el-progress
        class="sb-banner-bar"
        :percentage="batchProgress.running
          ? Math.round(((batchProgress.index || 0) / Math.max(batchProgress.total || 1, 1)) * 100)
          : Math.round(((batchConcurrentProgress.done || 0) / Math.max(batchConcurrentProgress.total || 1, 1)) * 100)"
        :show-text="false"
        :stroke-width="6"
      />
      <span class="sb-banner-n sc-mono">
        {{ batchProgress.running ? `${batchProgress.index}/${batchProgress.total}` : `${batchConcurrentProgress.done}/${batchConcurrentProgress.total}` }}
      </span>
      <el-button size="small" text type="danger" @click="cancelBatch">{{ t('common.cancel') }}</el-button>
    </div>

    <!-- 合成全集进度横幅（合成任务运行中，分镜面板同步可见） -->
    <div v-if="composeJob" class="sb-banner">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span class="sb-banner-label">{{ t('studio.sb.composing') }}</span>
      <el-progress class="sb-banner-bar" :percentage="composeJob.progress || 0" :show-text="false" :stroke-width="6" />
      <span class="sb-banner-n sc-mono">{{ composeJob.progress || 0 }}%</span>
    </div>

    <!-- 空状态 -->
    <EmptyState
      v-if="!segments.length"
      icon-component="Film"
      :title="t('studio.sb.emptyTitle')"
      :description="t('studio.sb.emptyDesc')"
      :action-label="canGen && st.curEid ? t('studio.act.genStoryboard') : ''"
      @action="actGenStoryboard()"
    />

    <!-- 分镜卡网格 -->
    <div v-else class="sb-grid" :style="{ '--sb-col-min': `${segColMin}px`, '--sb-ar': segAspect }">
      <!-- 「只显示未审阅」滤空：还有分镜但已全部审阅（取消勾选可回到全量视图） -->
      <div v-if="!shownSegments.length" class="sb-filter-empty">{{ t('studio.sb.allReviewed') }}</div>
      <div
        v-for="s in shownSegments"
        :key="s.id"
        class="ad-card sb-card"
        :class="{ busy: isBusy(s), 'sb-focus': focusSegId != null && String(focusSegId) === String(s.id) }"
        :data-seg-id="s.id"
      >
        <!-- 卡片画面：左上「分镜号 · 标题」，底部常驻本镜剧本（叠图显示），悬停补资产名 -->
        <div class="sb-thumb" @click="s.video_url && openPreview(s)">
          <img v-if="s.keyframe_url" :src="s.keyframe_url" loading="lazy" />
          <div v-else class="sb-thumb-empty"><el-icon><Film /></el-icon></div>
          <span class="sb-no" :title="s.title || undefined">{{ s.shot_no || ('#' + s.idx) }}<template v-if="s.title"> · {{ s.title }}</template></span>
          <span class="sb-dur">{{ s.duration }}s</span>
          <!-- 已审角标（预览窗口点「审阅」标记；换视频后服务端自动重置为未审） -->
          <span v-if="s.video_url && s.reviewed_at" class="sb-reviewed"><el-icon><Check /></el-icon>{{ t('episode.videos.reviewed') }}</span>
          <!-- 删除视频小按钮（卡片直达，替代菜单里的删除视频项） -->
          <button
            v-if="s.video_url"
            class="sb-delvideo"
            type="button"
            :title="t('storyboard.deleteVideoTitle')"
            :disabled="isBusy(s)"
            @click.stop="deleteVideo(s)"
          ><el-icon><Delete /></el-icon></button>
          <span v-if="s.video_url" class="sb-play"><el-icon><VideoPlay /></el-icon></span>
          <span v-if="isBusy(s)" class="sb-gen"><el-icon class="is-loading"><Loading /></el-icon></span>
          <div v-if="s.scene_script || (s.asset_refs || []).length" class="sb-thumb-bottom">
            <div v-if="s.scene_script" class="sb-desc">{{ s.scene_script }}</div>
            <div v-if="(s.asset_refs || []).length" class="sb-hover-refs">
              <span v-for="(r, ri) in s.asset_refs.slice(0, 4)" :key="ri" class="sb-ref">{{ r.name }}</span>
              <span v-if="s.asset_refs.length > 4" class="sb-ref more">+{{ s.asset_refs.length - 4 }}</span>
            </div>
          </div>
        </div>
        <div class="sb-actions">
          <el-checkbox
            class="sb-sel"
            :model-value="st.sbSel.has(s.id)"
            @change="(v) => toggleSel(s, v)"
          />
          <el-button size="small" class="btn-ink" :disabled="!canGen || isBusy(s) || !s.video_prompt" @click="genVideo(s)">
            <template v-if="isGenVideoBusy(s)"><el-icon class="is-loading"><Loading /></el-icon> {{ t('storyboard.generating') }}</template>
            <template v-else><el-icon><VideoPlay /></el-icon> {{ s.video_url ? t('storyboard.regenerate') : t('storyboard.generate') }}</template>
          </el-button>
          <el-dropdown trigger="click" @command="(cmd) => cmd === 'edit' ? startEdit(s) : cmd === 'upload' ? pickUpload(s) : cmd === 'prompt' ? genPrompt(s) : cmd === 'editor' ? openVideoEditor(s) : deleteSegment(s)">
            <button class="sb-more" type="button" :title="t('common.more')"><el-icon><MoreFilled /></el-icon></button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="edit" :disabled="!canEditAsset"><el-icon><EditPen /></el-icon> {{ t('common.edit') }}</el-dropdown-item>
                <el-dropdown-item command="prompt" :disabled="!canGen || isBusyPrompt(s)"><el-icon><ChatDotRound /></el-icon> {{ t('storyboard.genPromptTitle') }}</el-dropdown-item>
                <el-dropdown-item command="upload" :disabled="!canEditAsset || isBusy(s)"><el-icon><Upload /></el-icon> {{ t('storyboard.uploadVideo') }}</el-dropdown-item>
                <el-dropdown-item command="editor" divided :disabled="!s.video_url || isBusy(s)"><el-icon><Scissor /></el-icon> {{ t('storyboard.editVideo') }}</el-dropdown-item>
                <el-dropdown-item command="delshot" class="sb-danger-item"><el-icon><Delete /></el-icon> {{ t('storyboard.deleteSegmentTitle') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </div>

    <!-- 编辑抽屉 -->
    <el-drawer v-model="editing" class="sb-edit-drawer" :title="t('storyboard.detail')" size="min(480px, 92vw)" append-to-body>
      <div class="sb-form">
        <div class="sb-field">
          <label>{{ t('studio.sb.sceneScript') }}</label>
          <el-input v-model="editForm.scene_script" type="textarea" :rows="6" />
        </div>
        <div class="sb-field">
          <label>{{ t('studio.sb.videoPrompt') }}</label>
          <el-input v-model="editForm.video_prompt" type="textarea" :rows="16" />
        </div>
        <div class="sb-field">
          <label>{{ t('storyboard.shotAssets') }}</label>
          <div class="sb-asset-grid">
            <div v-for="r in editForm.asset_refs" :key="r.id" class="sb-asset-item">
              <div
                class="sb-asset-thumb"
                :class="{ clickable: !!previewableOf(r.id) }"
                :title="previewableOf(r.id) ? t('common.preview') : ''"
                @click="previewRef(r.id)"
              >
                <img v-if="thumbOf(r.id)" :src="thumbOf(r.id)" loading="lazy" />
                <el-icon v-else><component :is="KIND_ICON[kindOf(r.id)] || 'Files'" /></el-icon>
                <span v-if="kindOf(r.id) === 'video'" class="sb-asset-play"><el-icon><VideoPlay /></el-icon></span>
              </div>
              <div class="sb-asset-meta">
                <div class="sb-asset-name" :title="nameOf(r.id)">{{ nameOf(r.id) }}</div>
                <span class="sb-asset-kind">{{ t('storyboard.assetKind.' + kindOf(r.id)) }}</span>
              </div>
              <el-icon class="sb-asset-rm" :title="t('storyboard.remove')" @click="removeRef(r.id)"><Close /></el-icon>
            </div>
            <button type="button" class="sb-asset-add" @click="pickerOpen = true; pickerQ = '';">
              <el-icon><Plus /></el-icon>
              <span>{{ t('storyboard.addFromLibrary') }}</span>
            </button>
          </div>
        </div>
        <div class="sb-field-row">
          <div class="sb-field">
            <label>{{ t('studio.sb.durationSec') }}</label>
            <el-input-number v-model="editForm.duration" :min="1" :max="15" />
          </div>
          <div class="sb-field">
            <label>{{ t('studio.sb.transitionToNext') }}</label>
            <el-select v-model="editForm.transition" style="width: 150px;">
              <el-option v-for="tr in TRANSITIONS" :key="tr" :value="tr" :label="t(`storyboard.transition.${tr}`)" />
            </el-select>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="editing = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" @click="saveEdit">{{ t('common.save') }}</el-button>
      </template>
    </el-drawer>

    <!-- 大窗口预览（全屏铺满 + 视频贴边；打开即自动播放） -->
    <el-dialog v-model="previewVisible" class="sb-preview-dialog" width="100%" top="0" :show-close="true" append-to-body destroy-on-close>
      <template #header>
        <div class="preview-head">
          <el-icon><Film /></el-icon>
          <span>{{ previewSeg ? shotTag(previewSeg) : t('episode.videos.preview') }}</span>
          <span v-if="previewIdx > -1" class="preview-pos sc-mono">{{ previewIdx + 1 }} / {{ previewables.length }}</span>
          <!-- 审阅按钮：未审点按标记已审；已审再点取消审阅（需分镜编辑权限） -->
          <el-button
            v-if="previewSeg?.video_url"
            class="preview-review"
            :class="{ done: !!previewSeg.reviewed_at }"
            size="small"
            round
            :disabled="!canEditStoryboard"
            :loading="reviewBusy"
            :title="previewSeg.reviewed_at ? t('episode.videos.unreview') : t('episode.videos.review')"
            @click="toggleReview(previewSeg)"
          >
            <template v-if="!reviewBusy && previewSeg.reviewed_at"><el-icon><Check /></el-icon>&nbsp;{{ t('episode.videos.reviewed') }}</template>
            <template v-else>{{ t('episode.videos.review') }}</template>
          </el-button>
        </div>
      </template>
      <div v-if="previewSeg" class="preview-body" :style="{ '--pv-ar': previewAspect }">
        <!-- 删除本镜视频（左上角；需分镜编辑权限）：确认后删除并自动切到下一镜 -->
        <button v-if="canEditStoryboard" class="pv-del" type="button" :title="t('storyboard.deleteVideoTitle')" @click="deleteVideo(previewSeg)">
          <el-icon><Delete /></el-icon>
        </button>
        <!-- 上一镜/下一镜切换钮（首尾相应隐藏） -->
        <button v-if="hasPrevSeg" class="pv-nav prev" type="button" :title="t('episode.videos.prevShot')" @click="switchPreview(-1)">
          <el-icon><ArrowLeft /></el-icon>
        </button>
        <!-- :key 按镜头重挂载：VideoPreview 只在 mounted 拉起 autoplay，切镜后需重新触发 -->
        <VideoPreview :key="previewSeg.id" :src="previewSeg.video_url" :poster="previewSeg.keyframe_url" autoplay />
        <button v-if="hasNextSeg" class="pv-nav next" type="button" :title="t('episode.videos.nextShot')" @click="switchPreview(1)">
          <el-icon><ArrowRight /></el-icon>
        </button>
      </div>
    </el-dialog>

    <!-- 从资产库添加（缩略图点选，可连续添加） -->
    <el-dialog v-model="pickerOpen" :title="t('storyboard.addFromLibraryTitle')" width="min(560px, 92vw)" append-to-body>
      <el-input v-model="pickerQ" :placeholder="t('storyboard.searchAssetPlaceholder')" clearable />
      <div class="sb-picker-grid">
        <button v-for="a in pickableAssets" :key="a.id" type="button" class="sb-picker-item" @click="addRef(a)">
          <div class="sb-asset-thumb">
            <img v-if="a.thumb_url || a.image_url" :src="a.thumb_url || a.image_url" loading="lazy" />
            <el-icon v-else><component :is="KIND_ICON[a.kind] || 'Files'" /></el-icon>
            <span v-if="a.kind === 'video'" class="sb-asset-play"><el-icon><VideoPlay /></el-icon></span>
          </div>
          <div class="sb-asset-name" :title="a.name">{{ a.name }}</div>
          <span class="sb-asset-kind">{{ t('storyboard.assetKind.' + a.kind) }}</span>
        </button>
      </div>
      <div v-if="!pickableAssets.length" class="ad-muted sb-picker-empty">{{ t('common.noData') }}</div>
    </el-dialog>

    <!-- 资产预览（视频走 VideoPreview，图片走原图） -->
    <el-dialog v-model="assetPreview.open" width="min(760px, 92vw)" top="6vh" :show-close="true" append-to-body destroy-on-close>
      <template #header>
        <div class="preview-head">
          <el-icon><View /></el-icon>
          <span>{{ assetPreview.name }}</span>
        </div>
      </template>
      <div class="preview-body">
        <VideoPreview v-if="assetPreview.kind === 'video'" :src="assetPreview.url" :poster="assetPreview.poster" />
        <img v-else :src="assetPreview.url" class="sb-ap-img" />
      </div>
    </el-dialog>

    <!-- 按集角色服饰配置（与 workspace StoryboardEditor 同款窗口） -->
    <el-dialog v-model="costumeCfg.open" :title="t('asset.costumeConfig.title')" width="min(640px, 94vw)" append-to-body :close-on-click-modal="false" class="costume-cfg-dialog">
      <div v-loading="costumeCfg.loading" class="costume-cfg-body">
        <div class="ad-muted costume-cfg-desc">{{ t('asset.costumeConfig.desc') }}</div>
        <div class="ad-muted costume-cfg-desc">{{ t('asset.costumeConfig.pickTip') }}</div>
        <div class="ad-flex-center ad-gap-sm" style="margin-bottom: 12px;">
          <el-checkbox v-model="costumeCfg.showAll">{{ t('asset.costumeConfig.showAll') }}</el-checkbox>
        </div>
        <el-table :data="costumeCfgRows" size="small" :empty-text="t('asset.costumeConfig.empty')">
          <el-table-column :label="t('asset.costumeConfig.colCharacter')" min-width="140">
            <template #default="{ row }">
              <div class="ad-flex-center ad-gap-sm">
                <div class="ast-thumb sm"><img v-if="rowDefaultImg(row)" :src="rowDefaultImg(row)" /></div>
                <span>{{ row.name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('asset.costumeConfig.colCostume')" min-width="300">
            <template #default="{ row }">
              <div class="costume-pick">
                <!-- 默认服饰卡：缩略图与服饰图重复，整卡点击即选用，不提供预览 -->
                <div class="costume-pick-item" :class="{ 'is-active': row.costume_id == null }" @click="row.costume_id = null">
                  <span class="costume-pick-thumb">
                    <img v-if="rowDefaultImg(row)" :src="rowDefaultImg(row)" loading="lazy" decoding="async" />
                    <el-icon v-else><Picture /></el-icon>
                  </span>
                  <span class="costume-pick-name">{{ t('asset.costumeConfig.defaultOption') }}</span>
                </div>
                <!-- 服饰卡：点击卡片任意处=选用本集服饰；右下放大镜=预览大图（阻断冒泡，不触发选用） -->
                <div v-for="c in row.costumes" :key="c.id" class="costume-pick-item" :class="{ 'is-active': row.costume_id === c.id }" @click="row.costume_id = c.id">
                  <span v-if="c.image_url" class="costume-pick-thumb">
                    <img :src="c.thumb_url || c.image_url" loading="lazy" decoding="async" />
                    <button type="button" class="costume-pick-zoom" :title="t('common.preview')" @click.stop="previewCostumeCfg(row, c)">
                      <el-icon :size="12"><ZoomIn /></el-icon>
                    </button>
                  </span>
                  <span v-else class="costume-pick-thumb"><el-icon><Picture /></el-icon></span>
                  <span class="costume-pick-name">{{ c.name || t('asset.costume.untitled') }}</span>
                  <el-icon v-if="row.costume_id === c.id" class="costume-pick-check"><Check /></el-icon>
                </div>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!costumeCfgRows.length && !costumeCfg.loading" class="ad-muted" style="text-align: center; padding: 24px 0;">
          {{ t('asset.costumeConfig.empty') }}
        </div>
      </div>
      <template #footer>
        <el-button @click="costumeCfg.open = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="costumeCfg.saving" @click="saveCostumeConfig">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 服饰配置弹窗的大图预览：独立 viewer，翻页范围=该角色的全部服饰 -->
    <el-image-viewer
      v-if="costumePreview.open"
      :url-list="costumePreview.list"
      :initial-index="costumePreview.index"
      hide-on-click-modal
      @close="costumePreview.open = false"
    />
  </div>
</template>

<style scoped>
/* 根类用 sbd：勿用 sb（StudioView 状态栏同名类会经「子组件根节点继承父 scope」污染本页根元素） */
.sbd { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 14px 14px; overflow-y: auto; gap: 12px; }
.sc-mono { font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; }

.sb-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sb-selall { margin-left: auto; }
.sb-selall .el-checkbox__label, .sb-selnovideo .el-checkbox__label, .sb-onlyunreviewed .el-checkbox__label { font-size: 12.5px; color: var(--ad-text-soft); }
.sb-ep { display: inline-flex; align-items: center; gap: 6px; font-family: var(--ad-font-display); font-weight: 700; font-size: 16px; color: var(--ad-text-strong); }
.sb-ep .el-icon { color: var(--ad-brand); font-size: 15px; }

/* 批量横幅 */
.sb-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; border-radius: var(--ad-radius-md);
  background: var(--ad-brand-soft); border: 1px solid color-mix(in srgb, var(--ad-brand) 30%, transparent);
  flex: 0 0 auto;
}
.sb-banner-label { font-size: 13px; font-weight: 700; color: var(--ad-brand); white-space: nowrap; }
.sb-banner-bar { flex: 1; }
.sb-banner-n { font-size: 12px; color: var(--ad-brand); }

/* 网格自然撑开，随外层 .sb 滚动（勿设 flex/min-height，否则高度被压成一屏、后排卡片被裁）
   最小列宽走 --sb-col-min（脚本按项目画幅计算：竖屏 9:16=188px 基准，横屏 16:9=334px，等面积） */
.sb-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--sb-col-min, 188px), 1fr)); gap: 12px;
  align-content: start;
}
/* 「只显示未审阅」滤空占位（横跨整行居中） */
.sb-filter-empty {
  grid-column: 1 / -1;
  padding: 42px 0; text-align: center;
  font-size: 13.5px; color: var(--ad-text-muted);
}
.sb-card {
  padding: 0; overflow: hidden; display: flex; flex-direction: column;
  transition: transform .18s, box-shadow .18s, border-color .18s;
}
.sb-card:hover { transform: translateY(-2px); box-shadow: var(--ad-shadow-hover); border-color: color-mix(in srgb, var(--ad-brand) 35%, transparent); }
.sb-card.busy { border-color: color-mix(in srgb, var(--ad-brand) 45%, transparent); }
/* 任务面板跳转定位高亮：紫红加粗描边（1px 边框 + 1px 外环叠加）+ 缩放脉冲；
   0%/100% 帧与静态环一致，动画起止无跳变。总时长 1.65s × 2 ≈ 3.3s，与上方 setTimeout 3900 对应。
   置于 .busy 之后，等特异性下靠源顺序覆盖其金色描边 */
.sb-card.sb-focus {
  border-color: var(--ad-focus-jump);
  box-shadow: 0 0 0 1px var(--ad-focus-jump), 0 0 14px color-mix(in srgb, var(--ad-focus-jump) 28%, transparent);
  animation: sbFocusGlow 1.65s ease-in-out 2;
}
@keyframes sbFocusGlow {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 1px var(--ad-focus-jump), 0 0 14px color-mix(in srgb, var(--ad-focus-jump) 28%, transparent);
  }
  50% {
    transform: scale(1.03);
    box-shadow: 0 0 0 2px var(--ad-focus-jump), 0 0 0 7px color-mix(in srgb, var(--ad-focus-jump) 30%, transparent),
                0 0 22px color-mix(in srgb, var(--ad-focus-jump) 40%, transparent);
  }
}
/* 缩略图比例跟项目画幅走（--sb-ar 由 .sb-grid 注入；缺省按竖屏 9:16） */
.sb-thumb { position: relative; aspect-ratio: var(--sb-ar, 9 / 16); background: var(--ad-bg-soft); cursor: pointer; }
.sb-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sb-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); font-size: 26px; }
.sb-no {
  position: absolute; top: 8px; left: 8px;
  max-width: calc(100% - 64px); /* 给右侧时长签让位 */
  padding: 2px 9px; border-radius: var(--ad-radius-pill);
  background: rgba(0, 0, 0, .62); color: #fff;
  font-size: 11px; font-weight: 700; font-family: var(--ad-font-mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sb-dur {
  position: absolute; top: 8px; right: 8px;
  padding: 2px 7px; border-radius: var(--ad-radius-pill);
  background: rgba(0, 0, 0, .62); color: #fff;
  font-size: 11px; font-family: var(--ad-font-mono);
}
/* 已审角标（分镜号签下方；绿底白字示「通过」语义） */
.sb-reviewed {
  position: absolute; top: 36px; left: 8px;
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 8px; border-radius: var(--ad-radius-pill);
  background: color-mix(in srgb, var(--ad-success) 82%, #000); color: #fff;
  font-size: 11px; font-weight: 700;
  pointer-events: none;
}
.sb-reviewed .el-icon { font-size: 11px; }
/* 删除视频小按钮（时长签下方，卡片直达） */
.sb-delvideo {
  position: absolute; top: 36px; right: 8px;
  width: 24px; height: 24px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, .35); background: rgba(0, 0, 0, .55); color: #fff;
  font-size: 13px; cursor: pointer;
  transition: background .15s, border-color .15s;
}
.sb-delvideo:hover { background: var(--ad-danger); border-color: var(--ad-danger); }
.sb-delvideo:disabled { opacity: .45; cursor: not-allowed; }
.sb-play {
  position: absolute; inset: 0; margin: auto;
  width: 44px; height: 44px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .55); color: #fff; font-size: 22px;
  opacity: 0; transition: opacity .18s;
}
.sb-thumb:hover .sb-play { opacity: 1; }
.sb-gen {
  position: absolute; inset: 0; margin: auto;
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .5); color: var(--ad-brand); font-size: 20px;
}
/* 底部叠图浮层：本镜剧本常驻（图片上，非图下方），资产名悬停出现 */
.sb-thumb-bottom {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 20px 8px 7px;
  background: linear-gradient(transparent, rgba(0, 0, 0, .78) 45%);
  pointer-events: none;
}
.sb-desc {
  font-size: 11.5px; line-height: 1.5; color: #fff;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-line;
}
.sb-hover-refs { display: none; flex-wrap: wrap; gap: 4px; }
.sb-thumb:hover .sb-hover-refs { display: flex; }
.sb-desc + .sb-hover-refs { margin-top: 5px; }
.sb-ref {
  padding: 1px 8px; border-radius: var(--ad-radius-pill);
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border);
  font-size: 11px; color: var(--ad-text-muted);
}
.sb-ref.more { border-style: dashed; }
.sb-actions { display: flex; align-items: center; gap: 6px; padding: 8px 12px 12px; }
.sb-actions .el-button { flex: 1; }
.sb-more {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; flex: 0 0 auto;
  border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm);
  background: transparent; color: var(--ad-text-soft); cursor: pointer;
}
.sb-more:hover { color: var(--ad-brand); border-color: var(--ad-brand); }
.sb-danger-item { color: var(--ad-danger) !important; }

/* 卡片勾选框（操作行左侧） */
.sb-actions .sb-sel { height: auto; margin-right: 2px; }

/* 编辑抽屉：本镜资产网格（缩略图 + 名称 + 移除） */
.sb-asset-grid { display: flex; flex-direction: column; gap: 8px; }
.sb-asset-item {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 8px; border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-soft); position: relative;
}
.sb-asset-thumb {
  width: 56px; height: 40px; border-radius: 6px; overflow: hidden; flex: 0 0 auto;
  background: var(--ad-bg-elevated); color: var(--ad-text-muted);
  display: flex; align-items: center; justify-content: center; position: relative;
}
.sb-asset-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sb-asset-thumb.clickable { cursor: zoom-in; }
.sb-asset-thumb.clickable:hover img { opacity: .82; }
.sb-asset-play {
  position: absolute; inset: 0; margin: auto; width: 22px; height: 22px; border-radius: 50%;
  background: rgba(0, 0, 0, .55); color: #fff; font-size: 12px;
  display: flex; align-items: center; justify-content: center; pointer-events: none;
}
.sb-asset-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sb-asset-name { font-size: 12.5px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-asset-kind { align-self: flex-start; font-size: 11px; color: var(--ad-text-muted); }
.sb-asset-rm { flex: 0 0 auto; color: var(--ad-text-muted); cursor: pointer; transition: color .15s; }
.sb-asset-rm:hover { color: var(--ad-danger); }
.sb-asset-add {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 10px; border: 1px dashed var(--ad-border); border-radius: var(--ad-radius-sm);
  background: transparent; color: var(--ad-text-muted); font-size: 12.5px; cursor: pointer;
  transition: border-color .15s, color .15s;
}
.sb-asset-add:hover { border-color: var(--ad-brand); color: var(--ad-brand); }

/* 资产点选弹窗 */
.sb-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; max-height: 52vh; overflow-y: auto; }
.sb-picker-item {
  display: flex; flex-direction: column; align-items: stretch; gap: 4px;
  padding: 6px; border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-soft); cursor: pointer; text-align: left;
  transition: border-color .15s, transform .15s;
}
.sb-picker-item:hover { border-color: var(--ad-brand); transform: translateY(-1px); }
.sb-picker-item .sb-asset-thumb { width: 100%; height: 72px; }
.sb-picker-empty { padding: 20px 0; text-align: center; }
.sb-ap-img { width: 100%; max-height: 72vh; object-fit: contain; display: block; border-radius: var(--ad-radius-sm); }

/* 按集角色服饰弹窗（与 workspace StoryboardEditor 同名同款；append-to-body 弹窗 slot 内容带本组件 data-v，scoped 可达） */
.sb-costume { flex: 0 0 auto; }
.ast-thumb { width: 40px; height: 40px; border-radius: 8px; background: var(--ad-bg-soft); overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); flex-shrink: 0; position: relative; }
.ast-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ast-thumb.sm { width: 28px; height: 28px; border-radius: 6px; }
.costume-cfg-desc { margin-bottom: 12px; line-height: 1.6; }
/* 服饰选择：缩略图卡片（点击卡片=选用，右下放大镜=预览大图）；缩略图 16:9（96x54） */
.costume-pick { display: flex; flex-wrap: wrap; gap: 8px; }
.costume-pick-item {
  position: relative; width: 96px; padding: 4px; cursor: pointer; text-align: center;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.costume-pick-item:hover { border-color: var(--ad-accent); }
.costume-pick-item.is-active { border-color: var(--ad-accent); box-shadow: 0 0 0 1px var(--ad-accent); }
.costume-pick-thumb {
  position: relative; display: flex; align-items: center; justify-content: center;
  width: 100%; height: 54px; border-radius: 6px; overflow: hidden;
  background: var(--ad-bg); color: var(--ad-text-muted);
}
.costume-pick-thumb img { width: 100%; height: 100%; object-fit: cover; }
.costume-pick-zoom {
  position: absolute; right: 3px; bottom: 3px; width: 20px; height: 20px; padding: 0; border: none;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); color: #fff; border-radius: 5px; cursor: zoom-in;
  opacity: 0; transition: opacity 0.18s;
}
.costume-pick-item:hover .costume-pick-zoom { opacity: 1; }
.costume-pick-name {
  display: block; margin-top: 4px; font-size: 11px; line-height: 1.4; color: var(--ad-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.costume-pick-check {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; font-size: 10px;
  background: var(--ad-accent); color: #fff; border-radius: 50%;
}

/* 编辑抽屉 */
.sb-form { display: flex; flex-direction: column; gap: 14px; }
.sb-field { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.sb-field > label { font-size: 12.5px; font-weight: 700; color: var(--ad-text-soft); }
.sb-field-row { display: flex; gap: 14px; }

@media (max-width: 900px) {
  .sbd { padding: 10px; }
  /* 窄屏列宽整体 ×0.8：竖屏 150px（与旧固定值一致），横屏等比缩小，画幅间仍等面积 */
  .sb-grid { grid-template-columns: repeat(auto-fill, minmax(calc(var(--sb-col-min, 188px) * 0.8), 1fr)); }
}

/* 大窗口预览（与 EpisodeList 同款） */
.preview-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--ad-text); }
.preview-head .el-icon { color: var(--ad-brand); }
/* 审阅按钮（预览头部右侧；弹窗 teleport 到 body，slot 内容仍带 data-v，scoped 可达；
   头部 padding-right 64px 已让位右上角关闭圆钮） */
.preview-review { margin-left: auto; }
.preview-review.done { color: var(--ad-success); border-color: color-mix(in srgb, var(--ad-success) 55%, transparent); background: color-mix(in srgb, var(--ad-success) 14%, transparent); }
.preview-body { width: 100%; position: relative; }
.preview-body :deep(.vp) { max-height: 78vh; height: auto; }
/* 头部镜头序号（第 n / 共 m） */
.preview-pos { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--ad-text-muted); }
/* 上一镜/下一镜切换钮（弹窗左右缘垂直居中；slot 内容带 data-v，scoped 可达） */
.pv-nav {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 5;
  width: 44px; height: 44px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, .28); background: rgba(0, 0, 0, .45); color: #fff;
  font-size: 20px; cursor: pointer;
  transition: background .15s, border-color .15s;
}
.pv-nav:hover { background: var(--ad-brand); border-color: var(--ad-brand); color: #10131a; }
.pv-nav.prev { left: 16px; }
.pv-nav.next { right: 16px; }
/* 删除本镜视频钮（预览左上角；头部是浮层占约 54px 高，top 让开头部渐变）：
   圆钮同 pv-nav 口径，红 hover 区分危险语义 */
.pv-del {
  position: absolute; top: 64px; left: 16px; z-index: 5;
  width: 44px; height: 44px; border-radius: 50%; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, .28); background: rgba(0, 0, 0, .45); color: #fff;
  font-size: 18px; cursor: pointer;
  transition: background .15s, border-color .15s;
}
.pv-del:hover { background: rgba(239, 68, 68, .9); border-color: rgba(239, 68, 68, .9); color: #fff; }
@media (max-width: 768px) {
  .pv-nav { width: 36px; height: 36px; font-size: 17px; }
  .pv-nav.prev { left: 8px; }
  .pv-nav.next { right: 8px; }
  .pv-del { width: 36px; height: 36px; font-size: 16px; top: 56px; left: 8px; }
}
</style>

<!-- 抽屉/气泡 teleport 到 body，scoped 样式够不到，需非 scoped 块（同 DefaultLayout mnav-drawer 惯例） -->
<style>
/* 场景剧本上方间距：Element Plus 抽屉头默认 margin-bottom 32px，收紧 */
.sb-edit-drawer .el-drawer__header { margin-bottom: 12px; }
.sb-edit-drawer .el-drawer__body { padding-top: 0; }
/* 分镜视频预览窗口：全屏铺满（100vw × 100vh），视频贴边。
   头部改为浮层（不占布局高度）→ 视频区撑满整窗高度；
   非 scoped 块（append-to-body teleport）；选择器压过 scoped 的 .preview-body :deep(.vp) 78vh 旧规 */
.sb-preview-dialog {
  height: 100vh;
  margin-bottom: 0;   /* EP 默认 bottom 50px，全屏会顶出滚动条 */
  padding: 0;         /* 去掉对话框自身 16px 内边距，视频贴边 */
  border-radius: 0 !important; /* 全局 .el-dialog 圆角带 !important，此处须同级才能归零（真全屏直角） */
  background: #000;   /* 视频撑满整窗，露底即黑 */
  display: flex; flex-direction: column;
}
.sb-preview-dialog .el-dialog__header {
  position: absolute; top: 0; left: 0; right: 0; z-index: 10;
  padding: 12px 64px 18px 16px; /* 右侧留出关闭按钮位 */
  background: linear-gradient(rgba(0, 0, 0, .62), transparent);
}
.sb-preview-dialog .el-dialog__header .preview-head { color: #fff; }
.sb-preview-dialog .el-dialog__header .preview-head .el-icon { color: var(--ad-brand); }
/* max-height:none 顶掉 theme.scss 全局 body 上限（100dvh-240px），全屏时视频区才能真正撑满 */
.sb-preview-dialog .el-dialog__body { flex: 1; min-height: 0; max-height: none; display: flex; flex-direction: column; }
.sb-preview-dialog .el-dialog__body .preview-body { flex: 1; min-height: 0; display: flex; justify-content: center; }
/* 视频区按项目画幅 contain 适配：高恒撑满，宽=高×画幅（超宽时被 max-width 钳制，比例经 aspect-ratio 传导保持） */
.sb-preview-dialog .el-dialog__body .preview-body .vp { height: 100%; max-height: 100%; width: auto; max-width: 100%; aspect-ratio: var(--pv-ar, 9 / 16); border-radius: 0; }
/* 关闭按钮：金色圆形高亮（EP 默认为右上角透明小叉） */
.sb-preview-dialog .el-dialog__headerbtn {
  top: 10px; right: 12px; width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--ad-brand);
  font-size: 20px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .5);
  transition: transform .15s, background .15s;
}
.sb-preview-dialog .el-dialog__headerbtn .el-dialog__close { color: #10131a; font-weight: 700; }
.sb-preview-dialog .el-dialog__headerbtn:hover { background: color-mix(in srgb, var(--ad-brand) 82%, #fff); transform: scale(1.08); }
.sb-preview-dialog .el-dialog__headerbtn:hover .el-dialog__close { color: #10131a; }
</style>
