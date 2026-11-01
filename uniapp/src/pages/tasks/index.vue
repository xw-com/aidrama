<script setup>
/**
 * 任务中心（Tab）：proposal「任务中心」—— ptop 标题(进行中 chip) + 筛选 chips + tcard 列表。
 * 数据逻辑与 client TasksView 一致：服务端分页 + jobs store 就地合并 + 终态跃迁补拉。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { onReachBottom, onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { useJobsStore } from '../../stores/jobs';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { jobApi } from '../../api';
import { taskName } from '../../utils/task';
import { toast } from '../../utils/ui';
import { statusBarHeight } from '../../utils/system';
import AdTabbar from '../../components/ad-tabbar/ad-tabbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';

const { t } = useI18n();
const jobs = useJobsStore();
const auth = useAuthStore();
const theme = useThemeStore();

const typeLabel = (code) => t('task.type.' + code);
const STATUS_CLS = { pending: 'glass', running: 'teal', succeeded: 'ok', failed: 'bad', cancelled: 'glass' };
const statusCls = (code) => STATUS_CLS[code] || 'glass';

const filter = ref('all');
const filters = computed(() => [
  { key: 'all', label: t('common.all') },
  { key: 'pending', label: t('task.status.pending') },
  { key: 'active', label: t('task.status.running') },
  { key: 'succeeded', label: t('task.status.succeeded') },
  { key: 'failed', label: t('task.status.failed') },
  { key: 'cancelled', label: t('task.status.cancelled') },
]);

const page = ref(1);
const size = ref(10);
const rows = ref([]);
const total = ref(0);
const loading = ref(false);

// "排队中" = pending；"进行中"只含 running，排队任务不再混入
const statusParam = computed(() => {
  if (filter.value === 'pending') return 'pending';
  if (filter.value === 'active') return 'running';
  if (filter.value === 'succeeded') return 'succeeded';
  if (filter.value === 'failed') return 'failed';
  if (filter.value === 'cancelled') return 'cancelled';
  return undefined;
});

// 竞态守卫：切页签/触底翻页/下拉刷新/轮询补拉都可能并发在途，先发的慢回包若照单全收，
// 旧页签的行（含排队中任务）会被 concat 进新页签列表——「已完成里出现排队中」即此因。
// 序号不等的过期回包整包丢弃，loading 也只归最新的请求管。
let fetchSeq = 0;
async function fetchPage() {
  const seq = ++fetchSeq;
  loading.value = true;
  try {
    const res = await jobApi.list({ page: page.value, size: size.value, status: statusParam.value });
    if (seq !== fetchSeq) return; // 已有更新的请求接管渲染，丢弃过期回包
    rows.value = page.value === 1 ? (res.rows || []) : rows.value.concat(res.rows || []);
    total.value = res.total || 0;
  } catch { /* http 层已提示 */ }
  finally { if (seq === fetchSeq) loading.value = false; }
}

function setFilter(key) {
  filter.value = key;
  page.value = 1;
  rows.value = [];
  fetchPage();
}
function loadMore() {
  if (loading.value || rows.value.length >= total.value) return;
  page.value += 1;
  fetchPage();
}

// 顶部「进行中 N」chip 只数 running：排队中(pending)不算进行中
const running = computed(() => jobs.items.filter((j) => j.status === 'running').length);

function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function duration(j) {
  if (!j?.created_at) return '-';
  const start = new Date(j.created_at).getTime();
  const end = j.updated_at ? new Date(j.updated_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return t('task.durationSec', { n: sec });
  return t('task.durationMin', { m: Math.floor(sec / 60), s: sec % 60 });
}

// 查看结果跳转：按任务类型直达具体目标并选中（ref_id 语义随类型不同，见各分支注释）。
// 各目标页深链参数：storyboard ?sid= 定位分镜、episodes ?eid/?vjob= 选集/高亮成片、
// writer ?sid= 预选草稿、outline ?pid= 剧本大纲、assets ?kind= 预选资产类型页签、
// asset-edit ?aid= 直开资产。缺失字段时逐级兜底到上一级页面。
const sbUrl = (pid, eid, sid) => `/pages/workspace/storyboard?pid=${pid}&eid=${eid}${sid ? `&sid=${sid}` : ''}`;
const wsUrl = (pid) => `/pages/workspace/index?id=${pid}`;
function resultUrl(j) {
  const pid = j.project_id;
  const eid = j.episode_id;
  const rid = j.ref_id;
  switch (j.type) {
    // ref_id = 分镜 id（storyboard.routes）
    case 'segment_generate':
    case 'segment_video':
    case 'segment_erase_subtitle':
    case 'segment_prompt':
      return pid && eid ? sbUrl(pid, eid, rid) : (pid ? wsUrl(pid) : null);
    // 批量串行/并发生视频（整集队列）：jobs.activeOf 按 episode_id 命中，ref_id 语义不定 → 只定位到集
    case 'segment_video_batch':
    case 'segment_video_batch_concurrent':
      return pid && eid ? sbUrl(pid, eid) : (pid ? wsUrl(pid) : null);
    // ref_id 为空，只有 episode_id → 定位到集
    case 'storyboard_script':
      return pid && eid ? sbUrl(pid, eid) : (pid ? wsUrl(pid) : null);
    // 合成成片 → 分集成片页选中该集
    case 'video_synthesis':
      return pid && eid ? `/pages/workspace/episodes?pid=${pid}&eid=${eid}` : (pid ? wsUrl(pid) : null);
    // ref_id = 源成片 job_id → 成片页高亮该成片（含字幕版/剪辑版派生行）
    case 'video_subtitle':
    case 'subtitle_correct':
      return pid && eid ? `/pages/workspace/episodes?pid=${pid}&eid=${eid}&vjob=${rid}` : (pid ? wsUrl(pid) : null);
    // 剪辑导出：meta.editSource='segment' 时 ref_id = 分镜 id；否则 = 源成片 job_id → 剪辑页
    case 'video_edit':
      if (j.meta?.editSource === 'segment') return pid && eid ? sbUrl(pid, eid, rid) : (pid ? wsUrl(pid) : null);
      return pid && rid ? `/pages/workspace/clip?pid=${pid}&vid=${rid}` : (pid ? wsUrl(pid) : null);
    // 资产生图 → 资产库对应类型页签（result.asset.kind）；老任务无 result 时落默认页签
    case 'asset_image': {
      const kind = j.result?.asset?.kind;
      const kq = kind ? `&kind=${kind}` : '';
      return pid ? `/pages/workspace/assets?pid=${pid}${kq}` : null;
    }
    // 资产 AI 润色提示词：ref_id = 资产 id → 直开资产编辑（不带 kind，由回捞的资产自身决定）
    case 'asset_prompt':
      return pid && rid ? `/pages/workspace/asset-edit?pid=${pid}&aid=${rid}` : (pid ? `/pages/workspace/assets?pid=${pid}` : null);
    // 提取资产：项目级产物 → 资产库
    case 'asset_extract':
      return pid ? `/pages/workspace/assets?pid=${pid}` : null;
    // 剧本项目无 project_id：ref_id = 剧本草稿 id（episode_detail 的是分集 id，选不中，不带 sid）
    case 'script_outline':
    case 'episode_split':
      return `/pages/create/writer${rid ? `?sid=${rid}` : ''}`;
    case 'episode_detail':
      return '/pages/create/writer';
    // 导入/拆分剧本（本地 JS，零积分）：项目级产物 → 剧本大纲页
    case 'script_import':
    case 'script_parse':
      return pid ? `/pages/workspace/outline?pid=${pid}` : null;
    default:
      return pid ? wsUrl(pid) : null;
  }
}
function openResult(j) {
  const url = resultUrl(j);
  if (url) uni.navigateTo({ url });
}

async function cancel(j) {
  try {
    await jobs.cancel(j.id);
    toast(t('task.status.cancelled'), 'success');
    await fetchPage();
    auth.refreshCredits();
  } catch { /* store/http 层已提示 */ }
}

// ===== 删除历史任务：按状态（全部/已完成/失败）+ 时间档位（所有/一周/一月/一年前）批量清理 =====
const cleanupOpen = ref(false);
const cleanupStatus = ref('all');
const cleanupBefore = ref('week');
const cleanupLoading = ref(false);
const cleanupStatusOptions = computed(() => [
  { key: 'all', label: t('common.all') },
  { key: 'succeeded', label: t('task.status.succeeded') },
  { key: 'failed', label: t('task.status.failed') },
  { key: 'cancelled', label: t('task.status.cancelled') },
]);
const cleanupBeforeOptions = computed(() => [
  { key: 'all', label: t('task.cleanupAll') },
  { key: 'week', label: t('task.cleanupWeek') },
  { key: 'month', label: t('task.cleanupMonth') },
  { key: 'year', label: t('task.cleanupYear') },
]);
async function doCleanup() {
  if (cleanupLoading.value) return;
  cleanupLoading.value = true;
  try {
    const r = await jobs.cleanup({ status: cleanupStatus.value, before: cleanupBefore.value });
    cleanupOpen.value = false;
    const n = r?.deleted || 0;
    toast(n > 0 ? t('task.cleanupDone', { n }) : t('task.cleanupNone'), 'success');
    page.value = 1;
    rows.value = [];
    await fetchPage();
  } catch { /* store/http 层已提示 */ }
  finally { cleanupLoading.value = false; }
}

// 运行中任务超过 10 分钟可取消并退款；批量串行视频任务支持立即取消
const RUNNING_TIMEOUT_MS = 10 * 60 * 1000;
const now = ref(Date.now());
let nowTimer = null;
function canCancelRunning(row) {
  if (row.status !== 'running') return false;
  if (row.type === 'segment_video_batch') return true;
  return (now.value - new Date(row.updated_at).getTime()) > RUNNING_TIMEOUT_MS;
}

// jobs store 就地合并渲染；仅当本页任一任务进入终态时补拉一次分页
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const liveById = computed(() => {
  const m = {};
  for (const j of jobs.items || []) m[j.id] = j;
  return m;
});
const displayRows = computed(() => rows.value.map((r) => liveById.value[r.id] || r));
let lastTerminalSig = null;
function terminalSig() {
  return jobs.items
    .filter((j) => rows.value.some((r) => r.id === j.id) && TERMINAL.includes(j.status))
    .map((j) => j.id).sort((a, b) => a - b).join(',');
}
watch(() => jobs.items, () => {
  if (lastTerminalSig === null) return; // 首次轮询回包只记基线
  const sig = terminalSig();
  if (sig !== lastTerminalSig) {
    lastTerminalSig = sig;
    fetchPage();
  }
});

const ticoIcon = (type) => {
  if (/video|compose|subtitle/.test(type)) return 'video';
  if (/image|asset|extract|cover|generate/.test(type)) return 'drop'; // segment_generate 生图归图片类
  if (/storyboard|script|outline|prompt|episode/.test(type)) return 'spark'; // episode_split/detail 文稿类
  return 'tasks';
};

onMounted(() => {
  // 未登录兜底（正常由 TabBar/入口 requireLogin 确认框拦截，deep-link 直达才会走到这里）
  // 鸿蒙端：reLaunch 不绘制，用 redirectTo
  if (!auth.isLoggedIn) { uni.redirectTo({ url: '/pages/login/index' }); return; }
  fetchPage();
  jobs.fetchAll().then(() => {
    lastTerminalSig = terminalSig();
    jobs.ensurePolling();
  });
  nowTimer = setInterval(() => { now.value = Date.now(); }, 30000);
});
// 触底加载下一页（loadMore 自带 loading / 是否已到底守卫）
onReachBottom(() => loadMore());
// 下拉刷新：回到第一页重拉任务列表
onPullDownRefresh(async () => {
  if (!auth.isLoggedIn) { uni.stopPullDownRefresh(); return; }
  page.value = 1;
  try {
    await fetchPage();
    await jobs.fetchAll();
    lastTerminalSig = terminalSig();
  } finally { uni.stopPullDownRefresh(); }
});
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });
</script>

<template>
  <view class="ad-page with-tabbar" :class="theme.rootCls">
    <!-- 头部 -->
    <view class="ptop" :style="{ paddingTop: statusBarHeight() + 6 + 'px' }">
      <view>
        <view class="ptitle">{{ t('task.title') }}</view>
        <view class="psub">{{ t('task.subtitle') }}</view>
      </view>
      <view class="ptop-r">
        <view v-if="running" class="chip teal sm"><view class="pulse" /> {{ running }} {{ t('mobile.tasks.runningUnit') }}</view>
        <view class="mbtn ghost sm cleanup" @tap="cleanupOpen = true">{{ t('task.cleanup') }}</view>
      </view>
    </view>

    <!-- 筛选 -->
    <view class="chips">
      <text v-for="f in filters" :key="f.key" class="pchip" :class="{ on: filter === f.key }" @tap="setFilter(f.key)">{{ f.label }}</text>
    </view>

    <!-- 任务卡 -->
    <view v-for="row in displayRows" :key="row.id" class="card tcard">
      <view class="ttop">
        <view class="tico"><m-icon :name="ticoIcon(row.type)" :size="18" /></view>
        <view class="tt">
          <text class="tname">{{ taskName(row, typeLabel(row.type)) }}</text>
          <text class="tsub">{{ row.meta?.projectName || '' }}<template v-if="row.meta?.episodeTitle"> · {{ row.meta.episodeTitle }}</template></text>
        </view>
        <text class="chip sm" :class="statusCls(row.status)">
          <view v-if="row.status === 'running'" class="pulse" /> {{ t('task.status.' + row.status) }}
        </text>
      </view>
      <view v-if="['pending', 'running'].includes(row.status)" class="tprog">
        <view class="bar"><view class="bar-i" :style="{ width: (row.progress || 0) + '%' }" /></view>
        <text class="pct">{{ row.progress || 0 }}%</text>
      </view>
      <view v-if="row.stage" class="od-stage">{{ row.stage }}</view>
      <view v-if="row.error" class="terr">{{ row.error }}</view>
      <view class="tfoot">
        <text class="rt">{{ t('common.credits') }} {{ row.status === 'succeeded' ? (row.credits_used || 0) : '-' }}</text>
        <text class="rt">{{ fmtDate(row.created_at) }}</text>
        <text class="rt mono">{{ duration(row) }}</text>
      </view>
      <view v-if="row.status === 'pending' || (row.status === 'running' && canCancelRunning(row)) || (row.status === 'succeeded' && resultUrl(row))" class="tact">
        <view
          v-if="row.status === 'pending' || (row.status === 'running' && canCancelRunning(row))"
          class="mbtn ghost sm"
          @tap="cancel(row)"
        >{{ t('common.cancel') }}</view>
        <view v-else class="mbtn soft sm" @tap="openResult(row)">{{ t('task.viewResult') }}</view>
      </view>
    </view>

    <view v-if="!displayRows.length && !loading" class="ad-empty"><text class="et">{{ t('task.emptyTitle') }}</text></view>
    <view v-if="loading" class="ad-loading"><text>{{ t('common.loading') }}</text></view>
    <view v-if="!loading && displayRows.length >= total && displayRows.length" class="ad-endfoot"><text>{{ t('mobile.common.noMore') }}</text></view>
    <view style="height: 30px" />

    <AdTabbar current="tasks" />
    <AdDialog />

    <!-- 删除历史任务：仅清理已完成/失败的记录，不影响项目内已生成内容 -->
    <AdSheet v-model:show="cleanupOpen" :title="t('task.cleanupTitle')">
      <view class="ck-body">
        <text class="ck-label">{{ t('task.cleanupStatus') }}</text>
        <view class="ck-opts">
          <view
            v-for="o in cleanupStatusOptions"
            :key="o.key"
            class="ck-opt"
            :class="{ on: cleanupStatus === o.key }"
            @tap="cleanupStatus = o.key"
          >
            <text>{{ o.label }}</text>
          </view>
        </view>
        <text class="ck-label">{{ t('task.cleanupBefore') }}</text>
        <view class="ck-opts">
          <view
            v-for="o in cleanupBeforeOptions"
            :key="o.key"
            class="ck-opt"
            :class="{ on: cleanupBefore === o.key }"
            @tap="cleanupBefore = o.key"
          >
            <text>{{ o.label }}</text>
          </view>
        </view>
        <text class="ck-tip">{{ t('task.cleanupTip') }}</text>
        <view class="ck-btns">
          <view class="mbtn ghost" @tap="cleanupOpen = false"><text>{{ t('common.cancel') }}</text></view>
          <view class="mbtn danger" @tap="doCleanup"><text>{{ t('common.delete') }}</text></view>
        </view>
      </view>
    </AdSheet>
  </view>
</template>

<style scoped>
.tname { font-weight: 700; font-size: 14px; color: var(--ad-text); }
.tsub { font-size: 11px; color: var(--ad-text-mut); margin-top: 2px; }
.bar-i { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #f2d489, #e0b64e); transition: width 0.4s; }
.pct { font-size: 11px; color: var(--ad-text-mut); margin-left: 8px; min-width: 34px; text-align: right; }
.od-stage { margin-top: 8px; font-size: 12px; color: var(--ad-text-mut); }
.tact { display: flex; justify-content: flex-end; margin-top: 10px; }
.ad-loading { padding: 24px 0; text-align: center; color: var(--ad-text-mut); font-size: 12px; }
.ad-endfoot { padding: 14px 0; text-align: center; color: var(--ad-text-mut); font-size: 11px; }
.ad-empty { padding: 60px 30px; text-align: center; color: var(--ad-text-mut); font-size: 13px; }

/* 删除历史任务弹层 */
.ptop-r { display: flex; gap: 9px; align-items: center; }
/* 删除历史按钮：比自然宽度(「删除历史」4字≈78px)放宽30%；左间距=margin 11px+flex gap 9px=20px */
.ptop-r .mbtn.cleanup { min-width: 101px; margin-left: 11px; }
.ck-body { display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px; }
.ck-label { font-size: 13px; font-weight: 600; color: var(--ad-text-soft); }
.ck-opts { display: flex; gap: 8px; }
.ck-opt {
  flex: 1; min-height: 44px; border-radius: 12px;
  border: 1px solid var(--ad-line); background: var(--ad-inset);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 600; color: var(--ad-text-soft);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px;
}
.ck-opt.on { border-color: var(--ad-danger); color: var(--ad-danger); }
.ck-tip { font-size: 11.5px; line-height: 1.7; color: var(--ad-text-mut); }
.ck-btns { display: flex; gap: 10px; padding-top: 2px; }
.ck-btns .mbtn { flex: 1; }
</style>
