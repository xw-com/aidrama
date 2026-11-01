<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  storyboardApi, videoApi, assetApi, scriptApi, modelApi, projectApi, voiceApi,
} from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useJobsStore } from '../../stores/jobs';
import { can } from '../../utils/perms';
import { ElMessage, ElMessageBox } from 'element-plus';
import VideoPreview from '../../components/VideoPreview.vue';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { runJob, runJobs } = useCostAction();
const jobs = useJobsStore();

const projectId = computed(() => route.params.id);
const episodeId = computed(() => route.params.eid);

// 任务页「查看结果」深链 ?sid=：segments 就绪后定位选中，只消费一次（范式同 uniapp storyboard.vue）
let pendingSid = route.query.sid || null;

// 团队共享权限（project 自带 my_role/my_permissions；owner 恒全有）
const canEditStoryboard = computed(() => can(project.value, 'storyboard.edit'));
const canGen = computed(() => can(project.value, 'ai.generate'));
const canVideo = computed(() => can(project.value, 'video.manage'));
const canEditAsset = computed(() => can(project.value, 'asset.edit'));
// 只读横幅：member 且无任何写权限时提示（生成/编辑/合成全被禁）
const readonlyAll = computed(() => !canEditStoryboard.value && !canGen.value && !canVideo.value && !canEditAsset.value);

const episode = ref(null);
const episodes = ref([]); // 项目下全部剧集（集数选择器数据源）
const project = ref(null);
const segments = ref([]);
const assets = ref([]);
const activeId = ref(null);
const loading = ref(false);
const editing = ref(false);
const viewMode = ref('table'); // 分镜表展示模式：table 表格一览 / detail 单镜详情
const expanded = ref({}); // 分镜表下拉式：展开的镜 id 集合

// 视频生成：可选模型 + 分辨率 + 实时计价
const videoModels = ref([]);
const videoModelId = ref(null);
const videoResolution = ref(null);
const activeVideoModel = computed(() => videoModels.value.find((m) => m.id === videoModelId.value) || null);
// 切换模型时重置分辨率为该模型首个分辨率
watch(videoModelId, () => {
  const m = activeVideoModel.value;
  const list = m && Array.isArray(m.resolutions) ? m.resolutions : [];
  videoResolution.value = list.length ? list[0].value : null;
});

// 任务驱动的 busy 状态
const batchJob = computed(() => jobs.activeOf('segment_video_batch', Number(episodeId.value)));
const batchConcurrentJob = computed(() => jobs.activeOf('segment_video_batch_concurrent', Number(episodeId.value)));
// 视频上传中的分镜 id 集合（本地态，非 job）：并入 isBusy，使上传期间禁用生成/删除等冲突操作
const uploadingMap = ref({});
// 在途「剪辑本镜视频」Job（video_edit + meta.editSource=segment，ref_id=分镜 id）
const segEditBusy = (s) => jobs.items.some((j) => j.type === 'video_edit' && String(j.ref_id) === String(s.id) && j.meta?.editSource === 'segment' && (j.status === 'pending' || j.status === 'running'));
const isBusy = (s) => !!(jobs.activeOf('segment_generate', s.id) || jobs.activeOf('segment_video', s.id) || jobs.activeOf('segment_erase_subtitle', s.id) || segEditBusy(s) || (batchJob.value && s.status === 'generating') || (batchConcurrentJob.value && s.status === 'generating') || uploadingMap.value[s.id]);
const isBusyPrompt = (s) => !!jobs.activeOf('segment_prompt', s.id);
const composeJob = computed(() => jobs.activeOf('video_synthesis', Number(episodeId.value)));
// 合成分辨率档位：与后端 COMPOSE_RESOLUTIONS、管理端 VIDEO_RESOLUTION_PRESETS 同源同 casing
const COMPOSE_RESOLUTIONS = ['480p', '720p', '768p', '1080p', '2K', '4K'];
const COMPOSE_RES_KEY = 'aidrama:composeResolution';
// 记忆用户上次所选档（localStorage 校验白名单，防手改脏值；默认 1080p = 历史行为）
const composeResolution = ref((() => {
  try {
    const v = localStorage.getItem(COMPOSE_RES_KEY);
    if (COMPOSE_RESOLUTIONS.includes(v)) return v;
  } catch { /* 隐私模式等 localStorage 不可用 */ }
  return '1080p';
})());

const activeSegment = computed(() => segments.value.find((s) => s.id === activeId.value) || segments.value[0] || null);
const selectedCount = computed(() => segments.value.filter((s) => s.selected).length);
// 批量串行生成视频进度：派生自后端批量 Job 的 meta（index/total），关页面/重进页面都能恢复显示
const batchProgress = computed(() => ({
  index: batchJob.value?.meta?.index || 0,
  total: batchJob.value?.meta?.total || 0,
  running: !!batchJob.value,
}));
const cancellingBatch = ref(false); // 取消串行生成请求进行中
// 批量并发生成视频进度：派生自后端并发批量 Job 的 meta（done/total），关页面/重进页面都能恢复显示
const batchConcurrentProgress = computed(() => ({
  done: batchConcurrentJob.value?.meta?.done || 0,
  total: batchConcurrentJob.value?.meta?.total || 0,
  running: !!batchConcurrentJob.value,
}));
const cancellingConcurrent = ref(false); // 取消并发生成请求进行中
// 任一批量（串行/并发）在跑：用于禁用同区按钮 & 驱动分镜轮询
const anyBatchRunning = computed(() => batchProgress.value.running || batchConcurrentProgress.value.running);

// 分镜审计：dry-run 报告缺失资产 + 时长建议，按需应用修复（免费、同步）
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
  } catch { /* http 拦截器已提示 */ } finally { auditState.running = false; }
}
async function applyAuditFixes() {
  if (!auditState.report || !auditHasFixable.value) { auditState.open = false; return; }
  auditState.applying = true;
  try {
    const r = await storyboardApi.applyAudit(episodeId.value, { fixAssets: auditState.fixAssets, fixDuration: auditState.fixDuration });
    ElMessage.success(t('storyboard.auditApplied', { a: r.stats.assetsApplied, d: r.stats.durationApplied }));
    auditState.open = false;
    await load(); // 重拉 segments/assets/episode
  } catch { /* http 拦截器已提示 */ } finally { auditState.applying = false; }
}

const KIND_ICON = { character: 'User', scene: 'Picture', prop: 'Box', material: 'Files', video: 'VideoPlay' };
const kindLabel = (k) => t('storyboard.assetKind.' + k);
const kindIcon = (k) => KIND_ICON[k] || 'Files';
// 选择分镜段时，左侧只显示与本镜关联的全部资产（asset_refs: [{type,id,name}]），不再按类型分页
const leftList = computed(() => {
  const seg = activeSegment.value;
  if (!seg) return [];
  const ids = new Set((seg.asset_refs || []).map((r) => r.id));
  return assets.value.filter((a) => ids.has(a.id));
});

// 本镜资产图片预览（沿用 AssetLibrary 的 el-image-viewer 模式）：预览用原图，列表卡片用缩略图
const previewUrl = ref('');
const previewList = computed(() => leftList.value.filter((a) => shotImageUrl(a)).map((a) => shotImageUrl(a)));
const previewIndex = ref(0);
function previewImage(a) {
  const url = shotImageUrl(a);
  if (!url) return;
  const i = previewList.value.indexOf(url);
  previewIndex.value = i > -1 ? i : 0;
  previewUrl.value = url;
}

// ===== 本镜资产视频预览：视频资产点击开弹窗播放（meta.videoUrl），图片资产仍走图片查看器 =====
const shotVideo = reactive({ open: false, url: '', name: '' });
const assetPreviewable = (a) => !!(shotThumbUrl(a) || (a.kind === 'video' && a.meta?.videoUrl));
function previewAsset(a) {
  if (a.kind === 'video' && a.meta?.videoUrl) {
    shotVideo.url = a.meta.videoUrl;
    shotVideo.name = a.name;
    shotVideo.open = true;
    void ensureVoices();
    return;
  }
  previewImage(a);
}

// 视频预览窗旁的角色音色试听：本镜角色绑定音色（Asset.meta.voiceId）→ voices.audio_url 样本
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
// 条目旁试听按钮用的音色 id（绑定了音色的角色才有按钮）
const voiceIdOf = (a) => (a.kind === 'character' && a.meta?.voiceId ? Number(a.meta.voiceId) : null);
const previewVoiceId = ref(null);
const voiceAudioEl = ref(null);
function toggleVoicePreview(voiceId) {
  const el = voiceAudioEl.value;
  if (!el) return;
  if (previewVoiceId.value === voiceId) {
    el.pause();
    previewVoiceId.value = null;
    return;
  }
  const v = voices.value.find((x) => x.id === voiceId);
  if (!v?.audio_url) return ElMessage.warning(t('voice.noPreviewSample'));
  previewVoiceId.value = voiceId;
  el.src = v.audio_url;
  el.currentTime = 0;
  el.play().catch(() => {
    previewVoiceId.value = null;
    ElMessage.error(t('voice.noPreviewSample'));
  });
}
// 关窗即停音色试听（视频随 destroy-on-close 一并销毁）
watch(() => shotVideo.open, (o) => {
  if (!o) { voiceAudioEl.value?.pause(); previewVoiceId.value = null; }
});

// ===== 本镜资产：从资产库添加 / 移除（asset_refs 为权威数据，改动即时落库） =====
const assetPicker = reactive({ open: false, kind: '', q: '' });
const pickerSelected = ref([]); // 本次勾选待添加的资产 id
const refAssetIds = computed(() => new Set((activeSegment.value?.asset_refs || []).map((r) => r.id)));
const isRefAsset = (id) => refAssetIds.value.has(id);
const pickerSelectedSet = computed(() => new Set(pickerSelected.value));
// 资产库候选：按类型 + 关键词过滤
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
  if (isRefAsset(a.id)) return; // 已关联资产不可重复添加
  const set = new Set(pickerSelected.value);
  if (set.has(a.id)) set.delete(a.id);
  else set.add(a.id);
  pickerSelected.value = [...set];
}
async function persistAssetRefs() {
  const seg = activeSegment.value;
  if (!seg) return;
  try {
    await storyboardApi.updateSegment(seg.id, { asset_refs: seg.asset_refs || [] });
  } catch {
    ElMessage.error(t('storyboard.persistAssetsFail'));
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
  await persistAssetRefs();
  assetPicker.open = false;
  pickerSelected.value = [];
  ElMessage.success(t('storyboard.assetsAdded', { count: adds.length }));
}
async function removeAsset(a) {
  const seg = activeSegment.value;
  if (!seg) return;
  seg.asset_refs = (seg.asset_refs || []).filter((r) => r.id !== a.id);
  await persistAssetRefs();
  ElMessage.success(t('storyboard.assetRemoved', { name: a.name }));
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
    ]).catch((err) => {
      // 被移出项目/项目被删：回项目列表（http 层已弹错误提示）
      if (err?.status === 403 || err?.status === 404) router.replace('/projects');
      throw err;
    });
    episode.value = ep;
    episodes.value = proj?.episodes || [];
    project.value = proj || null;
    segments.value = segs;
    assets.value = asts;
    videoModels.value = (vms || []).filter((m) => m.enabled !== false); // 兜底：后端旧版本未过滤时不展示禁用项
    // 默认选中「设为默认」的视频模型，否则取第一条；并落到该模型首个分辨率
    // 已选中的模型若被 admin 停用（不在列表中），重置回默认/首条
    if (videoModels.value.length && !videoModels.value.some((m) => m.id === videoModelId.value)) {
      const def = videoModels.value.find((m) => m.is_default) || videoModels.value[0];
      videoModelId.value = def.id;
      const list = Array.isArray(def.resolutions) ? def.resolutions : [];
      videoResolution.value = list.length ? list[0].value : null;
    }
    // 深链指定镜（?sid=）优先定位并展开滚动；未命中/无深链回退默认首镜
    const want = pendingSid != null ? segs.find((s) => String(s.id) === String(pendingSid)) : null;
    pendingSid = null;
    if (want) {
      activeId.value = want.id;
      expanded.value = { [want.id]: true };
      nextTick(() => {
        const container = document.querySelector('.shot-list-scroll');
        const el = container?.querySelector(`.shot-card[data-sid="${want.id}"]`);
        if (container && el) container.scrollTo({ top: el.offsetTop - container.offsetTop, behavior: 'smooth' });
      });
    } else if (!activeId.value && segs.length) {
      activeId.value = segs[0].id;
    }
    // 预取按集服饰配置，供本镜资产面板渲染覆盖缩略图（失败不阻塞主流程）
    try {
      const cfgRows = await assetApi.episodeCostumeConfig(episodeId.value);
      costumeCfg.rows = Array.isArray(cfgRows) ? cfgRows : [];
    } catch { /* 忽略 */ }
  } finally {
    loading.value = false;
  }
}

// —— 按集角色服饰配置 ——
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

// 本镜资产里角色的服饰覆盖：assetId -> 本集选中服饰对象（未覆盖则无条目，用角色默认图）
const costumeOverrideMap = computed(() => {
  const m = {};
  for (const row of costumeCfg.rows) {
    if (!row.costume_id) continue;
    const c = (row.costumes || []).find((x) => x.id === row.costume_id);
    if (c && c.image_url) m[row.asset_id] = c;
  }
  return m;
});
function costumeOf(a) {
  return a.kind === 'character' ? costumeOverrideMap.value[a.id] : null;
}
function shotThumbUrl(a) {
  const c = costumeOf(a);
  if (c) return c.thumb_url || c.image_url;
  // 列表缩略优先用 webp 缩略图（原图 4K PNG 单张可达数 MB）；点开预览仍走原图
  return a.thumb_url || a.image_url;
}
// 点开预览的大图同样跟随服饰覆盖，否则改完服饰后缩略图已换、大图仍是角色默认图
function shotImageUrl(a) {
  const c = costumeOf(a);
  return (c && c.image_url) || a.image_url || '';
}

// 角色行的预览图：默认服饰图，否则首张服饰图
function rowDefaultImg(row) {
  const list = row?.costumes || [];
  const def = list.find((c) => c.is_default) || list[0];
  return def?.thumb_url || def?.image_url || '';
}

// 服饰配置弹窗里点缩略图预览大图：独立于本镜资产 viewer（翻页范围=该角色的全部服饰原图）
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
    const rows = await assetApi.episodeCostumeConfig(episodeId.value);
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
    await assetApi.saveEpisodeCostumeConfig(episodeId.value, configs);
    ElMessage.success(t('asset.costumeConfig.saved'));
    costumeCfg.open = false;
  } catch (e) {
    ElMessage.error(e?.message || t('errors.requestFailed'));
  } finally {
    costumeCfg.saving = false;
  }
}

function selectSegment(s) {
  activeId.value = s.id;
  editing.value = false;
}

// 顶栏集数选择：切换到其它剧集（改路由 :eid，watch(episodeId) 会重新加载）
function switchEpisode(eid) {
  if (!eid || Number(eid) === Number(episodeId.value)) return;
  // 重置本页 UI 状态，避免上一集残留
  activeId.value = null;
  expanded.value = {};
  editing.value = false;
  viewMode.value = 'table';
  router.push({ name: 'storyboard', params: { id: projectId.value, eid } });
}

// 分镜表下拉式：手风琴——展开当前镜时收起其它，再次点击已展开的则收起；同步选中
function toggleShot(s) {
  const isOpen = expanded.value[s.id];
  expanded.value = isOpen ? {} : { [s.id]: true };
  activeId.value = s.id;
}
function collapseAllShots() {
  expanded.value = {};
}
// 分镜表下拉式：点"编辑详情"直接切到详情模式并进入编辑态
function editShot(s) {
  selectSegment(s);
  startEdit();
  viewMode.value = 'detail';
}
// 从编辑详情返回分镜表列表
function backToList() {
  editing.value = false;
  viewMode.value = 'table';
}

// 插入一个空白分镜的公共流程（时长 4s，shot_no 由后端按 N-N-N 生成）
async function insertBlankSegment(payload) {
  try {
    const created = await storyboardApi.createSegment(episodeId.value, payload);
    // 后端已重排 idx，重新拉取保证列表顺序与 idx 一致
    segments.value = await storyboardApi.segments(episodeId.value);
    activeId.value = created.id;
    expanded.value = { [created.id]: true };
    ElMessage.success(t('storyboard.segmentAdded'));
    nextTick(() => {
      const container = document.querySelector('.shot-list-scroll');
      const el = container?.querySelector(`.shot-card[data-sid="${created.id}"]`);
      if (container && el) container.scrollTo({ top: el.offsetTop - container.offsetTop, behavior: 'smooth' });
    });
  } catch {
    // 失败提示由 http 拦截器统一处理
  }
}
// 在指定分镜之后插入一个空白分镜
function insertAfter(s) {
  return insertBlankSegment({ afterId: s.id });
}
// 在最前面（首个分镜之前）插入一个空白分镜；无分镜时等价于追加
function insertFirst() {
  const first = segments.value[0];
  return insertBlankSegment(first ? { beforeId: first.id } : {});
}

// 底部分镜轴：移动分镜位置（与前/后分镜交换顺序）。后端按新顺序归一化 idx 并返回全集列表，整体替换。
// 批量生成进行中 / 本镜生成中由后端拒绝，前端同步禁用按钮避免报错弹窗。
const movingMap = ref({}); // 移动请求进行中的分镜 id（禁用该镜按钮防连点）
async function moveSegment(s, direction) {
  if (movingMap.value[s.id]) return;
  movingMap.value[s.id] = true;
  try {
    segments.value = await storyboardApi.moveSegment(s.id, direction);
    ElMessage.success(t('storyboard.segmentMoved'));
    // 移动后让该镜保持在分镜轴可视区内（换位后槽位变化，长轴可能滚出视野）
    nextTick(() => {
      const el = document.querySelector(`.tl-item[data-sid="${s.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    });
  } catch {
    // 失败提示由 http 拦截器统一处理
  } finally {
    delete movingMap.value[s.id];
  }
}

// 删除指定分镜（二次确认；删除后刷新列表）
async function deleteSegment(s) {
  try {
    await ElMessageBox.confirm(t('storyboard.deleteSegmentConfirm', { name: s.shot_no || s.idx }), t('storyboard.deleteSegmentTitle'), {
      type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; } // 用户取消
  try {
    await storyboardApi.deleteSegment(s.id);
    segments.value = await storyboardApi.segments(episodeId.value);
    if (activeId.value === s.id) activeId.value = segments.value[0]?.id ?? null;
    ElMessage.success(t('storyboard.segmentDeleted'));
  } catch {
    // 失败提示由 http 拦截器统一处理
  }
}

// 删除指定分镜已生成的视频（二次确认）：清掉 video/keyframe/last_frame，状态回「待生成」，
// 保留 video_prompt，便于直接重新生成。生成中（isBusy）的镜不提供删除。
async function deleteVideo(s) {
  if (!s || !s.video_url || isBusy(s)) return;
  try {
    await ElMessageBox.confirm(t('storyboard.deleteVideoConfirm'), t('storyboard.deleteVideoTitle'), {
      type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; } // 用户取消
  // 删除前记录本镜在「已生成视频」序列中的位置：删除后同位置滑入的就是下一镜
  const prevIdx = segments.value.filter((x) => x.video_url).findIndex((x) => x.id === s.id);
  try {
    const fresh = await storyboardApi.deleteVideo(s.id);
    const i = segments.value.findIndex((x) => x.id === s.id);
    if (i > -1) segments.value[i] = fresh;
    // 预览窗内删除当前镜：自动切到下一镜（与时间轴切换同规则，只在已生成视频的分镜间移动）；
    // 本镜已是最后一镜则落到上一镜。表格模式下复用 selectFromTimeline 让列表滚到新镜；
    // 单镜详情模式下只切选中，不把用户强行拽回表格
    if (s.id === activeId.value && prevIdx > -1) {
      const list = segments.value.filter((x) => x.video_url);
      const next = list[Math.min(prevIdx, list.length - 1)];
      if (next && next.id !== s.id) {
        if (viewMode.value === 'table') selectFromTimeline(next);
        else selectSegment(next);
      }
    }
    ElMessage.success(t('storyboard.videoDeleted'));
  } catch {
    // 失败提示由 http 拦截器统一处理
  }
}
// 上传本地视频作为该分镜视频（用户自带素材，替代/补位 AI 生成）：打开文件选择框 → 已有视频则二次确认替换 → 上传 → 回写 segment。
// 与 AI 生成不同，不需要 video_prompt、不走 job 系统；上传中通过 uploadingMap 并入 isBusy 以禁用冲突操作。
const uploadInputRef = ref(null);
const uploadTargetId = ref(null);
function pickUploadVideo(s) {
  if (!s || isBusy(s)) return;
  uploadTargetId.value = s.id;
  if (uploadInputRef.value) uploadInputRef.value.value = ''; // 允许重复选择同一文件
  uploadInputRef.value?.click();
}
async function onUploadFileChange(e) {
  const file = e.target.files?.[0];
  const sid = uploadTargetId.value;
  uploadTargetId.value = null;
  if (!sid || !file) return;
  const s = segments.value.find((x) => x.id === sid);
  if (!s) return;
  // 已有视频（AI 生成或此前上传）→ 二次确认替换
  if (s.video_url) {
    try {
      await ElMessageBox.confirm(t('storyboard.replaceVideoConfirm'), t('storyboard.uploadVideo'), {
        type: 'warning', confirmButtonText: t('storyboard.uploadVideo'), cancelButtonText: t('common.cancel'),
      });
    } catch { return; } // 用户取消
  }
  uploadingMap.value[sid] = true;
  try {
    const fresh = await storyboardApi.uploadVideo(sid, file);
    const i = segments.value.findIndex((x) => x.id === sid);
    if (i > -1) segments.value[i] = fresh;
    ElMessage.success(t('storyboard.videoUploaded'));
  } catch {
    // 失败提示由 http 拦截器统一处理
  } finally {
    delete uploadingMap.value[sid];
  }
}

// 底部时间轴点击：激活并展开对应分镜卡片，平滑滚动至列表容器顶部对齐
function selectFromTimeline(s) {
  selectSegment(s);
  if (viewMode.value !== 'table') viewMode.value = 'table';
  expanded.value = { [s.id]: true };
  nextTick(() => {
    const container = document.querySelector('.shot-list-scroll');
    const el = container?.querySelector(`.shot-card[data-sid="${s.id}"]`);
    if (!container || !el) return;
    const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
  });
}
// 底部分镜轴：选中后用左右方向键切换前后分镜（与点击分镜轴行为一致）
function navigateShot(dir) {
  if (!segments.value.length) return;
  const curIdx = segments.value.findIndex((s) => s.id === activeId.value);
  const nextIdx = Math.min(Math.max((curIdx < 0 ? 0 : curIdx) + dir, 0), segments.value.length - 1);
  const target = segments.value[nextIdx];
  if (!target || target.id === activeId.value) return;
  selectFromTimeline(target);
  // 横向滚动让选中项进入分镜轴可视区
  nextTick(() => {
    const el = document.querySelector(`.tl-item[data-sid="${target.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  });
}
function onTimelineKeydown(e) {
  // 输入控件内不拦截方向键，避免影响文本编辑
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateShot(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateShot(1); }
}
// 任务/确认提示用的片段标识：分镜表章节(集) · 序号(镜号)
const shotTag = (s) =>
  `${episode.value?.title || t('storyboard.episodeN', { n: episode.value?.idx || '?' })} · ${s.shot_no || ('#' + s.idx)}`;

async function toggleSelect(s) {
  s.selected = !s.selected;
  // 即时落库，保证「合成全集」等服务端按 selected 读 DB 的逻辑与界面一致
  try {
    await storyboardApi.selectSegments(episodeId.value, [s.id], s.selected);
  } catch (e) {
    // 回滚界面状态，避免与后端不一致
    s.selected = !s.selected;
    ElMessage.error(t('storyboard.updateSelectFail'));
  }
}

// ===== 底部时间轴：手工设置「本镜 → 下一镜」的转场特效 =====
// 每个 popover 独立开关，以 segment id 为 key（trigger=click 自管，选中后手动置 false 关闭）。
const transVisibleMap = reactive({});
// 归一化转场值：未设置 / 历史值 'auto' 一律视为 'cut'（合成时不再自动添加转场，默认硬切）
const normTrans = (v) => (!v || v === 'auto' ? 'cut' : v);
async function pickTransition(s, value) {
  transVisibleMap[s.id] = false; // 立即关闭气泡
  if (normTrans(s.transition) === value) return;
  const prev = s.transition;
  s.transition = value; // 乐观更新，合成时后端按此字段选 xfade
  try {
    await storyboardApi.updateSegment(s.id, { transition: value });
    // 若该段正处于编辑态，同步编辑表单，避免保存时回写旧值
    if (editing.value && activeSegment.value?.id === s.id) editForm.value.transition = value;
    const label = TRANSITION_SHORT.value.find((o) => o.value === value)?.label || value;
    ElMessage.success(t('storyboard.transitionSet', { name: label }));
  } catch {
    s.transition = prev; // 回滚
    ElMessage.error(t('storyboard.setTransitionFail'));
  }
}

async function saveSelectAll(val) {
  const ids = segments.value.map((s) => s.id);
  await storyboardApi.selectSegments(episodeId.value, ids, val);
  segments.value.forEach((s) => (s.selected = val));
}

// 编辑当前片段
const editForm = ref({
  title: '', shot_no: '', scene_no: null,
  scene_script: '', video_prompt: '', duration: 5, transition: 'cut',
});
// 转场特效选项（value 对齐后端 xfade 白名单；'cut' 硬切为默认，合成时不再自动添加转场）
const TRANSITION_VALUES = ['cut', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'circleclose', 'radial', 'pixelize'];
const transLabel = (v) => t('storyboard.transition.' + normTrans(v));
const TRANSITION_OPTIONS = computed(() => TRANSITION_VALUES.map((v) => ({ value: v, label: transLabel(v) })));
// 底部时间轴「转场连接器」快捷入口：仅露出适合短剧的 7 种（详情编辑页仍保留全量 TRANSITION_OPTIONS）。
// value 对齐后端 xfade 白名单；short 为芯片上的 2 字简称。
const TRANSITION_SHORT_VALUES = ['cut', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'slideleft', 'slideright'];
const TRANSITION_SHORT = computed(() => TRANSITION_SHORT_VALUES.map((v) => ({ value: v, short: t('storyboard.transitionShort.' + v), label: transLabel(v) })));
// 转场芯片简称：优先精选表 short，回退全量 label 前两字，再回退「硬切」（兼容片段设了精选外转场的旧数据）
function transShortLabel(value) {
  const v = normTrans(value);
  const hit = TRANSITION_SHORT.value.find((o) => o.value === v);
  if (hit) return hit.short;
  const full = TRANSITION_OPTIONS.value.find((o) => o.value === v);
  return full ? full.label.slice(0, 2) : t('storyboard.transitionShort.cut');
}
// 是否为用户显式指定的转场（非硬切/未设置）→ 芯片高亮，提示「这里手工加过转场」
function isTransSet(value) {
  const v = normTrans(value);
  return v !== 'cut';
}
function startEdit() {
  if (!activeSegment.value) return;
  editing.value = true;
  const s = activeSegment.value;
  editForm.value = {
    title: s.title || '',
    shot_no: s.shot_no || '', scene_no: s.scene_no ?? null,
    scene_script: s.scene_script || '',
    video_prompt: s.video_prompt || '',
    duration: s.duration || 5, transition: normTrans(s.transition),
  };
}
async function saveEdit() {
  await storyboardApi.updateSegment(activeSegment.value.id, editForm.value);
  Object.assign(activeSegment.value, editForm.value);
  editing.value = false;
  viewMode.value = 'table';
  ElMessage.success(t('common.saveSuccess'));
}

// 检查是否有视频提示词，无则阻止生成视频
function requireVideoPrompt(s) {
  if (!s.video_prompt) {
    ElMessage.warning(t('storyboard.needPromptFirst'));
    return false;
  }
  return true;
}

// 生成本片段视频（异步任务）
async function generate(s) {
  if (!requireVideoPrompt(s)) return;
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
}

// 生成分镜提示词（异步任务，写入 video_prompt）
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

// 批量生成提示词（选中片段）——共享一个模型选择，汇总一次扣费确认
async function genPromptSelected() {
  const targets = segments.value.filter((s) => s.selected && !isBusyPrompt(s));
  if (!targets.length) return ElMessage.info(t('storyboard.noPromptTargets'));
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

// 仅重新生成视频（异步任务）
async function regenVideo(s) {
  if (!requireVideoPrompt(s)) return;
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: (sel) => storyboardApi.genEstimate(s.id, sel),
    createFor: (sel) => storyboardApi.generateVideo(s.id, sel),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    title: t('storyboard.genVideoTitle'), desc: t('storyboard.regenVideoDesc', { name: shotTag(s) }), confirmText: t('storyboard.generate'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.segment) {
        const i = segments.value.findIndex((x) => x.id === s.id);
        if (i > -1) segments.value[i] = j.result.segment;
      }
    },
  });
}

// 在线剪辑本镜视频：独立全屏窗口按分镜接源（seg-<id>）；导出写回替换本镜视频（时长/首尾帧同步更新）
function openVideoEditor(s) {
  if (!s || !s.video_url || isBusy(s)) return;
  window.open(`/editor/video/seg-${s.id}`, `aieditor_seg_${s.id}`)?.focus();
}

// 剪辑窗口导出完成（已写回本镜视频）：用消息携带的最新分镜行补位；拿不到时整表重拉兜底
function onEditorMessage(e) {
  if (e.origin !== window.location.origin) return;
  const d = e.data;
  if (!d || d.type !== 'aieditor:exported' || !d.segment_id) return;
  if (d.segment && d.segment.id) {
    const i = segments.value.findIndex((x) => x.id === d.segment.id);
    if (i > -1) { segments.value[i] = d.segment; return; }
  }
  storyboardApi.segments(episodeId.value).then((segs) => { segments.value = segs; }).catch(() => { /* 兜底失败忽略 */ });
}

// 去除本镜视频字幕（异步任务）：把原视频提交多模态视频模型，仅擦除字幕、其余保持不变，产物替换本镜视频
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

// 批量生成选中片段——提交一次后端批量任务：后端按分镜序号串行逐段生成（关页面/重启均不中断），
// 相邻同场景镜头自动以上一镜尾帧衔接；某段失败则跳过、继续，最终汇总成功/失败数。
async function generateSelected() {
  if (batchProgress.value.running) return;
  const targets = segments.value
    .filter((s) => s.selected && !isBusy(s)) // 选中即生成：已有视频的段由服务端先删旧视频再整批重生成
    .sort((a, b) => (a.idx || 0) - (b.idx || 0)); // 按分镜序号
  if (!targets.length) return ElMessage.info(t('storyboard.noGenTargets'));
  // 过滤掉没有 video_prompt 的片段
  const noPrompt = targets.filter((s) => !s.video_prompt);
  if (noPrompt.length) return ElMessage.warning(t('storyboard.someNoPrompt', { count: noPrompt.length }));
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: async (sel) => {
      // 汇总各段估算（与 useCostAction.sumEstimate 同构）
      const arr = await Promise.all(targets.map((t) => storyboardApi.genEstimate(t.id, sel).catch(() => null)));
      const ok0 = arr.filter(Boolean);
      const credits = ok0.reduce((n, r) => n + (Number(r.credits) || 0), 0);
      const discountedCredits = ok0.reduce((n, r) => n + (Number(r.discountedCredits) || Number(r.credits) || 0), 0);
      const first = ok0[0] || {};
      return { credits, count: ok0.length, originalCredits: credits, discountedCredits, discount: Number(first.discount) || 0, tier: first.tier || 'none', promo: ok0.map((r) => r.promo).find(Boolean) || null };
    },
    createFor: (sel) => storyboardApi.generateBatch(episodeId.value, { segmentIds: targets.map((t) => t.id), modelConfigId: sel.modelConfigId, resolution: sel.resolution }),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    onDone: (j) => {
      refreshSegments();
      if (j.status === 'succeeded') {
        const r = j.result || {};
        if (r.failed?.length) ElMessage.warning(t('storyboard.batchDoneWithFailures', { ok: r.completed?.length || 0, fail: r.failed.length }));
      }
    },
    title: t('storyboard.batchSerialTitle'),
    desc: t('storyboard.batchSerialDesc', { count: targets.length }),
    confirmText: t('storyboard.batchGenerate'),
  });
}

// 批量「并发」生成选中片段——提交一次后端并发批量任务：后端用有界并发池(最多4段)同时生成，
// 不串行排队、速度快；并发段之间不做跨镜首尾帧衔接，各段独立生成；某段失败则跳过、退款，继续其余。
async function generateSelectedConcurrent() {
  if (anyBatchRunning.value) return;
  const targets = segments.value
    .filter((s) => s.selected && !isBusy(s)) // 选中即生成：已有视频的段由服务端先删旧视频再整批重生成
    .sort((a, b) => (a.idx || 0) - (b.idx || 0)); // 按分镜序号（仅用于稳定的估价/展示顺序，实际并发）
  if (!targets.length) return ElMessage.info(t('storyboard.noGenTargets'));
  const noPrompt = targets.filter((s) => !s.video_prompt);
  if (noPrompt.length) return ElMessage.warning(t('storyboard.someNoPrompt', { count: noPrompt.length }));
  await runJob({
    modelType: 'video',
    selection: { modelConfigId: videoModelId.value, resolution: videoResolution.value },
    estimateFor: async (sel) => {
      const arr = await Promise.all(targets.map((t) => storyboardApi.genEstimate(t.id, sel).catch(() => null)));
      const ok0 = arr.filter(Boolean);
      const credits = ok0.reduce((n, r) => n + (Number(r.credits) || 0), 0);
      const discountedCredits = ok0.reduce((n, r) => n + (Number(r.discountedCredits) || Number(r.credits) || 0), 0);
      const first = ok0[0] || {};
      return { credits, count: ok0.length, originalCredits: credits, discountedCredits, discount: Number(first.discount) || 0, tier: first.tier || 'none', promo: ok0.map((r) => r.promo).find(Boolean) || null };
    },
    createFor: (sel) => storyboardApi.generateBatchConcurrent(episodeId.value, { segmentIds: targets.map((t) => t.id), modelConfigId: sel.modelConfigId, resolution: sel.resolution }),
    onConfirm: (sel) => { videoModelId.value = sel.modelConfigId; videoResolution.value = sel.resolution; },
    onDone: (j) => {
      refreshSegments();
      if (j.status === 'succeeded') {
        const r = j.result || {};
        if (r.failed?.length) ElMessage.warning(t('storyboard.concurrentDoneWithFailures', { ok: r.completed?.length || 0, fail: r.failed.length }));
      }
    },
    title: t('storyboard.batchConcurrentTitle'),
    desc: t('storyboard.batchConcurrentDesc', { count: targets.length }),
    confirmText: t('storyboard.batchGenerate'),
  });
}

// 取消正在运行的串行批量视频生成：后端翻转 cancelled 标志，workFn 下一段循环顶部检测到即停；
// 当前正在生成的那段会自然完成（成功计费/失败退款），后续段不再执行。分段列表由 generateSelected
// 的 onDone（任务转终态时触发）接管刷新。
async function cancelBatch() {
  const job = batchJob.value;
  if (!job || cancellingBatch.value) return;
  try {
    await ElMessageBox.confirm(t('storyboard.cancelBatchConfirm'), t('storyboard.cancelSerialTitle'), {
      type: 'warning', confirmButtonText: t('storyboard.cancelGenerate'), cancelButtonText: t('storyboard.reconsider'),
    });
  } catch { return; } // 用户放弃取消
  cancellingBatch.value = true;
  try {
    await jobs.cancel(job.id);
    ElMessage.success(t('storyboard.serialCancelled'));
  } catch {
    // 失败提示由 store/http 拦截器统一处理
  } finally {
    cancellingBatch.value = false;
  }
}

// 取消正在运行的并发批量视频生成：后端翻转 cancelled 标志，池中待跑段不再启动；
// 当前正在生成的若干段会自然完成（成功计费/失败退款）。分段列表由 generateSelectedConcurrent
// 的 onDone（任务转终态时触发）接管刷新。
async function cancelBatchConcurrent() {
  const job = batchConcurrentJob.value;
  if (!job || cancellingConcurrent.value) return;
  try {
    await ElMessageBox.confirm(t('storyboard.cancelBatchConfirm'), t('storyboard.cancelConcurrentTitle'), {
      type: 'warning', confirmButtonText: t('storyboard.cancelGenerate'), cancelButtonText: t('storyboard.reconsider'),
    });
  } catch { return; } // 用户放弃取消
  cancellingConcurrent.value = true;
  try {
    await jobs.cancel(job.id);
    ElMessage.success(t('storyboard.concurrentCancelled'));
  } catch {
    // 失败提示由 store/http 拦截器统一处理
  } finally {
    cancellingConcurrent.value = false;
  }
}

// 合成全集（异步任务，非大模型调用：不选模型，只选分辨率档位 + 确认价格）
async function compose() {
  const ready = segments.value.filter((s) => s.selected && s.video_url);
  if (!ready.length) return ElMessage.warning(t('storyboard.composeNeedReady'));
  await runJob({
    resolutionOptions: COMPOSE_RESOLUTIONS,
    resolutionHint: t('storyboard.composeResolutionHint'),
    selection: { resolution: composeResolution.value },
    estimateFor: (sel) => videoApi.composeEstimate(episodeId.value, sel.resolution),
    createFor: (sel) => videoApi.compose(episodeId.value, { resolution: sel.resolution }),
    onConfirm: (sel) => {
      composeResolution.value = sel.resolution;
      try { localStorage.setItem(COMPOSE_RES_KEY, sel.resolution); } catch { /* localStorage 不可用 */ }
    },
    title: t('storyboard.composeTitle'), desc: t('storyboard.composeDesc'), confirmText: t('storyboard.compose'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.episode) {
        episode.value = j.result.episode;
        ElMessage.success(t('storyboard.composeDoneTip'));
      }
    },
  });
}
// 轻量刷新分镜列表（批量运行期间定时调用，反映逐段 generating→done 的实时进度；不触发 loading 遮罩）
async function refreshSegments() {
  try { segments.value = await storyboardApi.segments(episodeId.value); } catch { /* ignore */ }
}
// 批量任务运行期间每 3s 刷新分镜；结束即停。重进页面时 batchJob 由 jobs store 恢复，定时器随之重建。
let _segPollTimer = null;
watch(() => anyBatchRunning.value, (running) => {
  if (running && !_segPollTimer) _segPollTimer = setInterval(refreshSegments, 3000);
  else if (!running && _segPollTimer) { clearInterval(_segPollTimer); _segPollTimer = null; }
});
onBeforeUnmount(() => { if (_segPollTimer) clearInterval(_segPollTimer); });

watch(episodeId, load);
onMounted(load);
onMounted(() => { void ensureVoices(); }); // 音色表：本镜角色条目旁的试听按钮要用（audio_url 样本）
onMounted(() => window.addEventListener('keydown', onTimelineKeydown));
onMounted(() => window.addEventListener('message', onEditorMessage));
onBeforeUnmount(() => window.removeEventListener('keydown', onTimelineKeydown));
onBeforeUnmount(() => window.removeEventListener('message', onEditorMessage));
onBeforeUnmount(() => { voiceAudioEl.value?.pause(); }); // 离开分镜页停止音色试听
</script>

<template>
  <div class="editor" v-loading="loading">
    <!-- 顶栏 -->
    <div class="ed-topbar">
      <div class="left ad-flex-center ad-gap-sm">
        <el-button text @click="router.push(`/projects/${projectId}?step=3`)"><el-icon><ArrowLeft /></el-icon> {{ t('storyboard.backToProject') }}</el-button>
        <el-dropdown
          v-if="episodes.length > 1"
          trigger="click"
          placement="bottom-start"
          popper-class="ep-dropdown"
          @command="switchEpisode"
        >
          <span class="ep-name ep-selectable">
            {{ t('storyboard.episodeN', { n: episode?.idx }) }} · {{ episode?.title || t('storyboard.untitled') }}
            <el-icon class="ep-caret"><CaretBottom /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="e in episodes"
                :key="e.id"
                :command="e.id"
                :class="{ 'is-current': e.id === Number(episodeId) }"
              >
                {{ t('storyboard.episodeN', { n: e.idx }) }} · {{ e.title || t('storyboard.untitled') }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <span v-else class="ep-name">{{ t('storyboard.episodeN', { n: episode?.idx }) }} · {{ episode?.title || t('storyboard.untitled') }}</span>
        <span class="chip">{{ project?.aspect_ratio || episode?.project?.aspect_ratio || '9:16' }}</span>
        <el-button v-if="canEditAsset" size="small" @click="openCostumeConfig"><el-icon><Brush /></el-icon> {{ t('asset.costumeConfig.button') }}</el-button>
        <el-button v-if="viewMode !== 'table'" size="small" @click="backToList"><el-icon><ArrowLeft /></el-icon> {{ t('storyboard.backToStoryboard') }}</el-button>
      </div>
    </div>

    <!-- 团队共享：member 无任何写权限时的只读提示 -->
    <div v-if="readonlyAll" class="ro-banner"><el-icon><Lock /></el-icon>{{ t('team.readonlyBanner') }}</div>

    <div class="ed-body">
      <!-- 左侧资产面板：本镜关联资产 -->
      <aside class="ed-left ad-card">
        <div class="left-head">
          <span class="ad-muted">{{ t('storyboard.shotAssets') }}</span>
          <div class="ad-flex-center ad-gap-sm">
            <span v-if="leftList.length" class="left-count">{{ leftList.length }}</span>
            <el-tooltip v-if="canEditStoryboard" :content="t('storyboard.addFromLibrary')" placement="bottom">
              <el-button text size="small" class="left-add" :disabled="!activeSegment" @click="openAssetPicker">
                <el-icon><Plus /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </div>
        <div class="left-list">
          <div v-for="a in leftList" :key="a.id" class="ast-item">
            <div class="ast-thumb" :class="{ clickable: assetPreviewable(a) }" :title="assetPreviewable(a) ? t('common.preview') : ''" @click="previewAsset(a)">
              <img v-if="shotThumbUrl(a)" :src="shotThumbUrl(a)" />
              <el-icon v-else><component :is="kindIcon(a.kind)" /></el-icon>
              <span v-if="a.kind === 'video' && a.meta?.videoUrl" class="ast-play"><el-icon><VideoPlay /></el-icon></span>
            </div>
            <div class="ast-body">
              <div class="ast-name">{{ a.name }}</div>
              <span class="ast-badge" :class="a.kind">{{ kindLabel(a.kind) }}</span>
            </div>
            <!-- 角色绑定音色：条目旁试听小按钮，点击播放/停止音色样本 -->
            <button
              v-if="voiceIdOf(a)"
              type="button" class="ast-voice" :class="{ playing: previewVoiceId === voiceIdOf(a) }"
              :title="previewVoiceId === voiceIdOf(a) ? t('voice.stopPreview') : t('voice.preview')"
              @click.stop="toggleVoicePreview(voiceIdOf(a))"
            >
              <el-icon><component :is="previewVoiceId === voiceIdOf(a) ? 'VideoPause' : 'Headset'" /></el-icon>
            </button>
            <el-icon v-if="canEditStoryboard" class="ast-remove" :title="t('storyboard.remove')" @click="removeAsset(a)"><Close /></el-icon>
          </div>
          <div v-if="!leftList.length" class="ad-muted left-empty">{{ activeSegment ? t('storyboard.noShotAssets') : t('storyboard.pleaseSelectSegment') }}</div>
        </div>
      </aside>

      <!-- 中间：分镜表（表格 / 详情 双模） -->
      <section class="ed-center ad-card">
        <!-- 分镜表（下拉式） -->
        <div v-if="viewMode === 'table'" class="shot-list-wrap">
          <div class="shot-list-head ad-flex-between">
            <span class="ad-title">{{ t('storyboard.storyboardList') }} · {{ t('storyboard.shotCount', { count: segments.length }) }}</span>
            <el-button text size="small" @click="collapseAllShots">{{ t('storyboard.collapseAll') }}</el-button>
          </div>
          <div class="shot-list-scroll">
            <div class="shot-list">
              <div
                v-for="s in segments" :key="s.id"
                class="shot-card ad-card"
                :data-sid="s.id"
                :class="{ active: s.id === activeId, done: s.video_url }"
              >
                <div class="shot-head" @click="toggleShot(s)">
                  <span class="shot-no">{{ s.shot_no || s.idx }}</span>
                  <div class="shot-head-info">
                    <span class="shot-title">{{ s.title }}</span>
                  </div>
                  <!-- 已审（reviewed_at 非空）后状态字由「已生成」改显「已审」，与预览窗审阅标记同口径 -->
                  <span class="chip" :class="s.video_url ? 'chip-success' : ''">{{ s.video_url ? (s.reviewed_at ? t('episode.videos.reviewed') : t('storyboard.statusGenerated')) : t('storyboard.statusPending') }}</span>
                  <span class="shot-dur">{{ s.duration }}s</span>
                  <el-icon class="caret"><component :is="expanded[s.id] ? 'ArrowUp' : 'ArrowDown'" /></el-icon>
                </div>
                <div v-if="expanded[s.id]" class="shot-body">
                  <div class="shot-detail-head ad-flex-between">
                    <span class="ad-title">{{ s.shot_no || ('#' + s.idx) }} {{ t('storyboard.detail') }}</span>
                    <div class="ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
                      <el-button v-if="canGen" size="small" :loading="isBusyPrompt(s)" :disabled="isBusyPrompt(s)" @click="genPrompt(s)"><el-icon><MagicStick /></el-icon> {{ t('storyboard.genVideoPrompt') }}</el-button>
                      <el-button v-if="canGen" size="small" :loading="isBusy(s)" :disabled="isBusy(s) || !s.video_prompt" @click="generate(s)"><el-icon><VideoPlay /></el-icon> {{ t('storyboard.generateVideoNow') }}</el-button>
                      <el-button v-if="canEditStoryboard" size="small" :loading="isBusy(s)" :disabled="isBusy(s)" @click="pickUploadVideo(s)"><el-icon><Upload /></el-icon> {{ t('storyboard.uploadVideo') }}</el-button>
                      <el-button v-if="canEditStoryboard" size="small" @click="editShot(s)"><el-icon><EditPen /></el-icon> {{ t('common.edit') }}</el-button>
                      <el-button v-if="canEditStoryboard" size="small" @click="deleteSegment(s)"><el-icon><Delete /></el-icon> {{ t('common.delete') }}</el-button>
                    </div>
                  </div>

                  <div v-if="s.scene_script" class="shot-sec scene-script-box">
                    <div class="sec-label"><span class="dot"></span>{{ t('storyboard.sceneScript') }}</div>
                    <div class="sec-text">{{ s.scene_script }}</div>
                  </div>

                  <div v-if="s.video_prompt" class="shot-sec">
                    <div class="sec-label"><span class="dot"></span>{{ t('storyboard.videoPrompt') }}</div>
                    <div class="sec-text mono">{{ s.video_prompt }}</div>
                  </div>

                  <div class="shot-foot" v-if="!s.video_prompt">
                    <span class="ad-muted" style="font-size:12px;">{{ t('storyboard.needGenPromptFirst') }}</span>
                  </div>
                </div>
              </div>
              <div v-if="!segments.length" class="ad-muted" style="padding: 24px; text-align: center;">{{ t('storyboard.emptySegments') }}</div>
            </div>
          </div>
        </div>

        <!-- 详情模式（富卡片） -->
        <template v-else>
          <template v-if="activeSegment">
            <div class="seg-head">
              <div class="seg-title-wrap">
                <span class="ad-title">{{ activeSegment.shot_no || t('storyboard.segmentN', { n: String(activeSegment.idx).padStart(2, '0') }) }}</span>
                <span v-if="activeSegment.title" class="seg-title-text">{{ activeSegment.title }}</span>
              </div>
              <div class="ad-flex-center ad-gap-sm">
                <el-button size="small" v-if="!editing && canEditStoryboard" @click="startEdit"><el-icon><EditPen /></el-icon> {{ t('common.edit') }}</el-button>
                <template v-else>
                  <el-button size="small" @click="backToList">{{ t('common.cancel') }}</el-button>
                  <el-button size="small" type="primary" class="btn-ink" @click="saveEdit">{{ t('common.save') }}</el-button>
                </template>
              </div>
            </div>

            <!-- 查看态 -->
            <div v-if="!editing" class="seg-view">
              <div class="seg-title-row">
                <span class="chip chip-dur">{{ activeSegment.duration }}s</span>
              </div>

              <div v-if="activeSegment.scene_script" class="seg-scene-script">
                <span class="ad-muted">{{ t('storyboard.sceneScriptColon') }}</span>{{ activeSegment.scene_script }}
              </div>

              <div v-if="activeSegment.video_prompt" class="seg-section">
                <div class="seg-section-label">{{ t('storyboard.videoPrompt') }}</div>
                <div class="seg-vp-body mono">{{ activeSegment.video_prompt }}</div>
              </div>

              <div class="seg-foot">
                <el-button v-if="canGen" :loading="isBusyPrompt(activeSegment)" :disabled="isBusyPrompt(activeSegment)" @click="genPrompt(activeSegment)">
                  <el-icon><MagicStick /></el-icon> {{ t('storyboard.genVideoPrompt') }}
                </el-button>
                <el-button v-if="canGen" type="primary" class="btn-ink" :loading="isBusy(activeSegment)" :disabled="isBusy(activeSegment) || !activeSegment.video_prompt" @click="generate(activeSegment)">
                  <el-icon><VideoPlay /></el-icon> {{ t('storyboard.generateNow') }}
                </el-button>
                <el-button v-if="canEditStoryboard" :loading="isBusy(activeSegment)" :disabled="isBusy(activeSegment)" @click="pickUploadVideo(activeSegment)">
                  <el-icon><Upload /></el-icon> {{ t('storyboard.uploadVideo') }}
                </el-button>
                  <span v-if="!activeSegment.video_prompt" class="ad-muted" style="font-size:12px;">{{ t('storyboard.needGenPromptFirst') }}</span>
              </div>
            </div>

            <!-- 编辑态 -->
            <div v-else class="seg-edit">
              <el-form label-position="top">
                <el-form-item :label="t('storyboard.fieldTitle')">
                  <el-input size="large" v-model="editForm.title" :placeholder="t('storyboard.titlePlaceholder')" maxlength="100" />
                </el-form-item>
                <div class="form-grid">
                  <el-form-item :label="t('storyboard.fieldShotNo')"><el-input size="large" v-model="editForm.shot_no" :placeholder="t('storyboard.shotNoPlaceholder')" /></el-form-item>
                  <el-form-item :label="t('storyboard.fieldDurationSeconds')"><el-input-number v-model="editForm.duration" :min="2" :max="15" /></el-form-item>
                  <el-form-item :label="t('storyboard.fieldTransition')">
                    <el-select size="large" v-model="editForm.transition" :placeholder="t('storyboard.transition.cut')">
                      <el-option v-for="o in TRANSITION_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
                    </el-select>
                    <div class="ad-muted" style="font-size:12px;margin-top:2px;">{{ t('storyboard.transitionTip') }}</div>
                  </el-form-item>
                </div>
                <el-form-item :label="t('storyboard.sceneScript')">
                  <el-input size="large" v-model="editForm.scene_script" type="textarea" :rows="4" />
                </el-form-item>
                <el-form-item :label="t('storyboard.videoPrompt')">
                  <el-input size="large" v-model="editForm.video_prompt" type="textarea" :rows="10" />
                </el-form-item>
              </el-form>
            </div>
          </template>
          <div v-else class="ed-empty">{{ t('storyboard.emptySegments') }}</div>
        </template>
      </section>

      <!-- 右侧：有视频时显示「视频预览」窗口 -->
      <aside v-if="activeSegment?.video_url" class="ed-right ad-card">
        <div class="right-title">
          <span class="ad-muted">{{ t('common.preview') }}</span>
          <el-button v-if="canGen" text size="small" :loading="isBusy(activeSegment)" :disabled="isBusy(activeSegment) || !activeSegment.video_prompt" @click="regenVideo(activeSegment)">
            <el-icon><Refresh /></el-icon> {{ t('storyboard.regenerate') }}
          </el-button>
        </div>
        <div class="preview-wrap">
          <VideoPreview :src="activeSegment.video_url" :poster="activeSegment.keyframe_url" />
          <button v-if="canEditStoryboard" class="vp-del" :title="t('storyboard.deleteVideoTitle')" @click="deleteVideo(activeSegment)">
            <el-icon><Delete /></el-icon>
          </button>
          <!-- 在线剪辑本镜视频：独立全屏窗口，导出后写回替换本镜视频 -->
          <button v-if="canVideo && !isBusy(activeSegment)" class="vp-cut" :title="t('storyboard.editVideo')" @click="openVideoEditor(activeSegment)">
            <el-icon><Scissor /></el-icon>
          </button>
        </div>
        <div class="right-meta">
          <span class="chip chip-success">{{ activeSegment.reviewed_at ? t('episode.videos.reviewed') : t('storyboard.statusGenerated') }}</span>
          <span class="ad-muted">{{ t('storyboard.segmentMeta', { n: String(activeSegment.idx).padStart(2, '0'), dur: activeSegment.duration }) }}</span>
        </div>
      </aside>
      <!-- 右侧：没有视频时，在这个位置显示「视频生成提示词」窗口 -->
      <aside v-else class="ed-right ad-card">
        <div class="right-title">
          <span class="ad-muted">{{ t('storyboard.videoPrompt') }}</span>
        </div>
        <div class="prompt-body">
          <div v-if="activeSegment?.video_prompt" class="prompt-text">{{ activeSegment.video_prompt }}</div>
          <div v-else class="prompt-empty">{{ activeSegment ? t('storyboard.noPromptYet') : t('storyboard.selectSegmentToView') }}</div>
        </div>
        <div v-if="activeSegment" class="right-meta">
          <span class="chip">{{ t('storyboard.statusPending') }}</span>
          <span class="ad-muted">{{ t('storyboard.segmentMeta', { n: String(activeSegment.idx).padStart(2, '0'), dur: activeSegment.duration }) }}</span>
        </div>
      </aside>
    </div>

    <!-- 底部时间轴 -->
    <div class="ed-bottom ad-card">
      <div class="bot-head ad-flex-between">
        <div class="ad-flex-center ad-gap-sm">
          <el-checkbox :model-value="selectedCount === segments.length && segments.length > 0" :disabled="!canEditStoryboard" @change="(v) => canEditStoryboard && saveSelectAll(v)">{{ t('storyboard.selectAll') }} {{ selectedCount }}/{{ segments.length }}</el-checkbox>
        </div>
        <div class="ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
          <el-button @click="runAudit" :disabled="anyBatchRunning" :loading="auditState.running"><el-icon><DocumentChecked /></el-icon> {{ t('storyboard.audit') }}</el-button>
          <el-button v-if="canGen" @click="genPromptSelected" :disabled="anyBatchRunning"><el-icon><MagicStick /></el-icon> {{ t('storyboard.genVideoPrompt') }}（{{ selectedCount }}）</el-button>
          <el-button v-if="canGen" type="primary" class="btn-ink" :loading="batchProgress.running" :disabled="anyBatchRunning" @click="generateSelected"><el-icon><VideoPlay /></el-icon> {{ t('storyboard.generateVideoInOrder') }}（{{ selectedCount }}）</el-button>
          <el-button v-if="canGen" type="primary" class="btn-ink" :loading="batchConcurrentProgress.running" :disabled="anyBatchRunning || !!composeJob" @click="generateSelectedConcurrent"><el-icon><VideoPlay /></el-icon> {{ t('storyboard.batchGenerateVideo') }}（{{ selectedCount }}）</el-button>
          <el-button v-if="canVideo" :loading="!!composeJob" :disabled="!!composeJob || anyBatchRunning" @click="compose"><el-icon><Film /></el-icon> {{ t('storyboard.composeAll') }}</el-button>
          <span v-if="batchProgress.running" class="ad-sub" style="color: var(--ad-brand);">{{ t('storyboard.serialGenerating') }} {{ batchProgress.index }}/{{ batchProgress.total }}</span>
          <el-button v-if="batchProgress.running" :loading="cancellingBatch" link type="warning" size="small" @click="cancelBatch">{{ t('common.cancel') }}</el-button>
          <span v-if="batchConcurrentProgress.running" class="ad-sub" style="color: var(--ad-brand);">{{ t('storyboard.concurrentGenerating') }} {{ batchConcurrentProgress.done }}/{{ batchConcurrentProgress.total }}</span>
          <el-button v-if="batchConcurrentProgress.running" :loading="cancellingConcurrent" link type="warning" size="small" @click="cancelBatchConcurrent">{{ t('common.cancel') }}</el-button>
        </div>
      </div>
      <div v-if="composeJob" class="compose-progress">
        <span class="cp-stage">{{ composeJob.stage || t('storyboard.jobQueued') }} · {{ composeJob.progress || 0 }}%</span>
        <el-progress :percentage="composeJob.progress || 0" :show-text="false" :stroke-width="4" />
      </div>
      <div class="timeline">
        <!-- 片段轴最前面：插入空白分镜（插到首个片段之前） -->
        <div v-if="segments.length && canEditStoryboard" class="tl-add-lead">
          <button type="button" class="tl-add-btn" :title="t('storyboard.addFirstTitle')" @click="insertFirst()"><el-icon><Plus /></el-icon></button>
        </div>
        <template v-for="(s, i) in segments" :key="s.id">
        <div
          class="tl-item"
          :data-sid="s.id"
          :class="{ active: s.id === activeId, done: s.video_url, generating: isBusy(s) }"
          @click="selectFromTimeline(s)"
        >
          <div class="tl-thumb">
            <img v-if="s.keyframe_url" :src="s.keyframe_url" />
            <el-icon v-else><Picture /></el-icon>
            <el-checkbox class="tl-check" :model-value="s.selected" :disabled="!canEditStoryboard" @click.stop @change="canEditStoryboard && toggleSelect(s)" />
            <div v-if="isBusy(s)" class="tl-loading"><el-icon class="is-loading"><Loading /></el-icon></div>
            <el-icon v-if="s.video_url" class="tl-play"><VideoPlay /></el-icon>
            <!-- 移动位置：‹ 与前一分镜交换 / › 与后一分镜交换（首/末镜对应方向禁用） -->
            <div v-if="canEditStoryboard" class="tl-move-group">
              <button
                type="button" class="tl-move"
                :disabled="i === 0 || isBusy(s) || anyBatchRunning || !!movingMap[s.id]"
                :title="t('storyboard.movePrevTitle', { name: s.shot_no || s.idx })"
                @click.stop="moveSegment(s, -1)"
              ><el-icon><ArrowLeft /></el-icon></button>
              <button
                type="button" class="tl-move"
                :disabled="i === segments.length - 1 || isBusy(s) || anyBatchRunning || !!movingMap[s.id]"
                :title="t('storyboard.moveNextTitle', { name: s.shot_no || s.idx })"
                @click.stop="moveSegment(s, 1)"
              ><el-icon><ArrowRight /></el-icon></button>
            </div>
            <button v-if="s.video_url && !isBusy(s) && canEditStoryboard" class="tl-del" :title="t('storyboard.deleteVideoTitle')" @click.stop="deleteVideo(s)">
              <el-icon><Delete /></el-icon>
            </button>
            <!-- 去除字幕：把本镜视频提交多模态视频模型擦除字幕，产物替换本镜视频 -->
            <button v-if="s.video_url && !isBusy(s) && canGen" class="tl-erase" :title="t('storyboard.eraseSubtitle')" @click.stop="eraseSubtitle(s)">
              <el-icon><Hide /></el-icon>
            </button>
            <!-- 在线剪辑本镜视频：独立全屏窗口，导出后写回替换本镜视频 -->
            <button v-if="s.video_url && !isBusy(s) && canVideo" class="tl-cut" :title="t('storyboard.editVideo')" @click.stop="openVideoEditor(s)">
              <el-icon><Scissor /></el-icon>
            </button>
          </div>
          <div class="tl-label">{{ t('storyboard.timelineShot', { n: s.shot_no || s.idx, dur: s.duration }) }}</div>
        </div>
        <!-- 两个分镜之间：转场连接器（手工设置本镜→下一镜的转场）+ 新增分镜 -->
        <div class="tl-connector">
          <el-popover
            v-if="canEditStoryboard"
            v-model:visible="transVisibleMap[s.id]"
            placement="top"
            :width="208"
            trigger="click"
            popper-class="tl-trans-pop"
          >
            <template #reference>
              <button
                type="button"
                class="tl-trans"
                :class="{ set: isTransSet(s.transition) }"
                :title="t('storyboard.transToNextTitle', { name: transShortLabel(s.transition) })"
                @click.stop
              >
                <el-icon class="tl-trans-ico"><Scissor v-if="!isTransSet(s.transition)" /><Switch v-else /></el-icon>
                <span class="tl-trans-txt">{{ transShortLabel(s.transition) }}</span>
              </button>
            </template>
            <div class="tl-trans-title">{{ t('storyboard.thisToNext') }} · {{ t('storyboard.transitionLabel') }}</div>
            <div class="tl-trans-grid">
              <button
                v-for="o in TRANSITION_SHORT"
                :key="o.value"
                type="button"
                class="tl-trans-opt"
                :class="{ selected: normTrans(s.transition) === o.value }"
                @click="pickTransition(s, o.value)"
              >{{ o.label }}</button>
            </div>
          </el-popover>
          <button v-if="canEditStoryboard" type="button" class="tl-add-btn" :title="t('storyboard.addAfterTitle', { name: s.shot_no || s.idx })" @click="insertAfter(s)"><el-icon><Plus /></el-icon></button>
        </div>
        </template>
        <div v-if="!segments.length" class="ad-muted" style="padding:16px;">{{ t('storyboard.noSegments') }}</div>
      </div>
    </div>

    <!-- 本镜资产图片预览 -->
    <el-image-viewer
      v-if="previewUrl"
      :url-list="previewList.length ? previewList : [previewUrl]"
      :initial-index="previewIndex"
      hide-on-click-modal
      @close="previewUrl = ''"
    />

    <!-- 服饰配置弹窗的大图预览：独立 viewer，翻页范围=该角色的全部服饰 -->
    <el-image-viewer
      v-if="costumePreview.open"
      :url-list="costumePreview.list"
      :initial-index="costumePreview.index"
      hide-on-click-modal
      @close="costumePreview.open = false"
    />

    <!-- 分镜上传视频用的隐藏文件选择框 -->
    <input ref="uploadInputRef" type="file" accept="video/*" style="display:none" @change="onUploadFileChange" />
    <!-- 音色试听音频元素（放弹窗外：本镜资产条目旁的按钮也要用，弹窗关着也能播） -->
    <audio ref="voiceAudioEl" hidden></audio>

    <!-- 本镜视频资产预览：视频旁提供本镜角色的音色试听（绑定音色样本） -->
    <el-dialog v-model="shotVideo.open" :title="shotVideo.name" width="min(960px, 94vw)" align-center destroy-on-close append-to-body class="shot-video-dialog">
      <!-- 统一走 VideoPreview，不裸挂 autoplay video（浏览器拦自动播放；组件内处理播放态） -->
      <VideoPreview v-if="shotVideo.url" :src="shotVideo.url" class="sv-video" />
      <div v-if="shotVoiceChars.length" class="sv-voices">
        <span class="sv-voices-label">{{ t('storyboard.voicePreview') }}</span>
        <button
          v-for="{ asset, voice } in shotVoiceChars" :key="asset.id"
          type="button" class="sv-voice-btn" :class="{ playing: previewVoiceId === voice.id }"
          :title="previewVoiceId === voice.id ? t('voice.stopPreview') : t('voice.preview')"
          @click="toggleVoicePreview(voice.id)"
        >
          <el-icon><component :is="previewVoiceId === voice.id ? 'VideoPause' : 'Headset'" /></el-icon>
          <span>{{ asset.name }}</span>
        </button>
      </div>
    </el-dialog>

    <!-- 从资产库添加资产 -->
    <el-dialog v-model="assetPicker.open" :title="t('storyboard.addFromLibraryTitle')" width="min(680px, 94vw)" append-to-body :close-on-click-modal="false">
      <div class="picker-toolbar ad-flex-center ad-gap-sm">
        <el-radio-group v-model="assetPicker.kind" size="small">
          <el-radio-button value="">{{ t('storyboard.kindAll') }}</el-radio-button>
          <el-radio-button value="character">{{ t('storyboard.assetKind.character') }}</el-radio-button>
          <el-radio-button value="scene">{{ t('storyboard.assetKind.scene') }}</el-radio-button>
          <el-radio-button value="prop">{{ t('storyboard.assetKind.prop') }}</el-radio-button>
          <el-radio-button value="material">{{ t('storyboard.assetKind.material') }}</el-radio-button>
          <el-radio-button value="video">{{ t('storyboard.assetKind.video') }}</el-radio-button>
        </el-radio-group>
        <el-input v-model="assetPicker.q" :placeholder="t('storyboard.searchAssetPlaceholder')" size="large" clearable style="width:200px;">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
      <div class="picker-list">
        <div
          v-for="a in pickerCandidates" :key="a.id"
          class="picker-item"
          :class="{ selected: pickerSelectedSet.has(a.id), added: isRefAsset(a.id), disabled: isRefAsset(a.id) }"
          @click="togglePick(a)"
        >
          <div class="ast-thumb">
            <img v-if="a.image_url" :src="a.thumb_url || a.image_url" loading="lazy" decoding="async" />
            <el-icon v-else><component :is="kindIcon(a.kind)" /></el-icon>
          </div>
          <div class="picker-meta">
            <div class="ast-name">{{ a.name }}</div>
            <span class="ast-badge" :class="a.kind">{{ kindLabel(a.kind) }}</span>
          </div>
          <span v-if="isRefAsset(a.id)" class="picker-added-tag">{{ t('storyboard.alreadyAdded') }}</span>
          <el-icon v-else-if="pickerSelectedSet.has(a.id)" class="picker-check"><Check /></el-icon>
          <el-icon v-else class="picker-add"><Plus /></el-icon>
        </div>
        <div v-if="!pickerCandidates.length" class="ad-muted picker-empty">{{ t('storyboard.noAssetsToAdd') }}</div>
      </div>
      <template #footer>
        <el-button @click="assetPicker.open = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :disabled="!pickerSelected.length" @click="confirmPickAssets">
          {{ t('storyboard.add') }}<span v-if="pickerSelected.length">（{{ pickerSelected.length }}）</span>
        </el-button>
      </template>
    </el-dialog>

    <!-- 按集角色服饰配置 -->
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

    <!-- 分镜审计结果 -->
    <el-dialog v-model="auditState.open" :title="t('storyboard.auditTitle')" width="min(720px, 94vw)" append-to-body :close-on-click-modal="false" class="audit-dialog">
      <div v-if="auditState.report" class="audit-body">
        <div class="audit-summary ad-flex-center ad-gap-md" style="flex-wrap: wrap;">
          <span class="ad-muted">{{ t('storyboard.auditSummaryAssets', { count: auditSummary.assetIssueCount }) }}</span>
          <span class="ad-muted">{{ t('storyboard.auditSummaryDuration', { count: auditSummary.durationIssueCount }) }}</span>
          <span v-if="auditSummary.overflowCount" class="ad-muted">{{ t('storyboard.auditSummaryOverflow', { count: auditSummary.overflowCount }) }}</span>
          <span style="flex: 1;"></span>
          <el-checkbox v-model="auditState.fixAssets">{{ t('storyboard.auditFixAssets') }}</el-checkbox>
          <el-checkbox v-model="auditState.fixDuration">{{ t('storyboard.auditFixDuration') }}</el-checkbox>
        </div>

        <div v-if="!auditVisibleItems.length" class="ad-muted audit-empty">{{ t('storyboard.auditEmpty') }}</div>

        <div class="audit-list">
          <div v-for="it in auditVisibleItems" :key="it.segmentId" class="audit-item ad-card">
            <div class="audit-item-head ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
              <span class="ad-muted">#{{ String(it.idx).padStart(2, '0') }} {{ it.shot_no || '' }}</span>
              <span v-if="it.duration.hasVideo && it.duration.changed" class="chip audit-chip-video">{{ t('storyboard.auditHasVideoHint') }}</span>
            </div>

            <div v-if="it.missingAssets.length" class="audit-chips ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
              <span v-for="m in it.missingAssets" :key="m.id" class="chip audit-chip-missing">
                {{ kindLabel(m.type) }} · {{ m.name }}
                <span class="audit-chip-reason">{{ m.reasonKey === 'speaker' ? t('storyboard.auditReasonSpeaker') : t('storyboard.auditReasonMention') }}</span>
              </span>
            </div>

            <div v-if="it.duration.changed || it.duration.overflow" class="audit-duration ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
              <span v-if="it.duration.changed" class="chip audit-chip-dur">
                {{ t('storyboard.auditDurationChange', { cur: it.duration.current, rec: it.duration.recommended }) }}
              </span>
              <span v-if="it.duration.overflow" class="chip audit-chip-warn">
                {{ t('storyboard.auditOverflow', { sec: it.duration.estimated }) }}
              </span>
            </div>

            <div v-if="it.warnings.length" class="audit-warnings ad-muted ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
              <span v-for="w in it.warnings" :key="w.id" class="audit-warn">{{ t('storyboard.auditWarningNoImage', { name: w.name }) }}</span>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="auditState.open = false">{{ t('common.close') }}</el-button>
        <el-button v-if="canEditStoryboard" type="primary" class="btn-ink" :loading="auditState.applying" :disabled="!auditHasFixable" @click="applyAuditFixes">
          {{ t('storyboard.auditApply') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.editor { height: calc(100vh - var(--ad-topbar-h)); display: flex; flex-direction: column; background: var(--ad-bg-soft); overflow: hidden; }
/* 团队共享只读横幅 */
.ro-banner {
  flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
  padding: 6px 20px; font-size: 12px; color: var(--ad-warning);
  background: rgba(251, 191, 36, 0.14); border-bottom: 1px solid color-mix(in srgb, var(--ad-warning) 35%, transparent);
}
.ed-topbar {
  height: 56px; flex: 0 0 56px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; background: var(--ad-bg-elevated); border-bottom: 1px solid var(--ad-border);
}
.ep-name { font-weight: 700; color: var(--ad-text); }
.ep-selectable {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; margin: 0 -4px; border-radius: 8px;
  cursor: pointer; user-select: none; outline: none;
  transition: background .15s, color .15s;
}
.ep-selectable:hover { background: var(--ad-bg-soft); color: var(--ad-brand); }
.ep-caret { font-size: 12px; color: var(--ad-text-muted); transition: color .15s, transform .2s; }
.ep-selectable:hover .ep-caret { color: var(--ad-brand); }
.dot-on { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--ad-success); margin-left: 6px; vertical-align: middle; }
.ed-body { flex: 1; display: grid; grid-template-columns: 200px 1fr 320px; gap: 16px; padding: 16px; min-height: 0; }
.ed-left { display: flex; flex-direction: column; overflow: hidden; }
.left-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 10px; border-bottom: 1px solid var(--ad-border); }
.lt { background: var(--ad-bg-soft); border: none; border-radius: 8px; padding: 8px; cursor: pointer; color: var(--ad-text-soft); font-size: 13px; font-weight: 600; }
.lt.active { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.left-filter { padding: 6px 10px; border-bottom: 1px solid var(--ad-border); }
.left-filter :deep(.el-checkbox__label) { font-size: 12px; color: var(--ad-text-soft); }
.left-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.left-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--ad-border); }
.left-head .ad-muted { font-size: 12px; }
.left-count { font-size: 12px; color: var(--ad-text-muted); background: var(--ad-bg-soft); border-radius: var(--ad-radius-sm); padding: 1px 8px; }
.left-empty { padding: 24px 0; text-align: center; font-size: 13px; }
.ast-item { display: flex; align-items: center; gap: 10px; }
.ast-thumb { width: 40px; height: 40px; border-radius: 8px; background: var(--ad-bg-soft); overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); flex-shrink: 0; position: relative; }
.ast-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ast-thumb.clickable { cursor: zoom-in; }
.ast-thumb.sm { width: 28px; height: 28px; border-radius: 6px; }
/* 视频资产缩略图上的播放角标：点击开视频预览弹窗 */
.ast-play {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; background: rgba(0, 0, 0, 0.32); pointer-events: none;
}
.costume-cfg-desc { margin-bottom: 12px; line-height: 1.6; }
/* 按集服饰选择：缩略图卡片（点击卡片=选用，右下放大镜=预览大图）；缩略图 16:9（96x54） */
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
.ast-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ast-name { font-size: 13px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ast-badge { align-self: flex-start; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; line-height: 1.6; }
.ast-badge.character { background: rgba(59,130,246,.14); color: #2563eb; }
.ast-badge.scene { background: rgba(16,185,129,.14); color: #059669; }
.ast-badge.prop { background: rgba(245,158,11,.16); color: #d97706; }
.ast-badge.material { background: var(--ad-brand-soft-2); color: var(--ad-accent); }
.ast-badge.video { background: rgba(6,182,212,.14); color: #0891b2; }
/* 角色条目旁的音色试听小按钮 */
.ast-voice {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border-radius: 50%;
  border: 1px solid var(--ad-border); background: var(--ad-bg-elevated);
  color: var(--ad-text-muted); font-size: 13px; cursor: pointer; transition: all .15s;
}
.ast-voice:hover { border-color: var(--ad-brand); color: var(--ad-brand); }
.ast-voice.playing { border-color: var(--ad-brand); color: var(--ad-brand); background: var(--ad-brand-soft); }
.left-add { padding: 4px !important; color: var(--ad-text-muted); }
.left-add:not(:disabled):hover { color: var(--ad-brand); }
.ast-remove { flex: 0 0 auto; padding: 3px; font-size: 14px; color: var(--ad-text-muted); cursor: pointer; border-radius: 6px; transition: color .15s, background .15s; }
.ast-remove:hover { color: #ef4444; background: rgba(239,68,68,.1); }

/* 资产库添加弹窗 */
.picker-toolbar { margin-bottom: 14px; flex-wrap: wrap; }
.picker-list { max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px; }
.picker-item { display: flex; align-items: center; gap: 12px; padding: 10px; border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); cursor: pointer; transition: border-color .15s, background .15s; }
.picker-item:hover { border-color: var(--ad-border-strong); background: var(--ad-bg-soft); }
.picker-item.selected { border-color: var(--ad-brand); background: color-mix(in srgb, var(--ad-brand) 6%, transparent); }
.picker-item.added { cursor: default; opacity: .55; background: var(--ad-bg-soft); }
.picker-item.added:hover { border-color: var(--ad-border); background: var(--ad-bg-soft); }
.picker-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.picker-added-tag { flex: 0 0 auto; font-size: 12px; color: var(--ad-text-muted); background: var(--ad-bg-elevated); border: 1px solid var(--ad-border); border-radius: 6px; padding: 2px 8px; }
.picker-check { flex: 0 0 auto; font-size: 18px; color: var(--ad-brand); }
.picker-add { flex: 0 0 auto; font-size: 16px; color: var(--ad-text-muted); }
.picker-empty { padding: 32px 0; text-align: center; }

.ed-center { display: flex; flex-direction: column; overflow: hidden; }
.seg-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--ad-border); }
.seg-view { padding: 20px; overflow-y: auto; flex: 1; }
.seg-title { font-size: 16px; font-weight: 700; color: var(--ad-text); margin-bottom: 10px; }
.seg-prompt { color: var(--ad-text-soft); line-height: 1.9; white-space: pre-wrap; font-size: 14px; }
.seg-narration { margin-top: 14px; font-size: 13px; color: var(--ad-text); }
.seg-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--ad-border); }
.seg-edit { padding: 16px 20px; overflow-y: auto; flex: 1; }
.ed-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); }

.ed-right { display: flex; flex-direction: column; overflow: hidden; }
.right-title { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--ad-border); }
.right-title .ad-muted { font-size: 12px; }
.preview-wrap { flex: 1; padding: 14px; display: flex; align-items: center; justify-content: center; min-height: 0; position: relative; }
/* 悬浮删除按钮（详情预览视频左上角） */
.vp-del {
  position: absolute; top: 22px; left: 22px; width: 32px; height: 32px; padding: 0;
  border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0, 0, 0, .5); color: #fff; font-size: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s, transform .15s; z-index: 2;
}
.vp-del:hover { background: rgba(239, 68, 68, .9); transform: scale(1.06); }
.vp-del:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
/* 悬浮「在线剪辑」按钮（详情预览视频右上角；琥珀色 hover 与左上角删除红区分） */
.vp-cut {
  position: absolute; top: 22px; right: 22px; width: 32px; height: 32px; padding: 0;
  border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0, 0, 0, .5); color: #fff; font-size: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s, transform .15s; z-index: 2;
}
.vp-cut:hover { background: rgba(217, 119, 6, .92); transform: scale(1.06); }
.vp-cut:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
/* 没有视频时：在同一位置展示「视频生成提示词」窗口 */
.prompt-body { flex: 1; padding: 14px; min-height: 0; overflow-y: auto; }
.prompt-text { font-size: 12px; line-height: 1.7; color: var(--ad-text-soft); white-space: pre-wrap; word-break: break-word; font-family: var(--ad-font-mono); background: var(--ad-bg-soft); border: 1px solid var(--ad-border); border-radius: 12px; padding: 12px 14px; }
.prompt-empty { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); font-size: 13px; }
.right-meta { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-top: 1px solid var(--ad-border); }
.right-meta .ad-muted { font-size: 12px; }

.ed-bottom { flex: 0 0 auto; margin: 0 16px 16px; }
.bot-head { padding: 10px 16px; border-bottom: 1px solid var(--ad-border); }
.compose-progress { padding: 8px 16px 10px; }
.cp-stage { display: block; font-size: 12px; color: var(--ad-text-muted); margin-bottom: 4px; }
.timeline { display: flex; gap: 10px; padding: 12px 16px; overflow-x: auto; }
.tl-item { flex: 0 0 auto; width: 92px; cursor: pointer; }
.tl-thumb { width: 92px; height: 130px; border-radius: 8px; background: var(--ad-bg-soft); border: 1px solid transparent; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); transition: border-color .15s ease, border-width .15s ease, box-shadow .15s ease; }
.tl-thumb img { width: 100%; height: 100%; object-fit: cover; }
/* done（已生成视频）：成功色细边框；先定义，让 active 可覆盖 */
.tl-item.done .tl-thumb { border-color: var(--ad-success); }
/* 选中态高亮：多重叠加，与未选中差别明显；颜色走主题变量 → 深/浅主题自适应。
   边框/光环/指示条用金色（--ad-gold：浅色金属金 #d4af37 / 深色亮金 #ffd24a），
   投影用中性阴影变量；置于 done 之后并用 .active.done 提升特异性，
   保证已生成片段被选中时仍显示金色而非成功色。 */
.tl-item.active .tl-thumb {
  border-color: var(--ad-gold);
  border-width: 2px; /* 选中态恢复 2px（未选中基础边框已降到 1px），配合 ring 维持原 3px 粗金边视觉 */
  box-shadow: 0 0 0 1px var(--ad-gold), 0 0 0 4px var(--ad-gold-soft), var(--ad-shadow-md);
}
.tl-item.active.done .tl-thumb {
  border-color: var(--ad-gold);
  border-width: 2px; /* 选中态恢复 2px（未选中基础边框已降到 1px），配合 ring 维持原 3px 粗金边视觉 */
  box-shadow: 0 0 0 1px var(--ad-gold), 0 0 0 4px var(--ad-gold-soft), var(--ad-shadow-md);
}
/* 选中缩略图底部金色指示条：4px 实色块，主题无关的强提示 */
.tl-item.active .tl-thumb::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 4px; background: var(--ad-gold); z-index: 4;
}
.tl-check { position: absolute; top: 4px; left: 4px; }
.tl-loading { position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; color: #fff; }
.tl-play { position: absolute; inset: 0; margin: auto; color: #fff; font-size: 24px; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6)); pointer-events: none; }
/* 悬浮删除按钮（时间轴缩略图右上角，与左上 .tl-check 对称；仅已生成且非生成中显示） */
.tl-del {
  position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; padding: 0;
  border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0, 0, 0, .5); color: #fff; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s, transform .15s; z-index: 3;
}
.tl-del:hover { background: rgba(239, 68, 68, .9); transform: scale(1.08); }
.tl-del:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 1px; }
/* 悬浮「去除字幕」按钮（时间轴缩略图右上角、删除按钮正下方；仅已生成、非生成中且有生成权限时显示） */
.tl-erase {
  position: absolute; top: 28px; right: 4px; width: 20px; height: 20px; padding: 0;
  border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0, 0, 0, .5); color: #fff; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s, transform .15s; z-index: 3;
}
.tl-erase:hover { background: var(--ad-brand); color: var(--ad-brand-contrast); transform: scale(1.08); }
.tl-erase:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 1px; }
/* 悬浮「在线剪辑」按钮（时间轴缩略图右上角、去除字幕正下方；琥珀色 hover 与删除红/擦除靛区分） */
.tl-cut {
  position: absolute; top: 52px; right: 4px; width: 20px; height: 20px; padding: 0;
  border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0, 0, 0, .5); color: #fff; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s, transform .15s; z-index: 3;
}
.tl-cut:hover { background: var(--ad-warning); transform: scale(1.08); }
.tl-cut:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 1px; }
/* 悬浮「移动位置」按钮组（时间轴缩略图底部居中：‹ 前移 / › 后移；与右上操作按钮同风格） */
.tl-move-group { position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); display: flex; gap: 3px; z-index: 3; }
.tl-move {
  width: 20px; height: 20px; padding: 0;
  border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0, 0, 0, .5); color: #fff; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s, transform .15s;
}
.tl-move:hover:not(:disabled) { background: var(--ad-brand); color: var(--ad-brand-contrast); transform: scale(1.08); }
.tl-move:disabled { opacity: .35; cursor: default; }
.tl-move:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 1px; }
.tl-label { font-size: 12px; color: var(--ad-text-soft); text-align: center; margin-top: 6px; transition: color .15s ease; }
/* 选中片段的标签：品牌色加粗，在轴上一眼可辨 */
.tl-item.active .tl-label { color: var(--ad-brand); font-weight: 700; }

/* 两个分镜之间的「转场连接器」：上方转场芯片 + 下方新增分镜 + 号；高度对齐缩略图(130px)垂直居中 */
.tl-connector { flex: 0 0 auto; align-self: flex-start; height: 130px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
/* 转场芯片：点击弹出精选转场（短剧常用 7 种）；已手动指定（非硬切）时高亮，默认显示剪刀=硬切 */
.tl-trans {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  min-width: 36px; padding: 5px 4px; border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-elevated); border: 1px solid var(--ad-border);
  color: var(--ad-text-muted); cursor: pointer; line-height: 1;
  transition: color .15s, border-color .15s, background .15s, box-shadow .15s, transform .15s;
}
.tl-trans:hover { color: var(--ad-brand); border-color: var(--ad-brand); background: color-mix(in srgb, var(--ad-brand) 6%, transparent); transform: scale(1.05); }
.tl-trans.set { color: var(--ad-brand); border-color: color-mix(in srgb, var(--ad-brand) 55%, transparent); background: var(--ad-brand-soft); }
.tl-trans-ico { font-size: 14px; }
.tl-trans-txt { font-size: 11px; font-weight: 600; }
.tl-trans:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
.tl-add-btn {
  width: 24px; height: 24px; padding: 0; border-radius: 50%;
  background: var(--ad-bg-elevated); border: 1px dashed var(--ad-border-strong);
  color: var(--ad-text-muted); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; font-size: 14px;
  transition: color .15s, border-color .15s, background .15s, box-shadow .15s, transform .15s;
}
.tl-add-btn:hover {
  color: var(--ad-brand); border-color: var(--ad-brand); border-style: solid;
  background: color-mix(in srgb, var(--ad-brand) 8%, transparent); box-shadow: 0 1px 8px color-mix(in srgb, var(--ad-brand) 22%, transparent); transform: scale(1.08);
}
.tl-add-btn:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
/* 片段轴最前面的插入入口：与缩略图等高、垂直居中，紧贴轴首 */
.tl-add-lead { flex: 0 0 auto; height: 130px; display: flex; align-items: center; }

/* 分镜表（下拉式） */
.shot-list-wrap { display: flex; flex-direction: column; overflow: hidden; flex: 1; min-height: 0; }
.shot-list-head { padding: 14px 18px; border-bottom: 1px solid var(--ad-border); }
.shot-list-scroll { flex: 1; overflow: auto; min-height: 0; }
.shot-list { display: flex; flex-direction: column; gap: 12px; padding: 14px 18px; }

.shot-card { overflow: hidden; transition: box-shadow .18s ease, border-color .18s ease; }
.shot-card:hover { box-shadow: var(--ad-shadow-hover); border-color: var(--ad-border-strong); }
.shot-card.active { border-color: color-mix(in srgb, var(--ad-brand) 50%, transparent); box-shadow: 0 2px 10px color-mix(in srgb, var(--ad-brand) 8%, transparent); }

.shot-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; cursor: pointer; }
.shot-no {
  display: inline-flex; width: 34px; height: 34px; border-radius: var(--ad-radius-sm);
  background: var(--ad-brand-soft); color: var(--ad-brand); align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; flex: 0 0 auto;
}
.shot-card.done .shot-no { background: color-mix(in srgb, var(--ad-success) 16%, transparent); color: var(--ad-success); }
.shot-head-info { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.shot-title { flex: 1; min-width: 0; color: var(--ad-text); font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shot-kf-mini { width: 44px; height: 32px; border-radius: 6px; background: var(--ad-bg-soft); border: 1px solid var(--ad-border); overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); position: relative; flex: 0 0 auto; }
.shot-kf-mini img { width: 100%; height: 100%; object-fit: cover; }
.shot-card.done .shot-kf-mini { border-color: var(--ad-success); }
.kf-busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45); color: #fff; font-size: 14px; }
.shot-dur { font-size: 12px; color: var(--ad-text-muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.caret { color: var(--ad-text-muted); flex: 0 0 auto; transition: transform .2s, color .2s; }
.shot-card.active .caret { color: var(--ad-accent); }

.shot-body { padding: 4px 16px 16px; border-top: 1px solid var(--ad-border); background: var(--ad-bg-soft); }
.shot-detail-head { padding: 12px 0 10px; }

/* 字段瓦片网格 */
.field-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
.field-tile { background: var(--ad-bg-elevated); border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); padding: 8px 10px; }
.ft-label { font-size: 11px; color: var(--ad-text-muted); font-weight: 600; margin-bottom: 3px; }
.ft-value { font-size: 13px; color: var(--ad-text); line-height: 1.4; word-break: break-word; }

/* 内容区块 */
.shot-sec { margin-bottom: 12px; }
.shot-sec:last-child { margin-bottom: 0; }
.sec-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--ad-text-soft); margin-bottom: 6px; }
.sec-label .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ad-accent); flex: 0 0 auto; }
.sec-text { font-size: 13px; color: var(--ad-text); line-height: 1.75; white-space: pre-wrap; word-break: break-word; background: var(--ad-bg-elevated); border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); padding: 10px 12px; }
.sec-text.mono { font-family: var(--ad-font-mono); font-size: 12px; color: var(--ad-text-soft); }
.scene-script-box .sec-text { background: color-mix(in srgb, var(--ad-brand) 5%, transparent); border-color: color-mix(in srgb, var(--ad-brand) 20%, transparent); }
.shot-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--ad-border); }

/* 共用 */
.tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: var(--ad-bg-soft); color: var(--ad-text-soft); border: 1px solid var(--ad-border); flex: 0 0 auto; }
.mono { font-family: var(--ad-font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }

/* 详情模式富卡片 */
.seg-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
/* 详情页头部镜号旁的分镜标题 */
.seg-title-wrap { min-width: 0; display: flex; align-items: baseline; }
.seg-title-text { font-size: 14px; color: var(--ad-text-soft); margin-left: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg-title-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg-shot-size { font-size: 15px; font-weight: 700; color: var(--ad-brand); }
.seg-sub { font-size: 13px; color: var(--ad-text-soft); }
.chip-dur { background: var(--ad-bg-soft); font-weight: 600; }
.seg-scene-script { font-size: 13px; color: var(--ad-text-soft); background: var(--ad-bg-soft); padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; line-height: 1.7; }
.seg-fields { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.field { display: flex; gap: 10px; font-size: 13px; line-height: 1.6; }
.fk { flex: 0 0 auto; color: var(--ad-text-muted); min-width: 3em; }
.fv { color: var(--ad-text); }
.seg-section { margin-bottom: 14px; }
.seg-section-label { font-size: 12px; font-weight: 600; color: var(--ad-text-muted); margin-bottom: 6px; }
.seg-vp-body { font-size: 12px; color: var(--ad-text-soft); background: var(--ad-bg-soft); padding: 10px; border-radius: 6px; line-height: 1.7; margin-top: 6px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }

@media (max-width: 1100px) {
  .ed-body { grid-template-columns: 1fr; }
  .ed-left { display: none; }
  .field-grid { grid-template-columns: repeat(2, 1fr); }
  .form-grid { grid-template-columns: 1fr; }
}

/* ===== 手机（≤768）：解除固定高度改为文档流滚动；左栏恢复显示（1100 断点隐藏它会造成功能缺失） ===== */
@media (max-width: 768px) {
  .editor { height: auto; min-height: calc(100dvh - var(--ad-topbar-h)); overflow: visible; }
  .ed-topbar { height: auto; min-height: 56px; flex: 0 0 auto; flex-wrap: wrap; padding: 8px 12px; gap: 6px; }
  .ed-topbar .left { flex-wrap: wrap; }
  .ed-body { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
  /* 顺序：分镜表 → 预览/提示词 → 本镜资产 */
  .ed-center { order: 1; overflow: visible; }
  .ed-right { order: 2; }
  .ed-left { order: 3; display: flex; }
  .left-list { max-height: 40vh; }
  .shot-list-wrap, .shot-list-scroll, .seg-view, .seg-edit { overflow: visible; }
  .shot-list { padding: 12px; }
  .shot-head { flex-wrap: wrap; row-gap: 4px; }
  .shot-detail-head, .seg-head, .right-meta { flex-wrap: wrap; row-gap: 6px; }
  .seg-foot { flex-wrap: wrap; row-gap: 8px; }
  .prompt-body { max-height: 44vh; }
  /* 底部时间轴吸底，长内容滚动时也能随时切镜 */
  .ed-bottom { position: sticky; bottom: 0; z-index: 6; margin: 0 12px 12px; background: var(--ad-bg-elevated); border: 1px solid var(--ad-border); border-radius: var(--ad-radius); box-shadow: var(--ad-shadow-md); }
  .timeline { padding: 10px 12px; }
  /* 资产选择弹窗：类型筛选按钮组允许换行 */
  .picker-toolbar :deep(.el-radio-group) { flex-wrap: wrap; }
}
</style>

<!-- 非 scoped：el-dropdown 下拉面板 teleport 到 body 外，需全局样式高亮当前集 -->
<style>
/* 本镜视频资产预览弹窗（append-to-body teleport，scoped 样式够不到） */
.shot-video-dialog .sv-video { max-height: 70vh; height: auto; }
.shot-video-dialog .sv-voices { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.shot-video-dialog .sv-voices-label { font-size: 13px; color: var(--ad-text-muted); }
.shot-video-dialog .sv-voice-btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px;
  border: 1px solid var(--ad-border); border-radius: 999px; background: var(--ad-bg-elevated);
  color: var(--ad-text-soft); font-size: 13px; cursor: pointer; transition: all 0.15s;
}
.shot-video-dialog .sv-voice-btn:hover { border-color: var(--ad-brand); color: var(--ad-brand); }
.shot-video-dialog .sv-voice-btn.playing { border-color: var(--ad-brand); color: var(--ad-brand); background: var(--ad-brand-soft); }
/* 底部时间轴转场选择气泡（el-popover 内容 teleport 到 body，需全局样式） */
.tl-trans-pop.el-popover.el-popper { padding: 10px 10px 8px; }
.tl-trans-pop .tl-trans-title { font-size: 12px; color: var(--ad-text-muted, #8b95a3); margin-bottom: 8px; font-weight: 600; }
.tl-trans-pop .tl-trans-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.tl-trans-pop .tl-trans-opt {
  padding: 7px 8px; border-radius: 8px; border: 1px solid var(--ad-border, #e5e7eb);
  background: var(--ad-bg-elevated, #fff); color: var(--ad-text-soft, #4b5563); cursor: pointer;
  font-size: 13px; line-height: 1.4; text-align: center;
  transition: color .15s, border-color .15s, background .15s;
}
.tl-trans-pop .tl-trans-opt:hover { border-color: var(--ad-brand); color: var(--ad-brand); background: color-mix(in srgb, var(--ad-brand) 6%, transparent); }
.tl-trans-pop .tl-trans-opt.selected { border-color: var(--ad-brand); color: var(--ad-brand); background: var(--ad-brand-soft); font-weight: 700; }

.ep-dropdown .el-dropdown-menu__item.is-current {
  color: var(--ad-brand);
  font-weight: 700;
  background: color-mix(in srgb, var(--ad-brand) 8%, transparent);
}
/* 剧集过多时限高并出现滚动条，避免面板无限拉长 */
.ep-dropdown .el-dropdown-menu {
  max-height: min(45vh, 360px);
  overflow-y: auto;
}

/* 分镜审计结果对话框 */
.audit-body { display: flex; flex-direction: column; gap: 12px; }
.audit-summary { font-size: 13px; }
.audit-empty { padding: 28px 0; text-align: center; }
.audit-list { display: flex; flex-direction: column; gap: 10px; max-height: 48vh; overflow-y: auto; }
.audit-item { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.audit-item-head { font-size: 13px; }
.audit-chips .chip, .audit-duration .chip { font-size: 12px; }
.audit-chip-missing { background: var(--ad-brand-soft); color: var(--ad-brand); }
.audit-chip-reason { opacity: .65; margin-left: 4px; }
.audit-chip-dur { background: rgba(245, 158, 11, .14); color: #b45309; }
.audit-chip-warn { background: rgba(239, 68, 68, .12); color: #b91c1c; }
.audit-chip-video { background: rgba(16, 185, 129, .12); color: #047857; }
.audit-warn { font-size: 12px; }
</style>
