<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, provide } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  projectApi, assetApi, storyboardApi, videoApi, characterOptionApi, artStyleApi,
} from '../../api';
import { useJobsStore } from '../../stores/jobs';
import { useCostAction } from '../../composables/useCostAction';
import { can, isOwner } from '../../utils/perms';
import { taskName } from '../../utils/task';
import { copyText } from '../../utils/clipboard';
import CharacterCreatorDialog from '../../components/CharacterCreatorDialog.vue';
import SubtitleSettingsDialog from '../../components/SubtitleSettingsDialog.vue';
import MemberManagerDialog from '../../components/MemberManagerDialog.vue';
import StudioAssets from './StudioAssets.vue';
import StudioStoryboard from './StudioStoryboard.vue';
import StudioFilm from './StudioFilm.vue';

const { t } = useI18n();
const router = useRouter();
const jobs = useJobsStore();
const { runJob, runJobs } = useCostAction();

// ====================================================================
// 项目总控台（创作台）：Ribbon 工作台壳。
// 本组件持有全部数据与动作，三个阶段子组件（资产/分镜/成片）经 inject
// 共享同一份上下文，针对「已有剧本的项目」做制作管理。
// 剧本创作（草稿对话/大纲/分集/导入）不在本台：入口在 /script-writer。
// ====================================================================

const STAGES = ['assets', 'storyboard', 'film'];
// 汇总估价（多项求和）：与 useCostAction.sumEstimate 同构（该函数未导出，此处按同口径实现）
async function sumEstimate(items, sel) {
  const results = await Promise.all(items.map((it) => it.estimateFor(sel).catch(() => null)));
  const ok = results.filter(Boolean);
  const credits = ok.reduce((n, r) => n + (Number(r.credits) || 0), 0);
  const discountedCredits = ok.reduce((n, r) => n + (Number(r.discountedCredits) || Number(r.credits) || 0), 0);
  const first = ok[0] || {};
  return { credits, count: ok.length, originalCredits: credits, discountedCredits, discount: Number(first.discount) || 0, tier: first.tier || 'none', promo: ok.map((r) => r.promo).find(Boolean) || null };
}

// ---------- 页面状态（子组件共享） ----------
const st = reactive({
  ready: false,
  loading: false,
  projects: [],
  sel: null,          // { kind: 'project', id }
  project: null,      // 当前项目详情（lean，含 episodes 概要）
  assets: [],
  segments: [],       // 当前集分镜
  films: [],          // 当前项目全部成片行
  sbSel: new Set(),   // 分镜卡片勾选（客户端态，切集由分镜页清空）
  stage: 'assets',    // Ribbon 当前页签
  curEid: null,       // 当前集 id
  focus: null,        // 任务面板跳转聚焦信号 { nonce, stage, assetId?, segmentId?, filmJobId? }
  sidebarOpen: true,
  tasksOpen: true,
});
const showCreator = ref(false);        // 自定义角色弹窗
const creatorSubmitting = ref(false);
// 自定义角色弹窗入口：模板 @click 直接引用，必须是顶层绑定（只挂 ctx 属性时点击会静默报错）
function openCreator() { showCreator.value = true; }
const audit = reactive({ running: false, open: false, report: null, fixAssets: true, fixDuration: true, applying: false }); // 分镜体检

const SEL_KEY = 'aidrama:studio:sel';
const SIDE_KEY = 'aidrama:studio:sidebar';
try { st.sidebarOpen = localStorage.getItem(SIDE_KEY) !== '0'; } catch { /* ignore */ }

// ---------- 权限 ----------
const pCan = (perm) => can(st.project, perm);
const canEditAsset = computed(() => pCan('asset.edit'));
const canEditStoryboard = computed(() => pCan('storyboard.edit'));
const canGen = computed(() => pCan('ai.generate'));
const canVideo = computed(() => pCan('video.manage'));
const canSettings = computed(() => pCan('project.settings'));
const amOwner = computed(() => isOwner(st.project));
const isProjectCtx = computed(() => st.sel?.kind === 'project');
const goWriter = () => router.push('/script-writer');

// ---------- 数据加载 ----------
async function loadLists() {
  st.projects = await projectApi.list().catch(() => []) || [];
}

function pickDefaultEpisode() {
  const eps = st.project?.episodes || [];
  return (eps.find((e) => (e.content_length || 0) > 0) || eps[0])?.id ?? null;
}

async function loadAssets() {
  if (!isProjectCtx.value) { st.assets = []; return; }
  try { st.assets = await assetApi.list(st.project.id); } catch { /* http 层已提示 */ }
}
async function loadSegments() {
  if (!isProjectCtx.value || !st.curEid) { st.segments = []; return; }
  try { st.segments = await storyboardApi.segments(st.curEid); } catch { /* ignore */ }
}
async function loadFilms() {
  if (!isProjectCtx.value) { st.films = []; return; }
  try { st.films = await videoApi.projectVideos(st.project.id); } catch { /* ignore */ }
}
// 轻刷新分镜（批量运行期轮询，不触发 loading）
async function refreshSegments() {
  if (!st.curEid) return;
  try { st.segments = await storyboardApi.segments(st.curEid); } catch { /* ignore */ }
}

async function loadContext() {
  if (!st.sel) {
    st.project = null; st.assets = []; st.segments = []; st.films = [];
    return;
  }
  st.loading = true;
  try {
    st.project = await projectApi.get(st.sel.id);
    st.curEid = pickDefaultEpisode();
    await Promise.all([loadAssets(), loadFilms()]);
    await loadSegments();
  } catch (e) {
    if (e?.status === 403 || e?.status === 404) {
      // 被移出项目/已删除：摘除失效上下文
      st.sel = null; persistSel();
      await loadLists();
    }
  } finally { st.loading = false; }
}

async function switchContext(sel) {
  if (!sel) { st.sel = null; persistSel(); await loadContext(); return; }
  if (st.sel && st.sel.kind === sel.kind && String(st.sel.id) === String(sel.id)) return;
  st.sel = { kind: sel.kind, id: sel.id };
  persistSel();
  await loadContext();
}

// 初次打开落页签：依次查第一章（第一集）成片 → 分镜 → 资产，显示第一个有内容的面板；全空兜底资产页签。
// 仅挂载时执行一次；探测第一章即锚定 curEid，保证面板展示与探测口径一致
async function pickInitialStage() {
  st.stage = 'assets';
  if (!isProjectCtx.value) return;
  const eps = st.project?.episodes || [];
  const ep1 = eps.slice().sort((a, b) => (a.idx || 0) - (b.idx || 0))[0];
  if (!ep1) return;
  setCurEid(ep1.id);
  const eid = Number(ep1.id);
  if (filmsOf(eid).length) { st.stage = 'film'; return; }
  // 第一章分镜：curEid 原本就是第一章时 loadContext 刚拉过直接用；否则显式拉一次
  if (Number(st.curEid) !== eid) {
    try { st.segments = await storyboardApi.segments(eid); } catch { st.segments = []; }
  }
  if (st.segments.length) { st.stage = 'storyboard'; return; }
  st.stage = 'assets';
}
function persistSel() {
  try {
    if (st.sel) localStorage.setItem(SEL_KEY, JSON.stringify(st.sel));
    else localStorage.removeItem(SEL_KEY);
  } catch { /* ignore */ }
}
function setStage(s) { if (STAGES.includes(s)) st.stage = s; }
function setCurEid(eid) { if (eid != null && Number(eid) !== Number(st.curEid)) st.curEid = Number(eid); }

// ---------- 任务面板跳转：按任务类型切页签/分集，并广播聚焦信号给对应面板 ----------
// 各面板 watch st.focus 滚动定位并高亮卡片；nonce 让同一目标的重复点击也能再次触发
let _focusNonce = 0;
function taskTarget(j) {
  switch (j.type) {
    case 'asset_extract': return { stage: 'assets', projectId: j.project_id };
    case 'asset_image':
    case 'asset_prompt': return { stage: 'assets', projectId: j.project_id, assetId: j.ref_id };
    case 'storyboard_script':
    case 'segment_video_batch':
    case 'segment_video_batch_concurrent': return { stage: 'storyboard', projectId: j.project_id, episodeId: j.episode_id };
    case 'segment_prompt':
    case 'segment_generate':
    case 'segment_video':
    case 'segment_erase_subtitle': return { stage: 'storyboard', projectId: j.project_id, episodeId: j.episode_id, segmentId: j.ref_id };
    case 'video_synthesis': return { stage: 'film', projectId: j.project_id, episodeId: j.episode_id };
    case 'video_subtitle': return { stage: 'film', projectId: j.project_id, filmJobId: j.ref_id };
    case 'video_edit': return j.meta?.editSource === 'segment'
      ? { stage: 'storyboard', projectId: j.project_id, episodeId: j.episode_id, segmentId: j.ref_id }
      : { stage: 'film', projectId: j.project_id, filmJobId: j.ref_id };
    default: return null; // project_cover 等无面板归属的任务不可跳转
  }
}
async function gotoTask(j) {
  const target = taskTarget(j);
  if (!target) return;
  // 跨项目任务先切上下文（loadContext 会拉全资产/成片/当前集分镜）
  if (target.projectId != null && (!st.sel || String(st.sel.id) !== String(target.projectId))) {
    await switchContext({ kind: 'project', id: target.projectId });
  }
  if (!isProjectCtx.value) return;
  if (target.episodeId != null) setCurEid(target.episodeId);
  setStage(target.stage);
  // 分镜聚焦前确保目标集分镜已就绪（切集的 watch 加载是异步的，这里显式等一次）
  if (target.stage === 'storyboard' && target.segmentId != null) await refreshSegments();
  st.focus = { nonce: ++_focusNonce, ...target };
}

// ---------- 上下文工具 ----------
const episodes = computed(() => st.project?.episodes || []);
const curEpisode = computed(() => episodes.value.find((e) => Number(e.id) === Number(st.curEid)) || null);
const filmsOf = (eid) => st.films.filter((v) => Number(v.episode_id) === Number(eid));
const composeFilmsOf = (eid) => filmsOf(eid).filter((v) => v.kind === 'compose' || v.kind === 'edit');
const hasContent = (ep) => (ep?.content_length ?? (ep?.content || '').length) > 0;

// ---------- 阶段完成态（页签角标 + 下一步建议） ----------
const stageDone = computed(() => ({
  assets: isProjectCtx.value && st.assets.length > 0,
  storyboard: st.segments.length > 0 && st.segments.every((s) => !!s.video_url),
  film: st.curEid != null && composeFilmsOf(st.curEid).length > 0,
}));
// 下一个未完成阶段（页签上的呼吸提示点）
const nextStage = computed(() => {
  for (const s of STAGES) if (!stageDone.value[s]) return s;
  return null;
});

// ---------- 忙碌判定（行内进度 + 冲突禁用） ----------
const extractJob = computed(() => (isProjectCtx.value ? jobs.activeOf('asset_extract', st.project?.id) : null));
const sbJob = computed(() => (st.curEid ? jobs.activeOf('storyboard_script', Number(st.curEid)) : null));
const batchJob = computed(() => (st.curEid ? jobs.activeOf('segment_video_batch', Number(st.curEid)) : null));
const batchCJob = computed(() => (st.curEid ? jobs.activeOf('segment_video_batch_concurrent', Number(st.curEid)) : null));
const composeJob = computed(() => (st.curEid ? jobs.activeOf('video_synthesis', Number(st.curEid)) : null));
// 合成全集完成同步兜底：刷新/重进页面后挂回的在途合成任务没有 onDone 回调（回调仅存内存），
// 任务到终态时靠这里的「有活跃 → 无活跃」消失沿重载成片列表。
// 轮询整表替换会让 computed 每轮返回新引用（prev/j 均非空的抖动），只认消失沿不误触
watch(composeJob, (j, prev) => { if (prev && !j) loadFilms(); });
const assetBusy = (a) => !!jobs.activeOf('asset_image', a.id);
const promptBusyOf = (s) => !!jobs.activeOf('segment_prompt', s.id);
const segBusyOf = (s) => !!(jobs.activeOf('segment_video', s.id)
  || (batchJob.value || batchCJob.value) && s.status === 'generating');
const anyBusy = computed(() => !!(extractJob.value || sbJob.value || batchJob.value || batchCJob.value
  || composeJob.value
  || st.assets.some(assetBusy) || st.segments.some((s) => segBusyOf(s) || promptBusyOf(s))));
// 分镜页签「批量生成视频」两按钮（串行/并发）共用状态：有勾选（全选/单选/全选无视频）即恒可用——勾选范围就是批量目标；
// 未勾选回退旧口径：存在「有提示词且未出片」的镜头才可点。批量任务运行期仍置灰（点击侧 actBatchSerial/Concurrent 亦有兜底）
const canBatchVideo = computed(() => {
  if (!canGen.value || batchJob.value || batchCJob.value) return false;
  return !!st.sbSel.size || st.segments.some((s) => s.video_prompt && !s.video_url);
});

// ---------- 上下文对象（provide 给阶段子组件） ----------
const ctx = {
  st,
  jobs,
  t,
  isProjectCtx, pCan,
  canEditAsset, canEditStoryboard, canGen, canVideo,
  episodes, curEpisode, filmsOf, composeFilmsOf, hasContent,
  stageDone, nextStage,
  extractJob, sbJob, batchJob, batchCJob, composeJob,
  assetBusy, promptBusyOf, segBusyOf,
  switchContext, setStage, setCurEid, refreshSegments, loadAssets, loadFilms,
  sumEstimate,
  // AI 动作（模板里经 ctx 解构使用）
  actExtract, actGenImages, actGenStoryboard, actBatchPrompt, actBatchSerial, actBatchConcurrent,
  actCompose, actShare, actAddAsset, runAudit, applyAuditFixes, audit,
  openCreator,
  goWriter,
};
provide('studio', ctx);

// ---------- AI 动作：资产 ----------
function actExtract() {
  if (!isProjectCtx.value || anyBusy.value) return;
  return runJob({
    modelType: 'text',
    estimateFor: (sel) => assetApi.extractEstimate(st.project.id, sel),
    createFor: (sel) => assetApi.extract(st.project.id, sel),
    title: t('studio.job.extractTitle'), desc: t('studio.job.extractDesc'), confirmText: t('common.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') { loadAssets(); } },
  });
}

// 批量为无形象资产生成设定图（runJobs 一次确认）
function actGenImages(targets) {
  const list = (targets || st.assets.filter((a) => !a.image_url && !assetBusy(a)));
  if (!list.length) return ElMessage.info(t('studio.hint.noMissingImages'));
  return runJobs({
    modelType: 'image',
    items: list.map((a) => ({
      estimateFor: (sel) => assetApi.genImageEstimate(a.id, sel),
      createFor: (sel) => assetApi.genImage(a.id, sel),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.asset) {
          const i = st.assets.findIndex((x) => x.id === a.id);
          if (i > -1) st.assets[i] = j.result.asset;
        }
      },
    })),
    title: t('studio.job.imagesTitle'), desc: t('studio.job.imagesDesc', { count: list.length }), confirmText: t('common.confirm'),
  });
}

// 手动添加资产（简单表单：类型 + 名称 + 描述）
const addAsset = reactive({ open: false, kind: 'character', name: '', description: '' });
async function actAddAsset() {
  const name = addAsset.name.trim();
  if (!name) return;
  try {
    const created = await assetApi.create(st.project.id, { kind: addAsset.kind, name, description: addAsset.description.trim() });
    st.assets.push(created.asset || created);
    addAsset.open = false; addAsset.name = ''; addAsset.description = '';
    ElMessage.success(t('studio.hint.assetAdded'));
  } catch { /* http 层已提示 */ }
}

// 自定义角色（CharacterCreatorDialog confirm → 统一确认页）
async function createCustomCharacter(payload) {
  creatorSubmitting.value = true;
  try {
    const job = await runJob({
      modelType: 'image',
      estimateFor: (sel) => characterOptionApi.createEstimate(st.project.id, sel),
      createFor: (sel) => characterOptionApi.create(st.project.id, { ...payload, modelConfigId: sel.modelConfigId }).then((d) => {
        st.assets.push(d.asset);
        return { job: d.job };
      }),
      title: t('charCreator.confirm.title'), desc: t('charCreator.confirm.desc'), confirmText: t('charCreator.confirmText'),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.asset) {
          const i = st.assets.findIndex((x) => x.id === j.result.asset.id);
          if (i > -1) st.assets[i] = j.result.asset;
        }
      },
    });
    if (job) showCreator.value = false;
  } finally { creatorSubmitting.value = false; }
}

// ---------- AI 动作：分镜 ----------
function actGenStoryboard() {
  if (!st.curEid || sbJob.value) return;
  return runJob({
    modelType: 'text',
    estimateFor: (sel) => storyboardApi.genStoryboardEstimate(st.curEid, sel),
    createFor: (sel) => storyboardApi.genStoryboard(st.curEid, sel),
    title: t('studio.job.storyboardTitle'), desc: t('studio.job.storyboardDesc'), confirmText: t('common.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') refreshSegments(); },
  });
}

async function ensureSelection(targets) {
  // 批量动作按服务端 selected 集合执行：先把目标集同步为选中（novice 路径免手选）
  const ids = targets.map((s) => s.id);
  await storyboardApi.selectSegments(st.curEid, ids, true);
  st.segments.forEach((s) => { if (ids.includes(s.id)) s.selected = true; });
}

// 卡片勾选的镜头；未勾选时返回 null，批量动作回退到原有默认范围
function sbSelectedScope() {
  if (!st.sbSel.size) return null;
  const list = st.segments.filter((s) => st.sbSel.has(s.id));
  return list.length ? list : null;
}

// 批量润色提示词：有勾选 → 所选镜头全部重润色（含已有提示词的，润色即改写）；
// 无勾选回退旧口径：全部缺提示词的镜头
async function actBatchPrompt(targets) {
  const scope = targets || sbSelectedScope() || st.segments.filter((s) => !s.video_prompt);
  const list = scope.filter((s) => !promptBusyOf(s));
  if (!list.length) return ElMessage.info(t('studio.hint.noMissingPrompt'));
  await ensureSelection(list);
  return runJobs({
    modelType: 'text',
    items: list.map((s) => ({
      estimateFor: (sel) => storyboardApi.genPromptEstimate(s.id, sel),
      createFor: (sel) => storyboardApi.genPrompt(s.id, sel),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.segment) {
          const i = st.segments.findIndex((x) => x.id === s.id);
          if (i > -1) st.segments[i] = j.result.segment;
        }
      },
    })),
    title: t('storyboard.batchGenPromptTitle'), desc: t('storyboard.batchGenPromptDesc', { count: list.length }), confirmText: t('common.confirm'),
  });
}

// 批量生成视频：串行（相邻镜头以上一镜尾帧衔接，novice 默认）
async function actBatchSerial(targets) {
  if (batchJob.value || batchCJob.value) return;
  const scope = targets || sbSelectedScope() || st.segments;
  const list = scope.filter((s) => !s.video_url && !segBusyOf(s))
    .slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
  const noPrompt = list.filter((s) => !s.video_prompt);
  if (noPrompt.length) return ElMessage.warning(t('studio.hint.someNoPrompt', { count: noPrompt.length }));
  if (!list.length) return ElMessage.info(t('studio.hint.noMissingVideo'));
  await ensureSelection(list);
  return runJob({
    modelType: 'video',
    estimateFor: (sel) => sumEstimate(list.map((s) => ({ estimateFor: (s2) => storyboardApi.genEstimate(s.id, s2) })), sel),
    createFor: (sel) => storyboardApi.generateBatch(st.curEid, { segmentIds: list.map((s) => s.id), modelConfigId: sel.modelConfigId, resolution: sel.resolution }),
    onDone: (j) => {
      refreshSegments();
      if (j.status === 'succeeded') {
        const r = j.result || {};
        if (r.failed?.length) ElMessage.warning(t('storyboard.batchDoneWithFailures', { ok: r.completed?.length || 0, fail: r.failed.length }));
      }
    },
    title: t('storyboard.batchSerialTitle'), desc: t('storyboard.batchSerialDesc', { count: list.length }), confirmText: t('common.confirm'),
  });
}

// 批量生成视频：并发（更快，不做跨镜衔接）
async function actBatchConcurrent(targets) {
  if (batchJob.value || batchCJob.value) return;
  const scope = targets || sbSelectedScope() || st.segments;
  const list = scope.filter((s) => !s.video_url && !segBusyOf(s))
    .slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
  const noPrompt = list.filter((s) => !s.video_prompt);
  if (noPrompt.length) return ElMessage.warning(t('studio.hint.someNoPrompt', { count: noPrompt.length }));
  if (!list.length) return ElMessage.info(t('studio.hint.noMissingVideo'));
  await ensureSelection(list);
  return runJob({
    modelType: 'video',
    estimateFor: (sel) => sumEstimate(list.map((s) => ({ estimateFor: (s2) => storyboardApi.genEstimate(s.id, s2) })), sel),
    createFor: (sel) => storyboardApi.generateBatchConcurrent(st.curEid, { segmentIds: list.map((s) => s.id), modelConfigId: sel.modelConfigId, resolution: sel.resolution }),
    onDone: (j) => {
      refreshSegments();
      if (j.status === 'succeeded') {
        const r = j.result || {};
        if (r.failed?.length) ElMessage.warning(t('storyboard.concurrentDoneWithFailures', { ok: r.completed?.length || 0, fail: r.failed.length }));
      }
    },
    title: t('storyboard.batchConcurrentTitle'), desc: t('storyboard.batchConcurrentDesc', { count: list.length }), confirmText: t('common.confirm'),
  });
}

// 分镜体检（免费同步）：报告缺失资产/时长问题，可一键修复
async function runAudit() {
  if (!st.curEid || audit.running) return;
  audit.running = true;
  try {
    audit.report = await storyboardApi.auditSegments(st.curEid);
    audit.open = true;
  } catch { /* http 层已提示 */ } finally { audit.running = false; }
}
async function applyAuditFixes() {
  if (!audit.report) { audit.open = false; return; }
  audit.applying = true;
  try {
    const r = await storyboardApi.applyAudit(st.curEid, { fixAssets: audit.fixAssets, fixDuration: audit.fixDuration });
    ElMessage.success(t('storyboard.auditApplied', { a: r.stats.assetsApplied, d: r.stats.durationApplied }));
    audit.open = false;
    if (Array.isArray(r.segments)) st.segments = r.segments; else await refreshSegments();
  } catch { /* http 层已提示 */ } finally { audit.applying = false; }
}

// ---------- AI 动作：成片 ----------
const COMPOSE_RES_KEY = 'aidrama:composeResolution'; // 与 StoryboardEditor 共用同一记忆键
async function actCompose() {
  if (!st.curEid || composeJob.value) return;
  const ready = st.segments.filter((s) => s.video_url);
  if (!ready.length) return ElMessage.warning(t('studio.hint.composeNeedVideo'));
  await ensureSelection(ready);
  let memoryRes = null;
  try { memoryRes = localStorage.getItem(COMPOSE_RES_KEY); } catch { /* ignore */ }
  return runJob({
    resolutionOptions: ['480p', '720p', '768p', '1080p', '2K', '4K'],
    resolutionHint: t('storyboard.composeResolutionHint'),
    selection: memoryRes ? { resolution: memoryRes } : undefined,
    estimateFor: (sel) => videoApi.composeEstimate(st.curEid, sel.resolution),
    createFor: (sel) => videoApi.compose(st.curEid, { resolution: sel.resolution }),
    onConfirm: (sel) => { try { localStorage.setItem(COMPOSE_RES_KEY, sel.resolution || ''); } catch { /* ignore */ } },
    onDone: (j) => { if (j.status === 'succeeded') { loadFilms(); ElMessage.success(t('studio.hint.composeDone')); } },
    title: t('storyboard.composeTitle'), desc: t('storyboard.composeDesc'), confirmText: t('common.confirm'),
  });
}

async function actShare() {
  try {
    const { token } = await projectApi.ensureShare(st.project.id);
    const url = `${window.location.origin}/share/${token}`;
    const ok = await copyText(url);
    if (ok) ElMessage.success(t('studio.hint.shareCopied'));
    else await ElMessageBox.alert(url, t('studio.hint.shareLink'), { confirmButtonText: t('common.confirm') });
  } catch { /* http 层已提示 */ }
}

// ---------- 项目设置：修改尺寸 / 风格 / 字幕 / 成员（功能同 WorkspaceView 顶栏快捷入口） ----------
// 轻刷新项目详情（比例/风格/字幕改动后同步 st.project，画面相关的 computed 自动跟随）
async function reloadProject() {
  if (!st.project) return;
  try { st.project = await projectApi.get(st.project.id); } catch { /* http 层已提示 */ }
}

// 画面比例快捷切换（9:16 / 16:9 / 1:1）
const aspects = computed(() => [
  { value: '9:16', label: t('workspace.aspect.vertical'), w: 9, h: 16 },
  { value: '16:9', label: t('workspace.aspect.horizontal'), w: 16, h: 9 },
  { value: '1:1', label: t('workspace.aspect.square'), w: 1, h: 1 },
]);
const aspectVisible = ref(false);
const aspectSaving = ref(false);
const SHAPE_MAX = 13; // 弹出项里迷你比例形的最大边长（px）
// 按真实宽高比绘制矩形，直观体现画面形状
function shapeStyle(ar) {
  const a = aspects.value.find((x) => x.value === ar);
  if (!a) return {};
  if (a.w >= a.h) return { width: SHAPE_MAX + 'px', height: Math.round((SHAPE_MAX * a.h) / a.w) + 'px' };
  return { height: SHAPE_MAX + 'px', width: Math.round((SHAPE_MAX * a.w) / a.h) + 'px' };
}
async function changeAspect(value) {
  aspectVisible.value = false;
  if (value === st.project?.aspect_ratio) return;
  aspectSaving.value = true;
  try {
    await projectApi.update(st.project.id, { aspect_ratio: value });
    ElMessage.success(t('workspace.aspect.updated'));
    await reloadProject();
  } catch {
    ElMessage.error(t('workspace.aspect.updateFailed'));
  } finally {
    aspectSaving.value = false;
  }
}

// 视觉风格切换弹窗（写实 / 动漫 两个大类页签；artStyles 首次打开时懒加载）
const artStyles = ref([]);
async function loadStyles() {
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
}
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
  if (!canSettings.value) return;
  pendingStyle.value = st.project?.style || '';
  activeCategory.value = categoryOf(pendingStyle.value);
  styleDialogVisible.value = true;
  if (!artStyles.value.length) loadStyles();
}
async function applyStyle() {
  if (!pendingStyle.value || pendingStyle.value === st.project?.style) {
    styleDialogVisible.value = false;
    return;
  }
  styleSaving.value = true;
  try {
    await projectApi.update(st.project.id, { style: pendingStyle.value });
    styleDialogVisible.value = false;
    ElMessage.success(t('workspace.style.updated'));
    await reloadProject();
  } catch {
    ElMessage.error(t('workspace.style.updateFailed'));
  } finally {
    styleSaving.value = false;
  }
}

// 项目全局字幕设置 / 成员管理弹窗开关
const subtitleSettingsVisible = ref(false);
const memberDialogVisible = ref(false);
// 无 project.settings 权限时按钮的禁用提示（同 WorkspaceView 只读 chip 口径）
const noPermTitle = computed(() => t('team.permNeeded', { perm: t('team.perms.projectSettings') }));

// ---------- 重命名 / 删除 ----------
async function renameContext() {
  if (!st.project) return;
  let name;
  try {
    ({ value: name } = await ElMessageBox.prompt(t('studio.hint.renamePrompt'), t('studio.hint.rename'), {
      inputValue: st.project.name || '', inputPattern: /\S/, inputErrorMessage: t('studio.hint.nameRequired'),
    }));
  } catch { return; }
  name = name.trim();
  try {
    await projectApi.update(st.project.id, { name });
    st.project.name = name;
    const row = st.projects.find((x) => x.id === st.project.id);
    if (row) row.name = name;
  } catch { /* http 层已提示 */ }
}
async function deleteContext() {
  const src = st.project;
  if (!src) return;
  try {
    await ElMessageBox.confirm(t('studio.hint.deleteConfirm', { name: src.name || '' }), t('common.tip'), { type: 'warning' });
  } catch { return; }
  try {
    await projectApi.remove(src.id);
    st.sel = null; persistSel();
    await loadLists();
    await loadContext();
    ElMessage.success(t('common.deleteSuccess'));
  } catch { /* http 层已提示 */ }
}

// ---------- 「下一步」向导引擎 ----------
const nextAction = computed(() => {
  if (!st.sel) return { key: 'create', label: t('studio.next.create'), run: goWriter, gold: true };
  if (anyBusy.value) {
    const j = jobs.active[0];
    return { key: 'busy', label: t('studio.next.busy', { name: taskName(j, t('task.defaultLabel')) }), disabled: true, running: true };
  }
  const eps = st.project?.episodes || [];
  if (!eps.some(hasContent)) return { key: 'script', label: t('studio.next.writeScript'), run: goWriter };
  if (extractJob.value) return { key: 'busy', label: t('studio.next.busy', { name: taskName(extractJob.value, t('task.defaultLabel')) }), disabled: true };
  if (!st.assets.length) return { key: 'extract', label: t('studio.next.extract'), run: () => actExtract(), gold: true };
  const missingImg = st.assets.filter((a) => !a.image_url && !assetBusy(a));
  if (missingImg.length) return { key: 'images', label: t('studio.next.images', { n: missingImg.length }), run: () => actGenImages(missingImg) };
  if (!st.curEid) return { key: 'script', label: t('studio.next.writeScript'), run: goWriter };
  if (sbJob.value) return { key: 'busy', label: t('studio.next.busy', { name: taskName(sbJob.value, t('task.defaultLabel')) }), disabled: true };
  if (!st.segments.length) return { key: 'storyboard', label: t('studio.next.storyboard', { n: curEpisode.value?.idx || '' }), run: () => actGenStoryboard(), gold: true };
  const noPrompt = st.segments.filter((s) => !s.video_prompt && !promptBusyOf(s));
  if (noPrompt.length) return { key: 'prompt', label: t('studio.next.prompts', { n: noPrompt.length }), run: () => actBatchPrompt(noPrompt) };
  const noVideo = st.segments.filter((s) => !s.video_url && !segBusyOf(s));
  if (noVideo.length) return { key: 'video', label: t('studio.next.videos', { n: noVideo.length }), run: () => actBatchSerial(noVideo) };
  if (composeJob.value) return { key: 'busy', label: t('studio.next.busy', { name: taskName(composeJob.value, t('task.defaultLabel')) }), disabled: true };
  if (!composeFilmsOf(st.curEid).length) return { key: 'compose', label: t('studio.next.compose'), run: () => actCompose(), gold: true };
  return { key: 'done', label: t('studio.next.done'), run: () => setStage('film') };
});

// ---------- 批量任务运行期轮询分镜（反映逐段进度；同 StoryboardEditor） ----------
let _segPoll = null;
watch(() => !!(batchJob.value || batchCJob.value), (running) => {
  if (running && !_segPoll) _segPoll = setInterval(refreshSegments, 3000);
  else if (!running && _segPoll) { clearInterval(_segPoll); _segPoll = null; }
});
onBeforeUnmount(() => { if (_segPoll) clearInterval(_segPoll); });

// ---------- 启动 ----------
onMounted(async () => {
  // 恢复上次上下文（历史遗留的 draft 键一律视为失效）
  try {
    const raw = localStorage.getItem(SEL_KEY);
    if (raw) st.sel = JSON.parse(raw);
  } catch { /* ignore */ }
  st.ready = false;
  try {
    await loadLists();
    const stillThere = st.sel && st.sel.kind === 'project'
      && st.projects.some((x) => String(x.id) === String(st.sel.id));
    if (!stillThere) {
      st.sel = st.projects.length ? { kind: 'project', id: st.projects[0].id } : null;
      persistSel();
    }
    await loadContext();
    await pickInitialStage();
  } finally { st.ready = true; }
});
watch(() => st.curEid, loadSegments);

// ---------- 页签 ----------
const stageTabs = computed(() => ([
  { key: 'assets', icon: 'PictureFilled', label: t('studio.tab.assets') },
  { key: 'storyboard', icon: 'Film', label: t('studio.tab.storyboard') },
  { key: 'film', icon: 'VideoPlay', label: t('studio.tab.film') },
]));

const selKey = computed({
  get: () => (st.sel ? `${st.sel.kind}:${st.sel.id}` : ''),
  set: (v) => {
    const [kind, id] = String(v).split(':');
    switchContext({ kind, id: Number(id) || id });
  },
});

const summary = computed(() => {
  const seg = st.segments.length;
  const vid = st.segments.filter((s) => s.video_url).length;
  const films = composeFilmsOf(st.curEid).length;
  return t('studio.status.projectSummary', {
    title: st.project?.name || '', ep: curEpisode.value?.idx || '-', seg, vid, films,
  });
});

function toggleSidebar() {
  st.sidebarOpen = !st.sidebarOpen;
  try { localStorage.setItem(SIDE_KEY, st.sidebarOpen ? '1' : '0'); } catch { /* ignore */ }
}
</script>

<template>
  <div class="studio" v-loading="!st.ready">
    <!-- ================= Ribbon ================= -->
    <header class="rb">
      <div class="rb-row1">
        <div class="rb-left">
          <button class="rb-home" type="button" :title="t('studio.ctx.backHome')" @click="router.push('/')">
            <el-icon><HomeFilled /></el-icon>
          </button>
          <el-select
            v-model="selKey"
            class="rb-works"
            :placeholder="t('studio.ctx.selectPh')"
            size="default"
            filterable
          >
            <el-option-group v-if="st.projects.length" :label="t('studio.ctx.groupProjects')">
              <el-option v-for="p in st.projects" :key="`project:${p.id}`" :value="`project:${p.id}`" :label="p.name">
                <span class="rb-opt-name"><el-icon class="rb-opt-ico"><Film /></el-icon>{{ p.name }}</span>
                <span class="rb-opt-tag">{{ t('studio.ctx.projectTag', { count: p.episode_count || 0 }) }}</span>
              </el-option>
            </el-option-group>
          </el-select>
          <el-dropdown v-if="st.sel" trigger="click" @command="(cmd) => cmd === 'rename' ? renameContext() : deleteContext()">
            <button class="rb-more" type="button" :title="t('studio.ctx.more')">
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="rename"><el-icon><EditPen /></el-icon> {{ t('studio.ctx.rename') }}</el-dropdown-item>
                <el-dropdown-item command="delete" divided class="rb-danger-item"><el-icon><Delete /></el-icon> {{ t('common.delete') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <button v-else class="rb-more" type="button" :title="t('studio.onboard.writerTitle')" @click="goWriter">
            <el-icon><Plus /></el-icon>
          </button>
        </div>

        <nav class="rb-tabs">
          <button
            v-for="tab in stageTabs"
            :key="tab.key"
            class="rb-tab"
            :class="{ active: st.stage === tab.key }"
            :disabled="!st.sel"
            @click="setStage(tab.key)"
          >
            <el-icon><component :is="tab.icon" /></el-icon>
            <span>{{ tab.label }}</span>
            <span v-if="st.sel && stageDone[tab.key]" class="rb-tab-done"><el-icon><Check /></el-icon></span>
            <span v-else-if="nextStage === tab.key && st.sel" class="rb-tab-next"></span>
          </button>
        </nav>

        <div class="rb-right">
          <button class="rb-tool" :class="{ on: st.tasksOpen }" :title="t('studio.tasks.title')" @click="st.tasksOpen = !st.tasksOpen">
            <el-icon><Tickets /></el-icon>
            <span v-if="jobs.activeCount" class="rb-badge">{{ jobs.activeCount > 99 ? '99+' : jobs.activeCount }}</span>
          </button>
          <button class="rb-tool" :class="{ on: st.sidebarOpen }" :title="t('studio.ctx.sidebar')" @click="toggleSidebar">
            <el-icon><Fold v-if="st.sidebarOpen" /><Expand v-else /></el-icon>
          </button>
        </div>
      </div>

      <!-- ============ Ribbon 功能按钮组（Word/Excel 式） ============ -->
      <div v-if="st.sel" class="rb-row2">
        <!-- —— 资产页签 —— -->
        <template v-if="st.stage === 'assets'">
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn gold" :disabled="!canGen || !!extractJob" @click="actExtract()"><el-icon><MagicStick /></el-icon><span>{{ t('studio.act.extract') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.extract') }}</div>
          </div>
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn" :disabled="!canEditAsset" @click="openCreator()"><el-icon><User /></el-icon><span>{{ t('studio.act.customChar') }}</span></button>
              <button class="rb-btn" :disabled="!canEditAsset" @click="addAsset.open = true"><el-icon><Plus /></el-icon><span>{{ t('studio.act.addAsset') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.newAsset') }}</div>
          </div>
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn" :disabled="!canGen || !st.assets.some((a) => !a.image_url)" @click="actGenImages()"><el-icon><PictureFilled /></el-icon><span>{{ t('studio.act.fillImages') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.images') }}</div>
          </div>
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn gold" :disabled="!st.assets.length" @click="setStage('storyboard')"><el-icon><Right /></el-icon><span>{{ t('studio.act.toStoryboard') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.nextStep') }}</div>
          </div>
        </template>

        <!-- —— 分镜页签 —— -->
        <template v-else-if="st.stage === 'storyboard'">
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn" :disabled="!st.segments.length || audit.running" @click="runAudit()"><el-icon><CircleCheckFilled /></el-icon><span>{{ t('studio.act.audit') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.shots') }}</div>
          </div>
          <div class="rb-group">
            <div class="rb-group-items">
              <!-- 批量润色：有勾选即可点（所选镜头重润色，含已有提示词的）；无勾选回退旧口径：存在缺提示词镜头才可点 -->
              <button class="rb-btn" :disabled="!canGen || (!st.sbSel.size && !st.segments.some((s) => !s.video_prompt))" @click="actBatchPrompt()"><el-icon><ChatDotRound /></el-icon><span>{{ t('studio.act.batchPrompt') }}</span></button>
              <!-- 有勾选分镜即可点（勾选范围即目标）；未勾选回退旧口径：存在待生成镜头才可点；串行/并发共用 canBatchVideo -->
              <button class="rb-btn" :disabled="!canBatchVideo" @click="actBatchSerial()"><el-icon><VideoPlay /></el-icon><span>{{ t('studio.act.batchSerial') }}</span></button>
              <button class="rb-btn" :disabled="!canBatchVideo" @click="actBatchConcurrent()"><el-icon><Timer /></el-icon><span>{{ t('studio.act.batchConcurrent') }}</span></button>
              <button class="rb-btn gold" :disabled="!canVideo || !st.curEid || !!composeJob || !st.segments.some((s) => s.video_url)" @click="actCompose()"><el-icon><Film /></el-icon><span>{{ t('studio.act.compose') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.generate') }}</div>
          </div>
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn gold" :disabled="!st.segments.some((s) => s.video_url)" @click="setStage('film')"><el-icon><Right /></el-icon><span>{{ t('studio.act.toFilm') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.nextStep') }}</div>
          </div>
        </template>

        <!-- —— 成片页签（合成全集入口移至分镜页签生成组） —— -->
        <template v-else>
          <div class="rb-group">
            <div class="rb-group-items">
              <button class="rb-btn" :disabled="!st.project" @click="actShare()"><el-icon><Share /></el-icon><span>{{ t('studio.act.share') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.act.share') }}</div>
          </div>
          <div class="rb-group">
            <div class="rb-group-items">
              <el-popover v-model:visible="aspectVisible" placement="bottom-start" :width="252" trigger="click" popper-class="asp-popper">
                <template #reference>
                  <button class="rb-btn" :disabled="!canSettings" :title="canSettings ? t('workspace.aspect.clickToEdit') : noPermTitle">
                    <el-icon><Crop /></el-icon><span>{{ t('studio.act.aspect') }}</span>
                  </button>
                </template>
                <div class="asp-pop">
                  <div class="asp-pop-title">{{ t('workspace.aspect.title') }}</div>
                  <div class="asp-pop-grid">
                    <button
                      v-for="a in aspects"
                      :key="a.value"
                      type="button"
                      class="asp-pop-item"
                      :class="{ active: a.value === st.project?.aspect_ratio }"
                      @click="changeAspect(a.value)"
                    >
                      <span class="chip-shape is-lg" :style="shapeStyle(a.value)"></span>
                      <span class="asp-pop-label">{{ a.label }}</span>
                      <span class="asp-pop-val">{{ a.value }}</span>
                    </button>
                  </div>
                </div>
              </el-popover>
              <button class="rb-btn" :disabled="!canSettings" :title="canSettings ? t('workspace.style.clickToEdit') : noPermTitle" @click="openStyleDialog()"><el-icon><Brush /></el-icon><span>{{ t('studio.act.style') }}</span></button>
              <button class="rb-btn" :disabled="!canSettings" :title="canSettings ? t('project.subtitleSettings.chip') : noPermTitle" @click="subtitleSettingsVisible = true"><el-icon><Headset /></el-icon><span>{{ t('studio.act.subtitle') }}</span></button>
              <!-- 成员管理：owner 专属（同 /projects 页口径），非 owner 不显示 -->
              <button v-if="amOwner" class="rb-btn" :title="t('team.manageMembers')" @click="memberDialogVisible = true"><el-icon><User /></el-icon><span>{{ t('team.members') }}</span></button>
            </div>
            <div class="rb-group-cap">{{ t('studio.rb.project') }}</div>
          </div>
        </template>
      </div>
    </header>

    <!-- ================= 空状态引导（无可用项目） ================= -->
    <section v-if="!st.sel" class="onboard">
      <div class="ob-clapper ad-stagger">
        <div class="ob-clapper-bar"><i></i><i></i><i></i></div>
        <div class="ob-clapper-body">
          <div class="ob-scene">{{ t('studio.onboard.scene') }}</div>
          <h1 class="ob-title">{{ t('studio.onboard.title') }}</h1>
          <p class="ob-sub">{{ t('studio.onboard.sub') }}</p>
        </div>
      </div>
      <div class="ob-choices ad-stagger">
        <button class="ob-card" @click="goWriter">
          <el-icon class="ob-ico"><EditPen /></el-icon>
          <span class="ob-card-title">{{ t('studio.onboard.writerTitle') }}</span>
          <span class="ob-card-desc">{{ t('studio.onboard.writerDesc') }}</span>
          <span class="ob-card-go">{{ t('studio.onboard.go') }} <el-icon><Right /></el-icon></span>
        </button>
      </div>
    </section>

    <!-- ================= 工作区 ================= -->
    <div v-else class="st-body" v-loading="st.loading">
      <!-- 左侧：分集 -->
      <aside v-show="st.sidebarOpen" class="side">
        <div class="side-cap"><el-icon><Film /></el-icon>{{ t('studio.side.episodesCap') }}</div>
        <button
          v-for="ep in episodes"
          :key="ep.id"
          class="side-item"
          :class="{ active: Number(ep.id) === Number(st.curEid) }"
          @click="setCurEid(ep.id)"
        >
          <span class="side-no">{{ ep.idx }}</span>
          <span class="side-name">{{ ep.title || t('studio.side.untitledEp') }}</span>
          <span class="side-dot" :class="{ done: hasContent(ep) }"></span>
        </button>
        <div v-if="!episodes.length" class="side-empty">{{ t('studio.side.noEpisodes') }}</div>
      </aside>

      <!-- 中央工作区：三阶段 -->
      <section class="st-main">
        <StudioAssets v-if="st.stage === 'assets'" />
        <StudioStoryboard v-else-if="st.stage === 'storyboard'" />
        <StudioFilm v-else />
      </section>

      <!-- 右侧：任务面板 -->
      <aside v-if="st.tasksOpen" class="tasks">
        <div class="side-cap"><el-icon><Tickets /></el-icon>{{ t('studio.tasks.title') }}</div>
        <div v-if="!jobs.items.length" class="side-empty">{{ t('studio.tasks.empty') }}</div>
        <div
          v-for="j in jobs.items.slice(0, 30)"
          :key="j.id"
          class="tk-row"
          :class="{ go: !!taskTarget(j) }"
          @click="gotoTask(j)"
        >
          <span class="tk-dot" :class="j.status"></span>
          <div class="tk-main">
            <div class="tk-name" :title="taskName(j, t('task.defaultLabel'))">{{ taskName(j, t('task.defaultLabel')) }}</div>
            <div v-if="j.status === 'pending' || j.status === 'running'" class="tk-meta">
              <span class="tk-stage">{{ j.stage || t('studio.tasks.queued') }}</span>
              <span class="tk-pct">{{ j.progress || 0 }}%</span>
            </div>
            <div v-else class="tk-meta">
              <span :class="j.status === 'succeeded' ? 'tk-ok' : 'tk-fail'">
                {{ j.status === 'succeeded' ? t('studio.tasks.done') : (j.status === 'failed' ? t('studio.tasks.failed') : t('studio.tasks.cancelled')) }}
              </span>
            </div>
          </div>
          <el-icon v-if="taskTarget(j)" class="tk-go"><Right /></el-icon>
          <button
            v-if="j.status === 'pending' || j.status === 'running'"
            class="tk-cancel"
            :title="t('studio.tasks.cancel')"
            @click.stop="jobs.cancel(j.id)"
          ><el-icon><Close /></el-icon></button>
        </div>
      </aside>
    </div>

    <!-- ================= 状态栏（场记板） ================= -->
    <footer class="sb">
      <div class="sb-left">
        <span class="sb-rec" v-if="anyBusy"></span>
        <span class="sb-summary">{{ summary }}</span>
      </div>
      <div class="sb-jobs">
        <span v-for="j in jobs.active.slice(0, 2)" :key="j.id" class="sb-job">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span class="sb-job-name">{{ taskName(j, t('task.defaultLabel')) }}</span>
          <span class="sb-job-pct">{{ j.progress || 0 }}%</span>
        </span>
        <span v-if="jobs.activeCount > 2" class="sb-job-more">+{{ jobs.activeCount - 2 }}</span>
      </div>
      <button class="sb-cta" :class="{ gold: nextAction.gold }" :disabled="nextAction.disabled" @click="nextAction.run">
        <el-icon v-if="nextAction.running" class="is-loading"><Loading /></el-icon>
        <el-icon v-else-if="nextAction.key === 'create'"><Plus /></el-icon>
        <template v-else>{{ t('studio.next.prefix') }}</template>
        <span>{{ nextAction.label }}</span>
        <el-icon v-if="!nextAction.disabled && !nextAction.running && nextAction.key !== 'create'"><Right /></el-icon>
      </button>
    </footer>

    <!-- ================= 弹窗 ================= -->
    <!-- 分镜体检报告（复用 storyboard.audit* 文案；字段口径与 storyboardAudit.service 一致） -->
    <el-dialog v-model="audit.open" :title="t('studio.act.audit')" width="min(640px, 94vw)" append-to-body>
      <div class="au-body">
        <div v-if="audit.report" class="au-summary">
          <span v-if="audit.report.summary.assetIssueCount" class="au-chip warn">{{ t('storyboard.auditSummaryAssets', { count: audit.report.summary.assetIssueCount }) }}</span>
          <span v-if="audit.report.summary.durationIssueCount" class="au-chip">{{ t('storyboard.auditSummaryDuration', { count: audit.report.summary.durationIssueCount }) }}</span>
          <span v-if="audit.report.summary.overflowCount" class="au-chip warn">{{ t('storyboard.auditSummaryOverflow', { count: audit.report.summary.overflowCount }) }}</span>
        </div>
        <div v-for="item in (audit.report?.items || []).filter((x) => x.missingAssets.length || x.duration.changed || x.duration.overflow || x.warnings.length)" :key="item.segmentId" class="au-item">
          <div class="au-item-name">{{ item.shot_no || ('#' + (item.idx ?? '?')) }}<template v-if="item.title"> · {{ item.title }}</template></div>
          <div v-if="item.missingAssets.length" class="au-item-row warn">
            {{ item.missingAssets.map((m) => `${m.name}（${m.reasonKey === 'speaker' ? t('storyboard.auditReasonSpeaker') : t('storyboard.auditReasonMention')}）`).join('、') }}
          </div>
          <div v-if="item.duration.changed" class="au-item-row">{{ t('storyboard.auditDurationChange', { cur: item.duration.current, rec: item.duration.recommended }) }}</div>
          <div v-if="item.duration.overflow" class="au-item-row warn">{{ t('storyboard.auditOverflow', { sec: item.duration.estimated }) }}</div>
          <div v-if="item.duration.changed && item.duration.hasVideo" class="au-item-row muted">{{ t('storyboard.auditHasVideoHint') }}</div>
          <div v-for="(w, wi) in item.warnings" :key="wi" class="au-item-row muted">{{ t('storyboard.auditWarningNoImage', { name: w.name }) }}</div>
        </div>
        <div v-if="!(audit.report?.items || []).some((x) => x.missingAssets.length || x.duration.changed || x.duration.overflow || x.warnings.length)" class="ad-sub">
          {{ t('storyboard.auditEmpty') }}
        </div>
        <div class="au-checks">
          <el-checkbox v-model="audit.fixAssets">{{ t('storyboard.auditFixAssets') }}</el-checkbox>
          <el-checkbox v-model="audit.fixDuration">{{ t('storyboard.auditFixDuration') }}</el-checkbox>
        </div>
      </div>
      <template #footer>
        <el-button @click="audit.open = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="audit.applying" @click="applyAuditFixes">{{ t('storyboard.auditApply') }}</el-button>
      </template>
    </el-dialog>

    <!-- 手动添加资产 -->
    <el-dialog v-model="addAsset.open" :title="t('studio.assetAdd.title')" width="min(480px, 94vw)" append-to-body>
      <div class="im-form">
        <div class="im-field">
          <label>{{ t('studio.assetAdd.kind') }}</label>
          <el-radio-group v-model="addAsset.kind">
            <el-radio-button value="character"><el-icon><User /></el-icon> {{ t('storyboard.assetKind.character') }}</el-radio-button>
            <el-radio-button value="scene"><el-icon><Picture /></el-icon> {{ t('storyboard.assetKind.scene') }}</el-radio-button>
            <el-radio-button value="prop"><el-icon><Box /></el-icon> {{ t('storyboard.assetKind.prop') }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="im-field">
          <label>{{ t('studio.assetAdd.name') }}</label>
          <el-input v-model="addAsset.name" :placeholder="t('studio.assetAdd.namePh')" maxlength="30" />
        </div>
        <div class="im-field">
          <label>{{ t('studio.assetAdd.desc') }}</label>
          <el-input v-model="addAsset.description" type="textarea" :rows="3" :placeholder="t('studio.assetAdd.descPh')" />
        </div>
      </div>
      <template #footer>
        <el-button @click="addAsset.open = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :disabled="!addAsset.name.trim()" @click="actAddAsset">{{ t('common.confirm') }}</el-button>
      </template>
    </el-dialog>

    <!-- 自定义角色 -->
    <CharacterCreatorDialog v-model="showCreator" :project-id="st.project?.id" :submitting="creatorSubmitting" @confirm="createCustomCharacter" />

    <!-- 视觉风格快捷切换弹窗（与 WorkspaceView 同款：写实/动漫页签 + 缩略图网格） -->
    <el-dialog v-model="styleDialogVisible" :title="t('workspace.style.title')" width="min(720px, 94vw)" top="8vh" append-to-body class="style-dlg">
      <div class="ad-sub style-dlg-hint">{{ t('workspace.style.hint') }}</div>
      <el-tabs v-model="activeCategory" class="style-tabs" @tab-change="onCategoryChange">
        <el-tab-pane v-for="cat in styleCategories" :key="cat.value" :name="cat.value" :label="`${cat.label} · ${cat.count}`">
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
    <el-image-viewer v-if="stylePreviewUrl" :url-list="[stylePreviewUrl]" hide-on-click-modal teleported @close="stylePreviewUrl = ''" />

    <!-- 项目全局字幕设置弹窗（对本项目所有分集的字幕烧录生效） -->
    <SubtitleSettingsDialog
      v-model="subtitleSettingsVisible"
      :project-id="st.project?.id"
      :aspect-ratio="st.project?.aspect_ratio || '9:16'"
      :subtitle="st.project?.settings?.subtitle || null"
      @updated="reloadProject"
    />

    <!-- 成员管理（团队共享，owner 专属） -->
    <MemberManagerDialog v-model="memberDialogVisible" :project-id="st.project?.id" @changed="reloadProject" />
  </div>
</template>

<style scoped>
.studio {
  /* /studio 路由 meta.hideTopbar 隐藏了全局顶栏，本页独占整屏（dvh 兜底移动端地址栏） */
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(1100px 600px at 90% -10%, var(--ad-brand-soft), transparent 60%),
    var(--ad-bg-soft);
}

/* 返回首页（项目选择左侧的金色 Home 图标） */
.rb-home {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; flex: 0 0 auto;
  border: none; border-radius: var(--ad-radius-sm);
  background: var(--ad-brand-gradient); color: var(--ad-brand-contrast);
  font-size: 16px; cursor: pointer;
  transition: filter .15s, transform .15s;
}
.rb-home:hover { filter: brightness(1.08); }
.rb-home:active { transform: scale(.96); }

/* ================= Ribbon ================= */
.rb {
  flex: 0 0 auto;
  background: var(--ad-bg-elevated);
  border-bottom: 1px solid var(--ad-border);
  box-shadow: var(--ad-shadow-xs);
  z-index: 30;
}
.rb-row1 {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px 4px;
}
.rb-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.rb-works { width: 250px; flex: 0 1 250px; min-width: 150px; }
.rb-opt-name { float: left; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
.rb-opt-ico { color: var(--ad-brand); font-size: 14px; }
.rb-opt-tag { float: right; font-size: 11px; color: var(--ad-text-muted); }
.rb-more {
  display: inline-flex; align-items: center; gap: 4px;
  height: 32px; padding: 0 8px;
  border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm);
  background: var(--ad-bg); color: var(--ad-text);
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: border-color .15s, color .15s, background .15s;
  flex: 0 0 auto;
}
.rb-more:hover { border-color: var(--ad-brand); color: var(--ad-brand); background: var(--ad-brand-soft); }

.rb-tabs { display: inline-flex; gap: 2px; flex: 0 0 auto; }
.rb-tab {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 16px;
  border: none; background: transparent;
  border-radius: var(--ad-radius-sm) var(--ad-radius-sm) 0 0;
  color: var(--ad-text-soft); font-size: 13.5px; font-weight: 700;
  font-family: var(--ad-font-body);
  cursor: pointer; transition: color .15s, background .15s;
  white-space: nowrap;
}
.rb-tab:hover:not(.disabled) { color: var(--ad-text); background: var(--ad-bg-soft); }
.rb-tab.active { color: var(--ad-brand); background: var(--ad-brand-soft); }
.rb-tab.disabled { opacity: .38; cursor: not-allowed; }
.rb-tab-done {
  display: inline-flex; color: var(--ad-success);
}
.rb-tab-done .el-icon { font-size: 12px; }
.rb-tab-next {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ad-brand);
  animation: rbPulse 1.8s ease-in-out infinite;
}
@keyframes rbPulse { 0%, 100% { opacity: .35; transform: scale(.8);} 50% { opacity: 1; transform: scale(1.15);} }

.rb-right { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.rb-tool {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  border: 1px solid transparent; border-radius: var(--ad-radius-sm);
  background: transparent; color: var(--ad-text-soft);
  font-size: 16px; cursor: pointer; transition: all .15s;
}
.rb-tool:hover, .rb-tool.on { color: var(--ad-brand); background: var(--ad-brand-soft); }
.rb-badge {
  position: absolute; top: -3px; right: -5px;
  min-width: 15px; height: 15px; padding: 0 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700;
  color: var(--ad-brand-contrast); background: var(--ad-brand);
  border-radius: 8px;
}

/* ---- 功能按钮组 ---- */
.rb-row2 {
  display: flex; align-items: stretch; gap: 0;
  padding: 4px 14px 6px;
  overflow-x: auto;
  scrollbar-width: thin;
}
.rb-group {
  display: flex; flex-direction: column; align-items: center;
  padding: 0 14px;
  border-right: 1px solid var(--ad-border);
  flex: 0 0 auto;
}
.rb-group:last-child { border-right: none; }
.rb-group-items { display: flex; align-items: stretch; gap: 4px; }
.rb-group-cap {
  margin-top: 3px;
  font-size: 10.5px; color: var(--ad-text-muted); letter-spacing: .06em;
  white-space: nowrap;
}
.rb-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  min-width: 72px; height: 54px; padding: 4px 10px;
  border: 1px solid transparent; border-radius: var(--ad-radius-sm);
  background: transparent; color: var(--ad-text);
  font-size: 12px; font-weight: 600; font-family: var(--ad-font-body);
  cursor: pointer; transition: all .15s;
  white-space: nowrap;
}
.rb-btn .el-icon { font-size: 19px; color: var(--ad-text-soft); transition: color .15s; }
.rb-btn:hover:not(:disabled) { background: var(--ad-bg-soft); border-color: var(--ad-border); }
.rb-btn:hover:not(:disabled) .el-icon { color: var(--ad-brand); }
.rb-btn:disabled { opacity: .38; cursor: not-allowed; }
.rb-btn.gold { color: var(--ad-brand); background: var(--ad-brand-soft); }
.rb-btn.gold .el-icon { color: var(--ad-brand); }
.rb-btn.gold:hover:not(:disabled) { border-color: var(--ad-brand); filter: brightness(1.03); }
.rb-danger-item { color: var(--ad-danger) !important; }

/* ================= 空状态引导 ================= */
.onboard {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 30px; padding: 24px; overflow-y: auto;
}
.ob-clapper {
  width: min(560px, 92vw);
  border: 1px solid var(--ad-border-strong);
  border-radius: var(--ad-radius-lg);
  overflow: hidden;
  background: var(--ad-bg-elevated);
  box-shadow: var(--ad-shadow-lg);
  transform: rotate(-1deg);
}
.ob-clapper-bar {
  display: flex; gap: 14px;
  height: 26px; padding: 0 14px; align-items: center;
  background: repeating-linear-gradient(-45deg, #14110c 0 16px, var(--ad-brand) 16px 32px);
}
.ob-clapper-bar i { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,.14); }
.ob-clapper-body { padding: 26px 30px 30px; text-align: center; }
.ob-scene {
  font-family: var(--ad-font-mono); font-size: 11px; letter-spacing: .3em;
  color: var(--ad-brand); text-transform: uppercase; margin-bottom: 10px;
}
.ob-title {
  margin: 0; font-family: var(--ad-font-display);
  font-size: 30px; font-weight: 700; color: var(--ad-text-strong); letter-spacing: .04em;
}
.ob-sub { margin: 10px 0 0; color: var(--ad-text-soft); font-size: 14px; line-height: 1.7; }
.ob-choices { display: flex; gap: 18px; flex-wrap: wrap; justify-content: center; }
.ob-card {
  width: min(300px, 88vw);
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  padding: 22px 22px 18px;
  border: 1px solid var(--ad-border); border-radius: var(--ad-radius-lg);
  background: var(--ad-bg-elevated);
  box-shadow: var(--ad-shadow-sm);
  cursor: pointer; text-align: left;
  transition: transform .18s, box-shadow .18s, border-color .18s;
  font-family: var(--ad-font-body);
}
.ob-card:hover { transform: translateY(-4px); box-shadow: var(--ad-shadow-hover); border-color: var(--ad-brand); }
.ob-ico { font-size: 26px; color: var(--ad-brand); }
.ob-card-title { font-family: var(--ad-font-display); font-size: 18px; font-weight: 700; color: var(--ad-text-strong); }
.ob-card-desc { font-size: 13px; color: var(--ad-text-soft); line-height: 1.65; }
.ob-card-go {
  margin-top: 4px; display: inline-flex; align-items: center; gap: 4px;
  font-size: 13px; font-weight: 700; color: var(--ad-brand);
}

/* ================= 工作区三栏 ================= */
.st-body { flex: 1; min-height: 0; display: flex; }
.side {
  width: 208px; flex: 0 0 208px;
  background: var(--ad-bg-elevated);
  border-right: 1px solid var(--ad-border);
  overflow-y: auto;
  padding: 10px 8px;
  display: flex; flex-direction: column; gap: 3px;
}
.side-cap {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 700; letter-spacing: .12em;
  color: var(--ad-text-muted); text-transform: uppercase;
  padding: 4px 8px 8px;
}
.side-cap .el-icon { font-size: 13px; color: var(--ad-brand); }
.side-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid transparent; border-radius: var(--ad-radius-sm);
  background: transparent; cursor: pointer; text-align: left; width: 100%;
  font-family: var(--ad-font-body); font-size: 13px;
  color: var(--ad-text-soft);
  transition: background .15s, color .15s;
}
.side-item:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
.side-item.active { background: var(--ad-brand-soft); color: var(--ad-brand); border-color: color-mix(in srgb, var(--ad-brand) 30%, transparent); }
.side-no {
  width: 20px; height: 20px; flex: 0 0 20px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; font-size: 11px; font-weight: 700;
  background: var(--ad-bg-soft); color: var(--ad-text-muted);
  font-variant-numeric: tabular-nums;
}
.side-item.active .side-no { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.side-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.side-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ad-border-strong); flex: 0 0 auto; }
.side-dot.done { background: var(--ad-success); }
.side-empty { padding: 18px 10px; font-size: 12px; color: var(--ad-text-muted); text-align: center; line-height: 1.6; }

.st-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* 任务面板 */
.tasks {
  width: 264px; flex: 0 0 264px;
  background: var(--ad-bg-elevated);
  border-left: 1px solid var(--ad-border);
  overflow-y: auto;
  padding: 10px 8px;
  display: flex; flex-direction: column; gap: 3px;
}
.tk-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 8px; border-radius: var(--ad-radius-sm);
}
.tk-row:hover { background: var(--ad-bg-soft); }
/* 可跳转的任务行（有面板归属）：指针 + 悬停浮出右侧箭头 */
.tk-row.go { cursor: pointer; }
.tk-go { align-self: center; flex: 0 0 auto; font-size: 13px; color: var(--ad-brand); opacity: 0; transition: opacity .15s; }
.tk-row.go:hover .tk-go { opacity: 1; }
.tk-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; background: var(--ad-border-strong); }
.tk-dot.pending { background: var(--ad-warning); animation: rbPulse 1.6s infinite; }
.tk-dot.running { background: var(--ad-brand); animation: rbPulse 1.2s infinite; }
.tk-dot.succeeded { background: var(--ad-success); }
.tk-dot.failed { background: var(--ad-danger); }
.tk-dot.cancelled { background: var(--ad-text-muted); }
.tk-main { flex: 1; min-width: 0; }
.tk-name { font-size: 12.5px; font-weight: 600; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-meta { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--ad-text-muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
.tk-ok { color: var(--ad-success); }
.tk-fail { color: var(--ad-danger); }
.tk-cancel {
  border: none; background: transparent; color: var(--ad-text-muted);
  width: 22px; height: 22px; border-radius: 50%; cursor: pointer; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
}
.tk-cancel:hover { color: var(--ad-danger); background: var(--ad-bg); }

/* ================= 状态栏（场记板） ================= */
.sb {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 14px;
  height: 46px; padding: 0 14px;
  background: var(--ad-sidebar-bg);
  border-top: 1px solid var(--ad-sidebar-border);
  color: var(--ad-sidebar-text);
}
.sb-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.sb-rec {
  width: 9px; height: 9px; border-radius: 50%;
  background: #ef4444; flex: 0 0 auto;
  animation: rbPulse 1.1s infinite;
}
.sb-summary {
  font-family: var(--ad-font-mono); font-size: 12px;
  color: var(--ad-sidebar-text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.sb-jobs { display: flex; align-items: center; gap: 12px; flex: 0 1 auto; min-width: 0; overflow: hidden; }
.sb-job { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ad-sidebar-text); white-space: nowrap; }
.sb-job .el-icon { color: var(--ad-brand); font-size: 13px; }
.sb-job-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.sb-job-pct { color: var(--ad-brand); font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; }
.sb-job-more { color: var(--ad-sidebar-text-muted); font-size: 12px; }
.sb-cta {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px; padding: 0 18px;
  border: 1px solid var(--ad-sidebar-border); border-radius: var(--ad-radius-pill);
  background: rgba(255,255,255,.06); color: var(--ad-sidebar-text-strong);
  font-size: 13px; font-weight: 700; font-family: var(--ad-font-body);
  cursor: pointer; flex: 0 0 auto;
  transition: all .18s;
  white-space: nowrap;
}
.sb-cta:hover:not(:disabled) { border-color: var(--ad-brand); color: var(--ad-brand); }
.sb-cta:disabled { opacity: .55; cursor: not-allowed; }
.sb-cta.gold {
  background: var(--ad-brand-gradient); border-color: transparent; color: var(--ad-brand-contrast);
  box-shadow: 0 2px 14px rgba(224, 182, 78, .35);
  animation: ctaBreath 2.4s ease-in-out infinite;
}
.sb-cta.gold:hover:not(:disabled) { filter: brightness(1.06); color: var(--ad-brand-contrast); }
@keyframes ctaBreath { 0%, 100% { box-shadow: 0 2px 14px rgba(224,182,78,.28);} 50% { box-shadow: 0 2px 22px rgba(224,182,78,.5);} }

/* ================= 弹窗内表单 ================= */
.im-form { display: flex; flex-direction: column; gap: 14px; }
.im-field { display: flex; flex-direction: column; gap: 6px; }
.im-field > label { font-size: 12.5px; font-weight: 700; color: var(--ad-text-soft); }
.im-field :deep(.el-radio-button .el-icon) { vertical-align: -2px; margin-right: 2px; }
.au-body { display: flex; flex-direction: column; gap: 10px; }
.au-summary { display: flex; flex-wrap: wrap; gap: 8px; }
.au-chip {
  padding: 3px 10px; border-radius: var(--ad-radius-pill);
  font-size: 12px; font-weight: 600;
  background: var(--ad-bg-soft); color: var(--ad-text-soft);
  border: 1px solid var(--ad-border);
}
.au-chip.warn { color: var(--ad-warning); border-color: color-mix(in srgb, var(--ad-warning) 40%, transparent); background: color-mix(in srgb, var(--ad-warning) 8%, transparent); }
.au-item { border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); padding: 8px 12px; }
.au-item-name { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
.au-item-row { font-size: 12.5px; color: var(--ad-text-soft); line-height: 1.6; }
.au-item-row.warn { color: var(--ad-warning); }
.au-item-row.muted { color: var(--ad-text-muted); }
.au-checks { display: flex; gap: 18px; margin-top: 4px; }

/* ================= 视觉风格切换弹窗（与 WorkspaceView 同款） ================= */
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

/* 比例弹出项里的迷你比例形：按真实宽高比绘制的矩形 */
.chip-shape {
  display: inline-block;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  flex: 0 0 auto;
  opacity: 0.85;
}
.chip-shape.is-lg { width: 22px; height: 22px; opacity: 1; }

/* ================= 响应式 ================= */
@media (max-width: 1080px) {
  .rb-works { width: 180px; flex-basis: 180px; }
  .side { width: 172px; flex-basis: 172px; }
  .tasks { width: 220px; flex-basis: 220px; }
}
@media (max-width: 900px) {
  .side { display: none; }
  .rb-tab { padding: 0 10px; }
  .rb-row2 { padding: 4px 8px 6px; }
  .rb-group { padding: 0 8px; }
}
@media (max-width: 640px) {
  .rb-works { width: 130px; flex-basis: 130px; min-width: 110px; }
  .rb-left { flex-wrap: nowrap; }
  .rb-tab span { display: none; }
  .rb-tab { padding: 0 12px; }
  .sb { gap: 8px; padding: 0 10px; }
  .sb-jobs { display: none; }
  .sb-cta { padding: 0 12px; }
  .sb-cta span:last-child { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
  .ob-choices { flex-direction: column; align-items: center; }
}
</style>

<!-- 比例气泡浮层被 teleport 到 body，需放在非 scoped 块中（同 WorkspaceView asp-popper 惯例） -->
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
