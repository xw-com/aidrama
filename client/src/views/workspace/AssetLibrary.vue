<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { assetApi, projectApi, voiceApi, characterOptionApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useJobsStore } from '../../stores/jobs';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../../components/EmptyState.vue';
import CharacterCreatorDialog from '../../components/CharacterCreatorDialog.vue';
import VideoPreview from '../../components/VideoPreview.vue';
import { can } from '../../utils/perms';

const props = defineProps({
  project: Object,
  projectId: [String, Number],
  // 嵌入式（studio 创作台）：与宿主共享同一份资产数组，两侧动作落库即双向可见
  assets: { type: Array, default: null },
  embedded: { type: Boolean, default: false },
  // 任务中心跳转聚焦信号 { nonce, assetId }（studio 内嵌模式用）
  focusSignal: { type: Object, default: null },
});
const emit = defineEmits(['reload', 'next']);
const route = useRoute();
const { t } = useI18n();
const { runJob, runJobs } = useCostAction();
const jobs = useJobsStore();

// 团队共享权限：资产管理（手工 CRUD/上传/服饰/参考图）与 AI 生成（提取/生图/润色）
const canEditAsset = computed(() => can(props.project, 'asset.edit'));
const canGen = computed(() => can(props.project, 'ai.generate'));

const tabs = computed(() => [
  { key: 'character', label: t('asset.type.character') },
  { key: 'scene', label: t('asset.type.scene') },
  { key: 'prop', label: t('asset.type.prop') },
  { key: 'material', label: t('asset.type.material') },
  { key: 'video', label: t('asset.type.video') },
]);
const activeTab = ref('character');
const localAssets = ref([]);
const assets = computed({
  get: () => (props.embedded && Array.isArray(props.assets) ? props.assets : localAssets.value),
  set: (v) => {
    if (props.embedded && Array.isArray(props.assets)) props.assets.splice(0, props.assets.length, ...v);
    else localAssets.value = v;
  },
});
const episodes = ref([]);
const loading = ref(false);
const voices = ref([]);

// 任务驱动的 busy 状态（轮询自动更新）
const extractJob = computed(() => jobs.activeOf('asset_extract', Number(props.projectId)));
const isGenerating = (a) => !!jobs.activeOf('asset_image', a.id);
const isBusyPrompt = (a) => !!jobs.activeOf('asset_prompt', a.id);

const counts = computed(() => {
  const m = { character: 0, scene: 0, prop: 0, material: 0, video: 0 };
  assets.value.forEach((a) => { m[a.kind] = (m[a.kind] || 0) + 1; });
  return m;
});
// 搜索关键字（按名称/别名/描述过滤，大小写不敏感）
const keyword = ref('');
// 当前 tab 的资产：按名称/别名/描述过滤，按 id 倒序（最新创建的排在最前），供分页与展示使用
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

// 分页：每页 12 个，仅在展示层切片；勾选与批量操作仍基于整个 tab 的 list
const pageSize = 12;
const page = ref(1);
const total = computed(() => list.value.length);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const pagedList = computed(() => {
  const start = (page.value - 1) * pageSize;
  return list.value.slice(start, start + pageSize);
});

// 勾选状态（客户端，按 id 维护；仅作用于当前 tab）
const selectedIds = ref(new Set());
const isSelected = (a) => selectedIds.value.has(a.id);
function toggleSelect(a, val) {
  const next = new Set(selectedIds.value);
  val ? next.add(a.id) : next.delete(a.id);
  selectedIds.value = next;
}
const tabSelectedCount = computed(() => list.value.filter((a) => isSelected(a)).length);
const pageSelectedCount = computed(() => pagedList.value.filter((a) => isSelected(a)).length);
// 全选作用于「当前页」（分页下更直观）；批量润色提示词仍汇总整个 tab 的勾选项
const allSelected = computed(() => pagedList.value.length > 0 && pagedList.value.every((a) => isSelected(a)));
function toggleAll(val) {
  const next = new Set(selectedIds.value);
  pagedList.value.forEach((a) => (val ? next.add(a.id) : next.delete(a.id)));
  selectedIds.value = next;
}

// 当前页未生成图片的资产（全选未生成作用于当前页；批量生图：有勾选走勾选项，否则整个 tab 的未生成）
const ungeneratedList = computed(() => pagedList.value.filter((a) => a.status !== 'done' && !isGenerating(a)));
const ungeneratedSelectedCount = computed(() => ungeneratedList.value.filter((a) => isSelected(a)).length);
const allUngeneratedSelected = computed(() => ungeneratedList.value.length > 0 && ungeneratedList.value.every((a) => isSelected(a)));
function toggleUngenerated(val) {
  const next = new Set(selectedIds.value);
  ungeneratedList.value.forEach((a) => (val ? next.add(a.id) : next.delete(a.id)));
  selectedIds.value = next;
}

// 本类无图资产（当前 tab 跨页全量）：全选无图作用于整个分类，便于批量生图一次圈齐；
// 与「全选未生成」（当前页、按生成状态）口径不同互不影响；视频 tab 无生图概念不展示
const noImageList = computed(() => list.value.filter((a) => !a.image_url));
const noImageSelectedCount = computed(() => noImageList.value.filter((a) => isSelected(a)).length);
const allNoImageSelected = computed(() => noImageList.value.length > 0 && noImageList.value.every((a) => isSelected(a)));
function toggleNoImage(val) {
  const next = new Set(selectedIds.value);
  noImageList.value.forEach((a) => (val ? next.add(a.id) : next.delete(a.id)));
  selectedIds.value = next;
}

// 任务面板跳转聚焦：切到资产所在分类/页，滚动定位并高亮（信号来自 StudioView.gotoTask）
const focusFlashId = ref(null);
watch(() => props.focusSignal, async (f) => {
  if (!f?.assetId) return;
  const a = assets.value.find((x) => String(x.id) === String(f.assetId));
  if (!a) return;
  if (a.kind !== activeTab.value) activeTab.value = a.kind; // watch(activeTab) 会重置页码
  // 被搜索关键字过滤掉时清关键字，保证目标卡可见
  if (keyword.value.trim() && !list.value.some((x) => String(x.id) === String(f.assetId))) keyword.value = '';
  await nextTick();
  const idx = list.value.findIndex((x) => String(x.id) === String(f.assetId));
  if (idx === -1) return;
  page.value = Math.floor(idx / pageSize) + 1;
  await nextTick();
  const el = document.querySelector(`.lib [data-asset-id="${f.assetId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focusFlashId.value = f.assetId;
  setTimeout(() => { if (String(focusFlashId.value) === String(f.assetId)) focusFlashId.value = null; }, 3900);
});

// 图片预览
const previewUrl = ref('');
const previewList = ref([]); // 打开预览时填充本次图片列表（资产 / 服饰）
const previewIndex = ref(0);
function previewImage(a) {
  if (!a.image_url) return;
  previewList.value = list.value.filter((x) => x.image_url).map((x) => x.image_url);
  const i = previewList.value.indexOf(a.image_url);
  previewIndex.value = i > -1 ? i : 0;
  previewUrl.value = a.image_url;
}
function previewCostume(c) {
  if (!c.image_url) return;
  previewList.value = costumes.value.filter((x) => x.image_url).map((x) => x.image_url);
  const i = previewList.value.indexOf(c.image_url);
  previewIndex.value = i > -1 ? i : 0;
  previewUrl.value = c.image_url;
}

async function load() {
  loading.value = true;
  try {
    const [list, p] = await Promise.all([assetApi.list(props.projectId), projectApi.get(props.projectId)]);
    assets.value = list;
    episodes.value = p.episodes || [];
  } finally {
    loading.value = false;
  }
}
// 加载声音库（用户上传 + 预设），供角色绑定声音下拉使用
voiceApi.list().then((v) => { voices.value = v; }).catch(() => {});

// 提取资产：先选择某一集，再针对该集提取（已存在略过）
const showExtractDialog = ref(false);
const extractEpisodeId = ref(null);
function openExtract() {
  if (!episodes.value.length) return ElMessage.warning(t('asset.noEpisode'));
  extractEpisodeId.value = episodes.value[0].id;
  showExtractDialog.value = true;
}
async function doExtract() {
  const eid = extractEpisodeId.value;
  if (!eid) return ElMessage.warning(t('asset.pleaseSelectEpisode'));
  showExtractDialog.value = false;
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => assetApi.extractEpisodeEstimate(props.projectId, eid, sel),
    createFor: (sel) => assetApi.extractEpisode(props.projectId, eid, sel),
    title: t('asset.extract.title'), desc: t('asset.extract.desc'), confirmText: t('asset.extract.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') load(); },
  });
}

// 单个生图（异步任务）
async function genImage(asset) {
  await runJob({
    modelType: 'image',
    estimateFor: (sel) => assetApi.genImageEstimate(asset.id, sel),
    createFor: (sel) => assetApi.genImage(asset.id, sel),
    title: t('asset.genImage.title'), desc: t('asset.genImage.desc', { name: asset.name }), confirmText: t('asset.gen.confirm'),
    // 参考图（图生图）：在确认弹窗内展示并允许添加/移除，回调负责持久化与同步卡片
    allowReferenceImage: true,
    referenceImage: refOf(asset),
    uploadReferenceImage: async (file) => {
      const updated = await assetApi.uploadReferenceImage(asset.id, file);
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

// 自定义角色：弹窗点选选项 → 统一确认页 → 建资产 + asset_image 任务生成设定图
const showCreator = ref(false);
const creatorSubmitting = ref(false);
async function createCustomCharacter(payload) {
  creatorSubmitting.value = true;
  try {
    const job = await runJob({
      modelType: 'image',
      estimateFor: (sel) => characterOptionApi.createEstimate(props.projectId, sel),
      createFor: (sel) => characterOptionApi.create(props.projectId, { ...payload, modelConfigId: sel.modelConfigId }).then((d) => {
        assets.value.push(d.asset); // 列表先入占位（无图 queued 态），任务轮询负责转终态
        return { job: d.job };
      }),
      title: t('charCreator.confirm.title'), desc: t('charCreator.confirm.desc'), confirmText: t('charCreator.confirmText'),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.asset) {
          const i = assets.value.findIndex((x) => x.id === j.result.asset.id);
          if (i > -1) assets.value[i] = j.result.asset;
        }
      },
    });
    if (job) showCreator.value = false; // 任务已建立才关弹窗；用户取消确认页则保留选择
  } finally {
    creatorSubmitting.value = false;
  }
}

// 单个 AI 润色提示词（异步任务）
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

// 参考图（图生图蓝本）：入口在资产卡片缩略图，上传/粘贴后持久化到资产，生图时后端自动读取
const refEditing = ref(null); // 当前管理参考图的资产对象（null 时弹窗关闭）
const refUrlInput = ref('');
const refUploading = ref(false);
const refOf = (a) => a?.meta?.referenceImage || '';

function openRefDialog(a) {
  refEditing.value = a;
  refUrlInput.value = '';
}
function patchAsset(updated) {
  const i = assets.value.findIndex((x) => x.id === updated.id);
  if (i > -1) assets.value[i] = { ...assets.value[i], ...updated }; // 合并而非整体替换，保留 costume_count 等列表附加字段
  if (refEditing.value && refEditing.value.id === updated.id) refEditing.value = { ...refEditing.value, ...updated };
}
function beforeRefUpload(file) {
  const isImg = file.type && file.type.startsWith('image/');
  const under10M = file.size / 1024 / 1024 < 10;
  if (!isImg) ElMessage.error(t('asset.upload.imageOnly'));
  else if (!under10M) ElMessage.error(t('asset.upload.tooLarge'));
  return isImg && under10M;
}
async function customRefUpload({ file }) {
  if (!refEditing.value) return;
  refUploading.value = true;
  try {
    const updated = await assetApi.uploadReferenceImage(refEditing.value.id, file);
    patchAsset(updated);
    refUrlInput.value = '';
    ElMessage.success(t('asset.ref.uploaded'));
  } catch { /* http 拦截器已报错 */ } finally {
    refUploading.value = false;
  }
}
async function applyRefUrl() {
  if (!refEditing.value) return;
  const url = refUrlInput.value.trim();
  if (!url) return;
  try {
    const updated = await assetApi.update(refEditing.value.id, { reference_image: url });
    patchAsset(updated);
    ElMessage.success(t('asset.ref.set'));
  } catch { /* http 拦截器已报错 */ }
}
async function removeRef() {
  if (!refEditing.value) return;
  try {
    const updated = await assetApi.update(refEditing.value.id, { reference_image: null });
    patchAsset(updated);
    refUrlInput.value = '';
    ElMessage.success(t('asset.ref.removed'));
  } catch { /* http 拦截器已报错 */ }
}

// 上传资产主图（不经过 AI 生图，直接用作资产图片）
const imgUploadingId = ref(null);
function beforeImageUpload(file) {
  const isImg = file.type && file.type.startsWith('image/');
  const under10M = file.size / 1024 / 1024 < 10;
  if (!isImg) ElMessage.error(t('asset.upload.imageOnly'));
  else if (!under10M) ElMessage.error(t('asset.upload.tooLarge'));
  return isImg && under10M;
}
async function customImageUpload(a, { file }) {
  imgUploadingId.value = a.id;
  try {
    const updated = await assetApi.uploadImage(a.id, file);
    patchAsset(updated);
    ElMessage.success(t('asset.image.uploaded'));
  } catch { /* http 拦截器已报错 */ } finally {
    imgUploadingId.value = null;
  }
}

// 上传视频素材（仅 video 类型资产）：封面/时长由后端自动从视频提取
const vidUploadingId = ref(null);
function beforeVideoUpload(file) {
  const isVideo = file.type && file.type.startsWith('video/');
  const under200M = file.size / 1024 / 1024 < 200;
  if (!isVideo) ElMessage.error(t('asset.upload.videoOnly'));
  else if (!under200M) ElMessage.error(t('asset.upload.videoTooLarge'));
  return isVideo && under200M;
}
async function customVideoUpload(a, { file }) {
  vidUploadingId.value = a.id;
  try {
    const updated = await assetApi.uploadVideo(a.id, file);
    patchAsset(updated);
    ElMessage.success(t('asset.video.uploaded'));
  } catch { /* http 拦截器已报错 */ } finally {
    vidUploadingId.value = null;
  }
}

// 视频转图片关键帧：上传视频 + 名称 + 个数，服务端同步均匀抽帧批量生成素材（名称#1..N，视频用完即删）
const showKeyframesDialog = ref(false);
const kfFile = ref(null);
const kfName = ref('');
const kfCount = ref(6);
const kfSubmitting = ref(false);
function openKeyframesDialog() {
  kfFile.value = null;
  kfName.value = '';
  kfCount.value = 6;
  kfSubmitting.value = false;
  showKeyframesDialog.value = true;
}
function onKeyframeVideoChange(file) {
  const raw = file?.raw;
  if (!raw || !beforeVideoUpload(raw)) return;
  kfFile.value = raw;
}
async function submitKeyframes() {
  if (!kfFile.value) { ElMessage.warning(t('asset.keyframes.noVideo')); return; }
  const name = kfName.value.trim();
  if (!name) { ElMessage.warning(t('asset.keyframes.nameRequired')); return; }
  kfSubmitting.value = true;
  try {
    const rows = await assetApi.createKeyframes(props.projectId, { file: kfFile.value, name, count: kfCount.value });
    assets.value.push(...rows);
    activeTab.value = 'material'; // 产物固定为素材类型：切到素材 tab 直观确认（watch 会重置页码）
    showKeyframesDialog.value = false;
    ElMessage.success(t('asset.keyframes.created', { count: rows.length }));
  } catch { /* http 拦截器已报错 */ } finally {
    kfSubmitting.value = false;
  }
}

// 视频预览弹窗（卡片封面/播放角标点击打开）
const videoPreview = reactive({ open: false, url: '', name: '' });
function openVideoPreview(a) {
  const url = a.meta?.videoUrl;
  if (!url) return;
  videoPreview.url = url;
  videoPreview.name = a.name;
  videoPreview.open = true;
}
// 时长文本（meta.duration 秒 → m:ss）；无时长返回空串不渲染
function durationText(a) {
  const d = Number(a.meta?.duration);
  if (!Number.isFinite(d) || d <= 0) return '';
  const s = Math.round(d);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 拖拽上传：把图片直接拖到资产卡片缩略图即可上传（无图时是显眼入口，有图时换图）
const dragOverId = ref(null);
const dragCounter = ref(0);
function onDragOver(e) { e.preventDefault(); }
function onDragEnter(a, e) {
  e.preventDefault();
  if (!canEditAsset.value) return; // 无编辑权限：不响应拖拽
  if (dragOverId.value !== a.id) { dragOverId.value = a.id; dragCounter.value = 1; }
  else dragCounter.value += 1;
}
function onDragLeave(a, e) {
  e.preventDefault();
  if (dragOverId.value !== a.id) return;
  dragCounter.value -= 1;
  if (dragCounter.value <= 0) { dragOverId.value = null; dragCounter.value = 0; }
}
async function onDrop(a, e) {
  e.preventDefault();
  dragOverId.value = null;
  dragCounter.value = 0;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // 视频资产拖入即传视频，其余类型传图片
  if (a.kind === 'video') {
    if (!beforeVideoUpload(file)) return;
    await customVideoUpload(a, { file });
    return;
  }
  if (!beforeImageUpload(file)) return;
  await customImageUpload(a, { file });
}

// 批量生图（当前 tab）——共享一个模型选择，汇总一次扣费确认，任务依次提交
// 有勾选则只生成勾选项（无视是否已生成过，允许对已生成资产重生成），否则生成整个 tab 的未生成；
// 两种情况都排除正在生成中的资产，避免同一资产重复提交任务
const batchImageTargets = computed(() => {
  if (tabSelectedCount.value) return list.value.filter((a) => isSelected(a) && !isGenerating(a));
  return list.value.filter((a) => a.status !== 'done' && !isGenerating(a));
});

async function genAllCurrent() {
  const targets = batchImageTargets.value;
  if (!targets.length) return ElMessage.info(t('asset.noMoreToGenerate'));
  await runJobs({
    modelType: 'image',
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

// 批量 AI 润色提示词（勾选项）——共享一次模型选择 + 汇总扣费确认，任务依次提交
async function genPromptSelected() {
  const targets = list.value.filter((a) => isSelected(a) && !isBusyPrompt(a));
  if (!targets.length) return ElMessage.info(t('asset.pleaseSelectForPrompt'));
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

// 编辑资产
const editing = ref(null);
const editForm = ref({ name: '', aliases: [], description: '', prompt: '', role_tag: '', doubao_asset_id: '', voice_id: '', voice_settings: null });
// 服饰（仅角色）：编辑弹窗打开时加载
const costumes = ref([]);
const costumeLoading = ref(false);
const costumeBusy = reactive({}); // costumeId -> true：该服饰有操作进行中（换装/上传/设默认/删除），用于显示等待态
function isCostumeBusy(c) { return !!costumeBusy[c.id]; }
// 包裹服饰的短操作（上传/设默认/删除）：执行期间标记 busy，结束清除
async function withCostumeBusy(costume, fn) {
  costumeBusy[costume.id] = true;
  try { return await fn(); }
  finally { delete costumeBusy[costume.id]; }
}
const editingAsset = computed(() => assets.value.find((x) => x.id === editing.value) || null);
function startEdit(a) {
  editing.value = a.id;
  editForm.value = {
    name: a.name, aliases: Array.isArray(a.aliases) ? [...a.aliases] : [],
    description: a.description || '', prompt: a.prompt || '',
    role_tag: a.role_tag || '', doubao_asset_id: a.doubao_asset_id || '',
    voice_id: a.meta?.voiceId || '',
    voice_settings: { ...DEFAULT_VOICE_SETTINGS, ...(a.meta?.voiceSettings || {}) },
  };
  costumes.value = [];
  if (a.kind === 'character') loadCostumes(a.id);
}

// —— 音色选择（仅角色）：编辑弹窗内入口，直接弹「音色选择」对话框 ——
// 音色列表来自 voices 表（voiceApi.list 预加载）；选中写 Asset.meta.voiceId，
// 语速/音量/语调等 voiceSettings 沿用已有值或默认值（声音设置弹窗已移除）
const DEFAULT_VOICE_SETTINGS = { speed: 1, volume: 5, pitch: 1, emotion: '' };
const showVoicePicker = ref(false); // 「音色选择」弹窗
const voiceTab = ref('system'); // system 系统音色 / favorites 收藏音色（收藏存 localStorage）
const voiceSceneFilter = ref(''); // voices.scene
const voiceAgeFilter = ref(''); // voices.age_range_text
const voiceGenderFilter = ref(''); // voices.gender（男/女/中性）
const pickerVoiceId = ref(null); // 弹窗内当前选中（仅高亮，确定才带回）
const pickerEntryVoiceId = ref(null); // 打开「音色选择」时的选中快照，取消时回滚

// 收藏音色（本地持久化，voices 表无收藏字段）
const VOICE_FAV_KEY = 'aidrama_voice_favorites';
const voiceFavorites = ref(new Set(JSON.parse(localStorage.getItem(VOICE_FAV_KEY) || '[]')));
function toggleFav(v) {
  const s = new Set(voiceFavorites.value);
  if (s.has(v.id)) s.delete(v.id); else s.add(v.id);
  voiceFavorites.value = s;
  localStorage.setItem(VOICE_FAV_KEY, JSON.stringify([...s]));
}
const isFav = (v) => voiceFavorites.value.has(v.id);

const boundVoiceName = computed(() => {
  if (!editForm.value.voice_id) return '';
  const v = voices.value.find((x) => x.id === Number(editForm.value.voice_id));
  return v?.name || '';
});
// 筛选项从数据派生（voices 表 scene / age_range_text 去重）
const sceneOptions = computed(() => [...new Set(voices.value.map((v) => v.scene).filter(Boolean))]);
const ageOptions = computed(() => [...new Set(voices.value.map((v) => v.age_range_text).filter(Boolean))]);
const filteredVoices = computed(() => voices.value
  .filter((v) => (voiceTab.value === 'favorites' ? isFav(v) : true))
  .filter((v) => !voiceSceneFilter.value || v.scene === voiceSceneFilter.value)
  .filter((v) => !voiceAgeFilter.value || v.age_range_text === voiceAgeFilter.value)
  .filter((v) => !voiceGenderFilter.value || v.gender === voiceGenderFilter.value));
function resetVoiceFilters() {
  voiceSceneFilter.value = '';
  voiceAgeFilter.value = '';
  voiceGenderFilter.value = '';
}
// 性别筛选项：label 显示「男声/女声/中性」，值对应 voices.gender
const genderVoiceOptions = computed(() => [
  { value: '男', label: t('voice.maleVoice') },
  { value: '女', label: t('voice.femaleVoice') },
  { value: '中性', label: t('voice.genderNeutral') },
]);

function openVoicePicker() {
  if (!editingAsset.value) return;
  pickerEntryVoiceId.value = editForm.value.voice_id ? Number(editForm.value.voice_id) : null;
  pickerVoiceId.value = pickerEntryVoiceId.value;
  voiceTab.value = 'system';
  resetVoiceFilters();
  showVoicePicker.value = true;
}
// 选中音色仅高亮，不关窗；点「确定」才写回角色，点「取消」回滚；再点已选卡片可取消选中
function selectVoice(v) {
  pickerVoiceId.value = pickerVoiceId.value === v.id ? null : v.id;
}
// 弹窗内「清除音色」：仅取消选中，点「确定」后写回空 = 解绑（服务端 voice_id 空值会置 null meta）
function clearVoicePicker() {
  pickerVoiceId.value = null;
}
// 入口行 × 直接解绑当前音色，无需进弹窗
function clearEditVoice() {
  editForm.value.voice_id = '';
  editForm.value.voice_settings = null;
}
function confirmVoicePicker() {
  editForm.value.voice_id = pickerVoiceId.value || '';
  // 已有自定义设置（语速/音量/语调/情感）沿用，否则默认值
  editForm.value.voice_settings = pickerVoiceId.value
    ? { ...DEFAULT_VOICE_SETTINGS, ...(editForm.value.voice_settings || {}) }
    : null;
  showVoicePicker.value = false;
  stopPreview();
}
function cancelVoicePicker() {
  pickerVoiceId.value = pickerEntryVoiceId.value;
  showVoicePicker.value = false;
  stopPreview();
}

// 试听：播放指定音色的本地样本（voices.audio_url），列表内每个音色旁都有试听按钮
// 状态由点击处理器直接同步（不依赖媒体事件驱动），事件仅作兜底校正，
// 避免 play/pause 事件未触发时按钮状态与实际播放脱节、点「停止」无响应
const previewVoiceId = ref(null); // 正在试听的音色 id（null = 未播放）
const voiceAudio = ref(null);
function togglePreview(v) {
  const audio = voiceAudio.value;
  if (!v || !audio) return;
  if (previewVoiceId.value === v.id) {
    audio.pause();
    previewVoiceId.value = null;
    return;
  }
  if (!v.audio_url) return ElMessage.warning(t('voice.noPreviewSample'));
  previewVoiceId.value = v.id;
  audio.src = v.audio_url;
  audio.currentTime = 0;
  audio.play().catch(() => {
    previewVoiceId.value = null;
    ElMessage.error(t('voice.noPreviewSample'));
  });
}
function stopPreview() {
  voiceAudio.value?.pause();
  previewVoiceId.value = null;
}
async function loadCostumes(aid) {
  costumeLoading.value = true;
  try { costumes.value = await assetApi.costumes(aid); } finally { costumeLoading.value = false; }
}
function patchCostume(updated) {
  const i = costumes.value.findIndex((c) => c.id === updated.id);
  if (i > -1) costumes.value[i] = updated;
}
async function addCostume(a) {
  const c = await assetApi.createCostume(a.id, { name: t('asset.costume.defaultName') });
  costumes.value.push(c);
}
async function customCostumeUpload(a, costume, { file }) {
  return withCostumeBusy(costume, async () => {
    const updated = await assetApi.uploadCostumeImage(a.id, costume.id, file);
    patchCostume(updated);
    if (updated.is_default) patchAssetAfterCostume(a);
    ElMessage.success(t('asset.costume.imageUploaded'));
  });
}
// 「换装」生图：以用户在确认框填写的「本次要求」作为唯一提示词，仅以角色原图为参考生成该套服饰
async function genCostumeImageByRequirement(a, costume) {
  const job = await runJob({
    modelType: 'image',
    allowRequirement: true,
    requirementPresets: [], // 此处「本次要求」即生图唯一提示词（描述服饰），不适用分镜文字规范快捷输入
    estimateFor: (sel) => assetApi.genCostumeImageEstimate(a.id, costume.id, sel),
    createFor: (sel) => assetApi.genCostumeImageByRequirement(a.id, costume.id, sel),
    title: t('asset.costume.genByReqTitle'), desc: t('asset.costume.genByReqDesc', { name: `${a.name}·${costume.name || t('asset.costume.defaultName')}` }), confirmText: t('asset.gen.confirm'),
    onDone: (j) => {
      delete costumeBusy[costume.id];
      if (j.status === 'succeeded' && j.result?.costume) {
        patchCostume(j.result.costume);
        if (j.result.costume.is_default) patchAssetAfterCostume(a);
      }
    },
  });
  // 确认后任务已创建并在后台运行；标记 busy 直到 onDone（终态：成功/失败/取消）触发
  if (job) costumeBusy[costume.id] = true;
}
async function setCostumeDefault(a, costume) {
  return withCostumeBusy(costume, async () => {
    const updated = await assetApi.setDefaultCostume(a.id, costume.id);
    // 后端已把默认服饰镜像回 Asset.image_url；重拉资产刷新卡片
    patchCostume(updated);
    await loadCostumes(a.id);
    patchAssetAfterCostume(a);
  });
}
async function saveCostumeField(a, costume) {
  const updated = await assetApi.updateCostume(a.id, costume.id, { name: costume.name, prompt: costume.prompt, doubao_asset_id: costume.doubao_asset_id });
  patchCostume(updated);
  ElMessage.success(t('asset.saved'));
}
async function removeCostume(a, costume) {
  await ElMessageBox.confirm(t('asset.costume.deleteConfirm', { name: costume.name || t('asset.costume.defaultName') }), t('common.tip'), { type: 'warning' });
  return withCostumeBusy(costume, async () => {
    await assetApi.removeCostume(a.id, costume.id);
    costumes.value = costumes.value.filter((c) => c.id !== costume.id);
    patchAssetAfterCostume(a);
  });
}
// 服饰变动后刷新资产卡片（默认服饰图可能已镜像到 Asset.image_url）
async function patchAssetAfterCostume() {
  try { await load(); } catch { /* ignore */ }
}
async function saveEdit(a) {
  const updated = await assetApi.update(a.id, editForm.value);
  const i = assets.value.findIndex((x) => x.id === a.id);
  if (i > -1) assets.value[i] = updated;
  editing.value = null;
  ElMessage.success(t('asset.saved'));
}
async function removeAsset(a) {
  await ElMessageBox.confirm(t('asset.delete.confirm', { name: a.name }), t('common.tip'), { type: 'warning' });
  await assetApi.remove(a.id);
  assets.value = assets.value.filter((x) => x.id !== a.id);
}
async function createAsset() {
  const a = await assetApi.create(props.projectId, { kind: activeTab.value, name: t('asset.newAsset') });
  assets.value.push(a);
  startEdit(a);
}

function statusInfo(a) {
  if (isGenerating(a)) return { text: t('asset.status.generating'), cls: 'chip-warning' };
  switch (a.status) {
    case 'generating': return { text: t('asset.status.generating'), cls: 'chip-warning' };
    case 'queued': return { text: t('asset.status.queued'), cls: '' };
    case 'failed': return { text: t('asset.status.failed'), cls: 'chip-danger' };
    case 'done': return { text: t('asset.status.done'), cls: 'chip-success' };
    default: return { text: a.status, cls: '' };
  }
}

function goNext() { emit('next'); }

// 空状态主按钮：视频 tab 走「创建资产」（asset.edit），其余走「AI 提取」（ai.generate）；无对应权限时不展示
const emptyActionLabel = computed(() => {
  if (activeTab.value === 'video') return canEditAsset.value ? `${t('common.create')}${tabs.value.find((x) => x.key === 'video')?.label || ''}` : '';
  return canGen.value ? t('asset.extract.button') : '';
});

// 切换分类回到第一页；资产增删导致页数减少时收回越界页码
watch(activeTab, () => { page.value = 1; });
watch(keyword, () => { page.value = 1; });
watch(pageCount, () => { if (page.value > pageCount.value) page.value = pageCount.value; });
watch(() => props.projectId, load);
onMounted(() => {
  // 深链预选资产类型页签（任务中心资产生图「查看结果」按 result.asset.kind 跳入，范式同 uniapp assets.vue）
  const kind = String(route.query.kind || '');
  if (kind && tabs.value.some((tb) => tb.key === kind)) activeTab.value = kind;
  load();
});
</script>

<template>
  <div :class="['ad-container', 'lib', { 'lib-embedded': embedded }]" v-loading="loading">
    <div class="ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
      <div class="ad-flex-center ad-gap-sm lib-toolbar">
        <div class="tabs">
          <button v-for="t in tabs" :key="t.key" class="tab" :class="{ active: activeTab === t.key }" @click="activeTab = t.key">
            {{ t.label }} <span class="cnt">{{ counts[t.key] || 0 }}</span>
          </button>
        </div>
        <el-input :size="embedded ? 'default' : 'large'" v-model="keyword" :placeholder="t('asset.search.placeholder')" clearable style="width: 220px; max-width: 100%; flex-shrink: 1;">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
      <div class="ad-flex-center ad-gap-sm lib-toolbar">
        <el-button v-if="canGen" :disabled="!tabSelectedCount" @click="genPromptSelected">
          <el-icon><MagicStick /></el-icon> {{ t('asset.batchGenPrompt.button') }}<span v-if="tabSelectedCount">（{{ tabSelectedCount }}）</span>
        </el-button>
        <!-- 视频资产封面由视频首帧生成，无生图概念，隐藏批量生图；AI 提取也不产出视频，隐藏提取入口 -->
        <el-button v-if="activeTab !== 'video' && canGen" @click="genAllCurrent">
          <el-icon><MagicStick /></el-icon> {{ t('asset.batchGenImage.button') }}<span v-if="batchImageTargets.length">（{{ batchImageTargets.length }}）</span>
        </el-button>
        <el-button v-if="canEditAsset" @click="createAsset"><el-icon><Plus /></el-icon> {{ t('common.create') }}{{ tabs.find((t) => t.key === activeTab)?.label }}</el-button>
        <!-- 视频转关键帧：产物固定进「素材」tab，入口仅在该 tab 展示 -->
        <el-button v-if="activeTab === 'material' && canEditAsset" @click="openKeyframesDialog"><el-icon><Film /></el-icon> {{ t('asset.keyframes.button') }}</el-button>
        <el-button v-if="activeTab === 'character' && canGen" type="primary" class="btn-ink" @click="showCreator = true"><el-icon><Avatar /></el-icon> {{ t('charCreator.button') }}</el-button>
        <el-button v-if="activeTab !== 'video' && canGen" type="primary" class="btn-ink" @click="openExtract"><el-icon><Box /></el-icon> {{ t('asset.extract.button') }}</el-button>
      </div>
    </div>

    <!-- 提取进度 -->
    <div v-if="extractJob" class="job-progress ad-card">
      <div class="jp-head">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span class="jp-title">{{ extractJob.stage || t('asset.job.queued') }}</span>
        <span class="ad-muted">{{ extractJob.progress || 0 }}%</span>
      </div>
      <el-progress :percentage="extractJob.progress || 0" :show-text="false" :stroke-width="6" />
    </div>

    <!-- 选择条：全选 -->
    <div v-if="list.length" class="select-bar ad-flex-between">
      <div class="ad-flex-center ad-gap-sm">
        <el-checkbox :model-value="allSelected" @change="toggleAll">{{ t('asset.selectAll') }} {{ pageSelectedCount }}/{{ pagedList.length }}</el-checkbox>
        <!-- 全选无图：本类（跨页全量)没有生成图片的资产；视频 tab 无生图概念不展示 -->
        <el-checkbox v-if="activeTab !== 'video' && noImageList.length" :model-value="allNoImageSelected" @change="toggleNoImage">{{ t('asset.selectNoImage') }} {{ noImageSelectedCount }}/{{ noImageList.length }}</el-checkbox>
        <el-checkbox v-if="activeTab !== 'video' && ungeneratedList.length" :model-value="allUngeneratedSelected" @change="toggleUngenerated">{{ t('asset.selectAllUngenerated') }} {{ ungeneratedSelectedCount }}/{{ ungeneratedList.length }}</el-checkbox>
      </div>
    </div>

    <!-- 资产网格（仅渲染当前页） -->
    <div class="grid">
      <div
        v-for="a in pagedList"
        :key="a.id"
        class="asset-card ad-card"
        :data-asset-id="a.id"
        :class="{ 'card-focus': focusFlashId != null && String(focusFlashId) === String(a.id) }"
      >
        <div
          class="thumb"
          :class="{ 'drag-over': dragOverId === a.id }"
          @dragenter="onDragEnter(a, $event)"
          @dragleave="onDragLeave(a, $event)"
          @dragover="onDragOver"
          @drop="onDrop(a, $event)"
        >
          <!-- 视频资产：封面（首帧，无封面时 video 元素兜底）+ 播放预览 + 时长角标；hover 可换视频 -->
          <template v-if="a.kind === 'video'">
            <template v-if="a.meta?.videoUrl">
              <img v-if="a.image_url" :src="a.thumb_url || a.image_url" :alt="a.name" class="thumb-img" loading="lazy" decoding="async" @click="openVideoPreview(a)" />
              <video v-else :src="a.meta.videoUrl" class="thumb-img" preload="metadata" muted playsinline @click="openVideoPreview(a)"></video>
              <button type="button" class="play-badge" @click="openVideoPreview(a)">
                <el-icon :size="30"><VideoPlay /></el-icon>
              </button>
              <span v-if="durationText(a)" class="duration-chip">{{ durationText(a) }}</span>
              <el-tooltip v-if="canEditAsset" :content="t('asset.uploadVideoChange')" placement="top">
                <el-upload
                  class="upload-img-btn"
                  :show-file-list="false"
                  :auto-upload="true"
                  :before-upload="beforeVideoUpload"
                  :http-request="(opts) => customVideoUpload(a, opts)"
                  accept="video/*"
                >
                  <button type="button" class="upload-img-btn-inner" :class="{ loading: vidUploadingId === a.id }">
                    <el-icon v-if="vidUploadingId === a.id" class="is-loading" :size="16"><Loading /></el-icon>
                    <el-icon v-else :size="16"><Upload /></el-icon>
                  </button>
                </el-upload>
              </el-tooltip>
            </template>
            <el-upload
              v-else-if="canEditAsset"
              class="thumb-uploader"
              :show-file-list="false"
              :auto-upload="true"
              :before-upload="beforeVideoUpload"
              :http-request="(opts) => customVideoUpload(a, opts)"
              accept="video/*"
            >
              <div class="upload-zone" :class="{ loading: vidUploadingId === a.id }">
                <el-icon v-if="vidUploadingId === a.id" class="is-loading" :size="26"><Loading /></el-icon>
                <el-icon v-else :size="26"><VideoPlay /></el-icon>
                <span class="uz-title">{{ vidUploadingId === a.id ? t('asset.uploading') : t('asset.uploadVideo') }}</span>
                <span v-if="vidUploadingId !== a.id" class="uz-hint">{{ t('asset.uploadHint') }}</span>
              </div>
            </el-upload>
            <div v-else class="thumb-empty"><el-icon :size="26"><VideoPlay /></el-icon></div>
          </template>
          <!-- 图片资产（原有逻辑） -->
          <template v-else>
            <img v-if="a.image_url" :src="a.thumb_url || a.image_url" :alt="a.name" class="thumb-img" loading="lazy" decoding="async" @click="previewImage(a)" />
            <el-upload
              v-else-if="!isGenerating(a) && canEditAsset"
              class="thumb-uploader"
              :show-file-list="false"
              :auto-upload="true"
              :before-upload="beforeImageUpload"
              :http-request="(opts) => customImageUpload(a, opts)"
              accept="image/*"
            >
              <div class="upload-zone" :class="{ loading: imgUploadingId === a.id }">
                <el-icon v-if="imgUploadingId === a.id" class="is-loading" :size="26"><Loading /></el-icon>
                <el-icon v-else :size="26"><Upload /></el-icon>
                <span class="uz-title">{{ imgUploadingId === a.id ? t('asset.uploading') : t('asset.uploadImage') }}</span>
                <span v-if="imgUploadingId !== a.id" class="uz-hint">{{ t('asset.uploadHint') }}</span>
              </div>
            </el-upload>
            <div v-else-if="isGenerating(a)" class="thumb-empty">
              <el-icon class="is-loading" :size="28"><Loading /></el-icon>
            </div>
            <div v-else class="thumb-empty"><el-icon :size="26"><Picture /></el-icon></div>
            <span v-if="a.image_url" class="zoom-hint"><el-icon :size="16"><ZoomIn /></el-icon></span>
            <el-tooltip v-if="a.image_url && canEditAsset" :content="t('asset.uploadImageChange')" placement="top">
              <el-upload
                class="upload-img-btn"
                :show-file-list="false"
                :auto-upload="true"
                :before-upload="beforeImageUpload"
                :http-request="(opts) => customImageUpload(a, opts)"
                accept="image/*"
              >
                <button type="button" class="upload-img-btn-inner" :class="{ loading: imgUploadingId === a.id }">
                  <el-icon v-if="imgUploadingId === a.id" class="is-loading" :size="16"><Loading /></el-icon>
                  <el-icon v-else :size="16"><Upload /></el-icon>
                </button>
              </el-upload>
            </el-tooltip>
          </template>
          <span v-if="a.kind === 'character' && a.role_tag" class="badge-role">{{ a.role_tag }}</span>
          <el-tooltip
            v-if="a.kind !== 'video' && canEditAsset"
            :content="refOf(a) ? t('asset.ref.setTooltip') : t('asset.ref.addTooltip')"
            placement="top"
          >
            <button class="ref-badge" :class="{ set: !!refOf(a) }" @click.stop="openRefDialog(a)">
              <img v-if="refOf(a)" :src="refOf(a)" :alt="t('asset.ref.alt')" />
              <el-icon v-else :size="14"><Plus /></el-icon>
            </button>
          </el-tooltip>
        </div>
        <div class="info">
          <div class="ad-flex-between">
            <span class="ad-flex-center" style="gap: 6px;">
              <el-checkbox :model-value="isSelected(a)" @change="(v) => toggleSelect(a, v)" />
              <span class="name">{{ a.name }}</span>
              <span v-if="a.kind === 'character'" class="costume-count-chip">{{ t('asset.costumeCount', { n: a.costume_count || 0 }) }}</span>
            </span>
            <span class="chip" :class="statusInfo(a).cls">{{ statusInfo(a).text }}</span>
          </div>
          <div class="desc">{{ a.description || t('asset.noDesc') }}</div>
        </div>
        <div class="ops">
          <div class="ops-group">
            <el-tooltip v-if="canGen" :content="a.prompt ? t('asset.regeneratePrompt') : t('asset.generatePrompt')" placement="top">
              <button class="op-btn" :class="{ loading: isBusyPrompt(a) }" :disabled="isBusyPrompt(a)" @click="genPrompt(a)">
                <el-icon><MagicStick /></el-icon>
              </button>
            </el-tooltip>
            <!-- 视频资产封面由视频首帧生成，无 AI 生图入口 -->
            <el-tooltip v-if="a.kind !== 'video' && canGen" :content="isGenerating(a) ? t('asset.status.generating') : (a.image_url ? t('asset.regenerateImage') : t('asset.generateImage'))" placement="top">
              <button class="op-btn" :class="{ loading: isGenerating(a) }" :disabled="isGenerating(a)" @click="genImage(a)">
                <el-icon v-if="isGenerating(a)" class="is-loading"><Loading /></el-icon>
                <el-icon v-else><PictureFilled /></el-icon>
              </button>
            </el-tooltip>
          </div>
          <span class="ops-sep"></span>
          <div class="ops-group">
            <el-tooltip v-if="canEditAsset" :content="t('common.edit')" placement="top">
              <button class="op-btn ghost" @click="startEdit(a)"><el-icon><Edit /></el-icon></button>
            </el-tooltip>
            <el-tooltip v-if="canEditAsset" :content="t('common.delete')" placement="top">
              <button class="op-btn ghost danger" @click="removeAsset(a)"><el-icon><Delete /></el-icon></button>
            </el-tooltip>
          </div>
        </div>
      </div>

      <!-- 新建卡片（仅在最后一页展示，避免每页重复入口） -->
      <div v-if="page >= pageCount && canEditAsset" class="asset-card new ad-card" @click="createAsset">
        <div class="thumb-empty" style="height: 100%;">
          <el-icon :size="30"><Plus /></el-icon>
        </div>
        <div class="info" style="text-align: center;">
          <div class="name" style="color: var(--ad-text-muted);">{{ t('asset.goCreate') }}</div>
          <div class="desc">{{ t('common.create') }}{{ tabs.find((t) => t.key === activeTab)?.label }}</div>
        </div>
      </div>

      <EmptyState
        v-if="!list.length && keyword.trim()"
        class="ad-card"
        icon="🔍"
        :title="t('asset.search.noResult')"
        :description="t('asset.search.noResultDesc', { kw: keyword.trim() })"
      />
      <EmptyState
        v-else-if="!list.length"
        class="ad-card"
        icon="🎭"
        :title="t('asset.empty.title', { type: tabs.find((t) => t.key === activeTab)?.label || t('asset.type.default') })"
        :description="t('asset.empty.desc')"
        :action-label="emptyActionLabel"
        @action="activeTab === 'video' ? createAsset() : openExtract()"
      />
    </div>

    <!-- 底部分页导航 -->
    <div v-if="list.length && pageCount > 1" class="page-bar">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        background
      />
    </div>

    <!-- 底部提示（embedded 时隐藏：studio 状态栏已有「下一步」CTA，避免重复） -->
    <div v-if="!embedded" class="action-bar ad-card">
      <div class="ad-flex-center ad-gap-sm">
        <el-icon><InfoFilled /></el-icon>
        <span class="ad-sub">{{ t('asset.tip.applyToSeries') }}</span>
      </div>
      <button class="next-cta" @click="goNext">
        <span>{{ t('asset.next') }}</span>
        <el-icon><Right /></el-icon>
      </button>
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editing" :title="t('asset.edit.title')" width="min(900px, 94vw)" align-center>
      <el-form label-position="top" v-if="editing">
        <el-row :gutter="16">
          <el-col :span="activeTab === 'character' ? 12 : 24" :xs="24">
            <el-form-item :label="t('common.name')"><el-input size="large" v-model="editForm.name" /></el-form-item>
          </el-col>
          <el-col v-if="activeTab === 'character'" :span="12" :xs="24">
            <el-form-item :label="t('asset.roleTag.label')">
              <el-input size="large" v-model="editForm.role_tag" :placeholder="t('asset.roleTag.placeholder')" />
            </el-form-item>
          </el-col>
        </el-row>
        <!-- 豆包资产 ID（角色/场景/道具）：填写后视频生成按 asset:// 引用数字资产 -->
        <el-row v-if="['character', 'scene', 'prop'].includes(activeTab)" :gutter="16">
          <el-col :span="12" :xs="24">
            <el-form-item :label="t('asset.doubaoAssetId.label')">
              <el-input size="large" v-model="editForm.doubao_asset_id" :placeholder="t('asset.doubaoAssetId.placeholder')" />
            </el-form-item>
          </el-col>
        </el-row>
        <!-- 音色选择（仅角色）：入口行，点击直接弹「音色选择」对话框 -->
        <el-form-item v-if="activeTab === 'character'" :label="t('asset.voice.label')">
          <div class="voice-entry">
            <div class="flex items-center gap-3 min-w-[180px]">
              <div class="voice-entry-avatar">
                <img v-if="editingAsset?.image_url" :src="editingAsset.image_url" :alt="editingAsset.name" />
                <el-icon v-else :size="22"><User /></el-icon>
              </div>
              <span class="voice-entry-name">{{ editingAsset?.name }}</span>
            </div>
            <button type="button" class="voice-entry-current" @click="openVoicePicker">
              <el-icon :size="16"><Microphone /></el-icon>
              <span>{{ boundVoiceName || t('asset.voice.placeholder') }}</span>
            </button>
            <button
              v-if="editForm.voice_id" type="button" class="voice-entry-clear"
              :title="t('voice.clear')" @click="clearEditVoice"
            >
              <el-icon :size="15"><Close /></el-icon>
            </button>
            <button type="button" class="voice-entry-open" @click="openVoicePicker">
              <span>{{ t('voice.pickerTitle') }}</span>
              <el-icon :size="16"><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="ad-sub ad-muted" style="font-size: 12px; margin-top: 4px;">{{ t('asset.voice.tip') }}</div>
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="24">
            <el-form-item :label="t('asset.aliases.label')">
              <el-select size="large"
                v-model="editForm.aliases" multiple filterable allow-create default-first-option
                :placeholder="t('asset.aliases.placeholder')" style="width: 100%;"
                :no-data-text="t('asset.aliases.placeholder')" :reserve-keyword="false"
              />
              <div class="ad-sub ad-muted" style="font-size: 12px; margin-top: 4px;">{{ t('asset.aliases.tip') }}</div>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12" :xs="24">
            <el-form-item :label="t('common.desc')"><el-input size="large" v-model="editForm.description" type="textarea" :rows="8" /></el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item :label="t('asset.imagePrompt')"><el-input size="large" v-model="editForm.prompt" type="textarea" :rows="8" /></el-form-item>
          </el-col>
        </el-row>
        <!-- 服饰（仅角色）：一套服饰 = 一张图，可设默认 -->
        <el-form-item v-if="activeTab === 'character'" :label="t('asset.costume.title')">
          <div class="costume-wrap" v-loading="costumeLoading">
            <div class="costume-grid">
              <div v-for="c in costumes" :key="c.id" class="costume-card">
                <div class="costume-thumb" :class="{ 'is-default': c.is_default }">
                  <img v-if="c.image_url" :src="c.thumb_url || c.image_url" class="costume-thumb-img" loading="lazy" decoding="async" @click="previewCostume(c)" />
                  <el-icon v-else><Picture /></el-icon>
                  <div v-if="isCostumeBusy(c)" class="costume-loading">
                    <el-icon class="is-loading" :size="20"><Loading /></el-icon>
                    <span>{{ t('asset.costume.processing') }}</span>
                  </div>
                  <span v-if="c.image_url" class="costume-zoom-hint"><el-icon :size="14"><ZoomIn /></el-icon></span>
                  <span v-if="c.is_default" class="costume-default-tag">{{ t('asset.costume.default') }}</span>
                </div>
                <el-input v-model="c.name" size="large" :placeholder="t('asset.costume.namePlaceholder')" style="margin-top:6px;" @change="saveCostumeField(editingAsset, c)" />
                <el-input v-model="c.doubao_asset_id" size="large" :placeholder="t('asset.doubaoAssetId.placeholder')" class="costume-doubao" @change="saveCostumeField(editingAsset, c)" />
                <div class="costume-ops">
                  <el-upload :disabled="isCostumeBusy(c)" :show-file-list="false" :auto-upload="true" :before-upload="beforeRefUpload" :http-request="(opts) => customCostumeUpload(editingAsset, c, opts)" accept="image/*">
                    <el-button text size="small" :disabled="isCostumeBusy(c)" :title="t('asset.uploadImage')"><el-icon><Upload /></el-icon></el-button>
                  </el-upload>
                  <el-button text size="small" :disabled="isCostumeBusy(c) || !canGen" :title="t('asset.costume.generateByRequirement')" @click="genCostumeImageByRequirement(editingAsset, c)"><el-icon><Switch /></el-icon></el-button>
                  <el-button text size="small" :disabled="isCostumeBusy(c)" :class="{ 'is-active': c.is_default }" :title="t('asset.costume.setDefault')" @click="setCostumeDefault(editingAsset, c)"><el-icon><Star /></el-icon></el-button>
                  <el-button text size="small" :disabled="isCostumeBusy(c)" type="danger" :title="t('common.delete')" @click="removeCostume(editingAsset, c)"><el-icon><Delete /></el-icon></el-button>
                </div>
              </div>
              <button type="button" class="costume-add" @click="addCostume(editingAsset)"><el-icon><Plus /></el-icon> {{ t('asset.costume.add') }}</button>
            </div>
            <div class="ad-sub ad-muted" style="font-size: 12px; margin-top: 6px;">{{ t('asset.costume.tip') }}</div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = null">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" @click="saveEdit(assets.find((x) => x.id === editing))">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 参考图弹窗 -->
    <el-dialog v-model="refEditing" :title="t('asset.ref.dialogTitle', { name: refEditing?.name || '' })" width="min(480px, 94vw)" align-center>
      <div v-if="refEditing" class="ref-dialog">
        <div class="ad-muted ref-tip">{{ t('asset.ref.tip') }}</div>
        <div class="ref-preview">
          <img v-if="refOf(refEditing)" :src="refOf(refEditing)" :alt="t('asset.ref.alt')" />
          <div v-else class="ref-preview-empty"><el-icon :size="30"><Picture /></el-icon><span>{{ t('asset.ref.notSet') }}</span></div>
        </div>
        <div class="ref-upload-row">
          <el-upload
            :show-file-list="false"
            :auto-upload="true"
            :before-upload="beforeRefUpload"
            :http-request="customRefUpload"
            accept="image/*"
          >
            <el-button :loading="refUploading"><el-icon><Upload /></el-icon> {{ t('asset.uploadImage') }}</el-button>
          </el-upload>
        </div>
        <el-divider>{{ t('asset.ref.pasteOr') }}</el-divider>
        <div class="ref-url-row">
          <el-input size="large" v-model="refUrlInput" :placeholder="t('asset.ref.urlPlaceholder')" clearable />
          <el-button :disabled="!refUrlInput.trim()" @click="applyRefUrl">{{ t('asset.ref.useUrl') }}</el-button>
        </div>
        <div v-if="refOf(refEditing)" class="ref-remove-row">
          <el-button text type="danger" @click="removeRef"><el-icon><Delete /></el-icon> {{ t('asset.ref.remove') }}</el-button>
        </div>
      </div>
      <template #footer>
        <el-button type="primary" class="btn-ink" @click="refEditing = null">{{ t('asset.done') }}</el-button>
      </template>
    </el-dialog>

    <!-- 音色选择弹窗（仅角色，编辑弹窗入口直接打开）：系统/收藏 + 场景/年龄/性别筛选 + 卡片网格（数据来自 voices 表） -->
    <el-dialog
      v-model="showVoicePicker" :title="t('voice.pickerTitle')"
      width="min(960px, 94vw)" align-center append-to-body @close="stopPreview"
    >
      <div class="vp-body">
        <!-- 系统音色 / 收藏音色 -->
        <div class="vp-tabs">
          <button type="button" class="vp-tab" :class="{ active: voiceTab === 'system' }" @click="voiceTab = 'system'">{{ t('voice.tabSystem') }}</button>
          <button type="button" class="vp-tab" :class="{ active: voiceTab === 'favorites' }" @click="voiceTab = 'favorites'">{{ t('voice.tabFavorites') }}</button>
        </div>

        <!-- 筛选：场景 / 年龄 / 性别 + 重置 -->
        <div class="vp-filters">
          <el-select v-model="voiceSceneFilter" :placeholder="t('voice.sceneAll')" clearable size="large">
            <el-option v-for="s in sceneOptions" :key="s" :label="s" :value="s" />
          </el-select>
          <el-select v-model="voiceAgeFilter" :placeholder="t('voice.ageAll')" clearable size="large">
            <el-option v-for="a in ageOptions" :key="a" :label="a" :value="a" />
          </el-select>
          <el-select v-model="voiceGenderFilter" :placeholder="t('voice.genderAll')" clearable size="large">
            <el-option v-for="g in genderVoiceOptions" :key="g.value" :label="g.label" :value="g.value" />
          </el-select>
          <button type="button" class="vp-reset" @click="resetVoiceFilters">{{ t('voice.resetFilter') }}</button>
        </div>

        <!-- 音色卡片网格：试听 + 名称（多情感标记）+ 收藏 -->
        <div class="vp-grid-wrap">
          <div class="vp-grid">
            <div
              v-for="v in filteredVoices" :key="v.id" role="button"
              class="vp-card" :class="{ active: v.id === pickerVoiceId }"
              @click="selectVoice(v)"
            >
              <button
                type="button" class="vp-play" :class="{ playing: previewVoiceId === v.id }"
                :title="t('voice.preview')" @click.stop="togglePreview(v)"
              >
                <el-icon :size="14" class="fill-current"><VideoPause v-if="previewVoiceId === v.id" /><VideoPlay v-else /></el-icon>
              </button>
              <div class="vp-name-wrap">
                <span class="vp-name" :title="v.name">{{ v.name }}</span>
                <span v-if="v.emotion_type === 1" class="vp-tag-hot">{{ t('voice.multiEmotion') }}</span>
              </div>
              <button
                type="button" class="vp-fav" :class="{ on: isFav(v) }"
                :title="t('voice.tabFavorites')" @click.stop="toggleFav(v)"
              >
                <el-icon :size="15"><Star /></el-icon>
              </button>
            </div>
            <div v-if="!filteredVoices.length" class="vp-empty">
              {{ voiceTab === 'favorites' ? t('voice.noFavorites') : t('voice.noMatch') }}
            </div>
          </div>
          <div v-if="filteredVoices.length" class="vp-end">{{ t('voice.noMore') }}</div>
        </div>

        <audio
          ref="voiceAudio"
          @ended="previewVoiceId = null"
          @error="previewVoiceId = null"
        ></audio>
      </div>
      <template #footer>
        <div class="vp-footer">
          <button type="button" class="vs-btn ghost" :disabled="!pickerVoiceId" @click="clearVoicePicker">{{ t('voice.clear') }}</button>
          <span class="vp-footer-spacer"></span>
          <button type="button" class="vs-btn ghost" @click="cancelVoicePicker">{{ t('common.cancel') }}</button>
          <button type="button" class="vs-btn primary" @click="confirmVoicePicker">{{ t('common.confirm') }}</button>
        </div>
      </template>
    </el-dialog>

    <!-- 选择分集提取资产 -->
    <el-dialog v-model="showExtractDialog" :title="t('asset.extract.dialogTitle')" width="min(480px, 94vw)" align-center>
      <div class="ad-sub" style="margin-bottom: 12px;">{{ t('asset.extract.dialogDesc') }}</div>
      <el-select v-model="extractEpisodeId" :placeholder="t('asset.extract.episodePlaceholder')" style="width: 100%;" size="large">
        <el-option v-for="ep in episodes" :key="ep.id" :label="t('asset.episodeLabel', { idx: ep.idx, title: ep.title })" :value="ep.id" />
      </el-select>
      <template #footer>
        <el-button @click="showExtractDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :disabled="!extractEpisodeId" @click="doExtract">{{ t('asset.next') }}</el-button>
      </template>
    </el-dialog>

    <!-- 视频转图片关键帧（素材 tab 专属：同步均匀抽帧，视频用完即删） -->
    <el-dialog v-model="showKeyframesDialog" :title="t('asset.keyframes.title')" width="min(480px, 94vw)" align-center>
      <div class="ad-sub" style="margin-bottom: 12px;">{{ t('asset.keyframes.desc') }}</div>
      <el-form label-position="top" :disabled="kfSubmitting">
        <el-form-item :label="t('asset.keyframes.videoLabel')" required>
          <el-upload :show-file-list="false" :auto-upload="false" accept="video/*" :on-change="onKeyframeVideoChange" style="width: 100%;">
            <el-button style="width: 100%;">
              <el-icon><Film /></el-icon>
              <span :style="kfFile ? 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' : ''">{{ kfFile ? kfFile.name : t('asset.keyframes.pickVideo') }}</span>
            </el-button>
          </el-upload>
        </el-form-item>
        <el-form-item :label="t('asset.keyframes.name')" required>
          <el-input v-model="kfName" maxlength="128" show-word-limit :placeholder="t('asset.keyframes.namePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('asset.keyframes.count')">
          <el-input-number v-model="kfCount" :min="1" :max="50" :step="1" style="width: 100%;" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="kfSubmitting" @click="showKeyframesDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="kfSubmitting" :disabled="!kfFile || !kfName.trim()" @click="submitKeyframes">{{ t('asset.keyframes.submit') }}</el-button>
      </template>
    </el-dialog>

    <!-- 图片预览 -->
    <el-image-viewer
      v-if="previewUrl"
      :url-list="previewList.length ? previewList : [previewUrl]"
      :initial-index="previewIndex"
      hide-on-click-modal
      @close="previewUrl = ''"
    />

    <!-- 视频预览（视频资产卡片点击打开；destroy-on-close 关窗即停播；统一 VideoPreview 组件） -->
    <el-dialog v-model="videoPreview.open" :title="videoPreview.name" width="min(960px, 94vw)" align-center destroy-on-close>
      <VideoPreview v-if="videoPreview.url" :src="videoPreview.url" style="max-height: 70vh; height: auto;" />
    </el-dialog>

    <!-- 自定义角色创建（点选外貌/人设选项 → 统一确认页生图） -->
    <CharacterCreatorDialog v-model="showCreator" :project-id="props.projectId" :submitting="creatorSubmitting" @confirm="createCustomCharacter" />
  </div>
</template>

<style scoped>
.lib { max-width: 1280px; }
/* studio 内嵌模式：去掉外层容器留白（studio 自己给 14px 内距），工具条压成一行胶囊风 */
.lib-embedded { max-width: none; padding: 0; }
.lib-embedded .tabs { width: auto; border-bottom: none; gap: 6px; }
.lib-embedded .tab {
  padding: 6px 14px; font-size: 13px; margin-bottom: 0;
  border: 1px solid var(--ad-border); border-radius: var(--ad-radius-pill);
  background: var(--ad-bg-soft);
}
.lib-embedded .tab.active {
  color: var(--ad-brand);
  border-color: color-mix(in srgb, var(--ad-brand) 55%, transparent);
  background: var(--ad-brand-soft);
}
.lib-embedded .el-button { border-radius: var(--ad-radius-pill); }
.lib-embedded .el-input__wrapper { border-radius: 999px !important; }
.lib-embedded .grid { margin-top: 14px; }
.lib-embedded .select-bar { margin-top: 10px; }
.lib-embedded .job-progress { margin-top: 10px; }
/* 工具条子组允许换行，避免窄屏横向越界 */
.lib-toolbar { flex-wrap: wrap; min-width: 0; }
.tabs { display: inline-flex; gap: 4px; border-bottom: 1px solid var(--ad-border); width: 100%; }
.tab {
  background: transparent; border: none; padding: 10px 18px; cursor: pointer;
  font-size: 15px; font-weight: 600; color: var(--ad-text-muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab.active { color: var(--ad-text); border-bottom-color: var(--ad-brand); }
.tab:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
.tab .cnt { color: var(--ad-text-muted); font-size: 12px; margin-left: 2px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(285px, 1fr)); gap: 16px; margin-top: 22px; }
.asset-card { overflow: hidden; transition: all 0.18s; display: flex; flex-direction: column; }
.asset-card:hover { box-shadow: var(--ad-shadow-hover); transform: translateY(-2px); }
/* 任务面板跳转定位高亮：紫红加粗描边（1px 边框 + 1px 外环叠加）+ 缩放脉冲；
   0%/100% 帧与静态环一致，动画起止无跳变。总时长 1.65s × 2 ≈ 3.3s，与上方 setTimeout 3900 对应 */
.asset-card.card-focus {
  border-color: var(--ad-focus-jump);
  box-shadow: 0 0 0 1px var(--ad-focus-jump), 0 0 14px color-mix(in srgb, var(--ad-focus-jump) 28%, transparent);
  animation: cardFocusGlow 1.65s ease-in-out 2;
}
@keyframes cardFocusGlow {
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
.thumb { aspect-ratio: 16/9; background: var(--ad-bg-soft); position: relative; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb-img { cursor: zoom-in; }
.zoom-hint {
  position: absolute; right: 8px; bottom: 8px; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); color: #fff; border-radius: 8px;
  opacity: 0; transition: opacity 0.18s; pointer-events: none;
}
.asset-card:hover .zoom-hint { opacity: 1; }
/* 视频资产：居中播放角标 + 右下时长角标（无封面的 video 元素兜底同 cover 裁切） */
.play-badge {
  position: absolute; left: 0; right: 0; top: 0; bottom: 0;
  width: 52px; height: 52px; margin: auto;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); color: #fff; border: none; border-radius: 999px;
  cursor: pointer; transition: all 0.18s;
}
.play-badge:hover { background: var(--ad-brand); color: var(--ad-brand-contrast); transform: scale(1.08); }
.duration-chip {
  position: absolute; right: 8px; bottom: 8px;
  background: rgba(0, 0, 0, 0.6); color: #fff;
  font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px;
  pointer-events: none;
}
video.thumb-img { object-fit: cover; cursor: pointer; }
.upload-img-btn { position: absolute; left: 8px; bottom: 8px; opacity: 0; transition: opacity 0.18s; }
.asset-card:hover .upload-img-btn { opacity: 1; }
.upload-img-btn-inner {
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); color: #fff; border-radius: 8px; border: none;
  cursor: pointer; transition: background 0.18s;
}
.upload-img-btn-inner:hover { background: var(--ad-brand); }
.upload-img-btn-inner.loading { opacity: 0.6; pointer-events: none; }
/* 无图资产的显眼上传区（点击 / 拖拽），撑满整个缩略图 */
.thumb-uploader { width: 100%; height: 100%; }
.thumb-uploader :deep(.el-upload) { width: 100%; height: 100%; display: flex; }
.upload-zone {
  width: 100%; height: 100%; box-sizing: border-box; padding: 10px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  border: 2px dashed var(--ad-border); border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-soft); color: var(--ad-text-muted); cursor: pointer;
  transition: border-color 0.18s, color 0.18s, background 0.18s;
}
.upload-zone .uz-title { font-size: 14px; font-weight: 600; color: var(--ad-text); }
.upload-zone .uz-hint { font-size: 12px; }
.upload-zone:hover,
.upload-zone.loading { border-color: var(--ad-brand); color: var(--ad-brand); }
.upload-zone:hover .uz-title { color: var(--ad-brand); }
/* 拖拽悬停高亮（无图上传区 / 有图换图通用） */
.thumb.drag-over { box-shadow: inset 0 0 0 2px var(--ad-brand); }
.thumb.drag-over .upload-zone {
  border-color: var(--ad-brand); color: var(--ad-brand);
  background: color-mix(in srgb, var(--ad-brand) 7%, transparent);
}
.thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); }
.badge-role { position: absolute; top: 8px; left: 8px; background: var(--ad-success); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.ref-badge {
  position: absolute; top: 8px; right: 8px; width: 30px; height: 30px; padding: 0;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  border-radius: 8px; border: 1px solid var(--ad-border); cursor: pointer;
  background: rgba(0, 0, 0, 0.45); color: #fff; transition: all 0.18s;
  opacity: 0;
}
.asset-card:hover .ref-badge { opacity: 1; }
.ref-badge.set { opacity: 1; border-color: rgba(255, 255, 255, 0.6); }
.ref-badge img { width: 100%; height: 100%; object-fit: cover; }
.ref-badge:hover { background: var(--ad-brand); border-color: var(--ad-brand); }
.ref-dialog .ref-tip { font-size: 12px; line-height: 1.7; margin-bottom: 14px; }
.ref-preview {
  width: 100%; aspect-ratio: 16/9; border-radius: var(--ad-radius-sm); overflow: hidden;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border); display: flex; align-items: center; justify-content: center;
}
.ref-preview img { width: 100%; height: 100%; object-fit: cover; }
.ref-preview-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--ad-text-muted); font-size: 12px; }
.ref-upload-row { margin-top: 14px; }
.ref-url-row { display: flex; align-items: center; gap: 8px; }
.ref-remove-row { margin-top: 16px; text-align: center; }
.info { padding: 10px 12px 6px; }
.name { font-weight: 600; color: var(--ad-text); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 105%; }
.desc { font-size: 12px; color: var(--ad-text-muted); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ops { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px 12px; }
.ops-group { display: flex; align-items: center; gap: 4px; }
.ops-sep { width: 1px; height: 18px; background: var(--ad-border); margin: 0 2px; }
.op-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 8px; border: none;
  background: var(--ad-bg-soft); color: var(--ad-text); cursor: pointer;
  font-size: 15px; transition: all 0.15s;
}
.op-btn:hover { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.op-btn.loading { opacity: 0.55; pointer-events: none; }
.op-btn.ghost { background: transparent; color: var(--ad-text-muted); }
.op-btn.ghost:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
.op-btn.danger:hover { background: var(--el-color-danger); color: #fff; }
.op-btn:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
.asset-card.new { cursor: pointer; justify-content: center; min-height: 180px; }
.empty { grid-column: 1 / -1; text-align: center; padding: 48px 20px; }
.empty-emoji { font-size: 44px; margin-bottom: 6px; }
.select-bar { margin-top: 18px; }
.page-bar { display: flex; justify-content: flex-end; margin-top: 18px; }
.action-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 26px; padding: 16px 20px; flex-wrap: wrap; }
.job-progress { margin-top: 18px; padding: 14px 18px; }
.jp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.jp-title { font-weight: 600; color: var(--ad-text); flex: 1; }

/* 醒目「下一步」CTA —— 与剧本大纲保持一致 */
.next-cta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 30px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--ad-accent) 0%, var(--ad-brand) 100%);
  color: var(--ad-accent-contrast);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--ad-accent) 45%, transparent);
  animation: nextPulse 2.2s ease-in-out infinite;
  transition: transform 0.15s, box-shadow 0.15s;
}
.next-cta:hover { transform: translateY(-2px); box-shadow: 0 10px 28px color-mix(in srgb, var(--ad-accent) 60%, transparent); }
.next-cta:active { transform: translateY(0); }
@keyframes nextPulse {
  0%, 100% { box-shadow: 0 6px 20px color-mix(in srgb, var(--ad-accent) 40%, transparent); }
  50% { box-shadow: 0 6px 28px color-mix(in srgb, var(--ad-accent) 72%, transparent); }
}
/* 服饰管理 */
.costume-wrap { width: 100%; }
.costume-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.costume-card { width: 116px; background: var(--ad-bg-soft); border-radius: var(--ad-radius-sm); padding: 8px; border: 1px solid var(--ad-border); }
.costume-thumb { position: relative; width: 100%; height: 100px; border-radius: 8px; overflow: hidden; background: var(--ad-bg); display: flex; align-items: center; justify-content: center; color: var(--ad-text-muted); border: 1px solid var(--ad-border); }
.costume-thumb img { width: 100%; height: 100%; object-fit: cover; }
.costume-thumb-img { cursor: zoom-in; }
.costume-zoom-hint {
  position: absolute; right: 4px; bottom: 4px; width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); color: #fff; border-radius: 6px;
  opacity: 0; transition: opacity 0.18s; pointer-events: none;
}
.costume-card:hover .costume-zoom-hint { opacity: 1; }
.costume-loading {
  position: absolute; inset: 0; z-index: 2;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  background: rgba(0, 0, 0, 0.45); color: #fff; font-size: 11px; border-radius: 8px;
}
.costume-thumb.is-default { border-color: var(--ad-brand); box-shadow: 0 0 0 1px var(--ad-brand) inset; }
.costume-default-tag { position: absolute; top: 4px; left: 4px; background: var(--ad-brand); color: var(--ad-brand-contrast); font-size: 11px; padding: 1px 6px; border-radius: 999px; }
.costume-ops { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px; margin-top: 4px; }
.costume-ops .el-button { margin-left: 0; padding: 5px; }
.costume-ops .el-button.is-active { color: var(--ad-warning); }
.costume-doubao { margin-top: 4px; }
.costume-count-chip { font-size: 11px; padding: 0 7px; line-height: 17px; background: var(--ad-brand-soft); color: var(--ad-brand); border-radius: 999px; white-space: nowrap; }
.costume-add { width: 116px; height: 100px; margin-top: 34px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: transparent; border: 1px dashed var(--ad-border); border-radius: var(--ad-radius-sm); color: var(--ad-text-soft); cursor: pointer; transition: all 0.15s; font-size: 13px; }
.costume-add:hover { border-color: var(--ad-brand); color: var(--ad-brand); }

/* —— 音色选择 —— */
/* 编辑弹窗内入口行：角色（头像+名称）｜当前音色｜选择按钮 */
.voice-entry { display: flex; align-items: center; gap: 12px; width: 100%; flex-wrap: wrap; }
.voice-entry-avatar {
  width: 44px; height: 44px; border-radius: 999px; overflow: hidden; flex-shrink: 0;
  border: 2px solid color-mix(in srgb, var(--ad-brand) 35%, transparent);
  background: var(--ad-bg-soft); color: var(--ad-text-muted);
  display: flex; align-items: center; justify-content: center;
}
.voice-entry-avatar img { width: 100%; height: 100%; object-fit: cover; }
.voice-entry-name { font-weight: 600; color: var(--ad-brand); }
.voice-entry-current {
  flex: 1; min-width: 140px; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: var(--ad-radius-sm); cursor: default;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border);
  color: var(--ad-text); font-size: 14px;
}
.voice-entry-current .el-icon { color: var(--ad-brand); }
.voice-entry-open {
  display: flex; align-items: center; gap: 6px; padding: 10px 16px; border-radius: var(--ad-radius-sm);
  border: 1px solid var(--ad-brand); background: transparent; color: var(--ad-brand);
  font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.voice-entry-open:hover { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.voice-entry-clear {
  flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 40px; border-radius: var(--ad-radius-sm); cursor: pointer;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border); color: var(--ad-text-muted);
  transition: all 0.15s;
}
.voice-entry-clear:hover { border-color: var(--ad-danger); color: var(--ad-danger); }

/* 音色选择弹窗：页签 + 筛选 + 卡片网格 */
.vp-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--ad-border); margin-bottom: 14px; }
.vp-tab {
  padding: 8px 2px 10px; font-size: 14px; font-weight: 500; cursor: pointer;
  color: var(--ad-text-muted); background: none; border: none; border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.vp-tab:hover { color: var(--ad-text); }
.vp-tab.active { color: var(--ad-brand); border-bottom-color: var(--ad-brand); }
.vp-tab:focus-visible { outline: 2px solid var(--ad-brand); outline-offset: 2px; }
.vp-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.vp-filters .el-select { flex: 1; min-width: 130px; width: auto; }
.vp-reset {
  flex-shrink: 0; height: 40px; padding: 0 16px; border-radius: 8px; font-size: 14px; cursor: pointer;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border); color: var(--ad-text-soft);
  transition: all 0.15s; white-space: nowrap;
}
.vp-reset:hover { border-color: color-mix(in srgb, var(--ad-brand) 50%, var(--ad-border)); color: var(--ad-text); }
.vp-grid-wrap { max-height: 52vh; overflow-y: auto; }
.vp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.vp-card {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--ad-radius-sm);
  cursor: pointer; transition: all 0.15s;
  background: var(--ad-bg); border: 1px solid var(--ad-border);
}
.vp-card:hover { border-color: color-mix(in srgb, var(--ad-brand) 40%, var(--ad-border)); background: color-mix(in srgb, var(--ad-brand) 5%, var(--ad-bg)); }
.vp-card.active { border-color: var(--ad-brand); background: color-mix(in srgb, var(--ad-brand) 10%, var(--ad-bg)); }
.vp-play {
  flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 999px; cursor: pointer;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border); color: var(--ad-text-soft);
  transition: all 0.15s;
}
.vp-play:hover { border-color: var(--ad-brand); color: var(--ad-brand); }
.vp-play.playing { background: var(--ad-brand); border-color: var(--ad-brand); color: var(--ad-brand-contrast); }
.vp-name-wrap { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.vp-name { font-size: 13px; font-weight: 600; color: var(--ad-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vp-tag-hot {
  flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 999px; white-space: nowrap;
  background: color-mix(in srgb, var(--ad-warning) 15%, transparent); color: var(--ad-warning);
}
.vp-fav {
  flex-shrink: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; border-radius: 6px; color: var(--ad-text-muted); cursor: pointer;
  transition: all 0.15s;
}
.vp-fav:hover { color: var(--ad-warning); background: var(--ad-bg-soft); }
.vp-fav.on { color: var(--ad-warning); }
.vp-empty { grid-column: 1 / -1; padding: 32px 0; text-align: center; color: var(--ad-text-muted); font-size: 13px; }
.vp-end { padding: 12px 0 4px; text-align: center; color: var(--ad-text-muted); font-size: 12px; }
.vp-footer { display: flex; gap: 12px; width: 100%; }
@media (max-width: 768px) {
  .vp-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .vp-filters .el-select { min-width: calc(50% - 10px); }
}

/* 底部按钮：取消 / 确定 */
.vs-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 12px 20px; border-radius: var(--ad-radius-sm); font-size: 15px; font-weight: 600;
  cursor: pointer; transition: all 0.15s;
}
.vs-btn.ghost { background: var(--ad-bg-soft); border: 1px solid var(--ad-border); color: var(--ad-text); }
.vs-btn.ghost:hover { border-color: color-mix(in srgb, var(--ad-brand) 50%, var(--ad-border)); }
.vs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.vp-footer-spacer { flex: 1; }
.vs-btn.primary { background: var(--ad-brand); border: none; color: var(--ad-brand-contrast); }
.vs-btn.primary:hover { filter: brightness(1.08); }
.vs-btn:focus-visible, .voice-entry-open:focus-visible, .voice-entry-clear:focus-visible,
.vp-play:focus-visible, .vp-fav:focus-visible, .play-badge:focus-visible, .costume-add:focus-visible {
  outline: 2px solid var(--ad-brand); outline-offset: 2px;
}

/* 手机：类型 tabs 横向滚动、资产卡单列 */
@media (max-width: 768px) {
  .tabs { overflow-x: auto; min-width: 0; }
  .grid { grid-template-columns: 1fr; gap: 12px; }
  /* 窄屏按钮组铺满整行，按钮左对齐依次折行 */
  .lib-toolbar { width: 100%; }
}
</style>
