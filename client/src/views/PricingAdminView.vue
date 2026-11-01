<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { pricingAdminApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';

const { t } = useI18n();

const MODEL_TYPES = ['text', 'image', 'video', 'asr', 'tts'];

const loading = ref(false);
const rows = ref([]);
const dialogVisible = ref(false);
const submitting = ref(false);
const editingId = ref(null); // null = 新增
const form = ref({});

async function refresh() {
  loading.value = true;
  try {
    rows.value = await pricingAdminApi.list();
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

function openCreate() {
  editingId.value = null;
  form.value = { feature: '', name: '', unit_desc: '', credits_per_unit: 1, unit: 1, model_type: '', sort: 0, enabled: true };
  dialogVisible.value = true;
}

function openEdit(row) {
  editingId.value = row.id;
  form.value = { ...row, model_type: row.model_type || '' };
  dialogVisible.value = true;
}

async function submitForm() {
  if (!editingId.value && !/^[A-Za-z][A-Za-z0-9_]*$/.test(form.value.feature.trim())) {
    ElMessage.warning(t('pricingAdmin.featurePlaceholder'));
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      name: form.value.name,
      unit_desc: form.value.unit_desc,
      credits_per_unit: Number(form.value.credits_per_unit) || 0,
      unit: Number(form.value.unit) || 1,
      model_type: form.value.model_type || null,
      sort: Number(form.value.sort) || 0,
      enabled: !!form.value.enabled,
    };
    if (editingId.value) {
      await pricingAdminApi.update(editingId.value, payload);
      ElMessage.success(t('pricingAdmin.saved'));
    } else {
      await pricingAdminApi.create({ ...payload, feature: form.value.feature.trim() });
      ElMessage.success(t('pricingAdmin.created'));
    }
    dialogVisible.value = false;
    await refresh();
  } finally {
    submitting.value = false;
  }
}

// 行内启停开关：停用 = 该功能按 0 积分放行（免费），须二次确认；取消/失败回拨开关
async function onToggle(row) {
  if (!row.enabled) {
    try {
      await ElMessageBox.confirm(t('pricingAdmin.confirmDisableText'), t('pricingAdmin.confirmDisableTitle'), { type: 'warning' });
    } catch {
      row.enabled = true;
      return;
    }
  }
  try {
    await pricingAdminApi.update(row.id, { enabled: row.enabled });
    ElMessage.success(t('pricingAdmin.saved'));
  } catch {
    row.enabled = !row.enabled;
  }
}
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="ad-page-head ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg ad-title">{{ t('pricingAdmin.title') }}</div>
          <div class="ad-sub">{{ t('pricingAdmin.subtitle') }}</div>
        </div>
        <div class="ad-flex-center ad-gap-sm">
          <el-button @click="refresh"><el-icon><Refresh /></el-icon> {{ t('pricingAdmin.refresh') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="openCreate">
            <el-icon><Plus /></el-icon> {{ t('pricingAdmin.create') }}
          </el-button>
        </div>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <el-alert type="warning" show-icon :closable="false" style="margin-bottom: 12px;" :title="t('pricingAdmin.alertFree')" />

      <div class="ad-card" style="padding: 18px 20px;">
        <div class="mt-table-wrap">
          <el-table :data="rows" size="small">
            <el-table-column prop="sort" :label="t('pricingAdmin.sort')" width="70" />
            <el-table-column prop="feature" :label="t('pricingAdmin.feature')" min-width="170" show-overflow-tooltip>
              <template #default="{ row }"><code class="pa-feature">{{ row.feature }}</code></template>
            </el-table-column>
            <el-table-column prop="name" :label="t('pricingAdmin.name')" min-width="130" show-overflow-tooltip />
            <el-table-column prop="unit_desc" :label="t('pricingAdmin.unitDesc')" min-width="110" show-overflow-tooltip />
            <el-table-column prop="credits_per_unit" :label="t('pricingAdmin.creditsPerUnit')" width="110" align="right" />
            <el-table-column prop="unit" :label="t('pricingAdmin.unit')" width="90" align="right" />
            <el-table-column :label="t('pricingAdmin.modelType')" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.model_type" size="small" effect="plain">{{ t('pricingAdmin.mt.' + row.model_type) }}</el-tag>
                <span v-else class="ad-muted">{{ t('pricingAdmin.mt.none') }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('pricingAdmin.enabled')" width="90">
              <template #default="{ row }">
                <el-switch v-model="row.enabled" @change="onToggle(row)" />
              </template>
            </el-table-column>
            <el-table-column :label="t('common.actions')" width="90" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEdit(row)">
                  <el-icon><Edit /></el-icon> {{ t('pricingAdmin.edit') }}
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <span class="ad-muted">{{ t('pricingAdmin.empty') }}</span>
            </template>
          </el-table>
        </div>
      </div>

      <!-- 新增/编辑弹窗（feature 建行后是代码契约，编辑态不展示） -->
      <el-dialog v-model="dialogVisible" :title="editingId ? t('pricingAdmin.edit') : t('pricingAdmin.create')" width="min(520px, 94vw)">
        <el-form label-position="top">
          <el-form-item v-if="!editingId" :label="t('pricingAdmin.feature')">
            <el-input v-model="form.feature" :placeholder="t('pricingAdmin.featurePlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.name')">
            <el-input v-model="form.name" maxlength="128" />
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.unitDesc')">
            <el-input v-model="form.unit_desc" maxlength="64" />
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.creditsPerUnit')">
            <el-input-number v-model="form.credits_per_unit" :min="0" :max="1000000" :precision="1" :step="1" style="width: 200px;" />
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.unit')">
            <el-input-number v-model="form.unit" :min="1" :max="10000000" :precision="0" :step="1" style="width: 200px;" />
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.modelType')">
            <el-select v-model="form.model_type" clearable style="width: 200px;" :placeholder="t('pricingAdmin.mt.none')">
              <el-option v-for="mt in MODEL_TYPES" :key="mt" :value="mt" :label="t('pricingAdmin.mt.' + mt)" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.sort')">
            <el-input-number v-model="form.sort" :precision="0" :step="1" style="width: 200px;" />
          </el-form-item>
          <el-form-item :label="t('pricingAdmin.enabled')">
            <el-switch v-model="form.enabled" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" :loading="submitting" @click="submitForm">{{ t('common.confirm') }}</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.mt-table-wrap { overflow-x: auto; }
.pa-feature { font-family: var(--el-font-family-mono, monospace); font-size: 12px; }
</style>
