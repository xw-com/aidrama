<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { maintenanceApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import { taskName } from '../utils/task';

const { t } = useI18n();

const AUTO_REFRESH_MS = 10000; // 维护期间任务卡自动刷新间隔

const loading = ref(false);
const status = ref({ active: false });
const tasks = ref([]);
const autoRefresh = ref(true);
const dialogVisible = ref(false);
const submitting = ref(false);
const form = ref({ reason: '', expectedEndAt: null });
let timer = null;

async function refreshAll() {
  loading.value = true;
  try {
    [status.value, tasks.value] = await Promise.all([maintenanceApi.status(), maintenanceApi.tasks()]);
  } finally {
    loading.value = false;
  }
}

// 自动刷新仅在维护中开启（页面挂载期间轮询，离开即清理）
function syncTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  if (autoRefresh.value && status.value.active) timer = setInterval(refreshAll, AUTO_REFRESH_MS);
}
watch([autoRefresh, () => status.value.active], syncTimer);
onMounted(refreshAll);
onUnmounted(() => timer && clearInterval(timer));

function openStartDialog() {
  form.value = { reason: '', expectedEndAt: null };
  dialogVisible.value = true;
}

async function confirmStart() {
  submitting.value = true;
  try {
    await maintenanceApi.start({
      reason: form.value.reason.trim() || undefined,
      expectedEndAt: form.value.expectedEndAt ? new Date(form.value.expectedEndAt).toISOString() : undefined,
    });
    dialogVisible.value = false;
    ElMessage.success(t('maintenance.started'));
    await refreshAll();
  } finally {
    submitting.value = false;
  }
}

async function confirmStop() {
  await ElMessageBox.confirm(t('maintenance.confirmStopText'), t('maintenance.confirmStopTitle'), { type: 'warning' });
  await maintenanceApi.stop();
  ElMessage.success(t('maintenance.stopped'));
  await refreshAll();
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const statusTagType = (s) => ({ pending: 'warning', running: 'primary' }[s] || 'info');
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="ad-page-head ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg ad-title">{{ t('maintenance.title') }}</div>
          <div class="ad-sub">{{ t('maintenance.subtitle') }}</div>
        </div>
        <el-button v-if="status.active" type="danger" @click="confirmStop">
          <el-icon><CircleClose /></el-icon> {{ t('maintenance.stopButton') }}
        </el-button>
        <el-button v-else type="warning" class="btn-ink" @click="openStartDialog">
          <el-icon><SetUp /></el-icon> {{ t('maintenance.startButton') }}
        </el-button>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <!-- 当前状态 -->
      <div class="ad-card" style="padding: 18px 20px; margin-bottom: 12px;">
        <div class="ad-flex-center ad-gap-sm" style="margin-bottom: 12px;">
          <span class="ad-title">{{ t('maintenance.statusLabel') }}</span>
          <el-tag :type="status.active ? 'danger' : 'success'" effect="dark">
            {{ status.active ? t('maintenance.active') : t('maintenance.inactive') }}
          </el-tag>
        </div>
        <div class="mt-grid">
          <div class="mt-cell"><span class="ad-muted">{{ t('maintenance.startedAt') }}：</span>{{ fmtTime(status.startedAt) }}</div>
          <div class="mt-cell"><span class="ad-muted">{{ t('maintenance.startedBy') }}：</span>{{ status.startedBy?.username || '—' }}</div>
          <div class="mt-cell"><span class="ad-muted">{{ t('maintenance.reason') }}：</span>{{ status.reason || t('maintenance.noReason') }}</div>
          <div class="mt-cell"><span class="ad-muted">{{ t('maintenance.expectedEndAt') }}：</span>{{ fmtTime(status.expectedEndAt) }}</div>
        </div>
      </div>

      <!-- 行为说明 -->
      <el-alert type="info" show-icon :closable="false" style="margin-bottom: 12px;" :title="t('maintenance.startDialogTip')" />

      <!-- 处理中任务 -->
      <div class="ad-card" style="padding: 18px 20px;">
        <div class="ad-flex-between" style="margin-bottom: 12px; flex-wrap: wrap; gap: 12px;">
          <div class="ad-flex-center ad-gap-sm">
            <span class="ad-title">{{ t('maintenance.tasksTitle') }}</span>
            <el-tag type="info" effect="plain">{{ t('maintenance.activeCount', { count: tasks.length }) }}</el-tag>
          </div>
          <div class="ad-flex-center ad-gap-sm">
            <span class="ad-muted">{{ t('maintenance.autoRefresh') }}</span>
            <el-switch v-model="autoRefresh" :disabled="!status.active" />
            <el-button size="small" @click="refreshAll"><el-icon><Refresh /></el-icon> {{ t('maintenance.refresh') }}</el-button>
          </div>
        </div>

        <el-alert
          v-if="!tasks.length && status.active"
          type="success" show-icon :closable="false"
          :title="t('maintenance.safeToRestart')"
          style="margin-bottom: 12px;"
        />

        <div class="mt-table-wrap">
          <el-table :data="tasks" size="small">
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column :label="t('maintenance.colTask')" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                <div>{{ taskName(row, t('task.defaultLabel')) }}</div>
                <div class="ad-muted" style="font-size: 12px;">{{ row.type }}</div>
              </template>
            </el-table-column>
            <el-table-column :label="t('common.status')" width="100">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small" effect="plain">
                  {{ t('task.status.' + row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('maintenance.colStage')" prop="stage" min-width="120" show-overflow-tooltip />
            <el-table-column :label="t('task.column.progress')" width="140">
              <template #default="{ row }">
                <el-progress :percentage="row.progress || 0" :stroke-width="8" />
              </template>
            </el-table-column>
            <el-table-column :label="t('maintenance.colUser')" prop="user_id" width="80" />
            <el-table-column :label="t('maintenance.colProject')" width="90">
              <template #default="{ row }">{{ row.project_id ?? '—' }}</template>
            </el-table-column>
            <el-table-column :label="t('common.updatedAt')" width="170">
              <template #default="{ row }">{{ fmtTime(row.updated_at) }}</template>
            </el-table-column>
            <template #empty>
              <span class="ad-muted">{{ t('maintenance.tasksEmpty') }}</span>
            </template>
          </el-table>
        </div>
      </div>

      <!-- 开启维护弹窗（本身即为确认步骤） -->
      <el-dialog v-model="dialogVisible" :title="t('maintenance.startDialogTitle')" width="min(480px, 94vw)">
        <el-form label-position="top">
          <el-form-item :label="t('maintenance.reason')">
            <el-input
              v-model="form.reason"
              type="textarea" :rows="3" maxlength="200" show-word-limit
              :placeholder="t('maintenance.reasonPlaceholder')"
            />
          </el-form-item>
          <el-form-item :label="t('maintenance.expectedEndAt')">
            <el-date-picker
              v-model="form.expectedEndAt"
              type="datetime" style="width: 100%;"
              :placeholder="t('maintenance.expectedEndAt')"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="warning" class="btn-ink" :loading="submitting" @click="confirmStart">
            {{ t('maintenance.confirmStart') }}
          </el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.mt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px 24px; }
.mt-cell { line-height: 1.8; }
.mt-table-wrap { overflow-x: auto; }
</style>
