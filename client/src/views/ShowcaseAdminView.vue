<script setup>
// 展示审核 admin：发布到展示中心的内容先审后放——列表/通过/驳回（驳回必填原因，发布者可见）
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { showcaseAdminApi } from '../api';

const { t } = useI18n();

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '-');

const list = ref([]);
const total = ref(0);
const page = ref(1);
const size = 20;
const loading = ref(false);
const keyword = ref('');
const status = ref('');

const statusTag = (s) => ({ pending: 'warning', approved: 'success', rejected: 'danger' }[s] || 'info');

async function load() {
  loading.value = true;
  try {
    const params = { page: page.value, size };
    if (keyword.value.trim()) params.q = keyword.value.trim();
    if (status.value) params.status = status.value;
    const data = await showcaseAdminApi.list(params);
    list.value = data.list || [];
    total.value = data.total || 0;
  } finally {
    loading.value = false;
  }
}

function search() { page.value = 1; load(); }

async function approve(row) {
  try {
    await ElMessageBox.confirm(
      t('showcaseAdmin.approveConfirm', { name: row.project?.name || `#${row.id}` }),
      t('showcaseAdmin.approve'),
      { type: 'warning' },
    );
  } catch { return; }
  await showcaseAdminApi.setStatus(row.id, 'approved');
  ElMessage.success(t('showcaseAdmin.approved'));
  load();
}

async function reject(row) {
  let reason = '';
  try {
    const { value } = await ElMessageBox.prompt(
      t('showcaseAdmin.rejectTip', { name: row.project?.name || `#${row.id}` }),
      t('showcaseAdmin.reject'),
      {
        type: 'warning',
        inputType: 'textarea',
        inputPlaceholder: t('showcaseAdmin.reasonPlaceholder'),
        inputValidator: (v) => (String(v || '').trim() ? true : t('showcaseAdmin.reasonRequired')),
      },
    );
    reason = String(value || '').trim();
  } catch { return; }
  await showcaseAdminApi.setStatus(row.id, 'rejected', reason);
  ElMessage.success(t('showcaseAdmin.rejected'));
  load();
}

function viewShowcase(row) {
  // 管理后台无前台展示详情路由：新开前台详情页（同源直达，预览视角与用户一致）
  window.open(`/showcase/${row.id}`, '_blank');
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('showcaseAdmin.title') }}</div>
        <div class="ad-sub">{{ t('showcaseAdmin.subtitle') }}</div>
      </div>
      <div class="ad-rule sa-rule" />

      <div class="ad-card sa-block">
        <div class="sa-filters">
          <el-input v-model="keyword" clearable :placeholder="t('showcaseAdmin.f.keyword')" style="width: 240px;" @keyup.enter="search" @clear="search" />
          <el-select v-model="status" clearable :placeholder="t('showcaseAdmin.f.status')" style="width: 130px;" @change="search">
            <el-option value="pending" :label="t('showcaseAdmin.status.pending')" />
            <el-option value="approved" :label="t('showcaseAdmin.status.approved')" />
            <el-option value="rejected" :label="t('showcaseAdmin.status.rejected')" />
          </el-select>
          <el-button @click="search"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
        </div>
        <div class="sa-table-wrap" v-loading="loading">
          <el-table :data="list" size="small">
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column :label="t('showcaseAdmin.c.project')" min-width="200">
              <template #default="{ row }">
                <div class="sa-proj">
                  <el-image
                    :src="row.project?.cover_thumb || row.project?.cover" fit="cover"
                    class="sa-cover" :preview-src-list="[row.project?.cover].filter(Boolean)" preview-teleported hide-on-click-modal
                  />
                  <div class="sa-proj-info">
                    <span class="sa-proj-name">{{ row.project?.name || `#${row.project_id}` }}</span>
                    <span class="ad-muted">{{ t('showcase.episodes', { n: row.episode_count ?? 0 }) }} · {{ t('showcase.views', { n: row.view_count || 0 }) }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('showcaseAdmin.c.publisher')" width="130" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.publisher ? (row.publisher.nickname || row.publisher.username || `#${row.publisher.id}`) : `#${row.user_id}` }}
              </template>
            </el-table-column>
            <el-table-column prop="description" :label="t('showcaseAdmin.c.description')" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ row.description || '-' }}</template>
            </el-table-column>
            <el-table-column :label="t('showcaseAdmin.c.status')" width="90">
              <template #default="{ row }">
                <el-tag :type="statusTag(row.status)" size="small" effect="plain">{{ t(`showcaseAdmin.status.${row.status}`) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reject_reason" :label="t('showcaseAdmin.c.reason')" min-width="130" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reject_reason || '-' }}</template>
            </el-table-column>
            <el-table-column :label="t('common.createdAt')" width="160">
              <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column :label="t('showcaseAdmin.c.reviewedAt')" width="160">
              <template #default="{ row }">{{ fmtTime(row.reviewed_at) }}</template>
            </el-table-column>
            <el-table-column :label="t('common.actions')" width="180" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.status === 'pending'" size="small" text type="success" @click="approve(row)">{{ t('showcaseAdmin.approve') }}</el-button>
                <el-button size="small" text type="danger" @click="reject(row)">{{ t('showcaseAdmin.reject') }}</el-button>
                <el-button size="small" text type="primary" @click="viewShowcase(row)">{{ t('showcaseAdmin.view') }}</el-button>
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
    </div>
  </div>
</template>

<style scoped>
.sa-rule { margin-bottom: 16px; }
.sa-block { padding: var(--ad-sp-5) var(--ad-sp-6); }
.sa-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.sa-table-wrap { overflow-x: auto; }
.sa-proj { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sa-cover { width: 56px; height: 32px; border-radius: 4px; flex-shrink: 0; background: var(--ad-fill, #f5f5f5); }
.sa-proj-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sa-proj-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
