<script setup>
/**
 * 分镜编辑器（client StoryboardEditor 移植，移动端单列）：
 * 分镜卡手风琴列表（点开展开：镜头剧本/提示词/生成动作/本镜资产/转场/移动/插入）
 * + 底部分镜轴（显隐开关，默认隐藏、本地记忆）+「功能」菜单（审计/批量提示词/串行·并发生成/合成全集）
 * + 按集角色服饰配置 + 分镜审计报告 + 本镜视频/资产预览 + 音色试听。
 */
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount, getCurrentInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad, onShow, onUnload, onPullDownRefresh } from '@dcloudio/uni-app';
import {
  storyboardApi, videoApi, assetApi, scriptApi, modelApi, projectApi, voiceApi,
} from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useBackGuard } from '../../composables/useBackGuard';
import { useJobsStore } from '../../stores/jobs';
import { useThemeStore } from '../../stores/theme';
import { can } from '../../utils/perms';
import { toast, confirm, actionSheet } from '../../utils/ui';
import { toAbsolute } from '../../utils/media';
import { saveVideo } from '../../utils/download';
import { statusBarHeight, navBarContentHeight } from '../../utils/system';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import VideoPlayerPopup from '../../components/video-player-popup/video-player-popup.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import AdDownloadDialog from '../../components/ad-download-dialog/ad-download-dialog.vue';

const { t } = useI18n();
const { runJob, runJobs } = useCostAction();
const jobs = useJobsStore();
const theme = useThemeStore();

const projectId = ref(null);
const episodeId = ref(null);

const episode = ref(null);
const episodes = ref([]);
const project = ref(null);
const segments = ref([]);
const assets = ref([]);
const activeId = ref(null);
const loading = ref(false);
const expandedId = ref(null); // 手风琴：展开的镜 id（移动端一次一个）

// 团队共享权限
const canEditStoryboard = computed(() => can(project.value, 'storyboard.edit'));
const canGen = computed(() => can(project.value, 'ai.generate'));
const canVideo = computed(() => can(project.value, 'video.manage'));
const canEditAsset = computed(() => can(project.value, 'asset.edit'));
const readonlyAll = computed(() => !canEditStoryboard.value && !canGen.value && !canVideo.value && !canEditAsset.value);

// ===== 视频模型 + 分辨率 =====
const videoModels = ref([]);
const videoModelId = ref(null);
const videoResolution = ref(null);
const activeVideoModel = computed(() => videoModels.value.find((m) => m.id === videoModelId.value) || null);
watch(videoModelId, () => {
  const m = activeVideoModel.value;
  const list = m && Array.isArray(m.resolutions) ? m.resolutions : [];
  videoResolution.value = list.length ? list[0].value : null;
});

// ===== 任务驱动的 busy =====
const batchJob = computed(() => jobs.activeOf('segment_video_batch', Number(episodeId.value)));
const batchConcurrentJob = computed(() => jobs.activeOf('segment_video_batch_concurrent', Number(episodeId.value)));
const uploadingMap = ref({});
// 提交窗口占位：确认页提交成功后、任务列表轮询到该 job 前（≤2s）保持按钮禁用，防连点双提交
const pendingGen = ref({});
const segEditBusy = (s) => jobs.items.some((j) => j.type === 'video_edit' && String(j.ref_id) === String(s.id) && j.meta?.editSource === 'segment' && (j.status === 'pending' || j.status === 'running'));
const isBusy = (s) => !!(jobs.activeOf('segment_generate', s.id) || jobs.activeOf('segment_video', s.id) || jobs.activeOf('segment_erase_subtitle', s.id) || segEditBusy(s) || (batchJob.value && s.status === 'generating') || (batchConcurrentJob.value && s.status === 'generating') || uploadingMap.value[s.id] || pendingGen.value[s.id]);
const isBusyPrompt = (s) => !!jobs.activeOf('segment_prompt', s.id);
const composeJob = computed(() => jobs.activeOf('video_synthesis', Number(episodeId.value)));

const activeSegment = computed(() => segments.value.find((s) => s.id === activeId.value) || segments.value[0] || null);
const selectedCount = computed(() => segments.value.filter((s) => s.selected).length);
const batchProgress = computed(() => ({
  index: batchJob.value?.meta?.index || 0,
  total: batchJob.value?.meta?.total || 0,
  running: !!batchJob.value,
}));
const cancellingBatch = ref(false);
const batchConcurrentProgress = computed(() => ({
  done: batchConcurrentJob.value?.meta?.done || 0,
  total: batchConcurrentJob.value?.meta?.total || 0,
  running: !!batchConcurrentJob.value,
}));
const cancellingConcurrent = ref(false);
const anyBatchRunning = computed(() => batchProgress.value.running || batchConcurrentProgress.value.running);
// ===== 合成分辨率档位（记忆上次所选） =====
const COMPOSE_RESOLUTIONS = ['480p', '720p', '768p', '1080p', '2K', '4K'];
const COMPOSE_RES_KEY = 'aidrama:composeResolution';
const composeResolution = ref((() => {
  try {
    const v = uni.getStorageSync(COMPOSE_RES_KEY);
    if (COMPOSE_RESOLUTIONS.includes(v)) return v;
  } catch { /* ignore */ }
  return '1080p';
})());

// ===== 分镜审计 =====
const auditState = reactive({ running: false, open: false, report: null, fixAssets: true, fixDuration: true, applying: false });
const auditItems = computed(() => auditState.report?.items || []);
const auditSummary = computed(() => auditState.report?.summary || {});
const auditVisibleItems = computed(() => auditItems.value.filter((i) =>
  i.missingAssets.length || i.duration.changed || i.duration.overflow || i.warnings.length));
const auditHasFixable = computed(() => auditVisibleItems.value.some((i) =>
  (auditState.fixAssets && i.missingAssets.length) || (auditState.fixDuration && i.duration.changed)));
async function runAudit() {
  auditState.running = true;
  try {
    auditState.report = await storyboardApi.auditSegments(episodeId.value);
    auditState.open = true;
  } catch { /* http 层已提示 */ } finally { auditState.running = false; }
}
async function applyAuditFixes() {
  if (!auditState.report || !auditHasFixable.value) { auditState.open = false; return; }
  auditState.applying = true;
  try {
    const r = await storyboardApi.applyAudit(episodeId.value, { fixAssets: auditState.fixAssets, fixDuration: auditState.fixDuration });
    toast(t('storyboard.auditApplied', { a: r.stats.assetsApplied, d: r.stats.durationApplied }), 'success');
    auditState.open = false;
    await load();
  } catch { /* http 层已提示 */ } finally { auditState.applying = false; }
}

// ===== 资产展示 =====
const KIND_ICON = { character: 'user', scene: 'drop', prop: 'case', material: 'import', video: 'video' };
const kindLabel = (k) => t('storyboard.assetKind.' + k);
const kindIcon = (k) => KIND_ICON[k] || 'import';
const leftList = computed(() => {
  const seg = activeSegment.value;
  if (!seg) return [];
  const ids = new Set((seg.asset_refs || []).map((r) => r.id));
  return assets.value.filter((a) => ids.has(a.id));
});

// ===== 按集角色服饰 =====
const costumeCfg = reactive({ rows: [] }); // load() 预取；弹层内可改
const episodeAssetIds = computed(() => {
  const ids = new Set();
  for (const s of segments.value) for (const r of (s.asset_refs || [])) if (r && r.id != null) ids.add(Number(r.id));
  return ids;
});
const costumeCfgShow = ref(false);
const costumeCfgLoading = ref(false);
const costumeCfgSaving = ref(false);
const costumeShowAll = ref(false);
const costumeCfgRows = computed(() => {
  if (costumeShowAll.value) return costumeCfg.rows;
  const ids = episodeAssetIds.value;
  return costumeCfg.rows.filter((r) => ids.has(Number(r.asset_id)));
});
const costumeOverrideMap = computed(() => {
  const m = {};
  for (const row of costumeCfg.rows) {
    if (!row.costume_id) continue;
    const c = (row.costumes || []).find((x) => x.id === row.costume_id);
    if (c && c.image_url) m[row.asset_id] = c;
  }
  return m;
});
const costumeOf = (a) => (a.kind === 'character' ? costumeOverrideMap.value[a.id] : null);
const shotThumbUrl = (a) => {
  const c = costumeOf(a);
  if (c) return toAbsolute(c.thumb_url || c.image_url);
  return toAbsolute(a.thumb_url || a.image_url);
};
const shotImageUrl = (a) => {
  const c = costumeOf(a);
  return toAbsolute((c && c.image_url) || a.image_url || '');
};
const rowDefaultImg = (row) => {
  const list = row?.costumes || [];
  const def = list.find((c) => c.is_default) || list[0];
  return toAbsolute(def?.thumb_url || def?.image_url || '');
};

async function openCostumeConfig() {
  costumeCfgShow.value = true;
  costumeCfgLoading.value = true;
  costumeShowAll.value = false;
  try {
    const rows = await assetApi.episodeCostumeConfig(episodeId.value);
    costumeCfg.rows = Array.isArray(rows) ? rows : [];
  } catch (e) {
    toast(e?.message || t('errors.requestFailed'), 'error');
  } finally { costumeCfgLoading.value = false; }
}
function pickCostume(row, cid) {
  row.costume_id = row.costume_id === cid ? null : cid; // 再点取消覆盖
}
async function saveCostumeConfig() {
  costumeCfgSaving.value = true;
  try {
    const configs = costumeCfg.rows.map((r) => ({ asset_id: r.asset_id, costume_id: r.costume_id || null }));
    await assetApi.saveEpisodeCostumeConfig(episodeId.value, configs);
    toast(t('asset.costumeConfig.saved'), 'success');
    costumeCfgShow.value = false;
  } catch (e) {
    toast(e?.message || t('errors.requestFailed'), 'error');
  } finally { costumeCfgSaving.value = false; }
}

// ===== 预览（图片 / 视频 / 音色） =====
const previewList = computed(() => leftList.value.filter((a) => shotImageUrl(a)).map((a) => shotImageUrl(a)));
function previewAsset(a) {
  if (a.kind === 'video' && a.meta?.videoUrl) {
    shotVideo.url = a.meta.videoUrl;
    shotVideo.name = a.name;
    shotVideo.open = true;
    return;
  }
  const url = shotImageUrl(a);
  if (!url) return;
  const urls = previewList.value.length ? previewList.value : [url];
  uni.previewImage({ urls, current: url });
}
const shotVideo = reactive({ open: false, url: '', name: '' });

const voices = ref([]);
let voicesLoaded = false;
async function ensureVoices() {
  if (voicesLoaded) return;
  voicesLoaded = true;
  try { voices.value = await voiceApi.list(); } catch { /* 拉不到音色则试听按钮不渲染 */ }
}
const shotVoiceChars = computed(() => leftList.value
  .filter((a) => a.kind === 'character' && a.meta?.voiceId)
  .map((a) => ({ asset: a, voice: voices.value.find((v) => v.id === Number(a.meta.voiceId)) }))
  .filter((x) => x.voice?.audio_url));
const voiceIdOf = (a) => (a.kind === 'character' && a.meta?.voiceId ? Number(a.meta.voiceId) : null);
let audioCtx = null;
const previewVoiceId = ref(null);
function toggleVoicePreview(voiceId) {
  if (previewVoiceId.value === voiceId) {
    audioCtx?.stop();
    previewVoiceId.value = null;
    return;
  }
  const v = voices.value.find((x) => x.id === voiceId);
  if (!v?.audio_url) { toast(t('voice.noPreviewSample'), 'error'); return; }
  if (!audioCtx) {
    audioCtx = uni.createInnerAudioContext();
    audioCtx.onEnded(() => { previewVoiceId.value = null; });
    audioCtx.onError(() => { previewVoiceId.value = null; toast(t('voice.noPreviewSample'), 'error'); });
  }
  audioCtx.stop();
  audioCtx.src = toAbsolute(v.audio_url);
  audioCtx.play();
  previewVoiceId.value = voiceId;
}
watch(() => shotVideo.open, (o) => { if (!o) { audioCtx?.stop(); previewVoiceId.value = null; } });

// App/系统返回：本镜视频预览开着时先关预览不退页，否则只回父级一层
// （编辑分镜是独立页，自管返回确认；H5 由各弹层组件内的 popstate 兜住；mp 端无拦截 API）
useBackGuard(() => {
  if (!shotVideo.open) return false;
  shotVideo.open = false;
  return true;
});

// ===== 本镜资产增删 =====
const assetPicker = reactive({ open: false, kind: '', q: '' });
const pickerSelected = ref([]);
const refAssetIds = computed(() => new Set((activeSegment.value?.asset_refs || []).map((r) => r.id)));
const isRefAsset = (id) => refAssetIds.value.has(id);
const pickerSelectedSet = computed(() => new Set(pickerSelected.value));
const pickerCandidates = computed(() => {
  const q = assetPicker.q.trim().toLowerCase();
  return assets.value.filter((a) => {
    if (assetPicker.kind && a.kind !== assetPicker.kind) return false;
    if (q && !String(a.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
});
function openAssetPicker() {
  if (!activeSegment.value) return;
  assetPicker.kind = '';
  assetPicker.q = '';
  pickerSelected.value = [];
  assetPicker.open = true;
}
function togglePick(a) {
  if (isRefAsset(a.id)) return;
  const set = new Set(pickerSelected.value);
  if (set.has(a.id)) set.delete(a.id);
  else set.add(a.id);
  pickerSelected.value = [...set];
}
async function persistAssetRefs(seg) {
  try {
    await storyboardApi.updateSegment(seg.id, { asset_refs: seg.asset_refs || [] });
  } catch {
    toast(t('storyboard.persistAssetsFail'), 'error');
  }
}
async function confirmPickAssets() {
  const seg = activeSegment.value;
  if (!seg) return;
  const existing = refAssetIds.value;
  const adds = assets.value
    .filter((a) => pickerSelectedSet.value.has(a.id) && !existing.has(a.id))
    .map((a) => ({ type: a.kind, id: a.id, name: a.name }));
  if (!adds.length) { assetPicker.open = false; return; }
  seg.asset_refs = [...(seg.asset_refs || []), ...adds];
  await persistAssetRefs(seg);
  assetPicker.open = false;
  pickerSelected.value = [];
  toast(t('storyboard.assetsAdded', { count: adds.length }), 'success');
}
async function removeAsset(a) {
  const seg = activeSegment.value;
  if (!seg) return;
  seg.asset_refs = (seg.asset_refs || []).filter((r) => r.id !== a.id);
  await persistAssetRefs(seg);
  toast(t('storyboard.assetRemoved', { name: a.name }), 'success');
}

async function load() {
  loading.value = true;
  try {
    const [ep, segs, asts, vms, proj] = await Promise.all([
      scriptApi.getEpisode(episodeId.value),
      storyboardApi.segments(episodeId.value),
      assetApi.list(projectId.value),
      modelApi.list('video', { enabledOnly: true }),
      projectApi.get(projectId.value),
    ]);
    episode.value = ep;
    episodes.value = proj?.episodes || [];
    project.value = proj || null;
    segments.value = segs;
    assets.value = asts;
    videoModels.value = (vms || []).filter((m) => m.enabled !== false);
    if (videoModels.value.length && !videoModels.value.some((m) => m.id === videoModelId.value)) {
      const def = videoModels.value.find((m) => m.is_default) || videoModels.value[0];
      videoModelId.value = def.id;
      const list = Array.isArray(def.resolutions) ? def.resolutions : [];
      videoResolution.value = list.length ? list[0].value : null;
    }
    // 深链指定镜优先：选中 + 展开并滚到吸顶栏下方（selectFromTimeline 的手动版，
    // 卡片 DOM 经 nextTick 渲染后 scrollCardToTop 才查得到 #sbcard-{id}）
    const want = pendingSid != null ? segs.find((s) => String(s.id) === String(pendingSid)) : null;
    pendingSid = null;
    if (want) {
      activeId.value = want.id;
      expandedId.value = want.id;
      nextTick(() => { scrollStripTo(want.id); scrollCardToTop(want.id); });
    } else if (!activeId.value || !segs.find((s) => s.id === activeId.value)) {
      activeId.value = segs[0]?.id ?? null;
      expandedId.value = segs[0]?.id ?? null;
    }
    try {
      const cfgRows = await assetApi.episodeCostumeConfig(episodeId.value);
      costumeCfg.rows = Array.isArray(cfgRows) ? cfgRows : [];
    } catch { /* ignore */ }
  } catch (err) {
    if (err?.status === 403 || err?.status === 404) uni.redirectTo({ url: '/pages/projects/index' });
  } finally {
    loading.value = false;
  }
}

// ===== 集数切换 =====
const epShow = ref(false);
function switchEpisode(eid) {
  if (!eid || Number(eid) === Number(episodeId.value)) { epShow.value = false; return; }
  epShow.value = false;
  activeId.value = null;
  expandedId.value = null;
  // 同页参数跳转：redirectTo 自身会重挂载，等于完整重置本页状态
  uni.redirectTo({ url: `/pages/workspace/storyboard?pid=${projectId.value}&eid=${eid}` });
}

// ===== 卡片手风琴 / 编辑 =====
function toggleShot(s) {
  const willExpand = expandedId.value !== s.id;
  expandedId.value = willExpand ? s.id : null;
  activeId.value = s.id;
  scrollStripTo(s.id);
  if (willExpand) scrollCardToTop(s.id); // 展开时把卡片头吸到导航栏下方，长内容从可见处开始看
}
function selectSegment(s) {
  activeId.value = s.id;
  expandedId.value = s.id;
}

// ===== 底部时间轴（client StoryboardEditor 底部轴移植）=====
// 轴横向滚动跟随当前镜：scroll-into-view 只在值变化时触发，先清空再赋值保证同镜也能复位。
const pageInstance = getCurrentInstance();
const stripScrollId = ref('');
function scrollStripTo(id) {
  stripScrollId.value = '';
  nextTick(() => { stripScrollId.value = 'tlseg-' + id; });
}
// 吸顶滚动动画：部分端 pageScrollTo 的 duration 不生效（表现为瞬跳），统一用逐帧 pageScrollTo
// 自绘 easeOutCubic 曲线保证全端一致；seq 号让新动画打断旧动画
let scrollAnimSeq = 0;
function animateScrollTo(target, dur = 260) {
  const seq = ++scrollAnimSeq;
  return new Promise((resolve) => {
    try {
      const q = uni.createSelectorQuery().in(pageInstance && pageInstance.proxy);
      q.selectViewport().scrollOffset();
      q.exec((res) => {
        if (seq !== scrollAnimSeq) { resolve(); return; }
        const from = (res && res[0] && res[0].scrollTop) || 0;
        const dist = target - from;
        if (Math.abs(dist) < 2) { resolve(); return; }
        const t0 = Date.now();
        const tick = () => {
          if (seq !== scrollAnimSeq) { resolve(); return; }
          const p = Math.min(1, (Date.now() - t0) / dur);
          uni.pageScrollTo({ scrollTop: Math.round(from + dist * (1 - Math.pow(1 - p, 3))), duration: 0 });
          if (p < 1) setTimeout(tick, 16);
          else resolve();
        };
        tick();
      });
    } catch { resolve(); }
  });
}
// 落顶高亮：卡片头闪一下品牌金再淡出，让「吸附到导航栏下」有可见反馈
const stuckId = ref(null);
let stuckTimer = null;
function flashStuck(id) {
  stuckId.value = id;
  if (stuckTimer) clearTimeout(stuckTimer);
  stuckTimer = setTimeout(() => { stuckId.value = null; stuckTimer = null; }, 720);
}
// 把指定分镜卡滚到吸顶导航栏正下方（client 用 scrollIntoView，跨端改 SelectorQuery + 逐帧滚动）
// 导航高 = 状态栏 + 内容行高（.anb 在子组件内，mp 端页面级查询选不到，按公式算；
// 内容行高走 utils/system 的 navBarContentHeight，mp 端与胶囊对齐后 < 48）
function scrollCardToTop(id) {
  nextTick(() => {
    try {
      const headH = statusBarHeight() + navBarContentHeight();
      const q = uni.createSelectorQuery().in(pageInstance && pageInstance.proxy);
      q.select('#sbcard-' + id).boundingClientRect();
      q.selectViewport().scrollOffset();
      q.exec(async (res) => {
        const rect = res && res[0];
        const off = (res && res[1]) || {};
        if (!rect) return;
        await animateScrollTo(Math.max(0, (off.scrollTop || 0) + rect.top - headH - 8));
        flashStuck(id);
      });
    } catch { /* 个别端不支持时仅切换选中，不滚动 */ }
  });
}
// 点轴上缩略图：激活并展开对应分镜卡
function selectFromTimeline(s) {
  selectSegment(s);
  scrollStripTo(s.id);
  scrollCardToTop(s.id);
}
// 轴头 ‹ › 切换当前镜（client 用键盘 ←/→，移动端降级为按钮）
const activeIdx = computed(() => segments.value.findIndex((s) => s.id === activeId.value));
function navigateShot(dir) {
  if (!segments.value.length) return;
  const cur = activeIdx.value;
  const next = Math.min(Math.max((cur < 0 ? 0 : cur) + dir, 0), segments.value.length - 1);
  const target = segments.value[next];
  if (!target || target.id === activeId.value) return;
  selectFromTimeline(target);
}

// ===== 编辑分镜（独立页 /pages/workspace/segment-edit，EventChannel 传入本镜；
// 保存后 uni.$emit('segment:updated') 回填列表） =====
function startEdit(s) {
  uni.navigateTo({
    url: `/pages/workspace/segment-edit?sid=${s.id}&eid=${episodeId.value || ''}`,
    success: (res) => res.eventChannel.emit('segment', s),
  });
}
function onSegmentUpdated(payload) {
  const i = segments.value.findIndex((x) => x.id === payload.id);
  if (i > -1) Object.assign(segments.value[i], payload);
}
const TRANSITION_VALUES = ['cut', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'circleclose', 'radial', 'pixelize'];
const normTrans = (v) => (!v || v === 'auto' ? 'cut' : v);
const transLabel = (v) => t('storyboard.transition.' + normTrans(v));
const TRANSITION_OPTIONS = computed(() => TRANSITION_VALUES.map((v) => ({ value: v, label: transLabel(v) })));
const TRANSITION_SHORT_VALUES = ['cut', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'slideleft', 'slideright'];
const TRANSITION_SHORT = computed(() => TRANSITION_SHORT_VALUES.map((v) => ({ value: v, label: transLabel(v) })));
const transShortLabel = (value) => {
  const v = normTrans(value);
  const hit = TRANSITION_OPTIONS.value.find((o) => o.value === v);
  return hit ? hit.label.slice(0, 2) : t('storyboard.transitionShort.cut');
};
const isTransSet = (value) => normTrans(value) !== 'cut';

// ===== 转场快捷设置（弹层） =====
const transShow = ref(false);
const transTarget = ref(null);
function openTransSheet(s) {
  transTarget.value = s;
  transShow.value = true;
}
async function pickTransition(s, value) {
  transShow.value = false;
  if (normTrans(s.transition) === value) return;
  const prev = s.transition;
  s.transition = value;
  try {
    await storyboardApi.updateSegment(s.id, { transition: value });
    const label = TRANSITION_OPTIONS.value.find((o) => o.value === value)?.label || value;
    toast(t('storyboard.transitionSet', { name: label }), 'success');
  } catch {
    s.transition = prev;
    toast(t('storyboard.setTransitionFail'), 'error');
  }
}

// ===== 插入 / 移动 / 删除分镜 =====
async function insertBlankSegment(payload) {
  try {
    const created = await storyboardApi.createSegment(episodeId.value, payload);
    segments.value = await storyboardApi.segments(episodeId.value);
    activeId.value = created.id;
    expandedId.value = created.id;
    toast(t('storyboard.segmentAdded'), 'success');
  } catch { /* http 层已提示 */ }
}
const insertAfter = (s) => insertBlankSegment({ afterId: s.id });
const insertFirst = () => {
  const first = segments.value[0];
  return insertBlankSegment(first ? { beforeId: first.id } : {});
};
const movingMap = ref({});
async function moveSegment(s, direction) {
  if (movingMap.value[s.id]) return;
  movingMap.value[s.id] = true;
  try {
    segments.value = await storyboardApi.moveSegment(s.id, direction);
    toast(t('storyboard.segmentMoved'), 'success');
    scrollStripTo(s.id); // 换位后槽位变化，让该镜保持在轴可视区内
  } catch { /* http 层已提示 */ } finally {
    delete movingMap.value[s.id];
  }
}
async function deleteSegment(s) {
  const ok = await confirm({
    title: t('storyboard.deleteSegmentTitle'),
    content: t('storyboard.deleteSegmentConfirm', { name: s.shot_no || s.idx }),
    danger: true,
  });
  if (!ok) return;
  try {
    await storyboardApi.deleteSegment(s.id);
    segments.value = await storyboardApi.segments(episodeId.value);
    if (activeId.value === s.id) { activeId.value = segments.value[0]?.id ?? null; expandedId.value = activeId.value; }
    toast(t('storyboard.segmentDeleted'), 'success');
  } catch { /* http 层已提示 */ }
}
const delBusy = ref(false);
async function deleteVideo(s) {
  if (!s || !s.video_url || isBusy(s) || delBusy.value) return;
  const ok = await confirm({
    title: t('storyboard.deleteVideoTitle'),
    content: t('storyboard.deleteVideoConfirm'),
    danger: true,
    top: 'max', // 预览弹层（VideoPlayerPopup 900）里也会触发：顶档 980/990 压过它
  });
  if (!ok) return;
  // 删除前记录本镜在「已生成视频」序列中的位置：删除后同位置滑入的就是下一镜
  const prevIdx = playableSegs.value.findIndex((x) => x.id === s.id);
  delBusy.value = true;
  try {
    const fresh = await storyboardApi.deleteVideo(s.id);
    const i = segments.value.findIndex((x) => x.id === s.id);
    if (i > -1) segments.value[i] = fresh;
    toast(t('storyboard.videoDeleted'), 'success');
    // 预览弹层内删除当前镜：自动切到下一镜（与竖滑同规则，只在已生成视频的分镜间移动）；
    // 本镜已是最后一镜则落到上一镜，一条视频都不剩时收起弹层
    if (playerShow.value && s.id === activeId.value) {
      const list = playableSegs.value;
      const next = list[Math.min(prevIdx, list.length - 1)];
      if (next) { activeId.value = next.id; expandedId.value = next.id; }
      else playerShow.value = false;
    }
  } catch { /* http 层已提示 */ } finally {
    delBusy.value = false;
  }
}

// ===== 上传本地视频替换本镜视频 =====
const uploadTargetId = ref(null);
function pickUploadVideo(s) {
  if (!s || isBusy(s)) return;
  uni.chooseVideo({
    success: async (res) => {
      const filePath = res.tempFilePath;
      if (!filePath) return;
      if (s.video_url) {
        const ok = await confirm({ title: t('storyboard.uploadVideo'), content: t('storyboard.replaceVideoConfirm') });
        if (ok) doUpload(s, filePath);
      } else {
        doUpload(s, filePath);
      }
    },
  });
}
async function doUpload(s, filePath) {
  uploadingMap.value[s.id] = true;
  try {
    const fresh = await storyboardApi.uploadVideo(s.id, filePath);
    const i = segments.value.findIndex((x) => x.id === s.id);
    if (i > -1) segments.value[i] = fresh;
    toast(t('storyboard.videoUploaded'), 'success');
  } catch { /* http 层已提示 */ } finally {
    delete uploadingMap.value[s.id];
  }
}

// ===== 播放本镜视频 =====
const playerShow = ref(false);
function playSegment(s) {
  if (!s.video_url) return;
  playerShow.value = true;
}

// ===== 审阅本镜视频（预览弹层顶栏按钮；已审态再点取消审阅） =====
// 换视频（重新生成/上传/剪辑写回/擦字幕）后服务端自动重置为未审
const reviewBusy = ref(false);
async function toggleReview(next) {
  const s = activeSegment.value;
  if (!s?.video_url || !canEditStoryboard.value || reviewBusy.value) return;
  reviewBusy.value = true;
  try {
    const fresh = await storyboardApi.reviewSegment(s.id, next);
    const i = segments.value.findIndex((x) => x.id === s.id);
    if (i > -1) segments.value[i] = fresh;
    toast(fresh.reviewed_at ? t('episode.videos.reviewDone') : t('episode.videos.reviewUndone'), 'success');
  } catch { /* http 层已提示 */ } finally {
    reviewBusy.value = false;
  }
}
// 预览内竖滑切镜：在「已生成视频」的分镜间移动（未生成的镜无视频可放，直接跳过）；
// 首末镜的边界由播放器组件做橡皮筋回弹，这里只管切换
const playableSegs = computed(() => segments.value.filter((x) => x.video_url));
const playIdx = computed(() => playableSegs.value.findIndex((x) => x.id === activeId.value));
const playerTitle = computed(() => {
  const s = activeSegment.value;
  return s ? t('storyboard.timelineShot', { n: s.shot_no || s.idx, dur: s.duration }) : '';
});
function swipeShot(dir) {
  const target = playableSegs.value[playIdx.value + dir];
  if (!target) return;
  activeId.value = target.id;
  expandedId.value = target.id; // 关掉预览后停留在这个镜
}

// ===== 下载本镜视频（共用 utils/download.saveVideo：H5 流式进度/App 下载后入相册，进度条由 AdDownloadDialog 展示）=====
function downloadSegment(s) {
  if (!s || !s.video_url) return;
  saveVideo(toAbsolute(s.video_url), `shot-${s.shot_no || s.idx}.mp4`, {
    ok: t('episode.videos.downloaded'),
    fail: t('episode.videos.downloadFail'),
    perm: t('episode.videos.albumPerm'),
    tip: t('common.tip'),
    okBtn: t('common.ok'),
  });
}

// ===== 选中 =====
const shotTag = (s) => `${episode.value?.title || t('storyboard.episodeN', { n: episode.value?.idx || '?' })} · ${s.shot_no || ('#' + s.idx)}`;
async function toggleSelect(s) {
  s.selected = !s.selected;
  try {
    await storyboardApi.selectSegments(episodeId.value, [s.id], s.selected);
  } catch {
    s.selected = !s.selected;
    toast(t('storyboard.updateSelectFail'), 'error');
  }
}
async function saveSelectAll(val) {
  const ids = segments.value.map((s) => s.id);
  await storyboardApi.selectSegments(episodeId.value, ids, val);
  segments.value.forEach((s) => (s.selected = val));
}

// ===== 生成动作 =====
const requireVideoPrompt = (s) => {
  if (!s.video_prompt) { toast(t('storyboard.needPromptFirst'), 'error'); return false; }
  return true;
};
async function generate(s) {
  if (isBusy(s)) return; // 生成/排队中：按钮已置灰（.dis 不拦截点击），此处兜底禁点
  if (!requireVideoPrompt(s)) return;
  pendingGen.value[s.id] = true;
  try {
    await runJob({
      modelType: 'video',
      selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
      estimateFor: (sel) => storyboardApi.genEstimate(s.id, sel),
      createFor: (sel) => storyboardApi.generateVideo(s.id, sel),
      onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
      title: t('storyboard.genVideoTitle'), desc: t('storyboard.genVideoDesc', { name: shotTag(s) }), confirmText: t('storyboard.generate'),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.segment) {
          const i = segments.value.findIndex((x) => x.id === s.id);
          if (i > -1) segments.value[i] = j.result.segment;
        }
      },
    });
    await jobs.fetchAll(); // 立即同步任务列表，让 isBusy 即刻转灰（不等下一轮 2s 轮询）
  } finally {
    delete pendingGen.value[s.id];
  }
}
// ===== 分镜操作组合菜单（卡内其余按钮收进菜单；视频类操作独立一行放镜头剧本上方） =====
const hasVideoOps = (s) => !!(canEditStoryboard.value || ((canGen.value || canVideo.value) && s.video_url));
async function openSegActions(s, i) {
  const items = [
    canGen.value && { key: 'prompt', icon: 'spark', label: t('storyboard.genVideoPrompt') },
    canGen.value && { key: 'gen', icon: 'video', label: t('storyboard.genVideoTitle') },
    canEditStoryboard.value && { key: 'edit', icon: 'pen', label: t('common.edit') },
    canEditStoryboard.value && i > 0 && !anyBatchRunning.value && { key: 'up', icon: 'up', label: movePrevLabel.value },
    canEditStoryboard.value && i < segments.value.length - 1 && !anyBatchRunning.value && { key: 'down', icon: 'down', label: moveNextLabel.value },
    canEditStoryboard.value && { key: 'trans', icon: 'right', label: `${t('storyboard.thisToNext')} · ${transShortLabel(s.transition)}` },
    canEditStoryboard.value && { key: 'insert', icon: 'plus', label: t('storyboard.addAfterTitle', { name: s.shot_no || s.idx }) },
    /* #ifdef H5 */
    canVideo.value && s.video_url && !isBusy(s) && { key: 'editor', icon: 'cut', label: t('storyboard.editVideo') },
    /* #endif */
    canEditStoryboard.value && { key: 'delSeg', icon: 'trash', label: t('storyboard.deleteSegmentTitle'), danger: true },
  ].filter(Boolean);
  const key = await actionSheet(items, { title: shotTag(s) });
  if (!key) return;
  if (key === 'prompt') genPrompt(s);
  else if (key === 'gen') generate(s);
  else if (key === 'edit') startEdit(s);
  else if (key === 'up') moveSegment(s, -1);
  else if (key === 'down') moveSegment(s, 1);
  else if (key === 'trans') openTransSheet(s);
  else if (key === 'insert') insertAfter(s);
  else if (key === 'editor') openVideoEditor(s);
  else if (key === 'delSeg') deleteSegment(s);
}
async function genPrompt(s) {
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => storyboardApi.genPromptEstimate(s.id, sel),
    createFor: (sel) => storyboardApi.genPrompt(s.id, sel),
    allowRequirement: true,
    title: t('storyboard.genPromptTitle'), desc: t('storyboard.genPromptDesc', { name: shotTag(s) }), confirmText: t('storyboard.generate'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.segment) {
        const i = segments.value.findIndex((x) => x.id === s.id);
        if (i > -1) segments.value[i] = j.result.segment;
      }
    },
  });
}
async function genPromptSelected() {
  const targets = segments.value.filter((s) => s.selected && !isBusyPrompt(s));
  if (!targets.length) { toast(t('storyboard.noPromptTargets'), 'error'); return; }
  await runJobs({
    modelType: 'text',
    items: targets.map((s) => ({
      estimateFor: (sel) => storyboardApi.genPromptEstimate(s.id, sel),
      createFor: (sel) => storyboardApi.genPrompt(s.id, sel),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.segment) {
          const i = segments.value.findIndex((x) => x.id === s.id);
          if (i > -1) segments.value[i] = j.result.segment;
        }
      },
    })),
    title: t('storyboard.batchGenPromptTitle'), desc: t('storyboard.batchGenPromptDesc', { count: targets.length }), confirmText: t('storyboard.batchGenerate'), allowRequirement: true,
  });
}

// 批量估价：汇总各段估算（与 useCostAction.sumEstimate 同构）
function sumBatchEstimate(targets) {
  return async (sel) => {
    const arr = await Promise.all(targets.map((tg) => storyboardApi.genEstimate(tg.id, sel).catch(() => null)));
    const ok0 = arr.filter(Boolean);
    const credits = ok0.reduce((n, r) => n + (Number(r.credits) || 0), 0);
    const discountedCredits = ok0.reduce((n, r) => n + (Number(r.discountedCredits) || Number(r.credits) || 0), 0);
    const first = ok0[0] || {};
    return { credits, count: ok0.length, originalCredits: credits, discountedCredits, discount: Number(first.discount) || 0, tier: first.tier || 'none' };
  };
}
function pickBatchTargets() {
  // 选中即生成：不检测是否已有分镜视频（已有视频的段由服务端先删旧视频再整批重生成）
  return segments.value
    .filter((s) => s.selected && !isBusy(s))
    .sort((a, b) => (a.idx || 0) - (b.idx || 0));
}
async function generateSelected() {
  if (batchProgress.value.running) return;
  const targets = pickBatchTargets();
  if (!targets.length) { toast(t('storyboard.noGenTargets'), 'error'); return; }
  const noPrompt = targets.filter((s) => !s.video_prompt);
  if (noPrompt.length) { toast(t('storyboard.someNoPrompt', { count: noPrompt.length }), 'error'); return; }
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: sumBatchEstimate(targets),
    createFor: (sel) => storyboardApi.generateBatch(episodeId.value, { segmentIds: targets.map((tg) => tg.id), modelConfigId: sel.modelConfigId, resolution: sel.resolution }),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    onDone: (j) => {
      refreshSegments();
      if (j.status === 'succeeded') {
        const r = j.result || {};
        if (r.failed?.length) toast(t('storyboard.batchDoneWithFailures', { ok: r.completed?.length || 0, fail: r.failed.length }), 'error');
      }
    },
    title: t('storyboard.batchSerialTitle'),
    desc: t('storyboard.batchSerialDesc', { count: targets.length }),
    confirmText: t('storyboard.batchGenerate'),
  });
}
async function generateSelectedConcurrent() {
  if (anyBatchRunning.value) return;
  const targets = pickBatchTargets();
  if (!targets.length) { toast(t('storyboard.noGenTargets'), 'error'); return; }
  const noPrompt = targets.filter((s) => !s.video_prompt);
  if (noPrompt.length) { toast(t('storyboard.someNoPrompt', { count: noPrompt.length }), 'error'); return; }
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: sumBatchEstimate(targets),
    createFor: (sel) => storyboardApi.generateBatchConcurrent(episodeId.value, { segmentIds: targets.map((tg) => tg.id), modelConfigId: sel.modelConfigId, resolution: sel.resolution }),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    onDone: (j) => {
      refreshSegments();
      if (j.status === 'succeeded') {
        const r = j.result || {};
        if (r.failed?.length) toast(t('storyboard.concurrentDoneWithFailures', { ok: r.completed?.length || 0, fail: r.failed.length }), 'error');
      }
    },
    title: t('storyboard.batchConcurrentTitle'),
    desc: t('storyboard.batchConcurrentDesc', { count: targets.length }),
    confirmText: t('storyboard.batchGenerate'),
  });
}
// ===== 底部功能菜单 + 分镜轴显隐 =====
// 分镜轴默认隐藏，用户选择存本地（下次进页记忆）
const AXIS_KEY = 'sb_axis_visible';
const axisVisible = ref(uni.getStorageSync(AXIS_KEY) === '1');
function toggleAxis() {
  axisVisible.value = !axisVisible.value;
  try { uni.setStorageSync(AXIS_KEY, axisVisible.value ? '1' : '0'); } catch { /* ignore */ }
}
// 批量操作收进「功能」菜单（主题化 actionSheet）；忙时按钮置灰、菜单不弹
async function openTools() {
  if (anyBatchRunning.value) return;
  const items = [
    { key: 'audit', icon: 'tasks', label: t('storyboard.audit') },
    canGen.value && { key: 'prompt', icon: 'spark', label: `${t('storyboard.genVideoPrompt')}（${selectedCount.value}）` },
    canGen.value && { key: 'order', icon: 'play', label: `${t('storyboard.generateVideoInOrder')}（${selectedCount.value}）` },
    canGen.value && { key: 'conc', icon: 'layers', label: `${t('storyboard.batchGenerateVideo')}（${selectedCount.value}）` },
    canVideo.value && { key: 'compose', icon: 'film', label: t('storyboard.composeAll') },
  ].filter(Boolean);
  const key = await actionSheet(items, { title: t('common.more') });
  if (!key) return;
  if (key === 'audit') runAudit();
  else if (key === 'prompt') genPromptSelected();
  else if (key === 'order') generateSelected();
  else if (key === 'conc') generateSelectedConcurrent();
  else if (key === 'compose' && !composeJob.value) compose();
}
async function cancelBatchJob(job, doneTip) {
  if (!job) return;
  try {
    await jobs.cancel(job.id);
    toast(doneTip, 'success');
  } catch { /* store/http 层已提示 */ }
}
async function cancelBatch() {
  const job = batchJob.value;
  if (!job || cancellingBatch.value) return;
  const ok = await confirm({ title: t('storyboard.cancelSerialTitle'), content: t('storyboard.cancelBatchConfirm') });
  if (!ok) return;
  cancellingBatch.value = true;
  await cancelBatchJob(job, t('storyboard.serialCancelled'));
  cancellingBatch.value = false;
}
async function cancelBatchConcurrent() {
  const job = batchConcurrentJob.value;
  if (!job || cancellingConcurrent.value) return;
  const ok = await confirm({ title: t('storyboard.cancelConcurrentTitle'), content: t('storyboard.cancelBatchConfirm') });
  if (!ok) return;
  cancellingConcurrent.value = true;
  await cancelBatchJob(job, t('storyboard.concurrentCancelled'));
  cancellingConcurrent.value = false;
}
// ===== 合成全集 =====
async function compose() {
  const ready = segments.value.filter((s) => s.selected && s.video_url);
  if (!ready.length) { toast(t('storyboard.composeNeedReady'), 'error'); return; }
  await runJob({
    resolutionOptions: COMPOSE_RESOLUTIONS,
    resolutionHint: t('storyboard.composeResolutionHint'),
    selection: { resolution: composeResolution.value },
    estimateFor: (sel) => videoApi.composeEstimate(episodeId.value, sel.resolution),
    createFor: (sel) => videoApi.compose(episodeId.value, { resolution: sel.resolution }),
    onConfirm: (sel) => {
      composeResolution.value = sel.resolution;
      try { uni.setStorageSync(COMPOSE_RES_KEY, sel.resolution); } catch { /* ignore */ }
    },
    title: t('storyboard.composeTitle'), desc: t('storyboard.composeDesc'), confirmText: t('storyboard.compose'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.episode) {
        episode.value = j.result.episode;
        toast(t('storyboard.composeDoneTip'), 'success');
      }
    },
  });
}

// ===== 在线剪辑（仅 H5：独立窗口打开，导出写回后 postMessage 通知本页） =====
function openVideoEditor(s) {
  if (!s || !s.video_url || isBusy(s)) return;
  /* #ifdef H5 */
  window.open(`/editor/video/seg-${s.id}`, `aieditor_seg_${s.id}`)?.focus();
  /* #endif */
}
function onEditorMessage(e) {
  const d = e.data;
  if (!d || d.type !== 'aieditor:exported' || !d.segment_id) return;
  if (d.segment && d.segment.id) {
    const i = segments.value.findIndex((x) => x.id === d.segment.id);
    if (i > -1) { segments.value[i] = d.segment; return; }
  }
  storyboardApi.segments(episodeId.value).then((segs) => { segments.value = segs; }).catch(() => { /* ignore */ });
}

// ===== 批量运行期间轮询分镜（3s） =====
async function refreshSegments() {
  try { segments.value = await storyboardApi.segments(episodeId.value); } catch { /* ignore */ }
}
let segPollTimer = null;
watch(() => anyBatchRunning.value, (running) => {
  if (running && !segPollTimer) segPollTimer = setInterval(refreshSegments, 3000);
  else if (!running && segPollTimer) { clearInterval(segPollTimer); segPollTimer = null; }
});

// 去除字幕
async function eraseSubtitle(s) {
  if (!s || !s.video_url || isBusy(s)) return;
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: (sel) => storyboardApi.genEstimate(s.id, sel),
    createFor: (sel) => storyboardApi.eraseSubtitle(s.id, sel),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    title: t('storyboard.eraseSubtitleTitle'), desc: t('storyboard.eraseSubtitleDesc', { name: shotTag(s) }), confirmText: t('storyboard.eraseSubtitle'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.segment) {
        const i = segments.value.findIndex((x) => x.id === s.id);
        if (i > -1) segments.value[i] = j.result.segment;
      }
    },
  });
}

// 移动按钮文案：去掉「」空名占位
const movePrevLabel = computed(() => t('storyboard.movePrevTitle', { name: '' }).replace('「」', ''));
const moveNextLabel = computed(() => t('storyboard.moveNextTitle', { name: '' }).replace('「」', ''));

// URL 指定镜（任务页「查看结果」深链 ?sid=）：segments 就绪后定位选中，只消费一次
let pendingSid = null;
onLoad((q) => {
  projectId.value = q?.pid || null;
  episodeId.value = q?.eid || null;
  pendingSid = q?.sid || null;
  uni.$on('segment:updated', onSegmentUpdated);
  /* #ifdef H5 */
  window.addEventListener('message', onEditorMessage);
  /* #endif */
});
onShow(() => { load(); ensureVoices(); });
// 下拉刷新：重拉分镜/项目/模型（本镜视频预览开着时不打断，直接收圈）
onPullDownRefresh(async () => {
  if (shotVideo.open || playerShow.value) { uni.stopPullDownRefresh(); return; }
  try { await load(); } finally { uni.stopPullDownRefresh(); }
});
onUnload(() => {
  if (segPollTimer) clearInterval(segPollTimer);
  if (stuckTimer) clearTimeout(stuckTimer);
  audioCtx?.destroy();
  uni.$off('segment:updated', onSegmentUpdated);
  /* #ifdef H5 */
  window.removeEventListener('message', onEditorMessage);
  /* #endif */
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('storyboard.episodeN', { n: episode?.idx }) + ' · ' + (episode?.title || t('storyboard.untitled'))">
      <template #right>
        <view class="sb-nav-acts">
          <view v-if="episodes.length > 1" class="chip glass sm" @tap="epShow = true">
            <m-icon name="film" :size="13" />
          </view>
        </view>
      </template>
    </AdNavbar>

    <!-- 团队共享只读提示（等首屏加载完再判定：project 未拉到前 can() 一律 false，先渲染会闪误报） -->
    <view v-if="project && readonlyAll" class="sb-ro">
      <m-icon name="drop" :size="12" />
      <text>{{ t('team.readonlyBanner') }}</text>
    </view>

    <!-- 比例 + 模型信息 -->
    <view class="sb-meta">
      <text class="chip glass sm mono">{{ project?.aspect_ratio || '9:16' }}</text>
      <text v-if="activeVideoModel" class="chip glass sm">{{ activeVideoModel.display_name || activeVideoModel.name }}<template v-if="videoResolution"> · {{ videoResolution }}</template></text>
      <view class="flex1" />
      <view v-if="canEditAsset" class="chip glass sm" @tap="openCostumeConfig">
        <m-icon name="user" :size="12" />
        <text>{{ t('asset.costumeConfig.button') }}</text>
      </view>
      <view v-if="canEditStoryboard && segments.length" class="chip glass sm" @tap="insertFirst">
        <m-icon name="plus" :size="12" />
        <text>{{ t('storyboard.addFirstTitle') }}</text>
      </view>
    </view>

    <!-- 批量进度横幅 -->
    <view v-if="batchProgress.running" class="card sb-banner">
      <view class="sb-banner-row">
        <text class="sb-banner-t">{{ t('storyboard.serialGenerating') }} {{ batchProgress.index }}/{{ batchProgress.total }}</text>
        <view class="chip warn sm" @tap="cancelBatch">{{ t('common.cancel') }}</view>
      </view>
      <view class="sb-bar"><view class="sb-bar-in" :style="{ width: (batchProgress.total ? (batchProgress.index / batchProgress.total) * 100 : 0) + '%' }" /></view>
    </view>
    <view v-if="batchConcurrentProgress.running" class="card sb-banner">
      <view class="sb-banner-row">
        <text class="sb-banner-t">{{ t('storyboard.concurrentGenerating') }} {{ batchConcurrentProgress.done }}/{{ batchConcurrentProgress.total }}</text>
        <view class="chip warn sm" @tap="cancelBatchConcurrent">{{ t('common.cancel') }}</view>
      </view>
      <view class="sb-bar"><view class="sb-bar-in teal" :style="{ width: (batchConcurrentProgress.total ? (batchConcurrentProgress.done / batchConcurrentProgress.total) * 100 : 0) + '%' }" /></view>
    </view>
    <view v-if="composeJob" class="card sb-banner">
      <view class="sb-banner-row">
        <text class="sb-banner-t">{{ composeJob.stage || t('storyboard.jobQueued') }} · {{ composeJob.progress || 0 }}%</text>
      </view>
      <view class="sb-bar"><view class="sb-bar-in teal" :style="{ width: (composeJob.progress || 0) + '%' }" /></view>
    </view>

    <!-- 分镜卡列表（手风琴） -->
    <view v-if="!segments.length && !loading" class="card sbempty">
      <text class="sbempty-emoji">🎬</text>
      <text class="sbempty-title">{{ t('storyboard.emptySegments') }}</text>
    </view>

    <view
      v-for="(s, i) in segments"
      :id="'sbcard-' + s.id"
      :key="s.id"
      class="card sbshot"
      :class="{ open: expandedId === s.id, gen: isBusy(s), stuck: stuckId === s.id }"
    >
      <!-- 卡头 -->
      <view class="sbshot-head" @tap="toggleShot(s)">
        <view class="sbcheck" :class="{ on: s.selected }" @tap.stop="canEditStoryboard && toggleSelect(s)">
          <m-icon v-if="s.selected" name="check" :size="11" color="#0a0a0f" :sw="3" />
        </view>
        <view class="sbshot-no mono">{{ s.shot_no || s.idx }}</view>
        <view class="sbshot-main">
          <text class="sbshot-title">{{ s.title || t('storyboard.untitled') }}</text>
          <text class="sbshot-sub mono">{{ s.duration }}s · {{ transShortLabel(s.transition) }}<template v-if="s.video_url"> · {{ s.reviewed_at ? t('episode.videos.reviewed') : t('storyboard.statusGenerated') }}</template></text>
        </view>
        <!-- 已审（reviewed_at 非空）后状态字由「已生成」改显「已审」，与预览窗审阅角标同口径 -->
        <text class="chip sm" :class="s.video_url ? 'ok' : (isBusy(s) ? 'teal' : 'warn')">{{ s.video_url ? (s.reviewed_at ? t('episode.videos.reviewed') : t('storyboard.statusGenerated')) : (isBusy(s) ? '...' : t('storyboard.statusPending')) }}</text>
        <text class="sbshot-caret">{{ expandedId === s.id ? '▴' : '▾' }}</text>
      </view>

      <!-- 展开体 -->
      <view v-if="expandedId === s.id" class="sbshot-body">
        <!-- 已生成视频：预览图（右上角「已审」角标） -->
        <view v-if="s.video_url" class="sbprev" @tap="playSegment(s)">
          <image v-if="s.keyframe_url" :src="toAbsolute(s.keyframe_url)" mode="aspectFill" class="sbprev-img" />
          <view v-else class="sbprev-img sbprev-blank"><m-icon name="play" :size="22" color="#e0b64e" /></view>
          <view class="sbprev-play"><m-icon name="play" :size="16" color="#fff" /></view>
          <text v-if="s.reviewed_at" class="sbprev-ok">{{ t('episode.videos.reviewed') }}</text>
        </view>

        <!-- 视频操作一行：上传 / 下载 / 去除字幕 / 删除视频（置于镜头剧本上方） -->
        <view v-if="hasVideoOps(s)" class="sbvops">
          <view v-if="canEditStoryboard" class="chip glass sm" :class="{ dis: isBusy(s) }" @tap="!isBusy(s) && pickUploadVideo(s)">{{ t('storyboard.upload') }}</view>
          <view v-if="canVideo && s.video_url" class="chip glass sm" @tap="downloadSegment(s)">{{ t('common.download') }}</view>
          <view v-if="canGen && s.video_url" class="chip glass sm" :class="{ dis: isBusy(s) }" @tap="!isBusy(s) && eraseSubtitle(s)">{{ t('storyboard.eraseSubtitle') }}</view>
          <view v-if="canEditStoryboard && s.video_url && !isBusy(s)" class="chip bad sm" @tap="deleteVideo(s)">{{ t('storyboard.deleteVideoTitle') }}</view>
        </view>

        <!-- 本镜剧本：已生成视频时展示；未生成时让位给视频生成提示词 -->
        <view v-if="s.video_url && s.scene_script" class="sbsec">
          <text class="sbsec-lab">{{ t('storyboard.sceneScript') }}</text>
          <scroll-view scroll-y class="sbsec-scroll">
            <text class="sbsec-txt">{{ s.scene_script }}</text>
          </scroll-view>
        </view>
        <!-- 视频提示词（已生成视频则收起，进编辑可见，避免长文案挤占卡片） -->
        <view v-if="s.video_prompt && !s.video_url" class="sbsec">
          <text class="sbsec-lab">{{ t('storyboard.videoPrompt') }}</text>
          <scroll-view scroll-y class="sbsec-scroll">
            <text class="sbsec-txt" user-select>{{ s.video_prompt }}</text>
          </scroll-view>
        </view>
        <text v-if="!s.video_prompt && !s.video_url" class="sbtip">{{ t('storyboard.needGenPromptFirst') }}</text>

        <!-- 本镜资产 -->
        <view class="sbassets">
          <view class="sbassets-head">
            <text class="sbsec-lab">{{ t('storyboard.shotAssets') }}<template v-if="leftList.length"> · {{ leftList.length }}</template></text>
            <view v-if="canEditStoryboard" class="chip glass sm" @tap="openAssetPicker">
              <m-icon name="plus" :size="11" />
            </view>
          </view>
          <scroll-view v-if="leftList.length" scroll-x class="sbassets-strip">
            <view v-for="a in leftList" :key="a.id" class="sbast">
              <view class="sbast-thumb" @tap="previewAsset(a)">
                <image v-if="shotThumbUrl(a)" :src="shotThumbUrl(a)" mode="aspectFill" class="sbast-img" />
                <view v-else class="sbast-img sbast-blank"><m-icon :name="kindIcon(a.kind)" :size="15" /></view>
                <view v-if="a.kind === 'video' && a.meta?.videoUrl" class="sbprev-play sm"><m-icon name="play" :size="10" color="#fff" /></view>
              </view>
              <text class="sbast-name">{{ a.name }}</text>
              <view
                v-if="voiceIdOf(a)"
                class="sbast-voice"
                :class="{ on: previewVoiceId === voiceIdOf(a) }"
                @tap="toggleVoicePreview(voiceIdOf(a))"
              >
                <m-icon name="play" :size="9" :color="previewVoiceId === voiceIdOf(a) ? '#0a0a0f' : '#2dd4bf'" />
              </view>
              <view v-if="canEditStoryboard" class="sbast-x" @tap="removeAsset(a)"><text>✕</text></view>
            </view>
          </scroll-view>
          <text v-else class="sbtip">{{ activeSegment ? t('storyboard.noShotAssets') : t('storyboard.pleaseSelectSegment') }}</text>
        </view>

        <!-- 分镜操作：其余按钮收进组合菜单 -->
        <view v-if="canGen || canEditStoryboard" class="mbtn ghost sm sbmore" @tap="openSegActions(s, i)">
          <m-icon name="set" :size="12" />
          <text>{{ t('storyboard.segActions') }}</text>
        </view>

      </view>
    </view>

    <!-- 底部操作栏 -->
    <view v-if="segments.length" class="sbfoot">
      <!-- 时间轴：分镜沿轴排布，点缩略图定位并展开对应卡片；‹ › 顺序切换用户所在镜（显隐可切换，默认隐藏） -->
      <view v-if="axisVisible" class="sbtl">
        <view class="sbtl-nav">
          <view class="sbtl-navbtn" :class="{ dis: activeIdx <= 0 }" @tap="navigateShot(-1)">
            <m-icon name="left" :size="12" />
          </view>
          <text class="sbtl-pos mono">{{ (activeIdx < 0 ? 0 : activeIdx) + 1 }}/{{ segments.length }}</text>
          <view class="sbtl-navbtn" :class="{ dis: activeIdx >= segments.length - 1 }" @tap="navigateShot(1)">
            <m-icon name="right" :size="12" />
          </view>
        </view>
        <scroll-view scroll-x class="sbtl-strip" :scroll-into-view="stripScrollId" scroll-with-animation>
          <view class="sbtl-track">
            <!-- 轴首：插入空白分镜（插到首个片段之前） -->
            <view v-if="canEditStoryboard" class="sbtl-lead" @tap="insertFirst">
              <view class="sbtl-add"><m-icon name="plus" :size="13" /></view>
            </view>
            <template v-for="(s, i) in segments" :key="s.id">
              <view
                :id="'tlseg-' + s.id"
                class="sbtl-item"
                :class="{ act: s.id === activeId, done: s.video_url, gen: isBusy(s) }"
                @tap="selectFromTimeline(s)"
              >
                <view class="sbtl-thumb">
                  <image v-if="s.keyframe_url" :src="toAbsolute(s.keyframe_url)" mode="aspectFill" class="sbtl-img" />
                  <view v-else class="sbtl-img sbtl-blank"><m-icon name="film" :size="16" /></view>
                  <view class="sbtl-check" :class="{ on: s.selected }" @tap.stop="canEditStoryboard && toggleSelect(s)">
                    <m-icon v-if="s.selected" name="check" :size="9" color="#0a0a0f" :sw="3" />
                  </view>
                  <view v-if="isBusy(s)" class="sbtl-loading"><view class="sbtl-spin" /></view>
                  <view v-else-if="s.video_url" class="sbprev-play sm"><m-icon name="play" :size="10" color="#fff" /></view>
                </view>
                <text class="sbtl-label">{{ t('storyboard.timelineShot', { n: s.shot_no || s.idx, dur: s.duration }) }}</text>
              </view>
              <!-- 两镜之间：转场连接器（复用转场弹层）+ 新增分镜 -->
              <view v-if="canEditStoryboard" class="sbtl-conn">
                <view class="sbtl-trans" :class="{ set: isTransSet(s.transition) }" @tap.stop="openTransSheet(s)">
                  <text>{{ transShortLabel(s.transition) }}</text>
                </view>
                <view class="sbtl-add" @tap.stop="insertAfter(s)"><m-icon name="plus" :size="11" /></view>
              </view>
            </template>
          </view>
        </scroll-view>
      </view>
      <view class="sbfoot-row">
        <view class="chip glass sm" :class="{ gold: selectedCount === segments.length && segments.length > 0 }" @tap="canEditStoryboard && saveSelectAll(!(selectedCount === segments.length && segments.length > 0))">
          <text>{{ t('storyboard.selectAll') }} {{ selectedCount }}/{{ segments.length }}</text>
        </view>
        <!-- 分镜轴显隐开关（默认隐藏，选择持久化） -->
        <view class="chip glass sm" :class="{ set: axisVisible }" @tap="toggleAxis">
          <m-icon :name="axisVisible ? 'eye' : 'eye-off'" :size="13" />
        </view>
        <view class="mbtn ghost sm flex1" :class="{ dis: anyBatchRunning }" @tap="openTools">
          <m-icon name="set" :size="12" />
          <text>{{ t('common.more') }}</text>
        </view>
      </view>
    </view>
    <view v-else style="height: 20px" />

    <!-- 集数切换 -->
    <AdSheet v-model:show="epShow" :title="t('storyboard.episodeN', { n: episode?.idx })">
      <view class="sbeplist">
        <view
          v-for="e in episodes"
          :key="e.id"
          class="sbep"
          :class="{ on: e.id === Number(episodeId) }"
          @tap="switchEpisode(e.id)"
        >
          <text class="sbep-t">{{ t('storyboard.episodeN', { n: e.idx }) }} · {{ e.title || t('storyboard.untitled') }}</text>
          <m-icon v-if="e.id === Number(episodeId)" name="check" :size="14" />
        </view>
      </view>
    </AdSheet>

    <!-- 转场快捷弹层 -->
    <AdSheet v-model:show="transShow" :title="t('storyboard.thisToNext') + ' · ' + t('storyboard.transitionLabel')">
      <view class="sbtransgrid">
        <view
          v-for="o in TRANSITION_SHORT"
          :key="o.value"
          class="sbtransopt"
          :class="{ on: transTarget && normTrans(transTarget.transition) === o.value }"
          @tap="transTarget && pickTransition(transTarget, o.value)"
        >{{ o.label }}</view>
      </view>
      <text class="sbtip">{{ t('storyboard.transitionTip') }}</text>
    </AdSheet>

    <!-- 资产库添加弹层 -->
    <AdSheet v-model:show="assetPicker.open" :title="t('storyboard.addFromLibraryTitle')">
      <view class="sbpicker">
        <scroll-view scroll-x class="sbkindrow">
          <view class="chip glass sm" :class="{ gold: !assetPicker.kind }" @tap="assetPicker.kind = ''">{{ t('storyboard.kindAll') }}</view>
          <view
            v-for="k in ['character', 'scene', 'prop', 'material', 'video']"
            :key="k"
            class="chip glass sm"
            :class="{ gold: assetPicker.kind === k }"
            @tap="assetPicker.kind = k"
          >{{ kindLabel(k) }}</view>
        </scroll-view>
        <input v-model="assetPicker.q" class="sb-input" :placeholder="t('storyboard.searchAssetPlaceholder')" />
        <scroll-view scroll-y class="sbpicklist">
          <view
            v-for="a in pickerCandidates"
            :key="a.id"
            class="sbpick"
            :class="{ sel: pickerSelectedSet.has(a.id), added: isRefAsset(a.id) }"
            @tap="togglePick(a)"
          >
            <view class="sbast-thumb">
              <image v-if="a.image_url" :src="toAbsolute(a.thumb_url || a.image_url)" mode="aspectFill" class="sbast-img" />
              <view v-else class="sbast-img sbast-blank"><m-icon :name="kindIcon(a.kind)" :size="15" /></view>
            </view>
            <view class="sbpick-meta">
              <text class="sbpick-name">{{ a.name }}</text>
              <text class="chip sm glass">{{ kindLabel(a.kind) }}</text>
            </view>
            <text v-if="isRefAsset(a.id)" class="chip sm">{{ t('storyboard.alreadyAdded') }}</text>
            <m-icon v-else-if="pickerSelectedSet.has(a.id)" name="check" :size="16" :sw="2.4" />
            <m-icon v-else name="plus" :size="15" />
          </view>
          <view v-if="!pickerCandidates.length" class="ad-empty"><text class="et">{{ t('storyboard.noAssetsToAdd') }}</text></view>
        </scroll-view>
        <view class="mbtn sm sbpick-go" :class="{ dis: !pickerSelected.length }" @tap="confirmPickAssets">
          {{ t('storyboard.addFromLibrary') }}<template v-if="pickerSelected.length">（{{ pickerSelected.length }}）</template>
        </view>
      </view>
    </AdSheet>

    <!-- 按集服饰配置 -->
    <AdSheet v-model:show="costumeCfgShow" :title="t('asset.costumeConfig.button')">
      <view class="sbcost">
        <text class="sbtip">{{ t('asset.costumeConfig.desc') }}</text>
        <view class="chip glass sm" :class="{ gold: costumeShowAll }" @tap="costumeShowAll = !costumeShowAll">{{ t('asset.costumeConfig.showAll') }}</view>
        <view v-if="costumeCfgLoading" class="sbcost-empty"><text>{{ t('common.loading') }}</text></view>
        <view v-else-if="!costumeCfgRows.length" class="sbcost-empty"><text>{{ t('asset.costumeConfig.empty') }}</text></view>
        <view v-for="row in costumeCfgRows" :key="row.asset_id" class="sbcost-row">
          <view class="sbcost-char">
            <view class="sbast-thumb">
              <image v-if="rowDefaultImg(row)" :src="rowDefaultImg(row)" mode="aspectFill" class="sbast-img" />
              <view v-else class="sbast-img sbast-blank"><m-icon name="user" :size="15" /></view>
            </view>
            <text class="sbcost-name">{{ row.name }}</text>
          </view>
          <scroll-view scroll-x class="sbcost-strip">
            <view class="sbcost-opt" :class="{ on: !row.costume_id }" @tap="pickCostume(row, null)">
              <text class="sbcost-optname">{{ t('asset.costumeConfig.defaultOption') }}</text>
            </view>
            <view
              v-for="c in row.costumes"
              :key="c.id"
              class="sbcost-opt"
              :class="{ on: row.costume_id === c.id }"
              @tap="pickCostume(row, c.id)"
            >
              <image v-if="c.thumb_url || c.image_url" :src="toAbsolute(c.thumb_url || c.image_url)" mode="aspectFill" class="sbcost-img" />
              <text class="sbcost-optname">{{ c.name || t('asset.costume.untitled') }}</text>
            </view>
          </scroll-view>
        </view>
        <view class="mbtn sm sbcost-save" :class="{ dis: costumeCfgSaving }" @tap="saveCostumeConfig">{{ t('common.save') }}</view>
      </view>
    </AdSheet>

    <!-- 分镜审计报告 -->
    <AdSheet v-model:show="auditState.open" :title="t('storyboard.auditTitle')">
      <view v-if="auditState.report" class="sbaudit">
        <view class="sbaudit-sum">
          <text class="chip glass sm">{{ t('storyboard.auditSummaryAssets', { count: auditSummary.assetIssueCount }) }}</text>
          <text class="chip glass sm">{{ t('storyboard.auditSummaryDuration', { count: auditSummary.durationIssueCount }) }}</text>
          <text v-if="auditSummary.overflowCount" class="chip glass sm">{{ t('storyboard.auditSummaryOverflow', { count: auditSummary.overflowCount }) }}</text>
        </view>
        <view class="sbaudit-fix">
          <view class="pchip" :class="{ on: auditState.fixAssets }" @tap="auditState.fixAssets = !auditState.fixAssets">{{ t('storyboard.auditFixAssets') }}</view>
          <view class="pchip" :class="{ on: auditState.fixDuration }" @tap="auditState.fixDuration = !auditState.fixDuration">{{ t('storyboard.auditFixDuration') }}</view>
        </view>
        <view v-if="!auditVisibleItems.length" class="sbcost-empty"><text>{{ t('storyboard.auditEmpty') }}</text></view>
        <scroll-view scroll-y class="sbaudit-list">
          <view v-for="it in auditVisibleItems" :key="it.segmentId" class="card sbaudit-item">
            <view class="sbaudit-head">
              <text class="mono">#{{ String(it.idx).padStart(2, '0') }} {{ it.shot_no || '' }}</text>
              <text v-if="it.duration.hasVideo && it.duration.changed" class="chip teal sm">{{ t('storyboard.auditHasVideoHint') }}</text>
            </view>
            <view v-if="it.missingAssets.length" class="sbchips">
              <text v-for="m in it.missingAssets" :key="m.id" class="chip warn sm">
                {{ kindLabel(m.type) }} · {{ m.name }}（{{ m.reasonKey === 'speaker' ? t('storyboard.auditReasonSpeaker') : t('storyboard.auditReasonMention') }}）
              </text>
            </view>
            <view v-if="it.duration.changed || it.duration.overflow" class="sbchips">
              <text v-if="it.duration.changed" class="chip teal sm">{{ t('storyboard.auditDurationChange', { cur: it.duration.current, rec: it.duration.recommended }) }}</text>
              <text v-if="it.duration.overflow" class="chip warn sm">{{ t('storyboard.auditOverflow', { sec: it.duration.estimated }) }}</text>
            </view>
            <view v-if="it.warnings.length" class="sbchips">
              <text v-for="w in it.warnings" :key="w.id" class="chip glass sm">{{ t('storyboard.auditWarningNoImage', { name: w.name }) }}</text>
            </view>
          </view>
        </scroll-view>
        <view v-if="canEditStoryboard" class="mbtn sm sbcost-save" :class="{ dis: auditState.applying || !auditHasFixable }" @tap="applyAuditFixes">{{ t('storyboard.auditApply') }}</view>
      </view>
    </AdSheet>

    <!-- 本镜视频播放（竖滑切上一镜/下一镜，只在已生成视频的分镜间移动） -->
    <VideoPlayerPopup
      v-model:show="playerShow"
      :url="activeSegment?.video_url || ''"
      :poster="activeSegment?.keyframe_url || ''"
      :title="playerTitle"
      :aspect="project?.aspect_ratio || ''"
      swipeable
      :has-prev="playIdx > 0"
      :has-next="playIdx + 1 < playableSegs.length"
      @prev="swipeShot(-1)"
      @next="swipeShot(1)"
      :reviewable="canEditStoryboard && !!activeSegment?.video_url"
      :reviewed="!!activeSegment?.reviewed_at"
      :reviewing="reviewBusy"
      @review="toggleReview"
      :deletable="canEditStoryboard && !!activeSegment?.video_url"
      :deleting="delBusy"
      @delete="deleteVideo(activeSegment)"
    />
    <!-- 本镜视频资产播放 -->
    <VideoPlayerPopup v-model:show="shotVideo.open" :url="shotVideo.url" :title="shotVideo.name" :aspect="project?.aspect_ratio || ''" />
    <AdDownloadDialog />
    <GenConfirmSheet />
  <AdDialog />
  </view>
</template>

<style scoped>
.sb-nav-acts { display: flex; align-items: center; gap: 8px; }
.sb-ro {
  display: flex; align-items: center; gap: 6px; margin: 0 18px 10px;
  padding: 8px 12px; border-radius: 11px; font-size: 12px; color: var(--ad-warning);
  background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3);
}
.sb-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 18px 12px; }
.flex1 { flex: 1; }
.sbempty { padding: 34px 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.sbempty-emoji { font-size: 40px; }
.sbempty-title { font-family: var(--ad-serif); font-size: 15px; font-weight: 700; color: var(--ad-text); line-height: 1.7; }

.sb-banner { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.sb-banner-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sb-banner-t { font-size: 13px; font-weight: 600; color: var(--ad-brand); }
.sb-bar { height: 4px; border-radius: 999px; background: var(--ad-inset); overflow: hidden; }
.sb-bar-in { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #f2d489, #e0b64e); transition: width 0.4s ease; }
.sb-bar-in.teal { background: linear-gradient(90deg, var(--ad-accent), #0d9488); }

.sbshot { padding: 0; overflow: hidden; }
.sbshot.open { border-color: rgba(224, 182, 78, 0.45); }
.sbshot.gen { border-color: rgba(45, 212, 191, 0.45); }
.sbshot-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
.sbcheck {
  width: 20px; height: 20px; border-radius: 6px; flex-shrink: 0;
  border: 1.5px solid var(--ad-line); display: flex; align-items: center; justify-content: center;
  background: var(--ad-inset);
}
.sbcheck.on { background: linear-gradient(135deg, #f2d489, #e0b64e); border-color: transparent; }
.sbshot-no { font-size: 12px; font-weight: 700; color: var(--ad-accent); flex-shrink: 0; }
.sbshot-main { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sbshot-title { font-size: 14px; font-weight: 600; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbshot-sub { font-size: 11px; color: var(--ad-text-mut); }
.sbshot-caret { font-size: 10px; color: var(--ad-text-mut); flex-shrink: 0; }

.sbshot-body { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--ad-line); padding-top: 12px; }
.sbprev { position: relative; border-radius: 12px; overflow: hidden; }
.sbprev-img { width: 100%; height: 180px; display: block; background: #0a0a0f; }
.sbprev-blank { display: flex; align-items: center; justify-content: center; }
.sbprev-play {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: rgba(10, 10, 15, 0.55); border: 1px solid rgba(255, 255, 255, 0.4); backdrop-filter: blur(4px);
}
.sbprev-play.sm { width: 22px; height: 22px; left: 50%; top: 50%; }
/* 已审角标（预览图右上角；绿底白字示「通过」语义，与成片卡已审角标同款） */
.sbprev-ok {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  padding: 3px 8px; border-radius: 7px;
  background: var(--ad-success); color: #fff;
  font-size: 10.5px; font-weight: 700;
}

.sbsec { display: flex; flex-direction: column; gap: 4px; }
.sbsec-lab { font-size: 12px; color: var(--ad-brand); font-weight: 700; }
.sbsec-txt { font-size: 13px; line-height: 1.7; color: var(--ad-text-soft); white-space: pre-wrap; word-break: break-word; }
.sbtip { font-size: 11px; color: var(--ad-text-mut); line-height: 1.6; }

.sbassets { display: flex; flex-direction: column; gap: 8px; }
.sbassets-head { display: flex; align-items: center; justify-content: space-between; }
.sbassets-strip { white-space: nowrap; width: 100%; }
.sbast { position: relative; display: inline-flex; flex-direction: column; align-items: center; gap: 4px; width: 64px; margin-right: 10px; }
.sbast-thumb { width: 64px; height: 64px; border-radius: 10px; overflow: hidden; background: var(--ad-inset); border: 1px solid var(--ad-line); }
.sbast-img { width: 100%; height: 100%; }
.sbast-blank { display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
.sbast-name { font-size: 10px; color: var(--ad-text-soft); max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbast-voice {
  position: absolute; left: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(10, 10, 15, 0.6); border: 1px solid rgba(45, 212, 191, 0.5);
}
.sbast-voice.on { background: #2dd4bf; }
.sbast-x {
  position: absolute; right: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(10, 10, 15, 0.6); color: #ef4444; font-size: 9px;
}

/* 视频操作行：上传 / 下载 / 去除字幕 / 删除视频（一行，置于镜头剧本上方） */
.sbvops { display: flex; flex-wrap: wrap; gap: 8px; }
/* 分镜操作组合菜单入口 */
.sbmore { display: flex; align-items: center; justify-content: center; }
/* 剧本/提示词限高，超出滚动 */
.sbsec-scroll { max-height: 210px; }
/* 吸顶动画：卡片头落位到导航栏下方时闪一下品牌金再淡出 */
.sbshot.stuck .sbshot-head { animation: sbstick-flash 0.72s ease; }
@keyframes sbstick-flash {
  0% { background: rgba(224, 182, 78, 0.18); }
  100% { background: transparent; }
}

.sbfoot .chip.set { border-color: rgba(224, 182, 78, 0.5); color: var(--ad-brand); }

.sb-input {
  width: auto; min-height: 40px; padding: 9px 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 13px;
}

.sbfoot {
  position: sticky; bottom: 0; z-index: 20;
  margin-top: 14px; padding: 10px 18px calc(10px + env(safe-area-inset-bottom));
  background: var(--ad-wbar-bg);
  display: flex; flex-direction: column; gap: 8px;
}
.sbfoot-row { display: flex; align-items: center; gap: 8px; }
.sbfoot-row .flex1 { flex: 1; display: flex; align-items: center; justify-content: center; }
.sbfoot-row .chip { flex-shrink: 0; }

/* ===== 底部时间轴（client StoryboardEditor .timeline 移植，吸底随时切镜）===== */
.sbtl {
  display: flex; flex-direction: column; gap: 6px;
  padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid var(--ad-line);
  background: var(--ad-panel); /* wbar 渐变顶部透明，轴块自带底色避免长列表透出 */
}
.sbtl-nav { display: flex; align-items: center; justify-content: center; gap: 12px; }
.sbtl-navbtn {
  width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-inset); border: 1px solid var(--ad-line); color: var(--ad-text-soft);
}
.sbtl-pos { font-size: 11px; color: var(--ad-text-mut); min-width: 44px; text-align: center; }
.sbtl-strip { width: 100%; white-space: nowrap; }
.sbtl-track { display: flex; align-items: flex-start; gap: 6px; padding: 2px; }
.sbtl-lead { flex: none; height: 78px; display: flex; align-items: center; }
.sbtl-item { flex: none; width: 56px; display: flex; flex-direction: column; align-items: center; }
.sbtl-thumb {
  position: relative; width: 56px; height: 78px; border-radius: 8px; overflow: hidden;
  background: var(--ad-inset); border: 1.5px solid transparent;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.sbtl-img { width: 100%; height: 100%; }
.sbtl-blank { display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
/* 已生成：成功色细边框；选中：品牌金边 + 光环 + 底部指示条（对齐 client .tl-item） */
.sbtl-item.done .sbtl-thumb { border-color: var(--ad-success); }
.sbtl-item.gen .sbtl-thumb { border-color: var(--ad-accent); }
.sbtl-item.act .sbtl-thumb {
  border-color: var(--ad-brand);
  box-shadow: 0 0 0 1px var(--ad-brand-soft);
}
.sbtl-item.act .sbtl-thumb::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
  background: var(--ad-brand); z-index: 3;
}
.sbtl-check {
  position: absolute; left: 3px; top: 3px; width: 15px; height: 15px; border-radius: 5px; z-index: 4;
  border: 1.5px solid var(--ad-line-strong); background: var(--ad-inset);
  display: flex; align-items: center; justify-content: center;
}
.sbtl-check.on { background: var(--ad-brand-gradient); border-color: transparent; }
.sbtl-loading {
  position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 4; background: rgba(10, 10, 15, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.sbtl-spin {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: var(--ad-accent);
  animation: sbtl-rot 0.9s linear infinite;
}
@keyframes sbtl-rot { to { transform: rotate(360deg); } }
.sbtl-label {
  font-size: 10px; color: var(--ad-text-soft); margin-top: 4px;
  max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sbtl-item.act .sbtl-label { color: var(--ad-brand); font-weight: 700; }
.sbtl-conn { flex: none; height: 78px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; }
.sbtl-trans {
  min-width: 26px; padding: 3px 5px; border-radius: 7px; text-align: center; line-height: 1.2;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text-mut); font-size: 10px; font-weight: 600;
}
.sbtl-trans.set { color: var(--ad-brand); border-color: var(--ad-brand); background: var(--ad-brand-soft); }
.sbtl-add {
  width: 20px; height: 20px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-inset); border: 1px dashed var(--ad-line-strong); color: var(--ad-text-mut);
}

.sbeplist { display: flex; flex-direction: column; max-height: 56vh; }
.sbep { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 10px; border-bottom: 1px solid var(--ad-line); }
.sbep.on { color: var(--ad-accent); }
.sbep.on .sbep-t { color: var(--ad-brand); }
.sbep-t { font-size: 14px; color: var(--ad-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sbtransgrid { display: flex; flex-wrap: wrap; gap: 10px; padding: 6px 0 12px; }
.sbtransopt {
  padding: 10px 16px; border-radius: 11px; border: 1.5px solid var(--ad-line);
  background: var(--ad-inset); font-size: 13px; color: var(--ad-text);
}
.sbtransopt.on { border-color: var(--ad-accent); color: var(--ad-accent); }

.sbpicker { display: flex; flex-direction: column; gap: 10px; }
.sbkindrow { white-space: nowrap; width: 100%; }
.sbkindrow .chip { display: inline-flex; margin-right: 8px; }
.sbpicklist { max-height: 46vh; display: flex; flex-direction: column; gap: 8px; }
.sbpick { display: flex; align-items: center; gap: 10px; padding: 8px; border: 1.5px solid var(--ad-line); border-radius: 12px; color: var(--ad-text-mut); }
.sbpick.sel { border-color: var(--ad-accent); background: rgba(45, 212, 191, 0.06); color: var(--ad-accent); }
.sbpick.added { opacity: 0.55; }
.sbpick-meta { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
.sbpick-name { flex: 1; font-size: 13px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbpick-go { display: flex; align-items: center; justify-content: center; }

.sbcost { display: flex; flex-direction: column; gap: 10px; }
.sbcost-row { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--ad-line); border-radius: 12px; }
.sbcost-char { display: flex; align-items: center; gap: 10px; }
.sbcost-name { font-size: 14px; font-weight: 600; color: var(--ad-text); }
.sbcost-strip { white-space: nowrap; width: 100%; }
.sbcost-opt {
  display: inline-flex; flex-direction: column; align-items: center; gap: 4px; width: 72px; margin-right: 8px;
  padding: 6px; border-radius: 10px; border: 1.5px solid var(--ad-line);
}
.sbcost-opt.on { border-color: var(--ad-brand); background: rgba(224, 182, 78, 0.08); }
.sbcost-img { width: 60px; height: 60px; border-radius: 8px; }
.sbcost-optname { font-size: 10px; color: var(--ad-text-soft); max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbcost-empty { padding: 24px 0; text-align: center; font-size: 12px; color: var(--ad-text-mut); }
.sbcost-save { display: flex; align-items: center; justify-content: center; }

.sbaudit { display: flex; flex-direction: column; gap: 12px; }
.sbaudit-sum { display: flex; flex-wrap: wrap; gap: 8px; }
.sbaudit-fix { display: flex; flex-wrap: wrap; gap: 8px; }
.sbaudit-list { max-height: 44vh; display: flex; flex-direction: column; gap: 8px; }
.sbaudit-item { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.sbaudit-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ad-text); }
.sbchips { display: flex; flex-wrap: wrap; gap: 6px; }
.dis { opacity: 0.55; pointer-events: none; }
</style>
