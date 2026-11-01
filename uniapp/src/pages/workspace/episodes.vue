<script setup>
/**
 * 分集与成片（工作台第 3 步）· 自 client/src/views/workspace/EpisodeList.vue 移植。
 * 覆盖：分集列表/删除（两次确认，后端分页每页 15 条：滑动到底自动追加下一页，跳集输入挂头部按钮组）、
 * 本集提取资产、生成分镜、进入分镜编辑、
 * 成片合成（分镜就绪后展示入口，对齐 client：合成主入口在分镜编辑器；静态分辨率档位走确认页 + 任务进度 + 结果播放）、成片列表（合成/字幕版/剪辑版树状排序）、
 * 删除成片、字幕两段式（ASR 提取 → 编辑器校对/智能校正/烧录，编辑器独立页 pages/workspace/subtitle-edit，
 * 经事件通道 + vid 交接记录）、项目字幕样式设置（随编辑器迁入该页）、
 * 在线剪辑入口（满页剪辑器 pages/workspace/clip，剪映式时间轴 UX）、单片下载（utils/download.saveVideo）、
 * 一键分享（ensureShare + 复制链接）、发布到展示中心（独立页 pages/workspace/showcase-publish，本页只留状态角标与入口）。
 * 桌面端特有能力在移动端省略：二维码弹窗（移动端支付走小程序壳/JSAPI）；
 * 视频预览统一走 VideoPlayerPopup 全屏弹层（页面不内嵌 video）。
 */
import { ref, computed, watch, nextTick, onMounted, getCurrentInstance } from 'vue';
import { onLoad, onShow, onUnload, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import {
  projectApi, scriptApi, assetApi, storyboardApi, videoApi, pricingApi, modelApi, showcaseApi,
} from '../../api';
import { API_ORIGIN } from '../../api/config';
import { useJobsStore } from '../../stores/jobs';
import { useThemeStore } from '../../stores/theme';
import { useCostAction } from '../../composables/useCostAction';
import { useVideoPlayer } from '../../composables/useVideoPlayer';
import { can, isOwner } from '../../utils/perms';
import { toast, confirm } from '../../utils/ui';
import { copyText } from '../../utils/clipboard';
import { toAbsolute, coverPalette } from '../../utils/media';
import { formatDuration } from '../../utils/format';
import { saveVideo, saveVideos } from '../../utils/download';
import { statusBarHeight, navBarContentHeight } from '../../utils/system';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import VideoPlayerPopup from '../../components/video-player-popup/video-player-popup.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import AdDownloadDialog from '../../components/ad-download-dialog/ad-download-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const jobs = useJobsStore();
const theme = useThemeStore();
const { runJob } = useCostAction();
const { play, playerShow, playerUrl, playerTitle } = useVideoPlayer();

let pid = null;
const project = ref(null);
const episodes = ref([]);
const loading = ref(false);
const storyboardPricing = ref(null);
// 是否已配置 asr 模型（admin 共享或本人）；无模型时无法转写，字幕入口直接拦截提示
const asrReady = ref(false);

// ---- 分集列表后端分页（每页 15 条）----
const EP_PAGE_SIZE = 15;
const epPage = ref(1);
const epTotal = ref(0);
const epTotalPages = computed(() => Math.max(1, Math.ceil(epTotal.value / EP_PAGE_SIZE)));
const epStatusCounts = ref({}); // 全项目状态分布（服务端聚合）：引导横幅判「一集都未进分镜」
const epLoading = ref(false); // 分集页级请求（翻页/跳转/深链定位）中的轻量态

// 拉一页分集。opts.page 按页码取（默认当前页）；opts.append 滑动到底追加下一页；
// opts.find 按 episodeId 定位所在页（深链定位/跳集用）。
// 附带项目级聚合（资产/积分按分集、状态分布）与轻量 project 信息（独立页不再整包拉项目详情）
let epSeq = 0; // 请求序号：快速翻页时旧响应不覆盖新页
async function loadEpisodes(opts = {}) {
  const seq = ++epSeq;
  epLoading.value = true;
  try {
    // 无参重拉（删成片/任务完成后的刷新）改为 1..epPage 累计重拉：滑动追页后 epPage 指向
    // 最后取过的页，只拉该页会整页替换掉已展示的前面页——「第一页删成片后跳到第二页、
    // 第一页 15 条不显示」即此因。
    const cumulative = !opts.find && !opts.page && !opts.append ? Math.max(1, epPage.value) : 0;
    let resp;
    if (cumulative > 1) {
      const resps = await Promise.all(
        Array.from({ length: cumulative }, (_, i) =>
          projectApi.episodesPage(pid, { page: i + 1, size: EP_PAGE_SIZE })),
      );
      if (seq !== epSeq) return null; // 已有更新的翻页请求，丢弃本次响应
      resp = { ...resps[0], rows: resps.flatMap((r) => r.rows || []) };
      // 尾页可能因删除后总数收缩而变空：以非空页数校正 epPage，避免下次追页重复取行
      epPage.value = Math.max(1, resps.filter((r) => (r.rows || []).length).length);
    } else {
      resp = await projectApi.episodesPage(pid, {
        page: opts.find ? undefined : (opts.page || (opts.append ? epPage.value + 1 : epPage.value)),
        size: EP_PAGE_SIZE,
        find: opts.find,
      });
      if (seq !== epSeq) return null; // 已有更新的翻页请求，丢弃本次响应
      epPage.value = resp.page || 1;
    }
    episodes.value = opts.append ? episodes.value.concat(resp.rows || []) : (resp.rows || []);
    epTotal.value = resp.total || 0;
    epStatusCounts.value = resp.status_counts || {};
    // 轻量 project（id/name/aspect_ratio + 权限）随分页接口带回，供权限计算/画幅/分享文案使用
    if (resp.project) {
      project.value = {
        ...project.value, ...resp.project,
        my_role: resp.my_role, my_permissions: resp.my_permissions,
      };
    }
    // 每个分集的角色/场景数 + 累计成本：聚合映射到行内（口径同原项目详情）
    const byEp = resp.asset_counts_by_episode || {};
    const costs = resp.credits_by_episode || {};
    episodes.value.forEach((e) => {
      const b = byEp[e.id] || {};
      e._chars = b.character || 0;
      e._scenes = b.scene || 0;
      e._cost = costs[e.id] || 0;
    });
    return resp;
  } catch (e) { /* http 层已提示 */ return null; } finally {
    epLoading.value = false;
  }
}

// 整包拉取全部分集（批量下载等全量场景；列表展示仍走分页，不写 episodes）
async function fetchAllEpisodes() {
  const resp = await projectApi.episodesPage(pid, { page: 1, size: 1000 });
  return resp?.rows || [];
}

// 滑动到底自动翻页：追加下一页（请求中/已到末页时忽略）
function loadMoreEpisodes() {
  if (loading.value || epLoading.value) return;
  if (!epTotal.value || episodes.value.length >= epTotal.value) return;
  loadEpisodes({ append: true });
}

// 跳转到特定集：按集号 idx 直达（idx 建集/删集时服务端保持连续 → 页码 = ceil(idx/每页条数)）
const jumpIdx = ref(null);
async function jumpToEpisode() {
  const n = Number(jumpIdx.value);
  if (!Number.isFinite(n) || n < 1 || !epTotal.value) return;
  jumpIdx.value = null; // 跳转后清空输入
  if (n > epTotal.value) {
    // 越界：收敛到最后一页
    await loadEpisodes({ page: epTotalPages.value });
    return;
  }
  await loadEpisodes({ page: Math.ceil(n / EP_PAGE_SIZE) });
  // 跳转后把目标卡滚到吸顶导航正下方（复用点选展开的滚动逻辑）
  const ep = episodes.value.find((e) => e.idx === n);
  if (ep) selectEp(ep);
}

// 团队共享权限：AI 生成（提取/分镜）与成片管理（字幕/删成片/合成）；删分集与剧本编辑同权限
const canGen = computed(() => can(project.value, 'ai.generate'));
const canVideo = computed(() => can(project.value, 'video.manage'));
const canEditScript = computed(() => can(project.value, 'script.edit'));
const amOwner = computed(() => isOwner(project.value));

// 分镜脚本计费提示（分集计数旁）
const sbHint = computed(() => {
  if (!storyboardPricing.value) return '';
  return t('episode.sbHint', {
    unit: storyboardPricing.value.unit,
    unitDesc: storyboardPricing.value.unit_desc,
    credits: storyboardPricing.value.credits_per_unit,
  });
});

// 分集成片历史：episode_id -> [ { job_id, kind, video_url, ... } ]
const videosByEpisode = ref({});

// URL 深链（任务页「查看结果」）：?eid= 选中某集；?vjob= 成片 job_id → 定位所在集 +
// 激活该成片 TAB + 闪金边。load() 消费后清空，重拉/下拉刷新不再触发
const flashVid = ref(null);
let flashTimer = null;
let pendingEid = null;
let pendingVjob = null;

// 列表：当前选中分集（展开显示详情）
const selectedId = ref(null);
const pageInstance = getCurrentInstance();
// 点选展开后把该卡滚到吸顶导航正下方，展开内容首屏可见
// （client 用 scrollIntoView，跨端改 SelectorQuery + pageScrollTo，范式同 storyboard.vue；个别端不支持时仅展开不滚动）
function selectEp(ep) {
  selectedId.value = ep.id;
  nextTick(() => {
    try {
      const headH = statusBarHeight() + navBarContentHeight();
      const q = uni.createSelectorQuery().in(pageInstance && pageInstance.proxy);
      q.select('#epcard-' + ep.id).boundingClientRect();
      q.selectViewport().scrollOffset();
      q.exec((res) => {
        const rect = res && res[0];
        const off = (res && res[1]) || {};
        if (!rect) return;
        uni.pageScrollTo({ scrollTop: Math.max(0, (off.scrollTop || 0) + rect.top - headH - 8), duration: 260 });
      });
    } catch { /* ignore */ }
  });
}

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
// 本集资产提取中（按 meta.episodeId 精确匹配）
const isExtracting = (ep) => jobs.items.some(
  (j) => j.type === 'asset_extract' && j.meta?.episodeId === ep.id && (j.status === 'pending' || j.status === 'running'),
);

// 分镜是否已生成（storyboard 及之后都算）→ 切换「生成/重新生成分镜」
function hasStoryboard(ep) {
  return ['storyboard', 'video', 'done'].includes(ep.status);
}
// 该集是否已提取资产（assets 及之后都算）→ 控制分镜生成门禁
function hasAssets(ep) {
  return ['assets', 'storyboard', 'video', 'done'].includes(ep.status);
}
function sbDesc(ep) {
  if (!hasAssets(ep)) return t('episode.actions.storyboard.descNoAssets');
  if (hasStoryboard(ep)) return t('episode.actions.storyboard.descHasStoryboard');
  return t('episode.actions.storyboard.descReady');
}

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
// 状态对应 chip 配色（ad.scss 的 chip 色系）
function statusChip(s) {
  if (s === 'done') return 'ok';
  if (s === 'storyboard') return 'teal';
  if (s === 'video') return 'gold';
  return 'glass';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 数据加载 ----------
async function loadVideos() {
  try {
    const list = await videoApi.projectVideos(pid);
    const map = {};
    (list || []).forEach((v) => {
      if (!map[v.episode_id]) map[v.episode_id] = [];
      map[v.episode_id].push(v);
    });
    videosByEpisode.value = map;
  } catch (e) { /* http 层已提示 */ }
}

function epVideos(ep) {
  return videosByEpisode.value[ep.id] || [];
}

// 全部成片行（含字幕版），用于按 source_job_id 关联
const allVideoRows = computed(() => Object.values(videosByEpisode.value).flat());

// 展示顺序：派生成片（字幕版/剪辑版）排在其源成片之前、源成片已删的「孤儿」殿后
// （剪辑版的源也可以是字幕版 → 按 source_job_id 树状展开）
function epVideoRows(ep) {
  const rows = epVideos(ep);
  const composes = rows.filter((v) => v.kind === 'compose');
  const derived = rows.filter((v) => v.kind !== 'compose');
  const childrenOf = {};
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

// 角标文案/配色：成片=品牌金（本体），字幕版/剪辑版=暗色描金边（派生），草稿不叠角标（面板已自带）
function badgeOf(v) {
  if (v.kind === 'edit') return t('episode.videos.editBadge');
  if (v.kind === 'compose') return t('episode.videos.composeBadge');
  return isDraft(v) ? t('episode.videos.draftBadge') : t('episode.videos.subtitleBadge');
}
function badgeCls(v) {
  return v.kind === 'compose' ? 'main' : 'sub';
}

// ---------- 多成片 TAB 切换：一集多条成片时同区域展示，按集记忆所选 ----------
const activeVideoByEp = ref({});

function tabBaseLabel(v) {
  return v.kind === 'compose' ? t('episode.videos.composeBadge') : badgeOf(v);
}

// TAB 文案：原片用「成片」，同名（如多条原片）时追加序号区分
function videoTabLabel(ep, v) {
  const rows = epVideoRows(ep);
  const base = tabBaseLabel(v);
  const dups = rows.filter((r) => tabBaseLabel(r) === base);
  return dups.length <= 1 ? base : `${base} ${dups.indexOf(v) + 1}`;
}

function activeIdOf(ep) {
  const rows = epVideoRows(ep);
  const want = String(activeVideoByEp.value[ep.id] ?? '');
  const hit = rows.find((v) => String(v.job_id) === want);
  return String((hit || rows[0])?.job_id ?? '');
}

// 展示列表：多条成片时只渲染当前 TAB 选中的一条；单条维持原样
function epDisplayRows(ep) {
  const rows = epVideoRows(ep);
  if (rows.length <= 1) return rows;
  const activeId = activeIdOf(ep);
  return rows.filter((v) => String(v.job_id) === activeId);
}

function setActiveVideo(ep, v) {
  activeVideoByEp.value = { ...activeVideoByEp.value, [ep.id]: v.job_id };
}

async function loadShowcaseStatus() {
  if (!amOwner.value) return;
  try {
    const st = await showcaseApi.status(pid);
    showcasePublishedId.value = st.id || null; // 仅留角标状态；简介/勾选快照由展示发布页自取
  } catch (e) { /* 尽力而为 */ }
}

async function load() {
  loading.value = true;
  try {
    // 四个请求相互独立，并行发出
    const [, , pricingList, asrModels] = await Promise.all([
      loadEpisodes(), // 后端分页：只拉当前页（深链目标不在当页时 consumeDeepLink 会按 find 重拉）
      loadVideos(),
      pricingApi.list().catch(() => null),
      modelApi.list('asr', { enabledOnly: true }).catch(() => null),
    ]);
    loadShowcaseStatus();
    storyboardPricing.value = (pricingList || []).find((x) => x.feature === 'storyboard_script') || null;
    asrReady.value = ((asrModels || []).filter((m) => m.enabled !== false)).length > 0;
    await consumeDeepLink();
  } catch (e) { /* http 层已提示 */ } finally {
    loading.value = false;
  }
}

// 消费 URL 深链：先按 ?vjob= 找成片行（匹配 job_id 或 source_job_id——字幕版/剪辑版
// 派生行挂在源成片 job 上），命中则激活所在集的对应 TAB 并闪金边；否则按 ?eid= 选集。
// 后端分页后目标集可能不在当前页：不在当页就按 find 定位所在页重拉再选。
// 在 videos 就绪后调用（load 末尾），只消费一次
async function consumeDeepLink() {
  const wantVjob = pendingVjob;
  pendingVjob = null;
  let hitEpId = null;
  if (wantVjob) {
    const hit = Object.entries(videosByEpisode.value)
      .flatMap(([epId, rows]) => rows.map((v) => ({ epId, v })))
      .find((x) => String(x.v.job_id) === String(wantVjob) || String(x.v.source_job_id) === String(wantVjob));
    if (hit) {
      hitEpId = hit.epId;
      activeVideoByEp.value = { ...activeVideoByEp.value, [hit.epId]: String(hit.v.job_id) };
      flashVid.value = String(hit.v.job_id);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashVid.value = null; flashTimer = null; }, 2600);
    }
  }
  if (hitEpId == null) {
    hitEpId = pendingEid;
    pendingEid = null;
  }
  // 统一 String 比较：URL 参数是字符串，集 id 可能是数字；目标集不在当页时按 find 定位所在页
  let ep = hitEpId != null && episodes.value.find((e) => String(e.id) === String(hitEpId));
  if (!ep && hitEpId != null) {
    await loadEpisodes({ find: hitEpId });
    ep = episodes.value.find((e) => String(e.id) === String(hitEpId));
  }
  if (ep) selectEp(ep);
}

// 合成/字幕/剪辑任务完成时自动刷新成片列表（仅当成片数实际增长时拉取，避免重复请求）
const succeededVideoIds = computed(() => jobs.items
  .filter((j) => ['video_synthesis', 'video_subtitle', 'video_edit'].includes(j.type)
    && j.status === 'succeeded' && String(j.project_id) === String(pid))
  .map((j) => j.id)
  .sort((a, b) => a - b)
  .join(','));
let lastSeenIds = succeededVideoIds.value;
watch(succeededVideoIds, (cur) => {
  if (cur && cur !== lastSeenIds) {
    lastSeenIds = cur;
    loadVideos();
  }
});

// ---------- 本集提取资产（异步任务） ----------
async function extractEpisode(ep) {
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => assetApi.extractEpisodeEstimate(pid, ep.id, sel),
    createFor: (sel) => assetApi.extractEpisode(pid, ep.id, sel),
    title: t('episode.actions.extract.button'),
    desc: t('episode.jobs.extract.desc', { idx: ep.idx, title: ep.title }),
    confirmText: t('episode.jobs.extract.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') load(); },
  });
}

// ---------- 生成分镜脚本（异步任务） ----------
async function genStoryboard(ep) {
  if (!hasAssets(ep)) {
    showWarn(ep.id, t('episode.warn.extractFirst'));
    return;
  }
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => storyboardApi.genStoryboardEstimate(ep.id, sel),
    createFor: (sel) => storyboardApi.genStoryboard(ep.id, sel),
    allowRequirement: true, // 「本次要求」追加到分镜生成提示词
    title: t('episode.jobs.storyboard.title'),
    desc: t('episode.jobs.storyboard.desc', { title: ep.title }),
    confirmText: t('episode.jobs.storyboard.confirm'),
    onDone: (j) => { if (j.status === 'succeeded') load(); },
  });
}

function openEditor(ep) {
  if (!hasStoryboard(ep)) {
    showWarn(ep.id, t('episode.warn.storyboardFirst'));
    return;
  }
  uni.navigateTo({ url: `/pages/workspace/storyboard?pid=${pid}&eid=${ep.id}` });
}

// ---------- 成片预览 + 审阅 ----------
// 当前预览的成片行（审阅钮状态取自它；与列表行同对象，改 reviewed_at 两处同步）
const previewFilm = ref(null);
function openPreview(v) {
  previewFilm.value = v;
  play({ url: toAbsolute(v.video_url), title: t('episode.videos.preview') });
}
// 审阅/取消审阅（已审再点取消；组件抛回取反后的布尔）
const reviewBusy = ref(false);
async function toggleReview(next) {
  const v = previewFilm.value;
  if (!v?.id || reviewBusy.value) return;
  reviewBusy.value = true;
  try {
    const res = await videoApi.reviewFilm(v.id, next);
    v.reviewed_at = res.reviewed_at;
    toast(res.reviewed_at ? t('episode.videos.reviewDone') : t('episode.videos.reviewUndone'), 'success');
  } catch (e) { /* http 层已提示 */ } finally {
    reviewBusy.value = false;
  }
}

// ---------- 删除成片（二次确认） ----------
// 按成片记录 id 删除（成片查询与 jobs 表解耦，Job 清理不影响成片历史），勿传 job_id
async function deleteFilm(v) {
  if (!v || !v.id) return;
  const okGo = await confirm({
    title: t('episode.videos.delete'),
    content: t('episode.videos.deleteConfirm'),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
  });
  if (!okGo) return;
  try {
    await videoApi.deleteFilm(v.id);
    toast(t('episode.videos.deleted'), 'success');
    await load(); // 删除可能使该集状态由「已完成」回退
  } catch (e) { /* http 层已提示 */ }
}

// ---------- 字幕两段式 · 第一步：提取 SRT 草稿（ASR 任务） ----------
async function addSubtitle(v) {
  if (!asrReady.value) {
    toast(t('episode.videos.asrNotConfigured'));
    return;
  }
  await runJob({
    modelType: 'asr',
    estimateFor: (sel) => videoApi.subtitleEstimate(v.job_id, sel),
    createFor: (sel) => videoApi.addSubtitle(v.job_id, sel),
    title: t('episode.videos.subtitleTitle'),
    desc: t('episode.videos.subtitleDesc'),
    confirmText: t('episode.videos.subtitleConfirm'),
    onDone: (j) => { if (j.status === 'succeeded') loadVideos(); },
  });
}

// 某条成片已有的字幕版（后端对已成功任务不查重，防重复靠这里禁用入口）
function subtitlesOf(v) {
  return allVideoRows.value.filter((s) => s.kind === 'subtitle' && String(s.source_job_id) === String(v.job_id));
}
const hasSubtitle = (v) => subtitlesOf(v).length > 0;
// 该成片的字幕任务进行中（严格按 type + ref_id 匹配，避免 job id 与 episode id 撞号误判）
const subtitleBusy = (v) => jobs.items.some(
  (j) => j.type === 'video_subtitle' && String(j.ref_id) === String(v.job_id) && (j.status === 'pending' || j.status === 'running'),
);
// 字幕行是否为「草稿」（已提取未合并，无 video_url）
const isDraft = (v) => v.kind === 'subtitle' && !v.video_url;
// 字幕行的源成片 URL（源成片已删时为空）
function sourceVideoUrlOf(v) {
  const src = allVideoRows.value.find((c) => c.kind !== 'subtitle' && String(c.job_id) === String(v.source_job_id));
  return src?.video_url || '';
}

// ---------- 字幕两段式 · 第二步：编辑器（校对/智能校正/烧录）独立页 ----------
// 完整成片记录经 opener 事件通道交接（页面端仍会按 vid 拉成片列表兜底解析源片 URL）
function openSubtitleEditor(v) {
  uni.navigateTo({
    url: `/pages/workspace/subtitle-edit?pid=${pid}&vid=${v.id}`,
    success: (res) => { try { res.eventChannel.emit('video', v); } catch { /* 个别端无 eventChannel */ } },
  });
}

// ---------- 成片在线剪辑（满页剪辑器，剪映式移动端 UX） ----------
function goClip(v) {
  if (!v || !v.video_url) return;
  uni.navigateTo({ url: `/pages/workspace/clip?pid=${pid}&vid=${v.job_id}` });
}

// ---------- 单片下载（H5 浏览器下载；App/小程序 下载临时文件后存入系统相册） ----------
function downloadFilm(v) {
  if (!v || !v.video_url) return;
  saveVideo(toAbsolute(v.video_url), `film-${v.job_id}.mp4`, {
    loading: t('common.loading'),
    ok: t('episode.videos.downloaded'),
    fail: t('episode.videos.downloadFail'),
    perm: t('episode.videos.albumPerm'),
    tip: t('common.tip'),
    okBtn: t('common.ok'),
  });
}

// ---------- 删除分集（两次确认防误删；后端连带清理并重排集号） ----------
const deleting = ref(false);
async function removeEpisode(ep) {
  if (!ep || deleting.value) return;
  const first = await confirm({
    title: t('episode.delete.title'),
    content: t('episode.delete.confirm', { idx: ep.idx, title: ep.title }),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
  });
  if (!first) return;
  const second = await confirm({
    title: t('episode.delete.titleAgain'),
    content: t('episode.delete.confirmAgain', { idx: ep.idx, title: ep.title }),
    confirmText: t('episode.delete.confirmAgainBtn'),
    cancelText: t('common.cancel'),
  });
  if (!second) return;
  deleting.value = true;
  try {
    await scriptApi.deleteEpisode(ep.id);
    toast(t('episode.delete.deleted', { idx: ep.idx }), 'success');
    await load();
  } catch (e) { /* http 层已提示 */ } finally {
    deleting.value = false;
  }
}

// ---------- 可下载/可发布的成片口径 ----------
// 每集按展示序（字幕版在前）取首条有视频的：优先最新字幕版（草稿无 video_url 不算），
// 无字幕版/仅草稿时回退原片；只剩孤儿字幕版时同样取到 —— 与分享播放页同口径。
// 后端分页后 episodes 只有当页，批量下载由调用方整包拉取传入
function downloadableEpisodes(eps) {
  return (eps || episodes.value)
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((ep) => ({ ep, video: epVideoRows(ep).find((v) => !!v.video_url) }))
    .filter((x) => !!x.video);
}

// ---------- 批量下载成片（H5 浏览器逐个触发下载；App/小程序 顺序下载并存入系统相册） ----------
function videoExt(url) {
  const m = /\.(\w{2,5})(?:$|\?|#)/.exec(url || '');
  return m ? m[1].toLowerCase() : 'mp4';
}
function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '').trim();
}
const downloading = ref(false);
async function downloadAllFilms() {
  // 可见列表只含当页，批量下载须整包拉取（分页接口 size 拉满即全量）
  downloading.value = true;
  try {
    const all = await fetchAllEpisodes();
    const items = downloadableEpisodes(all).map(({ ep, video }) => ({
      url: toAbsolute(video.video_url), // 媒体源站随 VITE_API_BASE/VITE_SERVER_ORIGIN（H5 非同源场景须绝对地址）
      filename: `第${ep.idx}集-${safeFileName(ep.title) || ep.idx}.${videoExt(video.video_url)}`,
    }));
    if (!items.length) {
      toast(t('episode.videos.downloadNone'));
      return;
    }
    /* #ifdef H5 */
    const okMsg = t('episode.videos.downloadDone', { n: items.length });
    /* #endif */
    /* #ifndef H5 */
    const okMsg = t('episode.videos.downloadSaved', { n: items.length });
    /* #endif */
    await saveVideos(items, {
      ok: okMsg,
      fail: t('episode.videos.downloadFailSome'),
      perm: t('episode.videos.albumPerm'),
      tip: t('common.tip'),
      okBtn: t('common.ok'),
    });
  } catch (e) {
    toast(t('episode.videos.downloadNone'));
  } finally {
    downloading.value = false;
  }
}

// ---------- 一键分享（免登录播放页，链接 24 小时有效） ----------
const sharing = ref(false);
function buildShareUrl(token) {
  // 服务端短链 /share/:token（由源站 nginx/后端跳转到 /pages/play/share?token=），
  // 用 API_ORIGIN 保证 H5 dev 环境也产出线上站链接
  return `${API_ORIGIN}/share/${token}`;
}

async function handleShare() {
  // 分集已分页，成片是否存在的判断以完整视频行表为准（服务端仍会校验）
  if (!allVideoRows.value.some((v) => v.video_url)) {
    toast(t('episode.share.noVideos'));
    return;
  }
  sharing.value = true;
  try {
    const { token, expires_at: expiresAt } = await projectApi.ensureShare(pid);
    const url = buildShareUrl(token);
    try {
      await copyText(t('episode.share.copyText', { name: project.value?.name || '', url }));
      toast(t('episode.share.copied'), 'success');
    } catch (e) {
      toast(t('episode.share.copyFail'));
      return;
    }
    if (expiresAt) {
      setTimeout(() => toast(t('episode.share.expiresAt', { time: new Date(expiresAt).toLocaleString() })), 2800);
    }
  } catch (e) { /* http 层已提示 */ } finally {
    sharing.value = false;
  }
}

// ---------- 发布到展示中心（owner 专属；独立页 pages/workspace/showcase-publish 承接表单与发布/下架） ----------
const showcasePublishedId = ref(null); // 已发布的展示记录 id（null=未发布）

function openShowcasePublish() {
  uni.navigateTo({ url: `/pages/workspace/showcase-publish?pid=${pid}` });
}

function goShowcase() {
  uni.navigateTo({ url: '/pages/showcase/index' });
}

function goOutline() {
  uni.navigateTo({ url: `/pages/workspace/index?id=${pid}&step=1` });
}

// 默认选中第一集
watch(episodes, (list) => {
  if (list.length && !list.find((e) => e.id === selectedId.value)) selectedId.value = list[0].id;
}, { immediate: true });

onLoad((q) => {
  pid = (q && (q.pid || q.id)) || null;
  pendingEid = (q && q.eid) || null;
  pendingVjob = (q && q.vjob) || null;
  // 字幕编辑页/展示发布页保存成功后广播 → 重拉列表（新字幕版成片 / 展示状态角标）
  uni.$on('episodes:reload', load);
});
onUnload(() => {
  uni.$off('episodes:reload', load);
  if (flashTimer) clearTimeout(flashTimer);
});
onShow(() => {
  jobs.fetchAll(); // 回到页面同步任务列表（行内进度 / 成片自动刷新依赖它）
});
onReachBottom(() => { loadMoreEpisodes(); });
onMounted(() => {
  if (pid) load();
});
// 下拉刷新：重拉分集成片列表 + 任务状态
onPullDownRefresh(async () => {
  try {
    jobs.fetchAll();
    if (pid) await load();
  } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page eps" :class="theme.rootCls">
    <AdNavbar :title="t('episode.page.title')" />

    <!-- 头部：计数 + 提示 + 动作 -->
    <view class="eps-head">
      <view class="eps-sub">
        <text>{{ t('episode.page.count', { n: epTotal }) }}</text>
      </view>
      <view class="eps-acts">
        <view class="pchip" :class="{ dis: loading }" @tap="!loading && load()"><text>{{ t('episode.refresh') }}</text></view>
        <!-- 一键分享为对外曝光开关，仅项目创建者可见 -->
        <view v-if="amOwner" class="pchip" :class="{ dis: sharing }" @tap="!sharing && handleShare()"><text>{{ t('episode.share.action') }}</text></view>
        <!-- 发布到展示中心（owner 专属；已发布时高亮，点击可改简介/勾选） -->
        <view v-if="amOwner" class="pchip" :class="{ on: !!showcasePublishedId }" @tap="openShowcasePublish()">
          <text>{{ showcasePublishedId ? t('showcase.publishedAction') : t('showcase.publishAction') }}</text>
        </view>
        <view v-if="amOwner && showcasePublishedId" class="pchip" @tap="goShowcase"><text>{{ t('showcase.goShowcase') }}</text></view>
        <view class="pchip" :class="{ dis: downloading }" @tap="!downloading && downloadAllFilms()">
          <m-icon name="import" :size="13" /><text>{{ t('episode.videos.downloadAll') }}</text>
        </view>
        <!-- 跳集：按集号直达所在页（列表超过一页才出现；翻页本身靠滑动到底自动追加） -->
        <view v-if="epTotal > EP_PAGE_SIZE" class="eps-jump">
          <input
            v-model="jumpIdx"
            class="eps-jump-in"
            type="number"
            placeholder-class="ad-ph"
            :placeholder="t('episode.list.jumpPlaceholder')"
            confirm-type="done"
            :disabled="epLoading"
            @confirm="jumpToEpisode"
          />
          <view class="pchip" :class="{ dis: epLoading }" @tap="!epLoading && jumpToEpisode()"><text>{{ t('episode.list.jumpGo') }}</text></view>
        </view>
      </view>
    </view>

    <!-- 引导横幅：还没有任何一集进入分镜（状态统计来自分页接口的整包口径 status_counts） -->
    <view v-if="epTotal && !(['storyboard', 'video', 'done']).some((s) => (epStatusCounts[s] || 0) > 0)" class="eps-guide">
      <text class="eps-guide-ic">🎬</text>
      <view class="eps-guide-tx">
        <text class="eps-guide-t">{{ t('episode.guide.title') }}</text>
        <text class="eps-guide-d">{{ t('episode.guide.desc') }}</text>
      </view>
    </view>

    <view v-if="loading && !episodes.length" class="eps-loading"><text>{{ t('common.loading') }}</text></view>

    <!-- 空态：还没有分集 -->
    <view v-else-if="!episodes.length" class="eps-empty">
      <text class="eps-empty-ic">🎬</text>
      <text class="eps-empty-t">{{ t('episode.empty.noEpisodesTitle') }}</text>
      <text class="eps-empty-d">{{ t('episode.empty.noEpisodesDesc') }}</text>
      <view class="mbtn soft eps-empty-btn" @tap="goOutline"><text>{{ t('episode.empty.goToOutline') }}</text></view>
    </view>

    <!-- 分集列表：点选展开详情 -->
    <view v-for="ep in episodes" :key="ep.id" :id="'epcard-' + ep.id" class="eps-card" :class="{ on: ep.id === selectedId }">
      <view class="eps-row" @tap="selectEp(ep)">
        <text class="eps-no">{{ ep.idx }}</text>
        <view class="eps-main">
          <text class="eps-name">{{ ep.title }}</text>
          <view class="eps-meta">
            <text class="chip" :class="statusChip(ep.status)">{{ statusLabel(ep.status) }}</text>
            <text class="eps-meta-t">{{ t('episode.characters') }} {{ ep._chars || 0 }} · {{ t('episode.scenes') }} {{ ep._scenes || 0 }} · {{ t('episode.videos.title') }} {{ epVideos(ep).length }}</text>
          </view>
        </view>
        <view class="eps-side">
          <view v-if="isBusy(ep) || isExtracting(ep)" class="pulse" />
          <template v-else>
            <!-- 删除分集：小图标居卡右上角（仅展开时出现；任务进行中由 pulse 接管自动隐藏；双重确认防误删） -->
            <view v-if="ep.id === selectedId && canEditScript" class="eps-del" @tap.stop="removeEpisode(ep)">
              <m-icon name="trash" :size="14" />
            </view>
            <m-icon v-else name="right" :size="15" />
          </template>
        </view>
      </view>

      <view v-if="ep.id === selectedId" class="eps-detail">
        <!-- 制作流程卡：① 提取资产 → ② 分镜脚本（两步合一卡，序号随进度点亮） -->
        <view class="eps-flow">
          <!-- 步骤 1 · 提取资产 -->
          <view class="eps-step">
            <view class="eps-step-mark" :class="{ done: hasAssets(ep), run: isExtracting(ep) }">
              <view v-if="isExtracting(ep)" class="pulse" />
              <m-icon v-else-if="hasAssets(ep)" name="check" :size="13" />
              <text v-else class="eps-step-no">1</text>
            </view>
            <view class="eps-step-body">
              <view class="eps-step-top">
                <text class="eps-step-t">{{ t('episode.actions.extract.title') }}</text>
                <view v-if="canGen && !isExtracting(ep)" class="mbtn soft sm" @tap="extractEpisode(ep)">
                  <m-icon name="spark" :size="13" /><text>{{ t('episode.actions.extract.button') }}</text>
                </view>
              </view>
              <text class="eps-step-d">{{ t('episode.actions.extract.desc') }}</text>
              <view v-if="isExtracting(ep)" class="eps-step-run"><text>{{ t('episode.extracting.progress') }}</text></view>
            </view>
          </view>

          <!-- 步骤 2 · 分镜脚本 -->
          <view class="eps-step">
            <view class="eps-step-mark" :class="{ done: hasStoryboard(ep), run: isBusy(ep) }">
              <view v-if="isBusy(ep)" class="pulse" />
              <m-icon v-else-if="hasStoryboard(ep)" name="check" :size="13" />
              <text v-else class="eps-step-no">2</text>
            </view>
            <view class="eps-step-body">
              <text class="eps-step-t">{{ t('episode.actions.storyboard.title') }}</text>
              <text class="eps-step-d">{{ sbDesc(ep) }}</text>
              <view class="eps-step-ops">
                <view v-if="canGen" class="mbtn ghost sm" :class="{ dis: isBusy(ep) }" @tap="!isBusy(ep) && genStoryboard(ep)">
                  <text>{{ hasStoryboard(ep) ? t('episode.actions.storyboard.regenerate') : t('episode.actions.storyboard.generate') }}</text>
                </view>
                <view class="mbtn sm" :class="{ dis: isBusy(ep) }" @tap="!isBusy(ep) && openEditor(ep)">
                  <text>{{ t('episode.actions.storyboard.enter') }}</text><m-icon name="right" :size="13" />
                </view>
              </view>
            </view>
          </view>
        </view>

        <!-- 分镜未生成就近提示 -->
        <view v-if="warnEpId === ep.id" class="eps-warn"><text>{{ warnMsg }}</text></view>

        <!-- 成片（合成成片 + 其字幕版/剪辑版） -->
        <view v-if="epVideoRows(ep).length" class="eps-videos">
          <!-- 多成片：TAB 行切换，下方同一张卡片区域展示选中的成片 -->
          <view v-if="epVideoRows(ep).length > 1" class="eps-vtabs">
            <view
              v-for="v in epVideoRows(ep)"
              :key="v.job_id"
              class="eps-vtab"
              :class="{ on: activeIdOf(ep) === String(v.job_id) }"
              @tap="setActiveVideo(ep, v)"
            ><text>{{ videoTabLabel(ep, v) }}</text></view>
          </view>
          <view v-for="v in epDisplayRows(ep)" :key="v.job_id" class="eps-vcard" :class="{ draft: isDraft(v), flash: flashVid === String(v.job_id) }">
            <!-- 海报区：信息全部上墙（类型/分辨率/时间/时长），点按播放或进字幕编辑 -->
            <view class="eps-vposter" @tap="isDraft(v) ? openSubtitleEditor(v) : openPreview(v)">
              <template v-if="isDraft(v)">
                <view class="eps-vdraft">
                  <text class="eps-vdraft-ic">📄</text>
                  <text class="eps-vdraft-t">{{ t('episode.videos.draftBadge') }}</text>
                </view>
              </template>
              <template v-else>
                <!-- 成片封面（第一帧 480P webp）优先；旧数据无封面回退占位渐变 -->
                <image
                  v-if="v.cover_url"
                  class="eps-vart eps-vimg"
                  :src="toAbsolute(v.cover_url)"
                  mode="aspectFill"
                />
                <view v-else class="eps-vart" :style="{ background: coverPalette(String(v.job_id)) }" />
                <view class="eps-vplay"><m-icon name="play" :size="18" color="#fff" /></view>
                <text v-if="v.duration" class="eps-vdur">{{ formatDuration(v.duration) }}</text>
                <text class="eps-vdate">{{ formatTime(v.created_at) }}</text>
              </template>
              <text v-if="!isDraft(v)" class="eps-vbadge" :class="badgeCls(v)">{{ badgeOf(v) }}</text>
              <!-- 已审角标（预览弹层点「审阅」标记；换视频/新成片后为未审） -->
              <text v-if="v.reviewed_at" class="eps-vbadge ok">{{ t('episode.videos.reviewed') }}</text>
              <text v-if="v.resolution && v.kind !== 'subtitle'" class="eps-vbadge res">{{ v.resolution }}</text>
            </view>
            <!-- 操作栏：等宽单元（图标+文字）+ 细分隔线，删除居尾；入口按权限/状态增减 -->
            <view class="eps-vbar">
              <!-- 字幕行：编辑字幕（改词/对时间后单独合并烧录）；无权限时仍可打开查看（编辑器只读） -->
              <view v-if="v.kind === 'subtitle'" class="eps-vcell" :class="{ dis: subtitleBusy(v) }" @tap.stop="!subtitleBusy(v) && openSubtitleEditor(v)">
                <m-icon name="film" :size="16" />
                <text>{{ subtitleBusy(v) ? t('episode.videos.subtitleRunning') : t('episode.videos.editSubtitle') }}</text>
              </view>
              <!-- 原片/剪辑版：提取字幕入口（已有字幕版时收起——字幕版就在上方 TAB 里；需成片管理权限） -->
              <view
                v-if="(v.kind === 'compose' || v.kind === 'edit') && canVideo && !hasSubtitle(v)"
                class="eps-vcell"
                :class="{ dis: subtitleBusy(v) }"
                @tap.stop="!subtitleBusy(v) && addSubtitle(v)"
              >
                <m-icon name="video" :size="16" /><text>CC</text>
              </view>
              <!-- 在线剪辑：掐头去尾/删段/调序 → 导出新成片（草稿无片源不可剪；需成片管理权限） -->
              <view v-if="v.video_url && canVideo" class="eps-vcell" @tap.stop="goClip(v)">
                <m-icon name="cut" :size="16" /><text>{{ t('episode.videos.editVideo') }}</text>
              </view>
              <!-- 下载本片：H5 浏览器下载；App/小程序下载后存入相册 -->
              <view v-if="v.video_url" class="eps-vcell" @tap.stop="downloadFilm(v)">
                <m-icon name="import" :size="16" /><text>{{ t('episode.videos.downloadVideo') }}</text>
              </view>
              <view v-if="canVideo" class="eps-vcell del" @tap.stop="deleteFilm(v)">
                <m-icon name="trash" :size="16" /><text>{{ t('common.delete') }}</text>
              </view>
            </view>
          </view>
        </view>
        <!-- 还没成片：分镜就绪后才提示去分镜页合成；更早阶段由上方操作卡与顶部引导横幅指路（对齐 client：该阶段不展示此区） -->
        <view v-else-if="hasStoryboard(ep)" class="eps-novideo"><text>{{ t('mobile.episodes.noVideos') }}</text></view>
      </view>
    </view>

    <!-- 滑动到底自动翻页：追加中 / 已全部加载（列表超过一页才提示） -->
    <view v-if="epTotal > EP_PAGE_SIZE" class="eps-more">
      <text v-if="epLoading">{{ t('common.loading') }}</text>
      <text v-else-if="episodes.length >= epTotal">{{ t('common.allLoaded') }}</text>
    </view>

    <!-- 全屏播放弹层（页面不内嵌 video，统一走此组件）；开启审阅钮（需成片管理权限） -->
    <VideoPlayerPopup
      v-model:show="playerShow"
      :url="playerUrl"
      :title="playerTitle"
      :aspect="project?.aspect_ratio || ''"
      :reviewable="!!previewFilm?.video_url && canVideo"
      :reviewed="!!previewFilm?.reviewed_at"
      :reviewing="reviewBusy"
      @review="toggleReview"
    />

    <!-- 统一「模型+价格」确认页（useCostAction 驱动，各页挂一份） -->
    <GenConfirmSheet />

  <AdDownloadDialog />
  <AdDialog />
  </view>
</template>

<style scoped>
.eps-head { padding: 4px 18px 12px; }
.eps-sub { font-size: 11.5px; line-height: 1.7; color: var(--ad-text-mut); }
.eps-sub-hint { color: var(--ad-brand); }
.eps-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.pchip.dis { opacity: 0.45; }

/* 引导横幅 */
.eps-guide {
  display: flex; align-items: center; gap: 12px;
  margin: 0 18px 14px; padding: 13px 15px;
  background: var(--ad-brand-soft);
  border: 1px solid rgba(224, 182, 78, 0.28);
  border-left: 3px solid var(--ad-brand);
  border-radius: 14px;
}
.eps-guide-ic { font-size: 20px; flex: none; }
.eps-guide-tx { display: flex; flex-direction: column; gap: 3px; }
.eps-guide-t { font-size: 13px; font-weight: 700; color: var(--ad-text); }
.eps-guide-d { font-size: 11.5px; line-height: 1.6; color: var(--ad-text-mut); }

.eps-loading { padding: 50px 0; text-align: center; font-size: 12.5px; color: var(--ad-text-mut); }

/* 跳集：集号输入 + 跳转按钮（挂头部按钮组尾部，与 pchip 等高） */
.eps-jump { display: flex; align-items: center; gap: 6px; }
.eps-jump-in {
  width: 64px; height: 31px; padding: 0 10px; box-sizing: border-box;
  border-radius: 16px; background: var(--ad-elev);
  border: 1px solid var(--ad-line); color: var(--ad-text);
  font-size: 12.5px; text-align: center;
}
/* 滑动到底自动翻页：底部状态行 */
.eps-more { padding: 14px 0 18px; text-align: center; font-size: 11.5px; color: var(--ad-text-mut); }

/* 空态 */
.eps-empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 46px 24px; }
.eps-empty-ic { font-size: 40px; line-height: 1; margin-bottom: 14px; }
.eps-empty-t { font-family: var(--ad-font-serif); font-weight: 700; font-size: 16px; color: var(--ad-text); margin-bottom: 6px; }
.eps-empty-d { font-size: 12px; line-height: 1.7; color: var(--ad-text-mut); margin-bottom: 16px; }
.eps-empty-btn { min-width: 180px; }

/* 分集卡 */
.eps-card {
  margin: 0 18px 12px;
  background: var(--ad-elev);
  border: 1px solid var(--ad-line);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: var(--ad-sh-card);
}
.eps-card.on { border-color: rgba(224, 182, 78, 0.45); background: var(--ad-elev); }
.eps-row { display: flex; align-items: center; gap: 11px; padding: 13px 14px; min-height: 40px; }
.eps-no {
  font-family: var(--ad-font-mono); font-weight: 700; font-size: 11px;
  color: var(--ad-brand); background: var(--ad-brand-soft);
  padding: 5px 8px; border-radius: 8px; flex: none;
}
.eps-card.on .eps-no { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.eps-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.eps-name { font-size: 14px; font-weight: 600; color: var(--ad-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.eps-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eps-meta-t { font-size: 10.5px; color: var(--ad-text-mut); }
.eps-side { flex: none; display: flex; align-items: center; justify-content: flex-end; min-width: 26px; color: var(--ad-text-mut); }

/* 展开详情 */
.eps-detail { padding: 2px 14px 15px; display: flex; flex-direction: column; gap: 11px; border-top: 1px solid var(--ad-line); }

/* 制作流程卡：① 提取资产 → ② 分镜脚本 两步合一 */
.eps-flow {
  margin-top: 12px; padding: 1px 14px;
  background: var(--ad-inset); border: 1px solid var(--ad-line); border-radius: 14px;
}
.eps-step { display: flex; gap: 11px; padding: 12px 0; }
.eps-step + .eps-step { border-top: 1px solid var(--ad-line); }
.eps-step-mark {
  flex: none; width: 24px; height: 24px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11.5px; font-weight: 700; color: var(--ad-text-mut);
  background: var(--ad-elev); border: 1px solid var(--ad-line);
}
.eps-step-mark.done {
  color: var(--ad-brand-contrast); background: var(--ad-brand); border-color: transparent;
}
.eps-step-mark.run {
  color: var(--ad-brand); background: var(--ad-brand-soft); border-color: rgba(224, 182, 78, 0.5);
}
.eps-step-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.eps-step-top { display: flex; align-items: center; gap: 8px; }
.eps-step-t { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 700; color: var(--ad-text); }
.eps-step-d { font-size: 11.5px; line-height: 1.6; color: var(--ad-text-mut); }
.eps-step-run { display: flex; align-items: center; gap: 7px; margin-top: 2px; font-size: 11.5px; color: var(--ad-brand); }
.eps-step-run .pulse { background: var(--ad-brand); }
.eps-step-ops { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
/* 删除分集：卡右上角小图标（:active 才转危险色，保持头部安静） */
.eps-del {
  flex: none; width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: var(--ad-text-mut); background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.eps-del:active {
  color: var(--ad-danger); background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.35);
}
.eps-warn {
  display: flex; align-items: center; gap: 7px; align-self: flex-start;
  margin-top: 11px; padding: 8px 12px; border-radius: 10px;
  font-size: 12px; color: var(--ad-warning);
  background: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.4);
}

/* 成片列表 */
.eps-videos { margin-top: 6px; padding-top: 13px; border-top: 1px dashed var(--ad-line); display: flex; flex-direction: column; gap: 11px; }
.eps-vtabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 2px; }
.eps-vtab {
  padding: 5px 12px; border-radius: 999px; border: 1px solid var(--ad-line);
  font-size: 11.5px; color: var(--ad-text-soft); background: var(--ad-inset);
}
.eps-vtab.on {
  color: #0a0a0f; font-weight: 700; border-color: transparent;
  background: linear-gradient(135deg, #f2d489, #e0b64e);
}
.eps-novideo { margin-top: 8px; font-size: 12px; color: var(--ad-text-mut); }
.eps-vcard {
  border: 1px solid var(--ad-line); border-radius: 14px; overflow: hidden; background: #000;
}
.eps-vcard.draft { background: var(--ad-inset); }
/* 深链定位反馈：目标成片卡闪两下品牌金描边（任务页「查看结果」跳转而来） */
.eps-vcard.flash { animation: eps-vflash 1.2s ease 2; }
@keyframes eps-vflash {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 0 3px rgba(224, 182, 78, 0.65); }
}
.eps-vposter { position: relative; width: 100%; height: 0; padding-bottom: 50%; }
.eps-vart { position: absolute; top: 0; right: 0; bottom: 0; left: 0; }
/* 封面图：铺满海报区（aspectFill 居中裁切，占位渐变同框） */
.eps-vimg { width: 100%; height: 100%; display: block; }
.eps-vplay {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 46px; height: 46px; border-radius: 50%;
  background: rgba(224, 182, 78, 0.92);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 0 4px rgba(255, 255, 255, 0.12);
  display: flex; align-items: center; justify-content: center;
}
.eps-vdraft {
  position: absolute; top: 0; right: 0; bottom: 0; left: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
  background: linear-gradient(135deg, rgba(224, 182, 78, 0.08), rgba(224, 182, 78, 0.16));
}
.eps-vdraft-ic { font-size: 26px; }
.eps-vdraft-t { font-size: 11px; font-weight: 700; color: var(--ad-brand); }
.eps-vbadge {
  position: absolute; top: 7px; left: 7px; z-index: 2;
  padding: 3px 8px; border-radius: 7px; font-size: 10.5px; font-weight: 700;
  color: var(--ad-brand-contrast); background: var(--ad-brand);
}
/* 派生版本（字幕版/剪辑版）：暗底金字，与本体（金底）区分层级 */
.eps-vbadge.sub {
  background: rgba(13, 13, 20, 0.72); color: var(--ad-brand);
  border: 1px solid rgba(224, 182, 78, 0.45);
}
/* 已审角标（版本角标下方；绿底白字示「通过」语义，与分镜卡已审角标同款） */
.eps-vbadge.ok {
  top: 38px; background: var(--ad-success); color: #fff;
}
.eps-vbadge.res {
  left: auto; right: 7px; font-weight: 600;
  background: rgba(15, 23, 42, 0.78); color: rgba(255, 255, 255, 0.9);
}
/* 海报角落信息：时长右下（视频 App 惯例），生成时间左下 */
.eps-vdur {
  position: absolute; right: 8px; bottom: 8px; z-index: 2;
  padding: 2px 7px; border-radius: 6px;
  background: rgba(0, 0, 0, 0.62); color: rgba(255, 255, 255, 0.92);
  font-family: var(--ad-font-mono); font-size: 10.5px; line-height: 1.5;
}
.eps-vdate {
  position: absolute; left: 9px; bottom: 10px; z-index: 2;
  font-size: 10px; color: rgba(255, 255, 255, 0.78);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  font-variant-numeric: tabular-nums;
}
/* 操作栏：等宽单元（图标上、文字下）+ 细分隔线，替代旧的彩色按钮堆 */
.eps-vbar { display: flex; align-items: stretch; background: var(--ad-inset); }
.eps-vcell {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; padding: 9px 4px 8px;
  font-size: 10.5px; line-height: 1.3; text-align: center; color: var(--ad-text-soft);
}
.eps-vcell + .eps-vcell { border-left: 1px solid var(--ad-line); }
.eps-vcell:active { background: var(--ad-elev); }
.eps-vcell.del { color: var(--ad-danger); }
.eps-vcell.dis { opacity: 0.45; }
</style>
