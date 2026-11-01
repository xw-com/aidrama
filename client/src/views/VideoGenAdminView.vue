<script setup>
// 视频生成留档 admin：全员 video_generations 只读列表/筛选 / 详情（含大 JSON params/submit_response/result）
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { videoGenAdminApi } from '../api';

const { t } = useI18n();

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '-');

// video_generations.status 枚举：pending/succeeded/failed（无 running/cancelled——扫描器一直查到终态）
const STATUSES = ['pending', 'succeeded', 'failed'];
// 厂商归位结果（videoVendorOf）；provider 为 ModelConfig 原值，不做枚举、直接展示
const VENDORS = ['seedance', 'dashscope', 'minimax', 'comfyui', 'generic'];
// 业务场景（与积分流水 feature 对齐）
const FEATURES = [
  'segment_generate', 'segment_video', 'segment_video_batch',
  'segment_video_batch_concurrent', 'segment_erase_subtitle',
];
const STATUS_TYPE = { pending: 'info', succeeded: 'success', failed: 'danger' };
const statusMeta = (code) => ({ label: t('vgAdmin.status.' + code), type: STATUS_TYPE[code] || 'info' });

const userName = (row) => (row.user ? (row.user.nickname || row.user.username || `#${row.user.id}`) : `#${row.user_id}`);

// 模型名：优先配置名称（配置被删时回退提交时快照 model 字段）；私有/共享按归属判断（user_id=NULL=共享）
const modelLabel = (row) => (row.modelConfig ? row.modelConfig.name : row.model);
const isPrivateModel = (row) => !!row.modelConfig?.user_id;
const targetLabel = (row) => {
  const parts = [];
  if (row.project) parts.push(row.project.name);
  if (row.episode) parts.push(t('vgAdmin.col.episodeN', { n: row.episode.idx }) + (row.episode.title ? ` ${row.episode.title}` : ''));
  if (row.segment) parts.push(row.segment.shot_no || `#${row.segment.idx} ${row.segment.title || ''}`.trim());
  return parts.join(' / ');
};

// ===== 列表 =====
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const size = 20;
const loading = ref(false);
const fStatus = ref('');
const fVendor = ref('');
const fFeature = ref('');
const fKeyword = ref('');

async function load() {
  loading.value = true;
  try {
    const params = { page: page.value, size };
    if (fStatus.value) params.status = fStatus.value;
    if (fVendor.value) params.vendor = fVendor.value;
    if (fFeature.value) params.feature = fFeature.value;
    if (fKeyword.value.trim()) params.keyword = fKeyword.value.trim();
    const data = await videoGenAdminApi.list(params);
    rows.value = data.rows || [];
    total.value = data.total || 0;
  } finally {
    loading.value = false;
  }
}

function search() { page.value = 1; load(); }

// ===== 详情（单独拉取，含大 JSON 字段 params/submit_response/result） =====
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref(null);
const pretty = (v) => (v == null ? '' : JSON.stringify(v, null, 2));

// URL 补全为完整地址：库内相对路径（/files/...）拼当前站点 origin，绝对 URL 原样；
// 可直接打开/复制（/files 产物出参已经 mediaSignMiddleware 追加过时效签名，带 query 同样能拼对）
const fullUrl = (u) => (u ? (/^https?:\/\//i.test(u) ? u : new URL(u, window.location.origin).href) : '');

async function copyUrl(u) {
  await navigator.clipboard.writeText(fullUrl(u));
  ElMessage.success(t('common.copied'));
}

async function openDetail(row) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await videoGenAdminApi.get(row.id);
  } finally {
    detailLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('vgAdmin.title') }}</div>
        <div class="ad-sub">{{ t('vgAdmin.subtitle') }}</div>
      </div>
      <div class="ad-rule va-rule" />

      <div class="ad-card va-block">
        <div class="va-filters">
          <el-select v-model="fStatus" clearable :placeholder="t('vgAdmin.f.status')" style="width: 120px;" @change="search">
            <el-option v-for="s in STATUSES" :key="s" :value="s" :label="t('vgAdmin.status.' + s)" />
          </el-select>
          <el-select v-model="fVendor" clearable :placeholder="t('vgAdmin.f.vendor')" style="width: 130px;" @change="search">
            <el-option v-for="v in VENDORS" :key="v" :value="v" :label="v" />
          </el-select>
          <el-select v-model="fFeature" clearable filterable :placeholder="t('vgAdmin.f.feature')" style="width: 200px;" @change="search">
            <el-option v-for="f in FEATURES" :key="f" :value="f" :label="f" />
          </el-select>
          <el-input v-model="fKeyword" clearable :placeholder="t('vgAdmin.f.keyword')" style="width: 250px;" @keyup.enter="search" @clear="search" />
          <el-button @click="search"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
        </div>

        <div class="va-table-wrap" v-loading="loading">
          <el-table :data="rows" size="small">
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column :label="t('jobAdmin.col.user')" min-width="120" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="cell-user">
                  <span>{{ userName(row) }}</span>
                  <span class="va-sub">{{ row.user?.external_id ? `xw:${row.user.external_id}` : `#${row.user_id}` }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.model')" min-width="190" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="cell-user">
                  <span class="va-model-name">
                    {{ modelLabel(row) }}
                    <el-tag v-if="row.modelConfig" :type="isPrivateModel(row) ? 'warning' : 'success'" size="small" effect="plain">
                      {{ t(isPrivateModel(row) ? 'vgAdmin.modelPrivate' : 'vgAdmin.modelShared') }}
                    </el-tag>
                    <el-tooltip v-else :content="t('vgAdmin.modelConfigMissing')" placement="top"><el-icon class="va-warn"><WarningFilled /></el-icon></el-tooltip>
                  </span>
                  <span class="va-sub">{{ row.provider }}<template v-if="row.modelConfig?.user_id"> · UID {{ row.modelConfig.user_id }}</template></span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.vendor')" width="100">
              <template #default="{ row }"><span class="ad-muted">{{ row.vendor }}</span></template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.feature')" min-width="150" show-overflow-tooltip>
              <template #default="{ row }"><span class="ad-muted">{{ row.feature }}</span></template>
            </el-table-column>
            <el-table-column :label="t('common.status')" width="90">
              <template #default="{ row }">
                <el-tag :type="statusMeta(row.status).type" size="small" effect="plain">{{ statusMeta(row.status).label }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.target')" min-width="170" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="targetLabel(row)" class="ad-muted">{{ targetLabel(row) }}</span>
                <span v-else class="ad-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.task')" width="80" align="center">
              <template #default="{ row }">
                <span class="ad-muted">{{ row.job_id ? `#${row.job_id}` : '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.polls')" width="80" align="center">
              <template #default="{ row }">
                <span class="ad-muted">{{ row.poll_count }}<template v-if="row.error_count"> / <span class="va-err-num">{{ row.error_count }}</span></template></span>
              </template>
            </el-table-column>
            <el-table-column :label="t('task.submittedAt')" width="160">
              <template #default="{ row }"><span class="ad-muted">{{ fmtTime(row.created_at) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('vgAdmin.col.finishedAt')" width="160">
              <template #default="{ row }"><span class="ad-muted">{{ fmtTime(row.finished_at) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('common.actions')" width="80" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click="openDetail(row)">{{ t('jobAdmin.detail') }}</el-button>
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

      <!-- 详情弹窗：全字段 + 大 JSON -->
      <el-dialog v-model="detailVisible" :title="t('vgAdmin.detailTitle', { id: detail?.id || '' })" width="min(720px, 94vw)" top="6vh">
        <div v-loading="detailLoading" class="va-detail">
          <template v-if="detail">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item :label="'ID'">{{ detail.id }}</el-descriptions-item>
              <el-descriptions-item :label="t('jobAdmin.col.user')">
                {{ userName(detail) }}<template v-if="detail.user?.external_id">（xw:{{ detail.user.external_id }}）</template>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.col.model')">
                {{ modelLabel(detail) }}
                <el-tag v-if="detail.modelConfig" :type="isPrivateModel(detail) ? 'warning' : 'success'" size="small" effect="plain">
                  {{ t(isPrivateModel(detail) ? 'vgAdmin.modelPrivate' : 'vgAdmin.modelShared') }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.col.modelConfig')">
                <template v-if="detail.modelConfig">ID {{ detail.modelConfig.id }}<template v-if="isPrivateModel(detail)">（UID {{ detail.modelConfig.user_id }}）</template></template>
                <span v-else>-</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('common.status')">
                <el-tag :type="statusMeta(detail.status).type" size="small" effect="plain">{{ statusMeta(detail.status).label }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.lastState')">
                {{ detail.last_state || '-' }}<span class="va-sub"> · {{ detail.vendor }} / {{ detail.provider }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.col.feature')">{{ detail.feature }}</el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.taskId')">{{ detail.task_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.project')">
                <template v-if="detail.project">{{ detail.project.name }}（ID {{ detail.project_id }}）</template>
                <span v-else>{{ detail.project_id || '-' }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.episode')">
                <template v-if="detail.episode">{{ t('vgAdmin.col.episodeN', { n: detail.episode.idx }) }} {{ detail.episode.title }}（ID {{ detail.episode_id }}）</template>
                <span v-else>{{ detail.episode_id || '-' }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.segment')">
                <template v-if="detail.segment">{{ detail.segment.shot_no || `#${detail.segment.idx}` }} {{ detail.segment.title }}（ID {{ detail.segment_id }}）</template>
                <span v-else>{{ detail.segment_id || '-' }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.job')">
                <template v-if="detail.job">#{{ detail.job.id }} · {{ detail.job.type }} · {{ t('task.status.' + detail.job.status) }}</template>
                <span v-else>{{ detail.job_id || '-' }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('task.submittedAt')">{{ fmtTime(detail.created_at) }}</el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.col.finishedAt')">{{ fmtTime(detail.finished_at) }}</el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.poll')">{{ detail.poll_count }} / {{ detail.error_count }}</el-descriptions-item>
              <el-descriptions-item :label="t('vgAdmin.d.baseUrl')" :span="2">
                <span class="va-break">{{ detail.base_url || '-' }}</span>
              </el-descriptions-item>
              <el-descriptions-item v-if="detail.submit_url" :label="t('vgAdmin.d.submitUrl')" :span="2">
                <div class="va-url-row">
                  <a class="va-url" :href="fullUrl(detail.submit_url)" target="_blank" rel="noopener">{{ fullUrl(detail.submit_url) }}</a>
                  <el-button size="small" text type="primary" @click="copyUrl(detail.submit_url)"><el-icon><DocumentCopy /></el-icon> {{ t('common.copy') }}</el-button>
                </div>
              </el-descriptions-item>
              <el-descriptions-item v-if="detail.result?.videoUrl" :label="t('vgAdmin.d.videoUrl')" :span="2">
                <div class="va-url-row">
                  <a class="va-url" :href="fullUrl(detail.result.videoUrl)" target="_blank" rel="noopener">{{ fullUrl(detail.result.videoUrl) }}</a>
                  <el-button size="small" text type="primary" @click="copyUrl(detail.result.videoUrl)"><el-icon><DocumentCopy /></el-icon> {{ t('common.copy') }}</el-button>
                </div>
              </el-descriptions-item>
              <el-descriptions-item v-if="detail.result?.lastFrameUrl" :label="t('vgAdmin.d.lastFrameUrl')" :span="2">
                <div class="va-url-row">
                  <a class="va-url" :href="fullUrl(detail.result.lastFrameUrl)" target="_blank" rel="noopener">{{ fullUrl(detail.result.lastFrameUrl) }}</a>
                  <el-button size="small" text type="primary" @click="copyUrl(detail.result.lastFrameUrl)"><el-icon><DocumentCopy /></el-icon> {{ t('common.copy') }}</el-button>
                </div>
              </el-descriptions-item>
            </el-descriptions>
            <template v-if="detail.error">
              <div class="va-json-label">{{ t('jobAdmin.d.error') }}</div>
              <pre class="va-json va-json-err">{{ detail.error }}</pre>
            </template>
            <template v-if="detail.params">
              <div class="va-json-label">params</div>
              <pre class="va-json">{{ pretty(detail.params) }}</pre>
            </template>
            <template v-if="detail.submit_response">
              <div class="va-json-label">submit_response</div>
              <pre class="va-json">{{ pretty(detail.submit_response) }}</pre>
            </template>
            <template v-if="detail.result">
              <div class="va-json-label">result</div>
              <pre class="va-json">{{ pretty(detail.result) }}</pre>
            </template>
          </template>
        </div>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.va-rule { margin-bottom: 16px; }
.va-block { padding: var(--ad-sp-5) var(--ad-sp-6); }
.va-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.va-table-wrap { overflow-x: auto; }
.cell-user { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.va-sub { font-size: 12px; color: var(--ad-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.va-model-name { font-weight: 600; color: var(--ad-text); font-size: 13px; display: flex; align-items: center; gap: 6px; min-width: 0; }
.va-warn { color: var(--ad-warning, #e6a23c); cursor: help; }
.va-err-num { color: var(--ad-danger); }

/* 详情弹窗 */
.va-detail { min-height: 120px; max-height: 70vh; overflow-y: auto; }
.va-json-label { font-size: 12px; font-weight: 700; color: var(--ad-text-muted); margin: 14px 0 6px; }
.va-json {
  margin: 0; padding: 10px 12px; border-radius: 8px;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border);
  font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;
  max-height: 240px; overflow-y: auto;
}
.va-json-err { color: var(--ad-danger); }
.va-break { word-break: break-all; }
.va-url-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.va-url { font-size: 12px; line-height: 1.6; word-break: break-all; color: var(--el-color-primary); text-decoration: none; }
.va-url:hover { text-decoration: underline; }
.va-url-row .el-button { flex-shrink: 0; }
</style>
