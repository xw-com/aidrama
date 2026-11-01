<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { modelApi, vendorApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

const { t } = useI18n();

const TYPES = [
  { key: 'text', icon: 'ChatDotRound' },
  { key: 'image', icon: 'Picture' },
  { key: 'video', icon: 'VideoPlay' },
  { key: 'asr', icon: 'Microphone' },
];
const FALLBACK_PROVIDERS = ['openai', 'custom', 'local-ffmpeg'];
const VIDEO_RESOLUTION_PRESETS = ['480p', '720p', '768p', '1080p', '2K', '4K'];
// 最大支持尺寸档位：与后端 IMAGE_MAX_SIZE_LADDER / normalizeMaxSize 同源同 casing
const IMAGE_MAX_SIZE_PRESETS = ['1K', '2K', '3K', '4K', '8K'];
const vendors = ref([]);
const providerOptions = computed(() => {
  const enabled = vendors.value.filter((v) => v.enabled);
  if (!enabled.length) return FALLBACK_PROVIDERS.map((code) => ({ code, name: code }));
  return enabled.map((v) => ({ code: v.code, name: v.name }));
});
const activeType = ref('text');
const list = ref([]);
const loading = ref(false);

const showForm = ref(false);
const editing = ref(null);
const form = ref(emptyForm());

function emptyForm() {
  return { name: '', type: 'text', provider: 'openai', base_url: '', api_key: '', model: '', api_style: 'openai', params: '{}', price: 0, resolutions: [], max_size: '2K', translate_prompt_en: false,
    // 视频模型输入上限默认 9/3/0 + 并发不限（NULL=不限，0=不支持该类输入；仅 video 类型保存）
    max_input_images: 9, max_input_audios: 3, max_input_videos: 0, max_concurrency: null,
    promo_discount: null, promoRange: null, enabled: true, is_default: false };
}

// 价格标签随类型变化
const priceLabel = computed(() => ({
  text: t('model.price.text'),
  image: t('model.price.image'),
  video: t('model.price.video'),
  asr: t('model.price.asr'),
}[form.value.type] || t('model.price.fallback')));

// 列表项计费摘要
function priceSummary(c) {
  if (c.type === 'video') {
    const list = (c.resolutions || []).filter((r) => r && r.value).map((r) => ({ value: r.value, price: Number(r.price) || 0 }));
    const priced = list.filter((r) => r.price > 0);
    const head = priced.length
      ? (Math.min(...priced.map((r) => r.price)) === Math.max(...priced.map((r) => r.price))
        ? t('model.price.perSec', { p: priced[0].price })
        : t('model.price.perSecRange', { min: Math.min(...priced.map((r) => r.price)), max: Math.max(...priced.map((r) => r.price)) }))
      : (c.price ? t('model.price.perSec', { p: c.price }) : '');
    const tail = list.length ? list.map((r) => r.value).join('/') : '';
    return [head, tail].filter(Boolean).join(' · ');
  }
  if (c.type === 'image') {
    // 支持尺寸已下线：图像一律按 max_size 档位生成，摘要只展示单价与最大档
    return c.price ? t('model.price.perImage', { p: c.price }) : '';
  }
  if (c.type === 'text') return c.price ? t('model.price.perCall', { p: c.price }) : '';
  if (c.type === 'asr') return c.price ? t('model.price.perMin', { p: c.price }) : '';
  return '';
}

function addResolution() { form.value.resolutions.push({ value: '', price: 0 }); }
function removeResolution(i) { form.value.resolutions.splice(i, 1); }

// ============ 限时折扣活动（模型维度） ============
// 折扣百分比promo_discount（85 = 付原价的 85%），与起止时间一体生效；与服务端 getModelPromo 同口径
function promoOff(c) {
  const p = Number(c && c.promo_discount);
  if (!p || p <= 0 || p >= 100) return null;
  const now = Date.now();
  const s = c.promo_start_at ? new Date(c.promo_start_at).getTime() : NaN;
  const e = c.promo_end_at ? new Date(c.promo_end_at).getTime() : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || now < s || now > e) return null;
  return Math.round((100 - p) * 100) / 100;
}
// 列表促销摘要（配置了折扣即展示，含起止时间；进行中与否用文案区分）
function promoSummary(c) {
  const p = Number(c.promo_discount);
  if (!p || p <= 0 || p >= 100) return '';
  const off = Math.round((100 - p) * 100) / 100;
  const fmt = (v) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return t('model.promo.summary', { p: off, start: fmt(c.promo_start_at), end: fmt(c.promo_end_at) });
}
// 列表卡片摘要：视频模型已配置的输入上限 / 全局并发（NULL=不限，不展示；全未配置则不显示 chip）
function inputLimitsChip(c) {
  const parts = [];
  if (c.max_input_images != null || c.max_input_audios != null || c.max_input_videos != null) {
    parts.push(t('model.inputLimits.chipLimits', { v: `${c.max_input_images ?? '∞'}/${c.max_input_audios ?? '∞'}/${c.max_input_videos ?? '∞'}` }));
  }
  if (c.max_concurrency != null) parts.push(t('model.inputLimits.chipConc', { v: c.max_concurrency }));
  return parts.join(' · ');
}
// 表单内实时示例：原价 100 积分 → 折后 X 积分
const promoPreview = computed(() => {
  const pd = Number(form.value.promo_discount);
  if (!pd || pd <= 0 || pd >= 100) return '';
  return t('model.promo.preview', { d: pd, p: Math.round((100 - pd) * 100) / 100 });
});
// 类型切换时重置分辨率（video=对象数组 / image=字符串数组，形态不同，避免错位）
function onTypeChange() { form.value.resolutions = []; }
// 选择厂商后，自动带入该厂商的默认 Base URL / API 风格（厂商未配置对应默认值时保持不变）
function onProviderChange(code) {
  const v = vendors.value.find((x) => x.code === code);
  if (!v) return;
  if (v.base_url) form.value.base_url = v.base_url;
  if (v.api_style) form.value.api_style = v.api_style;
}

// 管理页只管共享模型（服务端归属 user_id 为 NULL）：admin 自己的私有模型带 is_private 标志，
// 走「设置 → 私有模型」管理——这里若展示，编辑/删除接口（只认共享模型）会报不存在
const filtered = computed(() => list.value.filter((c) => !c.is_private && c.type === activeType.value));

async function load() {
  loading.value = true;
  try {
    list.value = await modelApi.list();
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = emptyForm();
  form.value.type = activeType.value;
  // 默认选当前类型支持的第一个厂商，并带入其默认 Base URL / API 风格
  const matched = vendors.value.find((v) => v.enabled && (v.supported_types || []).includes(activeType.value));
  if (matched) {
    form.value.provider = matched.code;
    onProviderChange(matched.code);
  }
  showForm.value = true;
}
function openEdit(c) {
  editing.value = c;
  form.value = {
    ...c,
    params: JSON.stringify(c.params || {}, null, 2),
    api_key: '',
    price: c.price ?? 0,
    resolutions: Array.isArray(c.resolutions) ? JSON.parse(JSON.stringify(c.resolutions)) : [],
    max_size: c.max_size || '2K', // 存量行 NULL 回退默认档
    // 输入上限/全局并发：NULL 显示为空（=不限），0 为合法值（=不支持该类输入）
    max_input_images: c.max_input_images ?? null,
    max_input_audios: c.max_input_audios ?? null,
    max_input_videos: c.max_input_videos ?? null,
    max_concurrency: c.max_concurrency ?? null,
    promo_discount: c.promo_discount ?? null,
    promoRange: c.promo_start_at && c.promo_end_at ? [new Date(c.promo_start_at), new Date(c.promo_end_at)] : null,
  };
  showForm.value = true;
}

async function save() {
  const payload = { ...form.value };
  let params = {};
  try { params = JSON.parse(payload.params || '{}'); } catch { return ElMessage.error(t('model.msg.paramsJson')); }
  payload.params = params;
  payload.price = Number(payload.price) || 0;
  // 提示词英译仅对视频模型生效：其他类型一律归 false，避免类型切换后残留脏开关
  if (payload.type !== 'video') payload.translate_prompt_en = false;
  // 按类型规整 resolutions：video=[{value,price}] / image=[]（支持尺寸已下线，生成统一按 max_size 档位）/ 其它=[]
  if (payload.type === 'video') {
    payload.resolutions = (payload.resolutions || [])
      .filter((r) => r && r.value)
      .map((r) => ({ value: String(r.value).trim(), price: Number(r.price) || 0 }));
  } else if (payload.type === 'image') {
    payload.resolutions = []; // 支持尺寸已下线：存量值保存时一并清空
    // 最大支持尺寸仅图像模型生效；非法值归一默认档 2K
    payload.max_size = IMAGE_MAX_SIZE_PRESETS.includes(payload.max_size) ? payload.max_size : '2K';
  } else {
    payload.resolutions = [];
    delete payload.max_size; // 其他类型不下发，避免类型切换误覆盖
  }
  // 视频模型输入上限 + 全局并发：空值归 null（=不限）、负数归 0；其他类型一律 null
  for (const k of ['max_input_images', 'max_input_audios', 'max_input_videos', 'max_concurrency']) {
    if (payload.type === 'video') {
      payload[k] = (payload[k] === null || payload[k] === undefined || payload[k] === '')
        ? null : Math.max(0, Math.floor(Number(payload[k]) || 0));
    } else {
      payload[k] = null;
    }
  }
  // 促销活动：折扣为空 → 三字段全清；填了折扣则起止时间必填（结束须晚于开始由服务端兜底校验）
  const pd = payload.promo_discount;
  if (pd === null || pd === undefined || pd === '') {
    payload.promo_discount = null;
    payload.promo_start_at = null;
    payload.promo_end_at = null;
  } else {
    const r = payload.promoRange;
    if (!Array.isArray(r) || r.length !== 2 || !r[0] || !r[1]) return ElMessage.error(t('model.promo.rangeRequired'));
    payload.promo_discount = Number(pd);
    payload.promo_start_at = new Date(r[0]).toISOString();
    payload.promo_end_at = new Date(r[1]).toISOString();
  }
  delete payload.promoRange;
  if (!payload.base_url && payload.provider !== 'local-ffmpeg') return ElMessage.error(t('model.msg.baseUrlRequired'));
  if (editing.value) {
    const upd = { ...payload };
    if (!upd.api_key) delete upd.api_key; // 不传则保留原值
    await modelApi.update(editing.value.id, upd);
    ElMessage.success(t('model.msg.updated'));
  } else {
    await modelApi.create(payload);
    ElMessage.success(t('model.msg.added'));
  }
  showForm.value = false;
  load();
}

async function remove(c) {
  await ElMessageBox.confirm(t('model.msg.deleteConfirm', { name: c.name }), t('common.tip'), { type: 'warning' });
  await modelApi.remove(c.id);
  ElMessage.success(t('common.deleteSuccess'));
  load();
}

async function setDefault(c) {
  await modelApi.update(c.id, { is_default: true });
  ElMessage.success(t('model.msg.defaultSet'));
  load();
}

// ============ 视频任务状态查询（admin 调试） ============
// 输入厂商侧任务 ID，按该模型配置的厂商契约转发查询，输出区展示厂商原始返回文本
const showTaskQuery = ref(false);
const tqModel = ref(null);      // 当前查询的模型配置行
const tqTaskId = ref('');
const tqLoading = ref(false);
const tqResult = ref(null);     // 服务端归一化结果（含 raw_text）
const tqError = ref('');

function openTaskQuery(c) {
  tqModel.value = c;
  tqTaskId.value = '';
  tqResult.value = null;
  tqError.value = '';
  showTaskQuery.value = true;
}

async function runTaskQuery() {
  const id = tqTaskId.value.trim();
  if (!id) return ElMessage.warning(t('model.taskQuery.taskIdRequired'));
  tqLoading.value = true;
  try {
    tqResult.value = await modelApi.queryTask(tqModel.value.id, id);
    tqError.value = '';
  } catch (err) {
    tqResult.value = null;
    tqError.value = err.message || t('model.taskQuery.queryFailed');
  } finally {
    tqLoading.value = false;
  }
}

// 归一化状态 → 展示文案/样式
function tqStateLabel(state) {
  return t(`model.taskQuery.state.${state || 'unknown'}`);
}
function tqStateType(state) {
  return { succeeded: 'success', failed: 'danger', error: 'warning', running: 'primary' }[state] || 'info';
}
// 复制输出区文本（提交信息 / 原始返回共用）
async function copyText(v) {
  try {
    await navigator.clipboard.writeText(v || '');
    ElMessage.success(t('model.taskQuery.copied'));
  } catch {
    ElMessage.error(t('model.taskQuery.copyFailed'));
  }
}

// 导入/导出
async function exportCfg() {
  const data = await modelApi.exportCfg(false);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aidroma-models-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(t('model.msg.exported'));
}

function onImport(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      const configs = json.configs || json;
      const res = await modelApi.importCfg(configs);
      ElMessage.success(t('model.msg.imported', { n: res.imported }));
      load();
    } catch (err) {
      ElMessage.error(t('model.msg.importFailed', { msg: err.message }));
    }
  };
  reader.readAsText(file.raw || file);
  return false;
}

onMounted(() => {
  load();
  vendorApi.list().then((rows) => { vendors.value = rows || []; }).catch(() => {});
});
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="ad-page-head ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg ad-title">{{ t('model.title') }}</div>
          <div class="ad-sub">{{ t('model.subtitle') }}</div>
        </div>
        <div class="ad-flex-center ad-gap-sm">
          <el-upload :show-file-list="false" :before-upload="onImport" accept=".json">
            <el-button><el-icon><Upload /></el-icon> {{ t('model.import') }}</el-button>
          </el-upload>
          <el-button @click="exportCfg"><el-icon><Download /></el-icon> {{ t('model.export') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="openCreate"><el-icon><Plus /></el-icon> {{ t('model.create') }}</el-button>
        </div>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <!-- 类型切换 -->
      <div class="type-tabs ad-stagger">
        <button v-for="typ in TYPES" :key="typ.key" class="type-tab ad-card" :class="{ active: activeType === typ.key }" @click="activeType = typ.key">
          <el-icon :size="22"><component :is="typ.icon" /></el-icon>
          <div>
            <div class="ad-title">{{ t(`model.types.${typ.key}.label`) }}</div>
            <div class="ad-sub" style="font-size:12px;">{{ t(`model.types.${typ.key}.desc`) }}</div>
          </div>
        </button>
      </div>

      <!-- 配置列表 -->
      <div class="cfg-list ad-stagger">
        <div v-for="c in filtered" :key="c.id" class="cfg-item ad-card">
          <div class="cfg-main">
            <div class="ad-flex-center ad-gap-sm">
              <span class="ad-title">{{ c.name }}</span>
              <span class="chip" v-if="c.is_default">{{ t('model.chip.default') }}</span>
              <span class="chip" :class="c.enabled ? 'chip-success' : 'chip-danger'">{{ c.enabled ? t('common.enable') : t('common.disable') }}</span>
              <span class="chip">{{ c.provider }}</span>
              <span class="chip" v-if="c.type === 'image'">≤{{ c.max_size || '2K' }}</span>
              <span class="chip" v-if="c.type === 'video' && c.translate_prompt_en">{{ t('model.chip.translateEn') }}</span>
              <span class="chip" v-if="c.type === 'video' && inputLimitsChip(c)">{{ inputLimitsChip(c) }}</span>
              <span class="chip chip-promo" v-if="promoOff(c) != null">{{ t('model.chip.promo', { p: promoOff(c) }) }}</span>
            </div>
            <div class="ad-sub" style="margin-top: 6px;">
              <span class="ad-muted">{{ t('model.baseUrl') }}</span>{{ c.base_url || '—' }}
              <span class="ad-muted" style="margin-left:12px;">{{ t('model.modelLabel') }}</span>{{ c.model || '—' }}
              <span class="ad-muted" style="margin-left:12px;">{{ t('model.keyLabel') }}</span>{{ c.api_key_masked || '—' }}
            </div>
            <div class="ad-sub" style="margin-top: 4px;" v-if="priceSummary(c)">
              <span class="ad-muted">{{ t('model.billing') }}</span>{{ priceSummary(c) }}
            </div>
            <div class="ad-sub promo-line" style="margin-top: 4px;" v-if="promoSummary(c)">
              <span class="ad-muted">{{ t('model.promo.label') }}</span>{{ promoSummary(c) }}
            </div>
          </div>
          <div class="cfg-ops">
            <el-button v-if="c.type === 'video'" size="small" text type="primary" @click="openTaskQuery(c)">{{ t('model.taskQuery.label') }}</el-button>
            <el-button v-if="!c.is_default" size="small" text @click="setDefault(c)">{{ t('model.setDefault') }}</el-button>
            <el-button size="small" text @click="openEdit(c)">{{ t('common.edit') }}</el-button>
            <el-button size="small" text type="danger" @click="remove(c)">{{ t('common.delete') }}</el-button>
          </div>
        </div>
        <EmptyState
          v-if="!filtered.length"
          class="ad-card"
          icon="⚙️"
          :title="t('model.empty.title', { type: t(`model.types.${activeType}.label`) })"
          :description="t('model.empty.desc')"
          :action-label="t('model.create')"
          @action="openCreate"
        />
      </div>

      <!-- 表单弹窗 -->
      <el-dialog v-model="showForm" :title="editing ? t('model.dialog.editTitle') : t('model.create')" width="min(760px, 94vw)">
        <el-form label-position="top" class="model-form-grid">
          <el-form-item :label="t('common.name')"><el-input size="large" v-model="form.name" :placeholder="t('model.placeholder.name')" /></el-form-item>
          <el-form-item :label="t('common.type')">
            <el-select size="large" v-model="form.type" style="width:100%" @change="onTypeChange">
              <el-option v-for="typ in TYPES" :key="typ.key" :label="t(`model.types.${typ.key}.label`)" :value="typ.key" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('model.provider')">
            <el-select size="large" v-model="form.provider" style="width:100%" filterable @change="onProviderChange">
              <el-option v-for="p in providerOptions" :key="p.code" :label="p.name" :value="p.code" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('model.apiStyle.label')">
            <el-radio-group v-model="form.api_style">
              <el-radio value="openai">{{ t('model.apiStyle.openai') }}</el-radio>
              <el-radio value="custom">{{ t('model.apiStyle.custom') }}</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('model.baseUrlLabel')"><el-input size="large" v-model="form.base_url" placeholder="https://api.openai.com/v1" /></el-form-item>
          <el-form-item :label="editing ? t('model.apiKey.keep') : t('model.apiKey.label')">
            <el-input size="large" v-model="form.api_key" type="password" show-password placeholder="sk-..." />
          </el-form-item>
          <el-form-item class="span-full" :label="t('model.modelName')"><el-input size="large" v-model="form.model" placeholder="gpt-4o-mini / dall-e-3" /></el-form-item>
          <el-form-item class="span-full" :label="t('model.params')">
            <el-input size="large" v-model="form.params" type="textarea" :rows="3" placeholder='{"temperature":0.7}' />
          </el-form-item>

          <!-- 价格 -->
          <el-form-item class="span-full" :label="priceLabel">
            <el-input-number v-model="form.price" :min="0" :precision="2" :step="1" controls-position="right" style="width:100%" />
            <div class="ad-sub" style="font-size:12px; margin-top:4px;">
              <template v-if="form.type === 'video'">{{ t('model.price.helpVideo') }}</template>
              <template v-else-if="form.type === 'asr'">{{ t('model.price.helpAsr') }}</template>
              <template v-else>{{ t('model.price.helpOther') }}</template>
            </div>
          </el-form-item>

          <!-- 视频分辨率：每个分辨率独立每秒价 -->
          <el-form-item v-if="form.type === 'video'" class="span-full" :label="t('model.resolution.label')">
            <div v-for="(r, i) in form.resolutions" :key="i" class="res-row">
              <el-select size="large" v-model="r.value" allow-create filterable default-first-option :placeholder="t('model.resolution.placeholder')" style="width:150px;">
                <el-option v-for="opt in VIDEO_RESOLUTION_PRESETS" :key="opt" :label="opt" :value="opt" />
              </el-select>
              <el-input-number v-model="r.price" :min="0" :precision="2" :step="1" controls-position="right" style="width:160px;" />
              <span class="ad-muted" style="font-size:12px;">{{ t('model.resolution.unit') }}</span>
              <el-button text type="danger" @click="removeResolution(i)"><el-icon><Delete /></el-icon></el-button>
            </div>
            <el-button size="small" @click="addResolution"><el-icon><Plus /></el-icon> {{ t('model.resolution.add') }}</el-button>
          </el-form-item>

          <!-- 最大支持尺寸（图像唯一尺寸配置）：生图一律按该档位换算画幅长宽提交，不生成高于该档的图 -->
          <el-form-item v-if="form.type === 'image'" class="span-full" :label="t('model.maxSize.label')">
            <el-select size="large" v-model="form.max_size" style="width:100%">
              <el-option v-for="opt in IMAGE_MAX_SIZE_PRESETS" :key="opt" :label="opt" :value="opt" />
            </el-select>
            <div class="ad-sub" style="font-size:12px; margin-top:4px;">{{ t('model.maxSize.help') }}</div>
          </el-form-item>

          <!-- 限时折扣活动（可选）：活动期内该模型按折扣价计费，生成确认页展示原价/折后价/优惠幅度 -->
          <el-form-item class="span-full" :label="t('model.promo.label')">
            <div class="promo-row">
              <el-input-number
                v-model="form.promo_discount"
                :min="1" :max="99" :precision="0" :step="5"
                controls-position="right"
                :placeholder="t('model.promo.discountPlaceholder')"
                style="width: 140px;"
              />
              <span class="ad-muted" style="font-size: 12px;">% · {{ t('model.promo.billingPercent') }}</span>
              <el-date-picker
                v-model="form.promoRange"
                type="datetimerange"
                :start-placeholder="t('model.promo.startPlaceholder')"
                :end-placeholder="t('model.promo.endPlaceholder')"
                style="width: min(380px, 100%);"
              />
            </div>
            <div class="ad-sub" style="font-size:12px; margin-top:4px;">{{ t('model.promo.help') }}</div>
            <div class="ad-sub promo-preview" style="font-size:12px; margin-top:4px;" v-if="promoPreview">{{ promoPreview }}</div>
          </el-form-item>

          <!-- 提示词英译（仅视频模型）：提交前先用默认文本大模型把提示词翻译成英文 -->
          <el-form-item v-if="form.type === 'video'" class="span-full" :label="t('model.translatePromptEn.label')">
            <div class="ad-flex-center" style="gap: 12px;">
              <el-switch v-model="form.translate_prompt_en" />
              <span class="ad-sub" style="font-size:12px;">{{ t('model.translatePromptEn.help') }}</span>
            </div>
          </el-form-item>

          <!-- 输入上限与全局并发（仅视频模型）：留空=不限，0=不支持该类输入；并发为全用户共享 -->
          <el-form-item v-if="form.type === 'video'" class="span-full" :label="t('model.inputLimits.label')">
            <div class="limit-grid">
              <div class="limit-item">
                <span class="ad-muted" style="font-size:12px;">{{ t('model.inputLimits.images') }}</span>
                <el-input-number v-model="form.max_input_images" :min="0" :max="99" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:130px;" />
              </div>
              <div class="limit-item">
                <span class="ad-muted" style="font-size:12px;">{{ t('model.inputLimits.audios') }}</span>
                <el-input-number v-model="form.max_input_audios" :min="0" :max="99" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:130px;" />
              </div>
              <div class="limit-item">
                <span class="ad-muted" style="font-size:12px;">{{ t('model.inputLimits.videos') }}</span>
                <el-input-number v-model="form.max_input_videos" :min="0" :max="99" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:130px;" />
              </div>
              <div class="limit-item">
                <span class="ad-muted" style="font-size:12px;">{{ t('model.inputLimits.concurrency') }}</span>
                <el-input-number v-model="form.max_concurrency" :min="0" :max="999" :step="1" controls-position="right" :placeholder="t('model.inputLimits.unlimited')" style="width:130px;" />
              </div>
            </div>
            <div class="ad-sub" style="font-size:12px; margin-top:4px;">{{ t('model.inputLimits.hint') }}</div>
          </el-form-item>
          <el-form-item class="span-full">
            <div class="ad-flex-center" style="gap: var(--ad-sp-4);">
              <el-switch v-model="form.enabled" :active-text="t('common.enable')" />
              <el-switch v-model="form.is_default" :active-text="t('model.switch.default')" />
            </div>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="showForm = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="save">{{ t('common.save') }}</el-button>
        </template>
      </el-dialog>

      <!-- 视频任务状态查询弹窗：输入任务 ID → 厂商查询 → 输出区展示原始返回文本 -->
      <el-dialog v-model="showTaskQuery" :title="t('model.taskQuery.title')" width="min(720px, 94vw)" @close="tqResult = null">
        <div class="ad-sub" style="margin-bottom: 12px;">
          <span class="ad-muted">{{ t('model.taskQuery.model') }}</span>{{ tqModel?.name || '—' }}
          <span class="ad-muted" style="margin-left:12px;">{{ t('model.taskQuery.vendor') }}</span>{{ tqModel?.provider || '—' }}
        </div>
        <div class="tq-input-row">
          <el-input
            v-model="tqTaskId"
            size="large"
            clearable
            :placeholder="t('model.taskQuery.taskIdPlaceholder')"
            @keyup.enter="runTaskQuery"
          />
          <el-button type="primary" class="btn-ink" size="large" :loading="tqLoading" @click="runTaskQuery">{{ t('model.taskQuery.query') }}</el-button>
        </div>

        <!-- 结果摘要 -->
        <div v-if="tqResult" class="tq-summary">
          <span class="ad-muted">{{ t('model.taskQuery.stateLabel') }}</span>
          <el-tag :type="tqStateType(tqResult.state)" effect="light">{{ tqStateLabel(tqResult.state) }}</el-tag>
          <span class="ad-muted">{{ t('model.taskQuery.vendor') }}</span><span class="chip">{{ tqResult.vendor }}</span>
          <template v-if="tqResult.vendorStatus">
            <span class="ad-muted">{{ t('model.taskQuery.vendorState') }}</span><span class="chip">{{ tqResult.vendorStatus }}</span>
          </template>
          <template v-if="tqResult.httpStatus != null">
            <span class="ad-muted">HTTP</span><span class="chip">{{ tqResult.httpStatus }}</span>
          </template>
        </div>
        <div v-if="tqResult?.message" class="ad-sub" style="margin-top: 6px;">
          <span class="ad-muted">{{ t('model.taskQuery.msgLabel') }}</span>{{ tqResult.message }}
        </div>
        <div v-if="tqResult?.videoUrl" class="ad-sub" style="margin-top: 4px; word-break: break-all;">
          <span class="ad-muted">{{ t('model.taskQuery.videoUrl') }}</span>{{ tqResult.videoUrl }}
          <el-link type="primary" :href="tqResult.videoUrl" target="_blank" style="margin-left: 8px; vertical-align: baseline;">{{ t('model.taskQuery.open') }}</el-link>
        </div>

        <!-- 输出区：提交给厂商的请求信息 + 厂商原始返回文本 -->
        <template v-if="tqResult">
          <div v-if="tqResult.request_text" class="ad-flex-between" style="margin: 14px 0 6px;">
            <span class="ad-title" style="font-size: 13px;">{{ t('model.taskQuery.requestLabel') }}</span>
            <el-button size="small" text @click="copyText(tqResult.request_text)"><el-icon><DocumentCopy /></el-icon> {{ t('model.taskQuery.copy') }}</el-button>
          </div>
          <el-input
            v-if="tqResult.request_text"
            :model-value="tqResult.request_text"
            type="textarea"
            readonly
            :autosize="{ minRows: 4, maxRows: 10 }"
            class="tq-raw"
          />
          <div class="ad-flex-between" style="margin: 14px 0 6px;">
            <span class="ad-title" style="font-size: 13px;">{{ t('model.taskQuery.outputLabel') }}</span>
            <el-button size="small" text @click="copyText(tqResult.raw_text)"><el-icon><DocumentCopy /></el-icon> {{ t('model.taskQuery.copy') }}</el-button>
          </div>
          <el-input
            :model-value="tqResult.raw_text"
            type="textarea"
            readonly
            :autosize="{ minRows: 8, maxRows: 22 }"
            class="tq-raw"
          />
        </template>
        <div v-else-if="tqError" class="tq-error">{{ tqError }}</div>
        <div v-else class="tq-empty">{{ t('model.taskQuery.empty') }}</div>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.model-form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }
.model-form-grid :deep(.span-full) { grid-column: 1 / -1; }
.type-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
.type-tab { display: flex; align-items: center; gap: 12px; padding: 14px 16px; cursor: pointer; border: 2px solid transparent; transition: all 0.15s; text-align: left; color: var(--ad-text-soft); }
.type-tab:hover { box-shadow: var(--ad-shadow-hover); }
.type-tab.active { border-color: var(--ad-brand); color: var(--ad-brand); }
.cfg-list { display: flex; flex-direction: column; gap: 12px; }
.cfg-item { display: flex; align-items: center; justify-content: space-between; padding: var(--ad-sp-5) var(--ad-sp-6); gap: var(--ad-sp-4); flex-wrap: wrap; }
.cfg-main { flex: 1; min-width: 260px; }
.cfg-ops { display: flex; gap: 4px; flex-shrink: 0; }
.res-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
/* 促销活动 chip 与摘要行：品牌金以示区分 */
.chip-promo { background: var(--ad-brand); color: var(--ad-brand-contrast, #221a04); }
.promo-line { color: var(--ad-brand); }
.promo-preview { color: var(--ad-brand); }
.promo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%; }
/* 输入上限/全局并发（仅 video）：四格并排 + 说明行 */
.limit-grid { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; width: 100%; }
.limit-item { display: flex; flex-direction: column; gap: 4px; }
/* 视频任务查询弹窗 */
.tq-input-row { display: flex; gap: 10px; }
.tq-input-row .el-input { flex: 1; }
.tq-summary { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.tq-raw :deep(.el-textarea__inner) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}
.tq-error { margin-top: 14px; color: var(--el-color-danger); font-size: 13px; }
.tq-empty { margin-top: 14px; padding: 24px 0; color: var(--ad-text-muted, #999); font-size: 13px; text-align: center; }
@media (max-width: 768px) {
  .type-tabs { grid-template-columns: 1fr 1fr; }
  .model-form-grid { grid-template-columns: 1fr; }
  .res-row { flex-wrap: wrap; row-gap: 6px; }
  .cfg-item { padding: 12px 14px; }
}
</style>
