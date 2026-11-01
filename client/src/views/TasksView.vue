<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useJobsStore } from '../stores/jobs';
import { useAuthStore } from '../stores/auth';
import { jobApi } from '../api';
import { taskName } from '../utils/task';
import { ElMessage } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();
const { t } = useI18n();
const jobs = useJobsStore();
const auth = useAuthStore();

const typeLabel = (code) => t('task.type.' + code);
const STATUS_TYPE = { pending: 'info', running: 'warning', succeeded: 'success', failed: 'danger', cancelled: 'info' };
const statusMeta = (code) => ({ label: t('task.status.' + code), type: STATUS_TYPE[code] || 'info' });

const filter = ref('all'); // all | pending | active | succeeded | failed | cancelled
const filters = computed(() => [
  { key: 'all', label: t('common.all') },
  { key: 'pending', label: t('task.status.pending') },
  { key: 'active', label: t('task.status.running') },
  { key: 'succeeded', label: t('task.status.succeeded') },
  { key: 'failed', label: t('task.status.failed') },
  { key: 'cancelled', label: t('task.status.cancelled') },
]);

// 服务端分页：每页 10 条
const page = ref(1);
const size = ref(10);
const rows = ref([]);
const total = ref(0);
const loading = ref(false);

// 过滤 → 服务端 status 参数（"排队中" = pending；"进行中"只含 running，排队任务不再混入）
const statusParam = computed(() => {
  if (filter.value === 'pending') return 'pending';
  if (filter.value === 'active') return 'running';
  if (filter.value === 'succeeded') return 'succeeded';
  if (filter.value === 'failed') return 'failed';
  if (filter.value === 'cancelled') return 'cancelled';
  return undefined;
});

// 竞态守卫：切页签/轮询补拉/取消后重拉都可能并发在途，先发的慢回包若照单全收，
// 会把旧页签的行（含排队中任务）整页覆盖进新页签——「已完成里出现排队中」即此因。
let fetchSeq = 0;
async function fetchPage() {
  const seq = ++fetchSeq;
  loading.value = true;
  try {
    const res = await jobApi.list({ page: page.value, size: size.value, status: statusParam.value });
    if (seq !== fetchSeq) return; // 已有更新的请求接管渲染，丢弃过期回包
    rows.value = res.rows || [];
    total.value = res.total || 0;
  } catch { /* http 拦截器已提示 */ }
  finally { if (seq === fetchSeq) loading.value = false; }
}

function setFilter(key) {
  filter.value = key;
  page.value = 1;
  rows.value = []; // 立即清掉旧页签的行，切换瞬间不残留显示（回包由 fetchSeq 守卫）
  fetchPage();
}

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

// ===== 查看结果跳转（与 uniapp 任务中心 resultUrl 同口径：按任务类型直达具体目标并选中，
// ref_id 语义随类型不同，见各分支注释；缺失字段时逐级兜底到上一级页面）=====
// 落点收敛为四类：分镜编辑器（?sid= 定位镜）、工作台三步页（step=1 剧本大纲 /
// step=2 资产库 ?kind= 预选页签 / step=3 分集视频 ?eid/?vjob= 定位成片）、
// 在线剪辑器（源成片 job id，openResult 里走具名窗口）、编剧向导（?sid= 预选草稿）
const wsUrl = (pid) => ({ path: `/projects/${pid}` });
const wsStepUrl = (pid, step, extra) => ({ path: `/projects/${pid}`, query: { step, ...extra } });
const sbUrl = (pid, eid, sid) => ({ name: 'storyboard', params: { id: pid, eid }, query: sid ? { sid } : {} });
function resultLink(j) {
  const pid = j.project_id;
  const eid = j.episode_id;
  const rid = j.ref_id;
  switch (j.type) {
    // ref_id = 分镜 id → 分镜编辑器定位该镜
    case 'segment_generate':
    case 'segment_video':
    case 'segment_erase_subtitle':
    case 'segment_prompt':
      return pid && eid ? sbUrl(pid, eid, rid) : (pid ? wsUrl(pid) : null);
    // 批量串行/并发生视频（整集队列）：ref_id 语义不定 → 只定位到集
    case 'segment_video_batch':
    case 'segment_video_batch_concurrent':
    // ref_id 为空，只有 episode_id → 定位到集
    case 'storyboard_script':
      return pid && eid ? sbUrl(pid, eid) : (pid ? wsUrl(pid) : null);
    // 合成成片 → 工作台「分集视频」步定位到该集
    case 'video_synthesis':
      return pid && eid ? wsStepUrl(pid, '3', { eid }) : (pid ? wsUrl(pid) : null);
    // ref_id = 源成片 job_id → 分集视频步选中所在集并高亮该成片（含字幕版/剪辑版派生行）
    case 'video_subtitle':
    case 'subtitle_correct':
      return pid && eid ? wsStepUrl(pid, '3', { eid, vjob: rid }) : (pid ? wsUrl(pid) : null);
    // 剪辑导出：meta.editSource='segment' 时 ref_id = 分镜 id；否则 = 源成片 job_id → 在线剪辑器
    case 'video_edit':
      if (j.meta?.editSource === 'segment') return pid && eid ? sbUrl(pid, eid, rid) : (pid ? wsUrl(pid) : null);
      return pid && rid ? { path: `/editor/video/${rid}` } : (pid ? wsUrl(pid) : null);
    // 资产生图 → 资产库对应类型页签（result.asset.kind）；老任务无 result 时落默认页签
    case 'asset_image': {
      const kind = j.result?.asset?.kind;
      return pid ? wsStepUrl(pid, '2', kind ? { kind } : {}) : null;
    }
    // 资产 AI 润色提示词 / 提取资产：项目级产物 → 资产库（无独立资产编辑页，同 uniapp 缺页兜底）
    case 'asset_prompt':
    case 'asset_extract':
      return pid ? wsStepUrl(pid, '2') : null;
    // 剧本项目无 project_id：ref_id = 剧本草稿 id（episode_detail 的是分集 id，选不中，不带 sid）
    case 'script_outline':
    case 'episode_split':
      return { path: '/script-writer', query: rid ? { sid: rid } : {} };
    case 'episode_detail':
      return { path: '/script-writer' };
    // 导入/拆分剧本（本地 JS，零积分）：项目级产物 → 工作台「剧本大纲」步
    case 'script_import':
    case 'script_parse':
      return pid ? wsStepUrl(pid, '1') : null;
    default:
      return pid ? wsUrl(pid) : null;
  }
}
function openResult(j) {
  const link = resultLink(j);
  if (!link) return;
  // 在线剪辑器是独立全屏页：window.open 具名窗口打开（同分集页「在线剪辑」入口），其余站内跳转
  if (link.path?.startsWith('/editor/video/')) {
    const jobId = link.path.split('/').pop();
    window.open(link.path, `aieditor_${jobId}`)?.focus();
    return;
  }
  router.push(link);
}

async function cancel(j) {
  try {
    await jobs.cancel(j.id);
    ElMessage.success(t('task.status.cancelled'));
    await fetchPage();
    // 取消可能触发预扣积分退还，刷新余额显示
    auth.refreshCredits();
  } catch { /* store/拦截器已提示 */ }
}

// ===== 删除历史任务：按状态（全部/已完成/失败）+ 时间档位（所有/一周/一月/一年前）批量清理 =====
const cleanupVisible = ref(false);
const cleanupStatus = ref('all');
const cleanupBefore = ref('week');
const cleanupLoading = ref(false);
const cleanupStatusOptions = computed(() => [
  { key: 'all', label: t('common.all') },
  { key: 'succeeded', label: t('task.status.succeeded') },
  { key: 'failed', label: t('task.status.failed') },
  { key: 'cancelled', label: t('task.status.cancelled') },
]);
async function doCleanup() {
  cleanupLoading.value = true;
  try {
    const r = await jobs.cleanup({ status: cleanupStatus.value, before: cleanupBefore.value });
    cleanupVisible.value = false;
    const n = r?.deleted || 0;
    if (n > 0) ElMessage.success(t('task.cleanupDone', { n }));
    else ElMessage.info(t('task.cleanupNone'));
    page.value = 1;
    await fetchPage();
  } catch { /* store/拦截器已提示 */ }
  finally { cleanupLoading.value = false; }
}

// 运行中任务超过 10 分钟可取消并退款；批量串行视频任务支持立即取消（后端按段协同取消）。
// now 响应式定时刷新，按钮到期自动出现
const RUNNING_TIMEOUT_MS = 10 * 60 * 1000;
const now = ref(Date.now());
let nowTimer = null;
function canCancelRunning(row) {
  if (row.status !== 'running') return false;
  if (row.type === 'segment_video_batch') return true;
  return (now.value - new Date(row.updated_at).getTime()) > RUNNING_TIMEOUT_MS;
}

// store 每 2s 轮询（limit=50）拿到的是最新任务数据：本页行就地合并渲染，
// 不再每次轮询后重拉分页接口（原先 watch items 每两秒多打一次 GET /jobs）。
// 仅当本页任一任务进入终态时补拉一次，让分页计数/筛选口径回正。
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
  if (lastTerminalSig === null) return; // 首次轮询回包只记基线，不触发补拉
  const sig = terminalSig();
  if (sig !== lastTerminalSig) {
    lastTerminalSig = sig;
    fetchPage();
  }
});

onMounted(() => {
  fetchPage(); // 本页数据自管 loading，不与 store 同步互相等待
  // store 同步（/jobs?limit=50）异步走：不阻塞首屏，回包后再记基线并按需起轮询
  jobs.fetchAll().then(() => {
    lastTerminalSig = terminalSig();
    jobs.ensurePolling();
  });
  nowTimer = setInterval(() => { now.value = Date.now(); }, 30000);
});
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-flex-between ad-page-head" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg">{{ t('task.title') }}</div>
          <div class="ad-sub">{{ t('task.subtitle') }}</div>
        </div>
        <div class="head-right">
          <div class="tabs">
            <button v-for="f in filters" :key="f.key" class="tab" :class="{ active: filter === f.key }" @click="setFilter(f.key)">
              {{ f.label }}
            </button>
          </div>
          <el-button plain type="danger" size="small" @click="cleanupVisible = true">{{ t('task.cleanup') }}</el-button>
        </div>
      </div>
      <div class="ad-rule tk-rule" />

      <div class="ad-card table-wrap" v-loading="loading">
        <el-table :data="displayRows" row-key="id" style="width: 100%;">
          <template #empty>
            <EmptyState icon-component="Box" :title="t('task.emptyTitle')" :description="t('task.emptyDesc')" />
          </template>
          <el-table-column :label="t('task.column.task')" min-width="180">
            <template #default="{ row }">
              <div class="cell-task">
                <span class="t-name">{{ taskName(row, typeLabel(row.type)) }}</span>
                <span class="t-sub">{{ row.meta?.projectName || '' }}<template v-if="row.meta?.episodeTitle"> · {{ row.meta.episodeTitle }}</template></span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.status')" width="110">
            <template #default="{ row }">
              <el-tag :type="statusMeta(row.status).type" effect="light" size="small">{{ statusMeta(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('task.column.progress')" min-width="220">
            <template #default="{ row }">
              <el-progress
                :percentage="row.progress || 0"
                :status="row.status === 'failed' ? 'exception' : row.status === 'succeeded' ? 'success' : undefined"
                :stroke-width="8"
              />
              <div class="stage">{{ row.stage || '' }}</div>
              <div v-if="row.error" class="err">{{ row.error }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.credits')" width="80" align="center">
            <template #default="{ row }">
              <span v-if="row.status === 'succeeded'" class="ad-muted">{{ row.credits_used || 0 }}</span>
              <span v-else class="ad-muted">-</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('task.submittedAt')" width="130">
            <template #default="{ row }"><span class="ad-muted tnum">{{ fmtDate(row.created_at) }}</span></template>
          </el-table-column>
          <el-table-column :label="t('task.column.duration')" width="90">
            <template #default="{ row }"><span class="ad-muted tnum">{{ duration(row) }}</span></template>
          </el-table-column>
          <el-table-column :label="t('common.action')" width="130" align="center">
            <template #default="{ row }">
              <el-button v-if="row.status === 'pending'" link type="warning" size="small" @click="cancel(row)">{{ t('common.cancel') }}</el-button>
              <el-button v-else-if="row.status === 'running' && canCancelRunning(row)" link type="warning" size="small" @click="cancel(row)">{{ t('common.cancel') }}</el-button>
              <el-button v-else-if="row.status === 'running'" link size="small" disabled>{{ t('task.runningBtn') }}</el-button>
              <el-button v-else-if="row.status === 'succeeded' && resultLink(row)" link type="primary" size="small" @click="openResult(row)">{{ t('task.viewResult') }}</el-button>
              <span v-else class="ad-muted">-</span>
            </template>
          </el-table-column>
        </el-table>
        <!-- 手机端（≤768px）：表格换为纵向卡片，信息多行展示，免横向滚动（PC 端隐藏） -->
        <div class="task-cards" v-loading="loading">
          <EmptyState v-if="!displayRows.length && !loading" icon-component="Box" :title="t('task.emptyTitle')" :description="t('task.emptyDesc')" />
          <div v-for="row in displayRows" :key="row.id" class="task-card">
            <div class="tc-head">
              <div class="tc-titles">
                <div class="t-name">{{ taskName(row, typeLabel(row.type)) }}</div>
                <div class="t-sub">{{ row.meta?.projectName || '' }}<template v-if="row.meta?.episodeTitle"> · {{ row.meta.episodeTitle }}</template></div>
              </div>
              <el-tag :type="statusMeta(row.status).type" effect="light" size="small">{{ statusMeta(row.status).label }}</el-tag>
            </div>
            <el-progress
              :percentage="row.progress || 0"
              :status="row.status === 'failed' ? 'exception' : row.status === 'succeeded' ? 'success' : undefined"
              :stroke-width="8"
            />
            <div class="stage">{{ row.stage || '' }}</div>
            <div v-if="row.error" class="err">{{ row.error }}</div>
            <div class="tc-meta">
              <span>{{ t('common.credits') }}: <template v-if="row.status === 'succeeded'">{{ row.credits_used || 0 }}</template><template v-else>-</template></span>
              <span>{{ t('task.submittedAt') }}: {{ fmtDate(row.created_at) }}</span>
              <span>{{ t('task.column.duration') }}: {{ duration(row) }}</span>
            </div>
            <div class="tc-actions">
              <el-button v-if="row.status === 'pending'" link type="warning" size="small" @click="cancel(row)">{{ t('common.cancel') }}</el-button>
              <el-button v-else-if="row.status === 'running' && canCancelRunning(row)" link type="warning" size="small" @click="cancel(row)">{{ t('common.cancel') }}</el-button>
              <el-button v-else-if="row.status === 'running'" link size="small" disabled>{{ t('task.runningBtn') }}</el-button>
              <el-button v-else-if="row.status === 'succeeded' && resultLink(row)" link type="primary" size="small" @click="openResult(row)">{{ t('task.viewResult') }}</el-button>
            </div>
          </div>
        </div>
        <div v-if="total > 0" class="pager">
          <el-pagination
            v-model:current-page="page"
            :page-size="size"
            :total="total"
            :pager-count="5"
            layout="total, prev, pager, next"
            background
            @current-change="fetchPage"
          />
        </div>
      </div>

      <!-- 删除历史任务：仅清理已完成/失败/已取消的记录，不影响项目内已生成内容 -->
      <el-dialog v-model="cleanupVisible" :title="t('task.cleanupTitle')" width="min(440px, 94vw)">
        <div class="cf-row">
          <div class="cf-label">{{ t('task.cleanupStatus') }}</div>
          <el-radio-group v-model="cleanupStatus">
            <el-radio-button v-for="o in cleanupStatusOptions" :key="o.key" :value="o.key">{{ o.label }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="cf-row">
          <div class="cf-label">{{ t('task.cleanupBefore') }}</div>
          <el-radio-group v-model="cleanupBefore">
            <el-radio-button value="all">{{ t('task.cleanupAll') }}</el-radio-button>
            <el-radio-button value="week">{{ t('task.cleanupWeek') }}</el-radio-button>
            <el-radio-button value="month">{{ t('task.cleanupMonth') }}</el-radio-button>
            <el-radio-button value="year">{{ t('task.cleanupYear') }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="cf-tip">{{ t('task.cleanupTip') }}</div>
        <template #footer>
          <el-button @click="cleanupVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="danger" :loading="cleanupLoading" @click="doCleanup">{{ t('common.delete') }}</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.tk-rule { margin-bottom: 16px; }
.head-right { display: flex; align-items: flex-end; gap: 12px; }
.tabs { display: inline-flex; gap: 4px; border-bottom: 1px solid var(--ad-border); }
.tab {
  background: transparent; border: none; padding: 8px 14px; cursor: pointer;
  font-size: 14px; font-weight: 600; color: var(--ad-text-muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color 0.15s, background 0.15s;
}
.tab:hover { color: var(--ad-text); background: var(--ad-bg-soft); }
.tab.active { color: var(--ad-text); border-bottom-color: var(--ad-primary); }
.table-wrap { padding: 8px 8px 16px; }
.pager { display: flex; justify-content: flex-end; margin-top: 16px; }
.cell-task { display: flex; flex-direction: column; gap: 2px; }
.t-name { font-weight: 600; color: var(--ad-text); font-size: 14px; }
.t-sub { font-size: 12px; color: var(--ad-text-muted); }
.stage { font-size: 12px; color: var(--ad-text-muted); margin-top: 4px; }
.err { font-size: 12px; color: var(--ad-danger); margin-top: 2px; word-break: break-all; }

/* 删除历史任务弹窗 */
.cf-row { margin-bottom: 14px; }
.cf-label { font-size: 13px; color: var(--ad-text-muted); margin-bottom: 8px; }
.cf-tip { font-size: 12px; line-height: 1.7; color: var(--ad-text-muted); background: var(--ad-bg-soft); border-radius: 8px; padding: 8px 12px; }

/* 手机端卡片列表：默认隐藏，≤768px 替换 el-table（多行展示，免横向滚动） */
.task-cards { display: none; flex-direction: column; gap: 12px; }
.task-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 14px; border-radius: 12px;
  background: var(--ad-bg-soft);
  border: 1px solid var(--ad-border);
}
.tc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.tc-titles { min-width: 0; }
.tc-titles .t-sub { word-break: break-all; }
.tc-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ad-text-muted); }
.tc-actions { display: flex; justify-content: flex-end; }

/* 手机：表格隐藏改用卡片；分页居中并允许换行 */
@media (max-width: 768px) {
  .table-wrap :deep(.el-table) { display: none; }
  .task-cards { display: flex; }
  .table-wrap { padding: 4px 4px 12px; }
  .pager { justify-content: center; }
  .pager :deep(.el-pagination) { flex-wrap: wrap; justify-content: center; row-gap: 6px; max-width: 100%; }
  /* 分页条收敛：隐藏总条数、缩小按钮，避免撑出显示区 */
  .pager :deep(.el-pagination__total) { display: none; }
  .pager :deep(.el-pager li),
  .pager :deep(.el-pagination .btn-prev),
  .pager :deep(.el-pagination .btn-next) { min-width: 28px; height: 28px; }
}
</style>
