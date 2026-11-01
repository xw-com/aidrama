<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { projectApi, scriptApi, storyboardApi, assetApi, videoApi, pricingApi, modelApi, showcaseApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useJobsStore } from '../../stores/jobs';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../../components/EmptyState.vue';
import SubtitleEditorDialog from '../../components/SubtitleEditorDialog.vue';
import LazyVideo from '../../components/LazyVideo.vue';
import VideoPreview from '../../components/VideoPreview.vue';
import QRCode from 'qrcode';
import { copyText } from '../../utils/clipboard';
import { can, isOwner } from '../../utils/perms';
import { formatDuration } from '../../utils/format';

const props = defineProps({ project: Object, projectId: [String, Number] });
const emit = defineEmits(['reload']);
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { runJob } = useCostAction();
const jobs = useJobsStore();

// 团队共享权限：AI 生成（提取/分镜）与成片管理（字幕/删成片）；一键分享 owner 专属
const canGen = computed(() => can(props.project, 'ai.generate'));
const canVideo = computed(() => can(props.project, 'video.manage'));
const canEditScript = computed(() => can(props.project, 'script.edit')); // 删分集与剧本编辑同权限
const amOwner = computed(() => isOwner(props.project));

const episodes = ref([]); // 当前页分集（后端分页，每页 15 条）
const loading = ref(false);
const epLoading = ref(false); // 分集页级请求（翻页/跳转/深链定位）中的轻量态
const storyboardPricing = ref(null);

// 分集成片历史：episode_id -> [ { job_id, video_url, created_at } ]
const videosByEpisode = ref({});

// 任务页「查看结果」深链（范式同 uniapp episodes.vue）：?eid= 选中某集；?vjob= 成片 job_id →
// 定位所在集 + 高亮闪框该成片。load() 末尾消费，只消费一次
const flashJob = ref('');
let flashTimer = null;
let pendingEid = route.query.eid ? String(route.query.eid) : null;
let pendingVjob = route.query.vjob ? String(route.query.vjob) : null;

// 消费 URL 深链：先按 ?vjob= 找成片行（匹配 job_id 或 source_job_id——字幕版/剪辑版
// 派生行挂在源成片 job 上），命中则选中所在集并闪框该成片；否则按 ?eid= 选集。
// 后端分页后目标集可能不在当前页：不在当页就按 find 定位所在页重拉再选。
// 在 videos 就绪后调用（load 末尾），只消费一次
async function consumeDeepLink() {
  const wantVjob = pendingVjob;
  pendingVjob = null;
  let hitEpId = pendingEid;
  pendingEid = null;
  if (wantVjob) {
    const hit = Object.entries(videosByEpisode.value)
      .flatMap(([epId, rows]) => rows.map((v) => ({ epId, v })))
      .find((x) => String(x.v.job_id) === String(wantVjob) || String(x.v.source_job_id) === String(wantVjob));
    if (hit) {
      hitEpId = hit.epId;
      flashJob.value = String(hit.v.job_id);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashJob.value = ''; flashTimer = null; }, 2600);
    }
  }
  if (hitEpId == null) return;
  // 统一 String 比较：URL 参数是字符串，集 id 可能是数字；目标集不在当页时按 find 定位所在页
  let ep = episodes.value.find((e) => String(e.id) === String(hitEpId));
  if (!ep) {
    await loadEpisodes({ find: hitEpId });
    ep = episodes.value.find((e) => String(e.id) === String(hitEpId));
  }
  if (ep) {
    selectedId.value = ep.id;
    if (flashJob.value) {
      nextTick(() => {
        document.querySelector(`.ep-video-thumb[data-vjob="${flashJob.value}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }
}
// 大窗口预览
const previewVisible = ref(false);
const previewVideo = ref(null);

// 分镜流程的就近提示（动态文案：未提取资产 / 未生成分镜）
const warnEpId = ref(null);
const warnMsg = ref('');
let warnTimer = null;
function showWarn(epId, msg) {
  warnEpId.value = epId;
  warnMsg.value = msg;
  if (warnTimer) clearTimeout(warnTimer);
  warnTimer = setTimeout(() => { warnEpId.value = null; }, 2600);
}

// 任务驱动的 busy 状态
const isBusy = (ep) => !!jobs.activeOf('storyboard_script', ep.id);

// 左右布局：当前选中分集
const selectedId = ref(null);
const selected = computed(() => episodes.value.find((e) => e.id === selectedId.value) || null);
function selectEp(ep) { selectedId.value = ep.id; }

// ---- 分集列表后端分页（每页 15 条）----
const EP_PAGE_SIZE = 15;
const epPage = ref(1);
const epTotal = ref(0);
const epTotalPages = computed(() => Math.max(1, Math.ceil(epTotal.value / EP_PAGE_SIZE)));
const epStatusCounts = ref({}); // 全项目状态分布（服务端聚合）：引导横幅判「一集都未进分镜」

// 拉一页分集。opts.page 翻页；opts.find 按 episodeId 定位所在页（深链定位用，服务端 ceil(idx/size)）。
// 附带项目级聚合（资产/积分按分集、状态分布），映射到行内 _chars/_scenes
let epSeq = 0; // 请求序号：快速翻页时旧响应不覆盖新页
async function loadEpisodes(opts = {}) {
  const seq = ++epSeq;
  epLoading.value = true;
  try {
    const resp = await projectApi.episodesPage(props.projectId, {
      page: opts.find ? undefined : (opts.page || epPage.value),
      size: EP_PAGE_SIZE,
      find: opts.find,
    });
    if (seq !== epSeq) return null; // 已有更新的翻页请求，丢弃本次响应
    episodes.value = resp.rows || [];
    epPage.value = resp.page || 1;
    epTotal.value = resp.total || 0;
    epStatusCounts.value = resp.status_counts || {};
    const byEp = resp.asset_counts_by_episode || {};
    episodes.value.forEach((e) => {
      const b = byEp[e.id] || {};
      e._chars = b.character || 0;
      e._scenes = b.scene || 0;
    });
    return resp;
  } catch { /* 失败提示由 http 拦截器统一处理 */ return null; } finally {
    epLoading.value = false;
  }
}

// 整包拉取全部分集（批量下载、发布展示中心勾选等全量场景；列表展示仍走分页，不写 episodes）
async function fetchAllEpisodes() {
  const resp = await projectApi.episodesPage(props.projectId, { page: 1, size: 1000 });
  return resp?.rows || [];
}

// 跳转到特定集：按集号 idx 直达（idx 建集/删集时服务端保持连续 → 页码 = ceil(idx/每页条数)）
const jumpIdx = ref(null);
async function jumpToEpisode() {
  const n = Number(jumpIdx.value);
  if (!Number.isFinite(n) || n < 1 || !epTotal.value) return;
  jumpIdx.value = null; // 跳转后清空输入
  if (n > epTotal.value) {
    // 越界：收敛到最后一页选末集
    await loadEpisodes({ page: epTotalPages.value });
    const last = episodes.value[episodes.value.length - 1];
    if (last) selectedId.value = last.id;
    return;
  }
  await loadEpisodes({ page: Math.ceil(n / EP_PAGE_SIZE) });
  const ep = episodes.value.find((e) => e.idx === n)
    || episodes.value[episodes.value.length - 1]; // 极端兜底：idx 意外断档时取该页末集
  if (ep) selectedId.value = ep.id;
}

// 本集资产提取中（按 meta.episodeId 精确匹配）
const isExtracting = (ep) => jobs.items.some(
  (j) => j.type === 'asset_extract' && j.meta?.episodeId === ep.id && (j.status === 'pending' || j.status === 'running')
);

// 针对单集提取资产（异步任务）
async function extractEpisode(ep) {
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => assetApi.extractEpisodeEstimate(props.projectId, ep.id, sel),
    createFor: (sel) => assetApi.extractEpisode(props.projectId, ep.id, sel),
    title: t('episode.actions.extract.button'), desc: t('episode.jobs.extract.desc', { idx: ep.idx, title: ep.title }), confirmText: t('episode.jobs.extract.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') load(); },
  });
}

async function loadVideos() {
  try {
    const list = await videoApi.projectVideos(props.projectId);
    const map = {};
    (list || []).forEach((v) => {
      if (!map[v.episode_id]) map[v.episode_id] = [];
      map[v.episode_id].push(v);
    });
    videosByEpisode.value = map;
  } catch { /* ignore */ }
}

function epVideos(ep) {
  return videosByEpisode.value[ep.id] || [];
}

// ---- 成片加字幕（两段式：① ASR 提取 SRT 草稿 ② 字幕编辑器校对后单独「合并字幕到视频」烧录）----
// 是否已配置 asr 模型（admin 共享或本人）；无模型时无法转写，入口直接拦截提示
const asrReady = ref(false);

// 全部成片行（含字幕版），用于按 source_job_id 关联
const allVideoRows = computed(() => Object.values(videosByEpisode.value).flat());

// 展示顺序：派生成片（字幕版/剪辑版）排在其源成片之前、源成片已删的「孤儿」殿后
// （与「优先字幕版」的下载/分享口径一致；剪辑版的源也可以是字幕版 → 按 source_job_id 树状展开）
function epVideoRows(ep) {
  const rows = epVideos(ep);
  const composes = rows.filter((v) => v.kind === 'compose');
  const derived = rows.filter((v) => v.kind !== 'compose');
  const childrenOf = {}; // 源 job_id -> 派生行（按出现序）
  for (const d of derived) {
    const k = String(d.source_job_id ?? '');
    (childrenOf[k] = childrenOf[k] || []).push(d);
  }
  const out = [];
  const pushed = new Set(); // 已入列行（按 job_id）：孤儿轮递归会与「子行已按孤儿先入列」重合，判重防同一行二次入列（曾致草稿卡渲染两次）
  const pushSubtree = (v) => {
    if (pushed.has(String(v.job_id))) return;
    pushed.add(String(v.job_id));
    for (const c of (childrenOf[String(v.job_id)] || [])) pushSubtree(c); // 先派生后自身
    out.push(v);
  };
  for (const c of composes) pushSubtree(c);
  for (const d of derived) pushSubtree(d); // 孤儿（含其下游）殿后；已被上游子树收编的自动跳过
  return out;
}

// 某条成片已有的字幕版（后端已拦截同片重复提交 video.subtitle_exists，前端禁用入口是体验层防线）
function subtitlesOf(v) {
  return allVideoRows.value.filter((s) => s.kind === 'subtitle' && String(s.source_job_id) === String(v.job_id));
}
const hasSubtitle = (v) => subtitlesOf(v).length > 0;
// 该成片的字幕任务进行中（严格按 type + ref_id 匹配，避免 job id 与 episode id 数值撞号误判）
const subtitleBusy = (v) => jobs.items.some(
  (j) => j.type === 'video_subtitle' && String(j.ref_id) === String(v.job_id) && (j.status === 'pending' || j.status === 'running')
);

async function addSubtitle(v) {
  if (!asrReady.value) {
    ElMessage.warning(t('episode.videos.asrNotConfigured'));
    return;
  }
  await runJob({
    modelType: 'asr',
    estimateFor: (sel) => videoApi.subtitleEstimate(v.job_id, sel),
    createFor: (sel) => videoApi.addSubtitle(v.job_id, sel),
    title: t('episode.videos.subtitleTitle'), desc: t('episode.videos.subtitleDesc'), confirmText: t('episode.videos.subtitleConfirm'),
    onDone: (j) => { if (j.status === 'succeeded') loadVideos(); },
  });
}

// ---- 在线剪辑（独立全屏窗口；具名窗口复用，勿带 noopener——会断 postMessage）----
function openVideoEditor(v) {
  if (!v?.job_id) return;
  window.open(`/editor/video/${v.job_id}`, `aieditor_${v.job_id}`)?.focus();
}
// 剪辑窗口导出完成后回调本窗口刷新成片列表（kind 'edit' 新行）
function onEditorMessage(e) {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type === 'aieditor:exported') loadVideos();
}

function openPreview(v) {
  previewVideo.value = v;
  previewVisible.value = true;
}

// ---- 字幕编辑器（两段式第二步）----
const subtitleEditor = ref(null); // { jobId: 提取任务 id, videoUrl: 源成片（预览定位用） }
const subtitleEditorVisible = ref(false);
// 字幕行是否为「草稿」（已提取未合并，无 video_url）
const isDraft = (v) => v.kind === 'subtitle' && !v.video_url;
// 字幕行的源成片 URL（源成片已删时为空，仅影响编辑器内视频预览）
function sourceVideoUrlOf(v) {
  const src = allVideoRows.value.find((c) => c.kind !== 'subtitle' && String(c.job_id) === String(v.source_job_id));
  return src?.video_url || '';
}
function openSubtitleEditor(v) {
  subtitleEditor.value = { jobId: v.job_id, videoUrl: sourceVideoUrlOf(v) };
  subtitleEditorVisible.value = true;
}

// 删除单条成片（二次确认）：删视频文件并从列表移出；若删的是该集当前成片，后端会清空并回退状态。
// 按成片记录 id 删除（成片查询与 jobs 表解耦，Job 清理不影响成片历史），勿传 job_id
async function deleteFilm(ep, v) {
  if (!v || !v.id) return;
  try {
    await ElMessageBox.confirm(t('episode.videos.deleteConfirm'), t('episode.videos.delete'), {
      type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; } // 用户取消
  try {
    await videoApi.deleteFilm(v.id);
    ElMessage.success(t('episode.videos.deleted'));
    if (previewVisible.value) previewVisible.value = false;
    await load(); // 删除可能使该集状态由「已完成」回退，刷新分集与成片列表
  } catch {
    // 失败提示由 http 拦截器统一处理
  }
}

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 删除分集（两次确认防误删）：第一次常规确认，第二次强提示不可恢复才真正执行。
// 后端连带清理：该集剧本/分镜/成片/字幕与对应文件，删除后重新编号保证集号连续。
const deleting = ref(false);
async function removeEpisode(ep) {
  if (!ep || deleting.value) return;
  try {
    await ElMessageBox.confirm(t('episode.delete.confirm', { idx: ep.idx, title: ep.title }), t('episode.delete.title'), {
      type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'),
      confirmButtonClass: 'el-button--danger',
    });
  } catch { return; } // 用户取消
  try {
    await ElMessageBox.confirm(t('episode.delete.confirmAgain', { idx: ep.idx, title: ep.title }), t('episode.delete.titleAgain'), {
      type: 'error', confirmButtonText: t('episode.delete.confirmAgainBtn'), cancelButtonText: t('common.cancel'),
      confirmButtonClass: 'el-button--danger',
    });
  } catch { return; } // 用户取消
  deleting.value = true;
  try {
    await scriptApi.deleteEpisode(ep.id);
    ElMessage.success(t('episode.delete.deleted', { idx: ep.idx }));
    if (previewVisible.value) previewVisible.value = false;
    await load();
    emit('reload'); // 集数变化同步外层工作区
  } catch {
    // 失败提示由 http 拦截器统一处理
  } finally {
    deleting.value = false;
  }
}

// ---- 批量下载成片 ----
// 每集按展示序（字幕版在前）取首条有视频的：优先最新字幕版（须已合并烧录，草稿无 video_url 不算），
// 该成片没有字幕版/仅草稿时回退原片；只剩孤儿字幕版时同样取到 —— 与分享播放页同口径。
// 后端分页后 episodes 只有当页，批量场景（下载/发布展示中心）由调用方整包拉取传入
function downloadableEpisodes(eps) {
  return (eps || episodes.value)
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((ep) => ({ ep, video: epVideoRows(ep).find((v) => !!v.video_url) }))
    .filter((x) => !!x.video);
}

// 从 URL 提取扩展名（取不到时兜底 mp4）
function videoExt(url) {
  const m = /\.(\w{2,5})(?:$|\?|#)/.exec(url || '');
  return m ? m[1].toLowerCase() : 'mp4';
}

// 清理文件名非法字符
function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '').trim();
}

const downloading = ref(false);
async function downloadAllFilms() {
  downloading.value = true;
  try {
    // 整包拉全量分集再配成片映射（列表本身仍只持有当页）
    const items = downloadableEpisodes(await fetchAllEpisodes());
    if (!items.length) {
      ElMessage.warning(t('episode.videos.downloadNone'));
      return;
    }
    for (const { ep, video } of items) {
      const a = document.createElement('a');
      a.href = video.video_url; // 同源 /files/ 相对路径，download 属性可指定文件名
      a.download = `第${ep.idx}集-${safeFileName(ep.title) || ep.idx}.${videoExt(video.video_url)}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 逐个间隔触发，避免被浏览器判定为批量自动下载而拦截
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    ElMessage.success(t('episode.videos.downloadDone', { n: items.length }));
  } finally {
    downloading.value = false;
  }
}

// ---- 一键分享（免登录播放页 /share/:token，链接 24 小时有效）----
const sharing = ref(false);
const shareVisible = ref(false);
const shareUrl = ref('');
const shareQr = ref('');
const shareExpires = ref(''); // 本地化的到期时间文案（弹窗展示用）

function buildShareUrl(token) {
  // 用 router.resolve 生成 href 再拼 origin，避免手拼 pathname 在子路径部署下出错
  const href = router.resolve({ name: 'sharePlay', params: { token } }).href;
  return `${location.origin}${href}`;
}

// 门禁 + 取令牌（后端幂等，过期自动换发），返回分享 URL；不可分享时提示并返回 null。
// 分页后客户端不再持有全部 episode 行，门禁改为查全量成片映射（口径=有可播视频行；服务端仍会校验）
async function ensureShareUrl() {
  if (!allVideoRows.value.some((v) => v.video_url)) {
    ElMessage.warning(t('episode.share.noVideos'));
    return null;
  }
  const { token, expires_at: expiresAt } = await projectApi.ensureShare(props.projectId);
  shareExpires.value = expiresAt ? t('episode.share.expiresAt', { time: new Date(expiresAt).toLocaleString() }) : '';
  return buildShareUrl(token);
}

async function openShareDialog(url) {
  shareUrl.value = url;
  shareVisible.value = true;
  try {
    shareQr.value = await QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: '#1a1a1a', light: '#ffffff' } });
  } catch {
    shareQr.value = '';
  }
}

async function handleShare() {
  sharing.value = true;
  try {
    const url = await ensureShareUrl();
    if (!url) return;
    // 复制发生在网络请求之后（Safari 手势激活可能已过期），失败时靠弹窗内链接手动复制兜底
    const done = await copyText(t('episode.share.copyText', { name: props.project?.name || '', url }));
    if (done) ElMessage.success(t('episode.share.copied'));
    else ElMessage.warning(t('episode.share.copyFail'));
    await openShareDialog(url);
  } finally {
    sharing.value = false;
  }
}

async function copyShareLink() {
  const done = await copyText(shareUrl.value);
  if (done) ElMessage.success(t('common.copied'));
}

// ---- 发布到展示中心（owner 专属；可播分集选版口径与批量下载一致，由后端校验门禁）----
const showcasePublishedId = ref(null); // 已发布的展示记录 id（null=未发布）
const showcaseSavedDesc = ref(''); // 已保存的展示简介（再次打开弹窗时回填）
const showcaseSavedEpids = ref(null); // 已保存的勾选分集 id（null=存量记录=全部可播分集）
const showcaseStatus = ref(null); // 审核状态：pending 待审 / approved 通过 / rejected 驳回
const showcaseRejectReason = ref(''); // 驳回原因（rejected 时展示）
const showcaseDialog = ref(false);
const showcaseDesc = ref('');
const showcaseSelected = ref([]); // 本次勾选要发布的分集 id（快照语义：之后再生成的新集不会自动出现）
const publishing = ref(false);

// 可发布的分集（与批量下载同口径：每集按展示序取首条有视频的成片行）。
// 后端分页后整包分集按需拉取，打开发布弹窗时才请求
const showcaseAllEps = ref([]); // 打开发布弹窗时整包拉取的全量分集
const showcaseEpisodes = computed(() => downloadableEpisodes(showcaseAllEps.value));

async function loadShowcaseStatus() {
  if (!amOwner.value) return;
  try {
    const st = await showcaseApi.status(props.projectId);
    showcasePublishedId.value = st.id || null;
    showcaseSavedDesc.value = st.description || '';
    showcaseSavedEpids.value = Array.isArray(st.episode_ids) ? st.episode_ids.map(Number) : null;
    showcaseStatus.value = st.status || null;
    showcaseRejectReason.value = st.reject_reason || '';
  } catch { /* ignore */ }
}

async function openShowcaseDialog() {
  // 整包拉全量分集（勾选列表与全选口径跨页）；失败时弹窗仍开，但列表为空、发布会被 noSelection 拦下
  showcaseAllEps.value = await fetchAllEpisodes().catch(() => []);
  // 已发布过则带出原简介与原勾选（发布接口幂等：重复发布=更新简介与勾选分集）
  showcaseDesc.value = showcaseSavedDesc.value;
  const all = showcaseEpisodes.value.map((x) => x.ep.id);
  const saved = Array.isArray(showcaseSavedEpids.value)
    ? [...new Set(showcaseSavedEpids.value.filter((id) => all.includes(Number(id))))]
    : null;
  showcaseSelected.value = saved && saved.length ? saved : all; // 勾选已全部失效时回退全选
  showcaseDialog.value = true;
}

const showcaseAllChecked = computed({
  get: () => showcaseEpisodes.value.length > 0 && showcaseSelected.value.length === showcaseEpisodes.value.length,
  set: (v) => { showcaseSelected.value = v ? showcaseEpisodes.value.map((x) => x.ep.id) : []; },
});
const showcaseIndeterminate = computed(() =>
  showcaseSelected.value.length > 0 && showcaseSelected.value.length < showcaseEpisodes.value.length);

async function publishToShowcase() {
  if (!showcaseSelected.value.length) return ElMessage.warning(t('showcase.noSelection'));
  publishing.value = true;
  try {
    const { id, status } = await showcaseApi.publish(props.projectId, showcaseDesc.value.trim(), showcaseSelected.value);
    showcasePublishedId.value = id;
    showcaseSavedDesc.value = showcaseDesc.value.trim();
    showcaseSavedEpids.value = [...showcaseSelected.value];
    showcaseStatus.value = status || 'pending';
    showcaseRejectReason.value = '';
    showcaseDialog.value = false;
    ElMessage.success(t('showcase.submitted'));
  } finally {
    publishing.value = false;
  }
}

// 取消发布（下架）：发布弹窗内直接操作，不必去展示中心
async function unpublishToShowcase() {
  try {
    await ElMessageBox.confirm(t('showcase.unpublishConfirm'), t('showcase.unpublish'), {
      type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; }
  await showcaseApi.remove(showcasePublishedId.value);
  showcasePublishedId.value = null;
  showcaseSavedDesc.value = '';
  showcaseSavedEpids.value = null;
  showcaseStatus.value = null;
  showcaseRejectReason.value = '';
  showcaseDialog.value = false;
  ElMessage.success(t('showcase.removed'));
}

function goShowcase() {
  showcaseDialog.value = false;
  router.push({ name: 'showcase' });
}

async function load() {
  loading.value = true;
  try {
    // 四个请求相互独立，并行发出（原先串行瀑布，工作台第 3 步打开明显偏慢）
    const [, , pricingList, asrModels] = await Promise.all([
      loadEpisodes(), // 后端分页：只拉当前页（首帧 page 1；深链目标不在当页时 consumeDeepLink 会按 find 重拉）
      loadVideos(),
      pricingApi.list().catch(() => null),
      modelApi.list('asr', { enabledOnly: true }).catch(() => null),
    ]);
    loadShowcaseStatus(); // 展示中心发布状态（owner；尽力而为，不阻塞加载）
    storyboardPricing.value = (pricingList || []).find((x) => x.feature === 'storyboard_script') || null;
    asrReady.value = ((asrModels || []).filter((m) => m.enabled !== false)).length > 0;
    await consumeDeepLink();
  } finally {
    loading.value = false;
  }
}

// 合成/字幕/剪辑任务完成时自动刷新成片列表（仅当成片数实际增长时拉取，避免重复请求）
const succeededVideoIds = computed(() =>
  jobs.items
    .filter((j) => ['video_synthesis', 'video_subtitle', 'video_edit'].includes(j.type) && j.status === 'succeeded' && String(j.project_id) === String(props.projectId))
    .map((j) => j.id)
    .sort((a, b) => a - b)
    .join(',')
);
let _lastSeenIds = succeededVideoIds.value;
watch(succeededVideoIds, (cur) => {
  if (cur && cur !== _lastSeenIds) {
    _lastSeenIds = cur;
    loadVideos();
  }
});

// 生成分镜脚本（异步任务）
async function genStoryboard(ep) {
  if (!hasAssets(ep)) {
    showWarn(ep.id, t('episode.warn.extractFirst'));
    return;
  }
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => storyboardApi.genStoryboardEstimate(ep.id, sel),
    createFor: (sel) => storyboardApi.genStoryboard(ep.id, sel),
    allowRequirement: true, // 「本次要求」追加到分镜生成提示词（与生成提示词入口一致）
    title: t('episode.jobs.storyboard.title'), desc: t('episode.jobs.storyboard.desc', { title: ep.title }), confirmText: t('episode.jobs.storyboard.confirm'),
    // 完成后不自动跳转：全局完成 toast 提示，就地刷新状态（生成分镜 → 进入编辑）
    onDone: (j) => { if (j.status === 'succeeded') load(); },
  });
}

function openEditor(ep) {
  if (!hasStoryboard(ep)) {
    showWarn(ep.id, t('episode.warn.storyboardFirst'));
    return;
  }
  router.push({ name: 'storyboard', params: { id: props.projectId, eid: ep.id } });
}

const sbHint = computed(() => {
  if (!storyboardPricing.value) return '';
  return t('episode.sbHint', {
    unit: storyboardPricing.value.unit,
    unitDesc: storyboardPricing.value.unit_desc,
    credits: storyboardPricing.value.credits_per_unit,
  });
});

function statusLabel(s) {
  return ({
    draft: t('episode.status.pending'),
    outline: t('episode.status.pending'),
    assets: t('episode.status.pending'),
    storyboard: t('episode.status.storyboardReady'),
    video: t('episode.status.videoSynthesizing'),
    done: t('episode.status.done'),
  })[s] || t('episode.status.pending');
}
// 状态对应的标签配色
function statusChip(s) {
  if (s === 'done') return 'chip-success';
  if (['storyboard', 'video'].includes(s)) return 'chip-accent';
  return '';
}
// 分镜是否已生成（storyboard 及之后的阶段都算）→ 用于切换“生成分镜 / 重新生成分镜”
function hasStoryboard(ep) {
  return ['storyboard', 'video', 'done'].includes(ep.status);
}
// 该集是否已提取资产（assets 及之后的阶段都算）→ 控制分镜生成门禁
function hasAssets(ep) {
  return ['assets', 'storyboard', 'video', 'done'].includes(ep.status);
}

// 默认选中第一集
watch(episodes, (list) => {
  if (list.length && !list.find((e) => e.id === selectedId.value)) selectedId.value = list[0].id;
}, { immediate: true });

onMounted(() => {
  load();
  jobs.fetchAll(); // 同步任务列表，用于监听合成完成自动刷新
  window.addEventListener('message', onEditorMessage); // 剪辑窗口导出完成回调
});
onUnmounted(() => {
  if (flashTimer) clearTimeout(flashTimer);
  window.removeEventListener('message', onEditorMessage);
});
</script>

<template>
  <div class="ad-container eps" v-loading="loading">
    <div class="ad-flex-between head" style="flex-wrap: wrap; gap: 12px;">
      <div>
        <div class="ad-title-lg">{{ t('episode.page.title') }}</div>
        <div class="ad-sub">{{ t('episode.page.count', { n: epTotal }) }}<span v-if="sbHint"> · {{ sbHint }}</span></div>
      </div>
      <div class="ad-flex-center ad-gap-sm">
        <el-button @click="load"><el-icon><Refresh /></el-icon> {{ t('episode.refresh') }}</el-button>
        <!-- 一键分享为对外曝光开关，仅项目创建者可见 -->
        <el-button v-if="amOwner" :loading="sharing" :disabled="downloading" @click="handleShare">
          <el-icon><Share /></el-icon> {{ t('episode.share.action') }}
        </el-button>
        <!-- 发布到展示中心（owner 专属；已发布时显示标记，点击可改简介；审核中/被驳回带状态提示） -->
        <el-button v-if="amOwner" :loading="publishing" :disabled="downloading" @click="openShowcaseDialog">
          <el-icon><Film /></el-icon>
          {{ showcaseStatus === 'pending' ? t('showcase.statusPending')
            : showcaseStatus === 'rejected' ? t('showcase.statusRejected')
            : showcasePublishedId ? t('showcase.publishedAction') : t('showcase.publishAction') }}
        </el-button>
        <el-button v-if="amOwner && showcasePublishedId" link type="primary" @click="goShowcase">
          {{ t('showcase.goShowcase') }}
        </el-button>
        <el-button type="primary" class="btn-ink" :loading="downloading" :disabled="downloading" @click="downloadAllFilms">
          <el-icon><Download /></el-icon> {{ t('episode.videos.downloadAll') }}
        </el-button>
      </div>
    </div>

    <div v-if="epTotal && !(['storyboard', 'video', 'done']).some((s) => (epStatusCounts[s] || 0) > 0)" class="guide-banner">
      <el-icon class="gb-icon"><InfoFilled /></el-icon>
      <div class="gb-text">
        <div class="gb-title">{{ t('episode.guide.title') }}</div>
        <div class="gb-sub">{{ t('episode.guide.desc') }}</div>
      </div>
    </div>

    <!-- 左右布局：左分集列表 / 右详情 -->
    <div v-if="episodes.length" class="md-layout">
      <!-- 左：分集列表 -->
      <aside v-loading="epLoading" class="md-list">
        <div class="md-list-head">
          <span class="ad-title"><el-icon><Film /></el-icon> {{ t('episode.list.title') }}</span>
          <span class="ad-muted md-list-count">{{ t('episode.list.count', { n: epTotal }) }}</span>
        </div>
        <div class="md-list-body">
          <div
            v-for="ep in episodes"
            :key="ep.id"
            class="md-item"
            :class="{ active: ep.id === selectedId }"
            role="button"
            tabindex="0"
            @click="selectEp(ep)"
            @keydown.enter.prevent="selectEp(ep)"
          >
            <span class="ep-no">{{ ep.idx }}</span>
            <span class="md-item-main">
              <span class="md-item-title">{{ ep.title }}</span>
              <span class="md-item-meta">
                <span class="chip mini" :class="statusChip(ep.status)">{{ statusLabel(ep.status) }}</span>
                <span>{{ t('episode.characters') }} {{ ep._chars || 0 }} · {{ t('episode.scenes') }} {{ ep._scenes || 0 }}</span>
              </span>
            </span>
          </div>
        </div>
        <!-- 分页 + 跳转（后端分页；仅超过一页时出现） -->
        <div v-if="epTotal > EP_PAGE_SIZE" class="md-list-foot">
          <el-pagination
            v-model:current-page="epPage"
            :page-size="EP_PAGE_SIZE"
            :total="epTotal"
            :pager-count="5"
            layout="prev, pager, next"
            size="small"
            background
            @current-change="() => loadEpisodes()"
          />
          <div class="md-jump">
            <el-input-number
              v-model="jumpIdx"
              :min="1"
              :max="epTotal"
              :controls="false"
              size="small"
              class="md-jump-input"
              :placeholder="t('episode.list.jumpPlaceholder')"
              @keyup.enter="jumpToEpisode"
            />
            <el-button size="small" text type="primary" @click="jumpToEpisode">{{ t('episode.list.jumpGo') }}</el-button>
          </div>
        </div>
      </aside>

      <!-- 右：分集详情 -->
      <section class="md-detail ad-card">
        <template v-if="selected">
          <div class="md-detail-head">
            <div class="md-detail-title">
              <span class="ep-no lg">{{ selected.idx }}</span>
              <div class="md-detail-title-text">
                <span class="ad-title-lg">{{ selected.title }}</span>
                <span class="md-meta">
                  <span class="chip" :class="statusChip(selected.status)">{{ statusLabel(selected.status) }}</span>
                  <span class="md-dot">·</span>{{ t('episode.characters') }} {{ selected._chars || 0 }}
                  <span class="md-dot">·</span>{{ t('episode.scenes') }} {{ selected._scenes || 0 }}
                </span>
              </div>
            </div>
            <!-- 删除分集：两次确认防误删；提取/分镜任务进行中先禁用 -->
            <el-button
              v-if="canEditScript" class="ep-del-btn" text type="danger"
              :loading="deleting" :disabled="isBusy(selected) || isExtracting(selected)"
              @click="removeEpisode(selected)"
            >
              <el-icon><Delete /></el-icon> {{ t('common.delete') }}
            </el-button>
          </div>

          <div class="md-detail-body">
            <!-- 本集提取进度 -->
            <div v-if="isExtracting(selected)" class="ep-inline-progress">
              <el-icon class="is-loading"><Loading /></el-icon>
              <span>{{ t('episode.extracting.progress') }}</span>
            </div>

            <!-- 操作卡 -->
            <div class="ep-actions">
              <div class="ep-action-card">
                <div class="ep-action-icon"><el-icon><Box /></el-icon></div>
                <div class="ep-action-text">
                  <div class="ep-action-title">{{ t('episode.actions.extract.title') }}</div>
                  <div class="ep-action-desc">{{ t('episode.actions.extract.desc') }}</div>
                </div>
                <el-button v-if="canGen" type="primary" class="btn-ink" :loading="isExtracting(selected)" :disabled="isExtracting(selected)" @click="extractEpisode(selected)">
                  <el-icon><MagicStick /></el-icon> {{ t('episode.actions.extract.button') }}
                </el-button>
              </div>

              <div class="ep-action-card">
                <div class="ep-action-icon"><el-icon><Film /></el-icon></div>
                <div class="ep-action-text">
                  <div class="ep-action-title">{{ t('episode.actions.storyboard.title') }}</div>
                  <div class="ep-action-desc">
                    <template v-if="!hasAssets(selected)">{{ t('episode.actions.storyboard.descNoAssets') }}</template>
                    <template v-else-if="hasStoryboard(selected)">{{ t('episode.actions.storyboard.descHasStoryboard') }}</template>
                    <template v-else>{{ t('episode.actions.storyboard.descReady') }}</template>
                  </div>
                </div>
                <div class="ep-action-ops">
                  <el-button v-if="canGen" plain :loading="isBusy(selected)" :disabled="isBusy(selected)" @click="genStoryboard(selected)">
                    <el-icon><MagicStick /></el-icon> {{ hasStoryboard(selected) ? t('episode.actions.storyboard.regenerate') : t('episode.actions.storyboard.generate') }}
                  </el-button>
                  <button class="ep-enter-btn" :disabled="isBusy(selected)" @click="openEditor(selected)">
                    <span>{{ t('episode.actions.storyboard.enter') }}</span><el-icon class="ep-enter-arrow"><ArrowRight /></el-icon>
                  </button>
                </div>
              </div>
            </div>

            <!-- 分镜未生成就近提示 -->
            <transition name="ep-warn">
              <div v-if="warnEpId === selected.id" class="ep-warn-hint">
                <el-icon><WarningFilled /></el-icon>
                <span>{{ warnMsg }}</span>
              </div>
            </transition>

            <!-- 成片（合成成片 + 其字幕版） -->
            <div v-if="epVideos(selected).length" class="ep-videos">
              <div class="ep-videos-title">
                <span class="label">{{ t('episode.videos.title') }}</span>
                <span class="count">{{ epVideos(selected).length }}</span>
              </div>
              <div class="ep-videos-grid">
                <div
                  v-for="v in epVideoRows(selected)"
                  :key="v.job_id"
                  class="ep-video-thumb"
                  :class="{ draft: isDraft(v), flash: flashJob === String(v.job_id) }"
                  :data-vjob="v.job_id"
                  @click="isDraft(v) ? openSubtitleEditor(v) : openPreview(v)"
                >
                  <!-- 草稿（已提取未合并）：无视频，文档占位；完整字幕版：视频预览 -->
                  <div v-if="isDraft(v)" class="ep-video-draft">
                    <el-icon :size="34"><Document /></el-icon>
                    <span>{{ t('episode.videos.draftBadge') }}</span>
                  </div>
                  <template v-else>
                    <!-- 成片封面（第一帧 480P webp）优先：一张小图替代 video 元素；旧数据无封面回退视频预览 -->
                    <img v-if="v.cover_url" class="ep-video-cover" :src="v.cover_url" alt="" loading="lazy" />
                    <LazyVideo v-else :src="v.video_url" />
                    <div class="ep-video-overlay">
                      <el-icon><VideoPlay /></el-icon>
                    </div>
                  </template>
                  <!-- 字幕版/草稿/剪辑版角标 -->
                  <span v-if="v.kind === 'subtitle' || v.kind === 'edit'" class="ep-video-badge">
                    {{ v.kind === 'edit' ? t('episode.videos.editBadge') : (isDraft(v) ? t('episode.videos.draftBadge') : t('episode.videos.subtitleBadge')) }}
                  </span>
                  <!-- 分辨率角标（右上）：合成/剪辑版成片的输出档位（字幕版继承源片分辨率，不标） -->
                  <span v-if="v.resolution && v.kind !== 'subtitle'" class="ep-video-badge ep-video-badge-res">{{ v.resolution }}</span>
                  <!-- 底部操作行：下载本片 / 编辑字幕或加字幕 / 在线剪辑 —— 横排一行，底对齐留间距 -->
                  <div class="ep-video-actions">
                    <a
                      v-if="v.video_url"
                      class="ep-video-dl"
                      :title="t('episode.videos.downloadVideo')"
                      :href="v.video_url"
                      :download="`${safeFileName(selected.title) || selected.idx}.mp4`"
                      @click.stop
                    >
                      <el-icon><Download /></el-icon>
                    </a>
                    <!-- 字幕行：编辑字幕（改词/对时间后单独「合并字幕到视频」）；无权限时仍可打开查看（编辑器内只读） -->
                    <button
                      v-if="v.kind === 'subtitle'"
                      class="ep-video-cc"
                      :class="{ busy: subtitleBusy(v) }"
                      :disabled="subtitleBusy(v)"
                      :title="subtitleBusy(v) ? t('episode.videos.subtitleRunning') : t('episode.videos.editSubtitle')"
                      @click.stop.prevent="openSubtitleEditor(v)"
                    >
                      <el-icon :size="16"><Edit /></el-icon>
                    </button>
                    <!-- 原片/剪辑版：提取字幕入口（合成版与剪辑版同权；在途/已有字幕时禁用；需成片管理权限） -->
                    <button
                      v-if="(v.kind === 'compose' || v.kind === 'edit') && canVideo"
                      class="ep-video-cc"
                      :class="{ busy: subtitleBusy(v) || hasSubtitle(v) }"
                      :disabled="subtitleBusy(v) || hasSubtitle(v)"
                      :title="subtitleBusy(v) ? t('episode.videos.subtitleRunning') : (hasSubtitle(v) ? t('episode.videos.subtitled') : t('episode.videos.addSubtitle'))"
                      @click.stop.prevent="addSubtitle(v)"
                    >
                      <span class="cc-mark">CC</span>
                    </button>
                    <!-- 在线剪辑入口：独立全屏窗口（合成/字幕版/剪辑版都可再剪；需成片管理权限） -->
                    <button
                      v-if="v.video_url && canVideo"
                      class="ep-video-cut"
                      :title="t('episode.videos.editVideo')"
                      @click.stop.prevent="openVideoEditor(v)"
                    >
                      <el-icon :size="15"><Scissor /></el-icon>
                    </button>
                  </div>
                  <button
                    v-if="canVideo"
                    class="ep-video-del"
                    :title="t('episode.videos.delete')"
                    @click.stop.prevent="deleteFilm(selected, v)"
                  >
                    <el-icon><Delete /></el-icon>
                  </button>
                  <div class="ep-video-time">{{ formatTime(v.created_at) }}</div>
                </div>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="md-detail-empty">
          <div class="empty-emoji">🎬</div>
          <div class="ad-title">{{ t('episode.empty.selectTitle') }}</div>
          <div class="ad-sub" style="margin-top:6px;">{{ t('episode.empty.selectDesc') }}</div>
        </div>
      </section>
    </div>

    <EmptyState
      v-else
      class="ad-card"
      icon="🎬"
      :title="t('episode.empty.noEpisodesTitle')"
      :description="t('episode.empty.noEpisodesDesc')"
      :action-label="t('episode.empty.goToOutline')"
      @action="router.push({ path: `/projects/${projectId}`, query: { step: '1' } })"
    />

    <!-- 大窗口预览 -->
    <!-- 字幕编辑器（两段式：提取完成后校对/修改，再「合并字幕到视频」） -->
    <SubtitleEditorDialog
      v-if="subtitleEditor"
      v-model="subtitleEditorVisible"
      :job-id="subtitleEditor.jobId"
      :video-url="subtitleEditor.videoUrl"
      :project-id="projectId"
      :aspect-ratio="project?.aspect_ratio || '9:16'"
      :subtitle="project?.settings?.subtitle || null"
      :readonly="!canVideo"
      @done="loadVideos"
      @style-updated="emit('reload')"
    />

    <el-dialog v-model="previewVisible" width="min(960px, 92vw)" top="6vh" :show-close="true" append-to-body destroy-on-close>
      <template #header>
        <div class="preview-head">
          <el-icon><Film /></el-icon>
          <span>{{ t('episode.videos.preview') }}</span>
          <span class="preview-time">{{ formatTime(previewVideo?.created_at) }}</span>
        </div>
      </template>
      <div v-if="previewVideo" class="preview-body">
        <!-- 统一走 VideoPreview（组件内处理空源/播放态），不再裸挂 autoplay video（浏览器会拦自动播放） -->
        <VideoPreview :src="previewVideo.video_url" />
      </div>
    </el-dialog>

    <!-- 一键分享：链接 + 二维码 -->
    <el-dialog v-model="shareVisible" width="min(360px, 94vw)" align-center append-to-body>
      <template #header>
        <div class="share-head">
          <el-icon><Share /></el-icon>
          <span>{{ t('episode.share.title') }}</span>
        </div>
      </template>
      <div class="share-body">
        <div class="share-name">《{{ project?.name }}》</div>
        <div class="share-url" :title="shareUrl">{{ shareUrl }}</div>
        <div v-if="shareQr" class="share-qr"><img :src="shareQr" alt="QR" /></div>
        <div class="ad-sub share-tip">{{ t('episode.share.qrTip') }}</div>
        <div v-if="shareExpires" class="ad-sub share-expire">{{ shareExpires }}</div>
        <el-button type="primary" class="btn-ink share-copy" @click="copyShareLink">
          <el-icon><DocumentCopy /></el-icon> {{ t('episode.share.copyLink') }}
        </el-button>
      </div>
    </el-dialog>

    <!-- 发布到展示中心：简介 + 勾选分集（全选/单选）+ 发布/更新/取消发布 -->
    <el-dialog v-model="showcaseDialog" width="min(520px, 94vw)" align-center append-to-body>
      <template #header>
        <div class="share-head">
          <el-icon><Film /></el-icon>
          <span>{{ t('showcase.publishTitle') }}</span>
        </div>
      </template>
      <div class="showcase-body">
        <div class="ad-sub">{{ t('showcase.publishDesc') }}</div>
        <!-- 审核状态行：发布/修改后进入人工审核，通过才公开可见 -->
        <div v-if="showcaseStatus" class="showcase-status">
          <el-tag v-if="showcaseStatus === 'pending'" type="warning" effect="plain" size="small">{{ t('showcase.statusPending') }}</el-tag>
          <el-tag v-else-if="showcaseStatus === 'approved'" type="success" effect="plain" size="small">{{ t('showcase.statusApproved') }}</el-tag>
          <el-tag v-else type="danger" effect="plain" size="small">{{ t('showcase.statusRejected') }}</el-tag>
          <span v-if="showcaseStatus === 'pending'" class="ad-sub">{{ t('showcase.reviewTip') }}</span>
          <span v-else-if="showcaseStatus === 'rejected' && showcaseRejectReason" class="ad-sub">{{ t('showcase.rejectReason') }}：{{ showcaseRejectReason }}</span>
        </div>
        <el-input
          v-model="showcaseDesc" type="textarea" :rows="3" maxlength="500" show-word-limit
          :placeholder="t('showcase.descriptionPlaceholder')"
        />
        <div class="showcase-eps">
          <div class="showcase-eps-head">
            <span>{{ t('showcase.selectEpisodes') }}</span>
            <el-checkbox v-model="showcaseAllChecked" :indeterminate="showcaseIndeterminate">
              {{ t('showcase.selectAll') }}（{{ showcaseSelected.length }}/{{ showcaseEpisodes.length }}）
            </el-checkbox>
          </div>
          <el-checkbox-group v-model="showcaseSelected" class="showcase-eps-list">
            <el-checkbox v-for="{ ep, video } in showcaseEpisodes" :key="ep.id" :value="ep.id" class="showcase-ep-item">
              <span class="showcase-ep-label">
                <span class="showcase-ep-title">{{ t('asset.episodeLabel', { idx: ep.idx, title: ep.title }) }}</span>
                <span class="showcase-ep-dur">{{ formatDuration(video?.duration) }}</span>
              </span>
            </el-checkbox>
          </el-checkbox-group>
        </div>
        <div class="showcase-foot">
          <el-button v-if="showcasePublishedId" @click="goShowcase">
            {{ t('showcase.viewShowcase') }}
          </el-button>
          <el-button v-if="showcasePublishedId" type="danger" plain @click="unpublishToShowcase">
            {{ t('showcase.unpublish') }}
          </el-button>
          <el-button type="primary" class="btn-ink" :loading="publishing" @click="publishToShowcase">
            {{ showcasePublishedId ? (showcaseStatus === 'pending' ? t('showcase.resubmit') : t('showcase.update')) : t('showcase.publish') }}
          </el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.eps { max-width: 1280px; }
.head { margin-bottom: 24px; }
.guide-banner {
  display: flex; align-items: center; gap: 14px;
  padding: 16px 20px; margin-bottom: 20px;
  background: linear-gradient(90deg, var(--ad-brand-soft), transparent 80%);
  border: 1px solid var(--ad-border); border-left: 3px solid var(--ad-brand);
  border-radius: var(--ad-radius);
}
.gb-icon { font-size: 22px; color: var(--ad-brand); flex: 0 0 auto; }
.gb-text { display: flex; flex-direction: column; gap: 2px; }
.gb-title { font-size: 14px; font-weight: 700; color: var(--ad-text); }
.gb-sub { font-size: 13px; color: var(--ad-text-soft); line-height: 1.6; }
/* 左右布局 */
.md-layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; align-items: stretch; }
.md-list {
  display: flex; flex-direction: column;
  background: var(--ad-bg-elevated); border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius); box-shadow: var(--ad-shadow);
  overflow: hidden; min-height: 420px;
}
.md-list-head { padding: 14px 16px; border-bottom: 1px solid var(--ad-border); display: flex; align-items: center; justify-content: space-between; }
.md-list-count { font-size: 12px; }
.md-list-body { display: flex; flex-direction: column; gap: 4px; padding: 8px; overflow-y: auto; max-height: 600px; }
/* 列表底部分页 + 跳转（每页 15 集） */
.md-list-foot {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 8px 10px; border-top: 1px solid var(--ad-border); flex-shrink: 0;
}
.md-jump { display: flex; align-items: center; gap: 4px; }
.md-jump .md-jump-input { width: 76px; }
.md-jump .md-jump-input :deep(.el-input__inner) { text-align: center; }
.md-item {
  display: flex; align-items: center; gap: 10px; padding: 12px;
  border: 1px solid transparent; border-radius: var(--ad-radius-sm);
  background: transparent; cursor: pointer; text-align: left; 
  transition: all 0.15s;
}
.md-item:hover { background: var(--ad-bg-soft); }
.md-item.active { background: var(--ad-brand-soft); border-color: var(--ad-brand); }
.md-item-main { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 4px; }
.md-item-title { font-weight: 600; color: var(--ad-text); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-item-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.chip.mini { font-size: 11px; padding: 1px 7px; border-radius: 999px; }

.md-detail { display: flex; flex-direction: column; padding: 24px 28px; min-height: 420px; }
.md-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--ad-border); }
.ep-del-btn { flex-shrink: 0; margin-top: 4px; }
.md-detail-title { display: flex; align-items: center; gap: 14px; }
.md-detail-title-text { display: flex; flex-direction: column; gap: 4px; }
.md-meta { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ad-text-muted); }
.md-dot { margin: 0 2px; opacity: 0.6; }
.md-detail-body { padding-top: 18px; flex: 1; display: flex; flex-direction: column; gap: 16px; }
.md-detail-empty { text-align: center; padding: 60px 20px; margin: auto; }
.md-detail-empty .empty-emoji { font-size: 44px; }

/* 集号圆标 */
.ep-no { display: inline-flex; width: 24px; height: 24px; border-radius: 50%; background: var(--ad-brand); color: var(--ad-brand-contrast); align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.ep-no.lg { width: 36px; height: 36px; font-size: 15px; box-shadow: 0 4px 12px var(--ad-brand-soft); }

/* 本集提取进度（行内） */
.ep-inline-progress { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; font-size: 13px; color: var(--ad-text-soft); background: var(--ad-bg-soft); border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); width: fit-content; }

/* 操作卡 */
.ep-actions { display: flex; flex-direction: column; gap: 12px; }
.ep-action-card { display: flex; align-items: center; gap: 14px; padding: 16px 18px; background: var(--ad-bg-soft); border: 1px solid var(--ad-border); border-radius: var(--ad-radius); }
.ep-action-icon { width: 42px; height: 42px; border-radius: var(--ad-radius-md); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--ad-brand-contrast); background: var(--ad-brand); }
.ep-action-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ep-action-title { font-size: 15px; font-weight: 700; color: var(--ad-text); }
.ep-action-desc { font-size: 12px; color: var(--ad-text-muted); line-height: 1.55; }
.ep-action-ops { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

/* 进入分镜编辑器 —— 主 CTA，醒目大按钮 */
.ep-enter-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 11px 22px;
  font-size: 15px; font-weight: 700; line-height: 1; white-space: nowrap;
  color: var(--ad-brand-contrast);
  background: linear-gradient(135deg, var(--ad-brand), var(--ad-brand-600));
  border: none; border-radius: var(--ad-radius);
  cursor: pointer;
  box-shadow: 0 6px 16px var(--ad-brand-soft);
  transition: transform 0.15s, box-shadow 0.15s, filter 0.15s;
}
.ep-enter-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 9px 22px var(--ad-gold-soft);
  filter: brightness(1.06);
}
.ep-enter-btn:active:not(:disabled) { transform: translateY(0); box-shadow: 0 4px 10px var(--ad-brand-soft); }
.ep-enter-btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
.ep-enter-btn .ep-enter-arrow { font-size: 16px; transition: transform 0.15s; }
.ep-enter-btn:hover:not(:disabled) .ep-enter-arrow { transform: translateX(3px); }

/* 分镜未生成就近提示 */
.ep-warn-hint {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: 12px; padding: 7px 12px;
  font-size: 13px; color: var(--ad-warning);
  background: rgba(251, 191, 36, 0.14);
  border: 1px solid color-mix(in srgb, var(--ad-warning) 40%, transparent);
  border-radius: var(--ad-radius-sm);
  width: fit-content;
}
.ep-warn-hint .el-icon { font-size: 15px; }
.ep-warn-enter-active, .ep-warn-leave-active { transition: opacity 0.2s, transform 0.2s; }
.ep-warn-enter-from, .ep-warn-leave-to { opacity: 0; transform: translateY(-4px); }

.empty { text-align: center; padding: 56px 20px; }
.empty-emoji { font-size: 44px; margin-bottom: 6px; }

/* 成片列表 */
.ep-videos { margin-top: 18px; padding-top: 16px; border-top: 1px dashed var(--ad-border); }
.ep-videos-title { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.ep-videos-title .label { font-size: 13px; font-weight: 600; color: var(--ad-text-soft); }
.ep-videos-title .count {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
  background: var(--ad-bg-soft); color: var(--ad-text-soft);
  font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
}
.ep-videos-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.ep-video-thumb {
  position: relative; width: 148px; height: 92px; border-radius: var(--ad-radius-sm); overflow: hidden;
  background: #000; cursor: pointer; border: 1px solid var(--ad-border);
  transition: transform 0.15s, box-shadow 0.15s;
}
.ep-video-thumb:hover { transform: translateY(-2px); box-shadow: var(--ad-shadow-hover); }
/* 深链命中成片闪框（任务中心「查看结果」定位提示，同 uniapp episodes 2.6s 消费） */
.ep-video-thumb.flash { animation: ep-video-flash 0.9s ease-in-out 3; }
@keyframes ep-video-flash {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 0 3px var(--ad-accent); }
}
.ep-video-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 封面图（第一帧 480P webp）：与 video 同口径铺满缩略框 */
.ep-video-cover { width: 100%; height: 100%; object-fit: cover; display: block; }
.ep-video-overlay {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 28px; background: rgba(0,0,0,0.22); transition: background 0.15s;
}
.ep-video-thumb:hover .ep-video-overlay { background: rgba(0,0,0,0.38); }
.ep-video-time {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 8px; font-size: 11px; color: #fff;
  background: linear-gradient(transparent, rgba(0,0,0,0.72)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ep-video-del {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: #fff; cursor: pointer;
  background: rgba(0,0,0,0.45); backdrop-filter: blur(4px);
  opacity: 0; transition: opacity 0.15s, background 0.15s, transform 0.15s;
}
.ep-video-thumb:hover .ep-video-del { opacity: 1; }
.ep-video-del:hover { background: rgba(220, 38, 38, 0.92); transform: scale(1.06); }
/* 字幕版角标（常显，左上） */
.ep-video-badge {
  position: absolute; top: 6px; left: 6px; z-index: 2;
  padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 700; color: var(--ad-brand-contrast);
  background: var(--ad-brand); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
/* 分辨率角标（右上，中性深色，与左上类型角标区分） */
.ep-video-badge.ep-video-badge-res { left: auto; right: 6px; background: rgba(126, 126, 126, 0.78); font-weight: 600; }
/* 底部操作行：下载本片 / 编辑·加字幕 / 在线剪辑 横排右对齐，底对齐留 6px 间距（压在时间条渐变上） */
.ep-video-actions {
  position: absolute; right: 6px; bottom: 6px; z-index: 2;
  display: flex; align-items: center; gap: 5px;
}
.ep-video-actions > * { opacity: 0; transition: opacity 0.15s, background 0.15s, transform 0.15s; }
.ep-video-thumb:hover .ep-video-actions > * { opacity: 1; }
.ep-video-actions > .busy { opacity: 1; }
/* 下载本片 */
.ep-video-dl {
  width: 22px; height: 22px; padding: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: #fff; cursor: pointer; text-decoration: none;
  background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(4px);
}
.ep-video-dl:hover { background: var(--ad-brand); transform: scale(1.06); color: var(--ad-brand-contrast); }
/* 字幕行「编辑字幕」/ 原片「加字幕」入口 */
.ep-video-cc {
  height: 22px; padding: 0 8px; border: none; border-radius: 11px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; letter-spacing: 0.5px; color: #fff; cursor: pointer;
  background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(4px);
}
.ep-video-cc:hover:not(:disabled) { background: var(--ad-brand); color: var(--ad-brand-contrast); transform: scale(1.05); }
.ep-video-cc.busy { cursor: not-allowed; background: rgba(0, 0, 0, 0.45); }
/* 在线剪辑入口（圆钮，琥珀色 hover 与 CC 金区分） */
.ep-video-cut {
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: #fff; cursor: pointer; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(4px);
}
.ep-video-cut:hover { background: var(--ad-warning); transform: scale(1.06); }
/* 字幕草稿占位（已提取未合并，无视频内容） */
.ep-video-draft {
  width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--ad-brand) 8%, var(--ad-bg-elevated)), color-mix(in srgb, var(--ad-brand) 16%, var(--ad-bg-elevated))); color: var(--ad-brand);
  font-size: 11px; font-weight: 700;
}
.ep-video-draft .el-icon { opacity: 0.85; }

/* 大窗口预览 */
.preview-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--ad-text); }
.preview-head .el-icon { color: var(--ad-brand); }
.preview-time { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--ad-text-muted); font-variant-numeric: tabular-nums; }
.preview-body { width: 100%; }
.preview-body :deep(.vp) { max-height: 78vh; height: auto; }

/* 一键分享弹窗 */
.share-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--ad-text); }
.share-head .el-icon { color: var(--ad-brand); }
.share-body { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 4px 6px 8px; }
.share-name { font-weight: 700; font-size: 16px; color: var(--ad-text); text-align: center; }
.share-url { word-break: break-all; user-select: text; font-size: 13px; color: var(--ad-text-muted); text-align: center; line-height: 1.5; }
.share-qr { background: #fff; padding: 8px; border-radius: 12px; }
.share-qr img { display: block; width: 220px; height: 220px; }
.share-tip { font-size: 12px; }
.share-expire { font-size: 12px; margin-top: 2px; color: var(--ad-warning); }
.share-copy { min-width: 160px; }

/* 发布到展示中心弹窗 */
.showcase-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 6px; }
.showcase-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.showcase-status .ad-sub { margin: 0; }
.showcase-foot { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
/* 分集勾选列表（发布到展示中心）：头部全选 + 可滚动多选区 */
.showcase-eps {
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius-sm);
  padding: 8px 12px 6px;
}
.showcase-eps-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 13px; font-weight: 600; color: var(--ad-text-strong);
  border-bottom: 1px solid var(--ad-border);
  padding-bottom: 6px; margin-bottom: 4px;
}
.showcase-eps-list { display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; }
.showcase-ep-item { height: 30px; margin-right: 0; width: 100%; }
.showcase-ep-label { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; flex: 1; }
.showcase-ep-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.showcase-ep-dur { flex: 0 0 auto; font-size: 12px; color: var(--ad-text-muted); font-variant-numeric: tabular-nums; }

@media (max-width: 860px) {
  .md-layout { grid-template-columns: 1fr; }
  .md-list { min-height: auto; }
  .md-list-body { max-height: 320px; }
  .ep-action-card { flex-wrap: wrap; }
  .ep-action-text { width: 100%; }
}
</style>
