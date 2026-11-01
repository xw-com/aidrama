<script setup>
// 私有模型新增/编辑弹窗（个人设置）：
// 厂商由系统厂商目录选定，接入地址默认取厂商预设、可改为兼容端点（中转/代理站，服务端校验），
// 模型从厂商清单选择（OpenAI 兼容厂商可用密钥实时拉取，也允许手动输入兜底），API Key 用户自填。
// 私有模型调用不计积分并在模型列表置顶。
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { modelApi, vendorApi } from '../api';

const emit = defineEmits(['saved']);
const { t } = useI18n();

const TYPE_KEYS = ['text', 'image', 'video', 'tts', 'asr'];
// 与后端 IMAGE_MAX_SIZE_LADDER 同源同 casing
const IMAGE_MAX_SIZE_PRESETS = ['1K', '2K', '3K', '4K', '8K'];
// 与后端 MY_VIDEO_RESOLUTIONS 同源同序（从高到低；确认页默认取首档）
const VIDEO_RESOLUTION_PRESETS = ['4K', '2K', '1080p', '720p', '480p'];
// 图像模型新增时的 params 预填：固定 4K 像素尺寸（params 同名键覆盖系统按 max_size 档位的计算值）
const IMAGE_PARAMS_DEFAULT = JSON.stringify({ size: '3840x2160' }, null, 2);

const visible = ref(false);
const saving = ref(false);
const editing = ref(null); // 编辑目标行；null = 新增
const vendors = ref([]); // 系统厂商目录（仅启用项）
const fetchedModels = ref({}); // vendorCode -> 本次会话拉取到的模型 id 列表（与厂商目录清单合并展示）
const fetching = ref(false);

const form = ref(emptyForm());

function emptyForm() {
  return { name: '', type: 'text', provider: '', base_url: '', model: '', api_key: '', max_size: '2K', params: '{}', resolutions: [], translate_prompt_en: false, max_input_images: null, max_input_audios: null, max_input_videos: null, max_concurrency: null, is_default: false };
}

// params 编辑态是 JSON 字符串；空/`{}` 视为未填写
function isParamsBlank() {
  const s = (form.value.params || '').trim();
  return !s || s === '{}';
}

// 当前类型支持的厂商（系统目录过滤）
const vendorOptions = computed(() => vendors.value.filter((v) => (v.supported_types || []).includes(form.value.type)));
const currentVendor = computed(() => vendors.value.find((v) => v.code === form.value.provider) || null);

// 模型选项：厂商目录清单 ∪ 本次拉取结果 ∪ 当前值（allow-create 兜底手输）
const modelOptions = computed(() => {
  const list = [...(currentVendor.value?.models || [])];
  for (const m of fetchedModels.value[form.value.provider] || []) {
    if (!list.includes(m)) list.push(m);
  }
  const cur = form.value.model?.trim();
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list;
});

// 拉取按钮可用性：OpenAI 兼容厂商 + 已填 Key
const canFetch = computed(() => currentVendor.value?.api_style === 'openai' && !!(form.value.api_key || '').trim() && !editing.value);

// 厂商官网（后台厂商目录配置）：补协议兜底，供「官网注册」新窗口打开
const vendorSiteUrl = computed(() => {
  const w = (currentVendor.value?.website || '').trim();
  return w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : '';
});

function onTypeChange() {
  form.value.resolutions = []; // 分辨率档位仅对视频类型有意义，切类型即清空
  // 新增图像模型：params 仍为空时预填默认 size（编辑态不覆盖已存值）
  if (!editing.value && form.value.type === 'image' && isParamsBlank()) {
    form.value.params = IMAGE_PARAMS_DEFAULT;
  }
  // 切换类型后当前厂商可能不再支持 → 自动落到第一个支持的厂商
  if (!vendorOptions.value.some((v) => v.code === form.value.provider)) {
    form.value.provider = vendorOptions.value[0]?.code || '';
  }
}

function onProviderChange() {
  form.value.model = ''; // 换厂商后原模型 id 失效
}

async function onFetchModels() {
  if (!canFetch.value || fetching.value) return;
  fetching.value = true;
  try {
    const res = await vendorApi.fetchModels(form.value.provider, form.value.api_key.trim(), (form.value.base_url || '').trim());
    const list = res?.models || [];
    fetchedModels.value[form.value.provider] = list;
    ElMessage.success(t('settings.privateModels.fetchOk', { n: list.length }));
  } finally {
    fetching.value = false;
  }
}

async function loadVendors() {
  try {
    vendors.value = (await vendorApi.catalog()) || [];
  } catch {
    vendors.value = [];
  }
}

// row = 编辑目标行（modelApi.myList 的项）；null = 新增
// presetType = 预选类型（从「生成确认」跳转带参：文本/图像/视频/语音，自动选中并联动厂商）
async function open(row, presetType) {
  editing.value = row || null;
  fetchedModels.value = {};
  form.value = row
    ? {
        name: row.name || '', type: row.type, provider: row.provider || '', base_url: row.base_url || '', model: row.model || '',
        api_key: '', max_size: row.max_size || '2K',
        params: JSON.stringify(row.params || {}, null, 2),
        resolutions: (Array.isArray(row.resolutions) ? row.resolutions : []).map((r) => r && r.value).filter(Boolean),
        translate_prompt_en: !!row.translate_prompt_en,
        max_input_images: row.max_input_images ?? null, max_input_audios: row.max_input_audios ?? null,
        max_input_videos: row.max_input_videos ?? null, max_concurrency: row.max_concurrency ?? null,
        is_default: !!row.is_default,
      }
    : emptyForm();
  if (!vendors.value.length) await loadVendors();
  // 新增 + 带类型参数：选中对应类型并联动第一个支持的厂商（onTypeChange 内含参数预填与厂商回落）
  if (!row && TYPE_KEYS.includes(presetType) && form.value.type !== presetType) {
    form.value.type = presetType;
    onTypeChange();
  }
  visible.value = true;
}
defineExpose({ open });

async function save() {
  const f = form.value;
  if (!f.provider) return ElMessage.warning(t('settings.privateModels.vendorRequired'));
  const model = f.model.trim();
  if (!model) return ElMessage.warning(t('settings.privateModels.modelRequired'));
  const key = f.api_key.trim();
  if (!editing.value && !key) return ElMessage.warning(t('settings.privateModels.keyRequired'));
  let params;
  try { params = JSON.parse((f.params || '').trim() || '{}'); } catch { return ElMessage.warning(t('model.msg.paramsJson')); }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ElMessage.warning(t('model.msg.paramsJson'));
  saving.value = true;
  try {
    if (editing.value) {
      const payload = { name: f.name, model, params, is_default: f.is_default };
      if (key) payload.api_key = key; // 留空保留原 Key
      payload.base_url = (f.base_url || '').trim(); // 留空恢复厂商预设（服务端归一化）
      if (f.type === 'image') payload.max_size = f.max_size;
      if (f.type === 'video') {
        payload.translate_prompt_en = f.translate_prompt_en;
        payload.resolutions = f.resolutions;
        // 上限四件套整组提交（服务端传任一字段即整组更新；null=不限）
        payload.max_input_images = f.max_input_images;
        payload.max_input_audios = f.max_input_audios;
        payload.max_input_videos = f.max_input_videos;
        payload.max_concurrency = f.max_concurrency;
      }
      await modelApi.myUpdate(editing.value.id, payload);
    } else {
      await modelApi.myCreate({
        name: f.name, type: f.type, provider: f.provider, base_url: (f.base_url || '').trim(), model, api_key: key,
        params,
        ...(f.type === 'image' ? { max_size: f.max_size } : {}),
        ...(f.type === 'video' ? {
          translate_prompt_en: f.translate_prompt_en, resolutions: f.resolutions,
          max_input_images: f.max_input_images, max_input_audios: f.max_input_audios,
          max_input_videos: f.max_input_videos, max_concurrency: f.max_concurrency,
        } : {}),
        is_default: f.is_default,
      });
    }
    ElMessage.success(t('settings.privateModels.saved'));
    visible.value = false;
    emit('saved');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="editing ? t('settings.privateModels.edit') : t('settings.privateModels.add')" width="min(560px, 94vw)" align-center>
    <el-form label-position="top" class="pm-form">
      <div class="pm-grid">
        <el-form-item :label="t('settings.privateModels.type')">
          <el-select size="large" v-model="form.type" style="width:100%" :disabled="!!editing" @change="onTypeChange">
            <el-option v-for="typ in TYPE_KEYS" :key="typ" :label="t(`settings.privateModels.types.${typ}.label`)" :value="typ" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('settings.privateModels.vendor')">
          <el-select size="large" v-model="form.provider" style="width:100%" filterable :disabled="!!editing" @change="onProviderChange">
            <el-option v-for="v in vendorOptions" :key="v.code" :label="v.name" :value="v.code" />
          </el-select>
        </el-form-item>
      </div>
      <div v-if="editing" class="pm-immutable">{{ t('settings.privateModels.editImmutable') }}</div>

      <el-form-item :label="t('settings.privateModels.baseUrl')">
        <el-input size="large" v-model="form.base_url" :placeholder="currentVendor?.base_url || 'https://...'" />
        <div class="pm-hint">
          {{ t('settings.privateModels.baseUrlHint') }}
          <a v-if="vendorSiteUrl" :href="vendorSiteUrl" target="_blank" rel="noopener" class="pm-sitelink">{{ t('settings.privateModels.visitSite') }}</a>
        </div>
      </el-form-item>

      <el-form-item :label="editing ? t('settings.privateModels.apiKeyKeep') : t('settings.privateModels.apiKey')">
        <el-input size="large" v-model="form.api_key" type="password" show-password placeholder="sk-..." />
      </el-form-item>

      <el-form-item :label="t('settings.privateModels.model')">
        <div class="pm-model-row">
          <el-select
            size="large"
            v-model="form.model"
            class="pm-model-select"
            filterable
            allow-create
            default-first-option
            :placeholder="t('settings.privateModels.model')"
          >
            <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
          </el-select>
          <el-tooltip v-if="currentVendor && currentVendor.api_style !== 'openai'" :content="t('settings.privateModels.fetchUnavailable')">
            <el-button size="large" disabled><el-icon><Refresh /></el-icon></el-button>
          </el-tooltip>
          <el-button v-else size="large" :loading="fetching" :disabled="!canFetch" @click="onFetchModels">
            <el-icon><Refresh /></el-icon> {{ fetching ? t('settings.privateModels.fetching') : t('settings.privateModels.fetchModels') }}
          </el-button>
        </div>
        <div class="pm-hint">{{ t('settings.privateModels.modelHint') }}</div>
      </el-form-item>

      <el-form-item :label="t('settings.privateModels.name')">
        <el-input size="large" v-model="form.name" :placeholder="t('settings.privateModels.namePlaceholder')" maxlength="64" />
      </el-form-item>

      <el-form-item :label="t('model.params')">
        <el-input size="large" v-model="form.params" type="textarea" :rows="3" placeholder='{"size": "3840x2160"}' />
        <div class="pm-hint">{{ t('settings.privateModels.paramsHint') }}</div>
      </el-form-item>

      <div class="pm-grid">
        <el-form-item v-if="form.type === 'image'" :label="t('settings.privateModels.maxSize')">
          <el-select size="large" v-model="form.max_size" style="width:100%">
            <el-option v-for="opt in IMAGE_MAX_SIZE_PRESETS" :key="opt" :label="opt" :value="opt" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.type === 'video'" :label="t('settings.privateModels.translateEn')">
          <el-switch v-model="form.translate_prompt_en" />
        </el-form-item>
        <el-form-item :label="t('settings.privateModels.isDefault')">
          <el-switch v-model="form.is_default" />
        </el-form-item>
      </div>

      <el-form-item v-if="form.type === 'video'" :label="t('settings.privateModels.resolutions')">
        <el-checkbox-group v-model="form.resolutions">
          <el-checkbox v-for="opt in VIDEO_RESOLUTION_PRESETS" :key="opt" :value="opt">{{ opt }}</el-checkbox>
        </el-checkbox-group>
        <div class="pm-hint">{{ t('settings.privateModels.resolutionsHint') }}</div>
      </el-form-item>

      <el-form-item v-if="form.type === 'video'" :label="t('model.inputLimits.label')">
        <div class="pm-limitgrid">
          <div class="pm-limititem">
            <span class="pm-limitlab">{{ t('model.inputLimits.images') }}</span>
            <el-input-number v-model="form.max_input_images" :min="0" :max="99" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:100%;" />
          </div>
          <div class="pm-limititem">
            <span class="pm-limitlab">{{ t('model.inputLimits.audios') }}</span>
            <el-input-number v-model="form.max_input_audios" :min="0" :max="99" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:100%;" />
          </div>
          <div class="pm-limititem">
            <span class="pm-limitlab">{{ t('model.inputLimits.videos') }}</span>
            <el-input-number v-model="form.max_input_videos" :min="0" :max="99" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:100%;" />
          </div>
          <div class="pm-limititem">
            <span class="pm-limitlab">{{ t('model.inputLimits.concurrency') }}</span>
            <el-input-number v-model="form.max_concurrency" :min="0" :max="999" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:100%;" />
          </div>
        </div>
        <div class="pm-hint">{{ t('model.inputLimits.hint') }}</div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button size="large" @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button size="large" type="primary" class="btn-ink" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.pm-form { text-align: left; }
.pm-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }
.pm-model-row { display: flex; gap: 8px; width: 100%; }
.pm-model-select { flex: 1; }
/* 输入上限四件套：与 admin 管理页同款「标签在上、输入在下」，四组固定一行不换行 */
.pm-limitgrid { display: flex; align-items: flex-end; gap: 10px; width: 100%; }
.pm-limititem { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pm-limitlab { font-size: 12px; color: var(--ad-text-muted); white-space: nowrap; }
.pm-hint { font-size: 12px; color: var(--ad-text-muted); margin-top: 4px; line-height: 1.6; width: 100%; }
.pm-sitelink { color: var(--ad-brand, #e0b64e); font-weight: 600; text-decoration: underline; margin-left: 6px; }
.pm-immutable { font-size: 12px; color: var(--ad-warning, #b8860b); margin: -6px 0 10px; }
@media (max-width: 600px) {
  .pm-grid { grid-template-columns: 1fr; }
  .pm-model-row { flex-wrap: wrap; }
}
</style>
