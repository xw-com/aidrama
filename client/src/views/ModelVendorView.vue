<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { vendorApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

const { t } = useI18n();

const TYPES = computed(() => [
  { key: 'text', label: t('vendor.types.text') },
  { key: 'image', label: t('vendor.types.image') },
  { key: 'video', label: t('vendor.types.video') },
  { key: 'asr', label: t('vendor.types.asr') },
]);

const list = ref([]);
const loading = ref(false);

const showForm = ref(false);
const editing = ref(null);
const form = ref(emptyForm());

function emptyForm() {
  return {
    name: '', code: '', base_url: '', api_style: 'openai',
    supported_types: [], models_text: '', logo_url: '', website: '', description: '',
    enabled: true, sort: 0,
  };
}

async function load() {
  loading.value = true;
  try {
    list.value = await vendorApi.list();
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = emptyForm();
  showForm.value = true;
}
function openEdit(v) {
  editing.value = v;
  form.value = { ...emptyForm(), ...v, supported_types: [...(v.supported_types || [])], models_text: (v.models || []).join('\n') };
  showForm.value = true;
}

async function save() {
  const payload = { ...form.value };
  if (!payload.name || !payload.code) return ElMessage.error(t('vendor.validate.nameCodeRequired'));
  // 模型清单：每行一个模型 ID（用户私有模型配置页的下拉数据源）
  payload.models = String(payload.models_text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  delete payload.models_text;
  if (editing.value) {
    await vendorApi.update(editing.value.id, payload);
    ElMessage.success(t('common.saveSuccess'));
  } else {
    await vendorApi.create(payload);
    ElMessage.success(t('vendor.addSuccess'));
  }
  showForm.value = false;
  load();
}

async function remove(v) {
  await ElMessageBox.confirm(t('vendor.confirmDelete', { name: v.name }), t('common.tip'), { type: 'warning' });
  await vendorApi.remove(v.id);
  ElMessage.success(t('common.deleteSuccess'));
  load();
}

// 导入/导出
async function exportVendors() {
  const data = await vendorApi.exportVendors();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xw-vendors-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(t('vendor.exportSuccess'));
}

function onImport(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      const vendors = json.vendors || json;
      const res = await vendorApi.importVendors(vendors);
      ElMessage.success(t('vendor.importedCount', { n: res.imported }));
      load();
    } catch (err) {
      ElMessage.error(t('vendor.importFailed') + ': ' + err.message);
    }
  };
  reader.readAsText(file.raw || file);
  return false;
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="ad-page-head ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg ad-title">{{ t('vendor.title') }}</div>
          <div class="ad-sub">{{ t('vendor.subtitle') }}</div>
        </div>
        <div class="ad-flex-center ad-gap-sm">
          <el-upload :show-file-list="false" :before-upload="onImport" accept=".json">
            <el-button><el-icon><Upload /></el-icon> {{ t('vendor.import') }}</el-button>
          </el-upload>
          <el-button @click="exportVendors"><el-icon><Download /></el-icon> {{ t('vendor.export') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="openCreate"><el-icon><Plus /></el-icon> {{ t('vendor.addVendor') }}</el-button>
        </div>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <!-- 厂商列表 -->
      <div class="cfg-list ad-stagger">
        <div v-for="v in list" :key="v.id" class="cfg-item ad-card">
          <div class="cfg-main">
            <div class="ad-flex-center ad-gap-sm">
              <span class="ad-title">{{ v.name }}</span>
              <span class="chip">{{ v.code }}</span>
              <span class="chip" :class="v.enabled ? 'chip-success' : 'chip-danger'">{{ v.enabled ? t('common.enable') : t('common.disable') }}</span>
              <span class="chip" v-for="tp in (v.supported_types || [])" :key="tp">{{ TYPES.find(x => x.key === tp)?.label || tp }}</span>
              <span class="chip" v-if="(v.models || []).length">{{ t('vendor.models') }} × {{ v.models.length }}</span>
            </div>
            <div class="ad-sub" style="margin-top: 6px;">
              <span class="ad-muted">{{ t('vendor.baseUrl') }}：</span>{{ v.base_url || '—' }}
              <span class="ad-muted" style="margin-left:12px;">{{ t('vendor.apiStyle') }}：</span>{{ v.api_style }}
              <span class="ad-muted" style="margin-left:12px;" v-if="v.website">{{ t('vendor.website') }}：</span><a v-if="v.website" :href="v.website" target="_blank" rel="noopener">{{ v.website }}</a>
            </div>
          </div>
          <div class="cfg-ops">
            <el-button size="small" text @click="openEdit(v)">{{ t('common.edit') }}</el-button>
            <el-button size="small" text type="danger" @click="remove(v)">{{ t('common.delete') }}</el-button>
          </div>
        </div>
        <EmptyState
          v-if="!list.length"
          class="ad-card"
          icon="📦"
          :title="t('vendor.emptyTitle')"
          :description="t('vendor.emptyDesc')"
          :action-label="t('vendor.addVendor')"
          @action="openCreate"
        />
      </div>

      <!-- 表单弹窗 -->
      <el-dialog v-model="showForm" :title="editing ? t('vendor.editVendor') : t('vendor.addVendor')" width="min(560px, 94vw)">
        <el-form label-position="top">
          <el-form-item :label="t('vendor.vendorName')"><el-input size="large" v-model="form.name" :placeholder="t('vendor.phName')" /></el-form-item>
          <el-form-item :label="t('vendor.codeLabel')">
            <el-input size="large" v-model="form.code" :placeholder="t('vendor.phCode')" :disabled="!!editing" />
          </el-form-item>
          <el-form-item :label="t('vendor.defaultBaseUrl')"><el-input size="large" v-model="form.base_url" placeholder="https://api.openai.com/v1" /></el-form-item>
          <el-form-item :label="t('vendor.apiStyle')">
            <el-radio-group v-model="form.api_style">
              <el-radio value="openai">{{ t('vendor.apiStyleOpenai') }}</el-radio>
              <el-radio value="custom">{{ t('vendor.apiStyleCustom') }}</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('vendor.supportedTypes')">
            <el-checkbox-group v-model="form.supported_types">
              <el-checkbox v-for="tp in TYPES" :key="tp.key" :value="tp.key">{{ tp.label }}</el-checkbox>
            </el-checkbox-group>
          </el-form-item>
          <!-- 模型清单：用户私有模型配置页「选模型」的下拉数据源（每行一个模型 ID） -->
          <el-form-item :label="t('vendor.models')">
            <el-input
              size="large"
              v-model="form.models_text"
              type="textarea"
              :rows="4"
              placeholder="gpt-4o&#10;gpt-4o-mini"
            />
            <div class="ad-sub" style="font-size:12px; margin-top:4px;">{{ t('vendor.modelsHint') }}</div>
          </el-form-item>
          <el-form-item :label="t('vendor.logoUrl')"><el-input size="large" v-model="form.logo_url" placeholder="https://..." /></el-form-item>
          <el-form-item :label="t('vendor.website')"><el-input size="large" v-model="form.website" placeholder="https://..." /></el-form-item>
          <el-form-item :label="t('common.desc')"><el-input size="large" v-model="form.description" :placeholder="t('vendor.optional')" /></el-form-item>
          <el-form-item>
            <div class="ad-flex-center" style="gap: var(--ad-sp-4);">
              <el-switch v-model="form.enabled" :active-text="t('common.enable')" />
              <span class="ad-muted">{{ t('vendor.sort') }}</span>
              <el-input-number v-model="form.sort" :min="0" :step="1" style="width: 120px;" />
            </div>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="showForm = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="save">{{ t('common.save') }}</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.cfg-list { display: flex; flex-direction: column; gap: 12px; }
.cfg-item { display: flex; align-items: center; justify-content: space-between; padding: var(--ad-sp-5) var(--ad-sp-6); gap: var(--ad-sp-4); flex-wrap: wrap; }
.cfg-main { flex: 1; min-width: 260px; }
.cfg-ops { display: flex; gap: 4px; flex-shrink: 0; }
</style>
