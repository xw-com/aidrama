<script setup>
// 任务管理 admin：全员任务列表/筛选 / 取消（running 可强制、绕过 10 分钟，退款给属主）/ 删除 / 批量清理终态记录
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { jobAdminApi } from '../api';
import { taskName } from '../utils/task';

const { t, te } = useI18n();

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '-');

// 后端 job type 全集（label 复用 task.type.*；缺键回退原码，见 i18n 叶子键约定）
const JOB_TYPES = [
  'script_outline', 'script_parse', 'episode_split', 'episode_detail',
  'asset_extract', 'asset_image', 'asset_prompt',
  'storyboard_script', 'segment_generate', 'segment_prompt', 'segment_video',
  'segment_video_batch', 'segment_video_batch_concurrent', 'segment_erase_subtitle',
  'video_synthesis', 'video_subtitle', 'subtitle_correct', 'video_edit',
  'project_cover', 'char_option_image', 'char_option_image_batch',
];
const typeLabel = (code) => (te(`task.type.${code}`) ? t(`task.type.${code}`) : code);

const STATUS_TYPE = { pending: 'info', running: 'warning', succeeded: 'success', failed: 'danger', cancelled: 'info' };
const statusMeta = (code) => ({ label: t('task.status.' + code), type: STATUS_TYPE[code] || 'info' });

const userName = (row) => (row.user ? (row.user.nickname || row.user.username || `#${row.user.id}`) : `#${row.user_id}`);

function duration(j) {
  if (!j?.created_at) return '-';
  const start = new Date(j.created_at).getTime();
  const end = j.updated_at ? new Date(j.updated_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return t('task.durationSec', { n: sec });
  return t('task.durationMin', { m: Math.floor(sec / 60), s: sec % 60 });
}

// ===== 列表 =====
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const size = 20;
const loading = ref(false);
const fStatus = ref('');
const fType = ref('');
const fKeyword = ref('');

async function load() {
  loading.value = true;
  try {
    const params = { page: page.value, size };
    if (fStatus.value) params.status = fStatus.value;
    if (fType.value) params.type = fType.value;
    if (fKeyword.value.trim()) params.keyword = fKeyword.value.trim();
    const data = await jobAdminApi.list(params);
    rows.value = data.rows || [];
    total.value = data.total || 0;
  } finally {
    loading.value = false;
  }
}

function search() { page.value = 1; load(); }

// ===== 取消（pending 撤队；running 强制取消并退款给属主） =====
const cancellingId = ref(0);
async function cancel(row) {
  const running = row.status === 'running';
  try {
    await ElMessageBox.confirm(
      t(running ? 'jobAdmin.cancelForce' : 'jobAdmin.cancelPending'),
      t('common.tip'),
      { type: 'warning' },
    );
  } catch { return; }
  cancellingId.value = row.id;
  try {
    await jobAdminApi.cancel(row.id);
    ElMessage.success(t('task.status.cancelled'));
    load();
  } finally {
    cancellingId.value = 0;
  }
}

// ===== 删除单条终态记录 =====
const deletingId = ref(0);
async function remove(row) {
  try {
    await ElMessageBox.confirm(t('jobAdmin.deleteConfirm'), t('common.tip'), { type: 'warning' });
  } catch { return; }
  deletingId.value = row.id;
  try {
    await jobAdminApi.remove(row.id);
    ElMessage.success(t('common.deleteSuccess'));
    load();
  } finally {
    deletingId.value = 0;
  }
}

// ===== 详情（单独拉取，含大 JSON 字段 result） =====
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref(null);
const pretty = (v) => (v == null ? '' : JSON.stringify(v, null, 2));

async function openDetail(row) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await jobAdminApi.get(row.id);
  } finally {
    detailLoading.value = false;
  }
}

// ===== 批量清理终态记录（复用任务中心的档位文案 task.cleanup*） =====
const cleanupVisible = ref(false);
const cleanupStatus = ref('all');
const cleanupBefore = ref('week');
const cleanupUserId = ref(null);
const cleanupLoading = ref(false);
const cleanupStatusOptions = [
  { key: 'all', labelKey: 'common.all' },
  { key: 'succeeded', labelKey: 'task.status.succeeded' },
  { key: 'failed', labelKey: 'task.status.failed' },
  { key: 'cancelled', labelKey: 'task.status.cancelled' },
];
async function doCleanup() {
  cleanupLoading.value = true;
  try {
    const r = await jobAdminApi.cleanup({
      status: cleanupStatus.value,
      before: cleanupBefore.value,
      user_id: cleanupUserId.value || undefined,
    });
    cleanupVisible.value = false;
    const n = r?.deleted || 0;
    if (n > 0) ElMessage.success(t('task.cleanupDone', { n }));
    else ElMessage.info(t('task.cleanupNone'));
    page.value = 1;
    await load();
  } catch { /* 拦截器已提示 */ }
  finally { cleanupLoading.value = false; }
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('jobAdmin.title') }}</div>
        <div class="ad-sub">{{ t('jobAdmin.subtitle') }}</div>
      </div>
      <div class="ad-rule ja-rule" />

      <div class="ad-card ja-block">
        <div class="ja-filters">
          <el-select v-model="fStatus" clearable :placeholder="t('jobAdmin.f.status')" style="width: 130px;" @change="search">
            <el-option v-for="s in ['pending', 'running', 'succeeded', 'failed', 'cancelled']" :key="s" :value="s" :label="t('task.status.' + s)" />
          </el-select>
          <el-select v-model="fType" clearable filterable :placeholder="t('jobAdmin.f.type')" style="width: 170px;" @change="search">
            <el-option v-for="ty in JOB_TYPES" :key="ty" :value="ty" :label="typeLabel(ty)" />
          </el-select>
          <el-input v-model="fKeyword" clearable :placeholder="t('jobAdmin.f.keyword')" style="width: 250px;" @keyup.enter="search" @clear="search" />
          <el-button @click="search"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
          <div class="ja-flex-spacer"></div>
          <el-button plain type="danger" size="small" @click="cleanupVisible = true">{{ t('task.cleanup') }}</el-button>
        </div>

        <div class="ja-table-wrap" v-loading="loading">
          <el-table :data="rows" size="small">
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column :label="t('jobAdmin.col.user')" min-width="120" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="cell-user">
                  <span>{{ userName(row) }}</span>
                  <span class="ja-sub">{{ row.user?.external_id ? `xw:${row.user.external_id}` : `#${row.user_id}` }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('task.column.task')" min-width="190">
              <template #default="{ row }">
                <div class="cell-user">
                  <span class="ja-task-name">{{ taskName(row, typeLabel(row.type)) }}</span>
                  <span class="ja-sub">{{ row.meta?.projectName || '' }}<template v-if="row.meta?.episodeTitle"> · {{ row.meta.episodeTitle }}</template></span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('common.status')" width="90">
              <template #default="{ row }">
                <el-tag :type="statusMeta(row.status).type" size="small" effect="plain">{{ statusMeta(row.status).label }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('task.column.progress')" min-width="170">
              <template #default="{ row }">
                <el-progress
                  :percentage="row.progress || 0"
                  :status="row.status === 'failed' ? 'exception' : row.status === 'succeeded' ? 'success' : undefined"
                  :stroke-width="8"
                />
                <div class="ja-stage">{{ row.stage || '' }}</div>
                <div v-if="row.error" class="ja-err">{{ row.error }}</div>
              </template>
            </el-table-column>
            <el-table-column :label="t('common.credits')" width="80" align="center">
              <template #default="{ row }">
                <span class="ad-muted">{{ row.status === 'succeeded' ? (row.credits_used || 0) : '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('task.submittedAt')" width="160">
              <template #default="{ row }"><span class="ad-muted">{{ fmtTime(row.created_at) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('task.column.duration')" width="100">
              <template #default="{ row }"><span class="ad-muted">{{ duration(row) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('common.actions')" width="170" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click="openDetail(row)">{{ t('jobAdmin.detail') }}</el-button>
                <el-button
                  v-if="row.status === 'pending' || row.status === 'running'"
                  size="small" text type="warning"
                  :loading="cancellingId === row.id"
                  @click="cancel(row)"
                >{{ t('common.cancel') }}</el-button>
                <el-button
                  v-else
                  size="small" text type="danger"
                  :loading="deletingId === row.id"
                  @click="remove(row)"
                >{{ t('common.delete') }}</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <span class="ad-muted">{{ t('common.noData') }}</span>
            </template>
          </el-table>
        </div>
        <el-pagination
          layout="total, prev, pager, next" :total="total" :page-size="size" :current-page="page"
          @current-change="(p) => { page = p; load(); }"
        />
      </div>

      <!-- 详情弹窗 -->
      <el-dialog v-model="detailVisible" :title="t('jobAdmin.detailTitle', { id: detail?.id || '' })" width="min(680px, 94vw)" top="6vh">
        <div v-loading="detailLoading" class="ja-detail">
          <template v-if="detail">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item :label="'ID'">{{ detail.id }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.col.user')">
                {{ userName(detail) }}<template v-if="detail.user?.external_id">（xw:{{ detail.user.external_id }}）</template>
              </el-descriptions-item>
              <el-descriptions-item :label="t('common.type')">{{ typeLabel(detail.type) }}<span class="ja-sub">（{{ detail.type }}）</span></el-descriptions-item>
              <el-descriptions-item :label="t('common.status')">
                <el-tag :type="statusMeta(detail.status).type" size="small" effect="plain">{{ statusMeta(detail.status).label }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('task.column.progress')">{{ detail.progress || 0 }}% · {{ detail.stage || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('common.credits')">{{ detail.credits_used || 0 }}</el-descriptions-item>
              <el-descriptions-item :label="t('task.submittedAt')">{{ fmtTime(detail.created_at) }}</el-descriptions-item>
              <el-descriptions-item :label="t('common.updatedAt')">{{ fmtTime(detail.updated_at) }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.d.project')">{{ detail.project_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.d.episode')">{{ detail.episode_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.d.refId')">{{ detail.ref_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.d.cancelReason')">{{ detail.meta?.cancel_reason || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.d.refunded')" v-if="detail.meta?.refunded_credits">{{ detail.meta.refunded_credits }}</el-descriptions-item>
            </el-descriptions>
            <template v-if="detail.error">
              <div class="ja-json-label">{{ t('jobAdmin.d.error') }}</div>
              <pre class="ja-json ja-json-err">{{ detail.error }}</pre>
            </template>
            <template v-if="detail.meta && Object.keys(detail.meta).length">
              <div class="ja-json-label">meta</div>
              <pre class="ja-json">{{ pretty(detail.meta) }}</pre>
            </template>
            <template v-if="detail.result">
              <div class="ja-json-label">result</div>
              <pre class="ja-json">{{ pretty(detail.result) }}</pre>
            </template>
          </template>
        </div>
      </el-dialog>

      <!-- 批量清理终态记录（档位文案复用任务中心 task.cleanup*） -->
      <el-dialog v-model="cleanupVisible" :title="t('task.cleanupTitle')" width="min(460px, 94vw)">
        <div class="cf-row">
          <div class="cf-label">{{ t('task.cleanupStatus') }}</div>
          <el-radio-group v-model="cleanupStatus">
            <el-radio-button v-for="o in cleanupStatusOptions" :key="o.key" :value="o.key">{{ t(o.labelKey) }}</el-radio-button>
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
        <div class="cf-row">
          <div class="cf-label">{{ t('jobAdmin.cleanupUser') }}</div>
          <el-input-number v-model="cleanupUserId" :min="1" :controls="false" :placeholder="t('jobAdmin.cleanupUserPh')" style="width: 160px;" />
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
.ja-rule { margin-bottom: 16px; }
.ja-block { padding: var(--ad-sp-5) var(--ad-sp-6); }
.ja-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.ja-flex-spacer { flex: 1; }
.ja-table-wrap { overflow-x: auto; }
.cell-user { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ja-sub { font-size: 12px; color: var(--ad-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ja-task-name { font-weight: 600; color: var(--ad-text); font-size: 13px; }
.ja-stage { font-size: 12px; color: var(--ad-text-muted); margin-top: 2px; }
.ja-err {
  font-size: 12px; color: var(--ad-danger); margin-top: 2px;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}

/* 详情弹窗 */
.ja-detail { min-height: 120px; max-height: 70vh; overflow-y: auto; }
.ja-json-label { font-size: 12px; font-weight: 700; color: var(--ad-text-muted); margin: 14px 0 6px; }
.ja-json {
  margin: 0; padding: 10px 12px; border-radius: 8px;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border);
  font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;
  max-height: 240px; overflow-y: auto;
}
.ja-json-err { color: var(--ad-danger); }

/* 清理弹窗 */
.cf-row { margin-bottom: 14px; }
.cf-label { font-size: 13px; color: var(--ad-text-muted); margin-bottom: 8px; }
.cf-tip { font-size: 12px; line-height: 1.7; color: var(--ad-text-muted); background: var(--ad-bg-soft); border-radius: 8px; padding: 8px 12px; }
</style>
