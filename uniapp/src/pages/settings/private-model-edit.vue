<script setup>
/**
 * 私有模型 新增/编辑页（独立页面而非弹层：规避 App/小程序弹层 input 初值坑）。
 * 厂商由系统厂商目录选定；接入地址默认取厂商预设、可改为兼容端点（服务端校验）；
 * 模型从厂商清单点选（OpenAI 兼容厂商可用密钥实时拉取，也可直接手输）；API Key 用户自填。
 * 保存走 modelApi.myCreate/myUpdate。
 */
import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { modelApi, vendorApi } from '../../api';
import { toast, toastError, confirm } from '../../utils/ui';
import { copyText } from '../../utils/clipboard';
// #ifdef APP-HARMONY
import { openBrowserUrl } from '../../uni_modules/aidrama-url-opener';
// #endif
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useThemeStore } from '../../stores/theme';
import { useGenConfirmStore } from '../../stores/genConfirm';
import { useBackGuard } from '../../composables/useBackGuard';

useBackGuard();

const { t } = useI18n();
const themeStore = useThemeStore();
const genConfirmStore = useGenConfirmStore();

const TYPE_KEYS = ['text', 'image', 'video', 'tts', 'asr'];
// 与后端 IMAGE_MAX_SIZE_LADDER 同源
const IMAGE_MAX_SIZE_PRESETS = ['1K', '2K', '3K', '4K', '8K'];
// 与后端 MY_VIDEO_RESOLUTIONS 同源同序（从高到低；确认页默认取首档）
const VIDEO_RESOLUTION_PRESETS = ['4K', '2K', '1080p', '720p', '480p'];
// 图像模型新增时的 params 预填：固定 4K 像素尺寸（params 同名键覆盖系统按 max_size 档位的计算值）
const IMAGE_PARAMS_DEFAULT = JSON.stringify({ size: '3840x2160' }, null, 2);
const paramsPlaceholder = '{"size": "3840x2160"}';

const editingId = ref(null); // null = 新增
const ready = ref(false);
const saving = ref(false);
const fetching = ref(false);
const fetchedList = ref([]); // 本次会话拉取的模型 id（与厂商目录清单合并）

const vendors = ref([]);
const form = ref(emptyForm());

function emptyForm() {
  return { name: '', type: 'text', provider: '', base_url: '', model: '', api_key: '', max_size: '2K', params: '{}', resolutions: [], translate_prompt_en: false, max_input_images: null, max_input_audios: null, max_input_videos: null, max_concurrency: null, is_default: false };
}

// 上限输入归一化（⚠️ 先判空再 Number：Number(null)===0 会把「不限」当成上限 0）：空/非法 → null（不限）
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// params 编辑态是 JSON 字符串；空/`{}` 视为未填写
function isParamsBlank() {
  const s = (form.value.params || '').trim();
  return !s || s === '{}';
}

const typeOptions = computed(() => TYPE_KEYS.map((k) => ({ key: k, label: t(`settings.privateModels.types.${k}.label`) })));

// 当前类型支持的厂商
const vendorOptions = computed(() => vendors.value.filter((v) => (v.supported_types || []).includes(form.value.type)));
const currentVendor = computed(() => vendors.value.find((v) => v.code === form.value.provider) || null);

// 模型候选：厂商目录清单 ∪ 拉取结果（去重）
const modelChips = computed(() => {
  const list = [...(currentVendor.value?.models || [])];
  for (const m of fetchedList.value) if (!list.includes(m)) list.push(m);
  return list;
});

// 输入即过滤：按模型输入框文字（不区分大小写）筛选候选清单，清空输入恢复全量
const filteredModelChips = computed(() => {
  const q = (form.value.model || '').trim().toLowerCase();
  if (!q) return modelChips.value;
  return modelChips.value.filter((m) => m.toLowerCase().includes(q));
});

// 拉取条件：OpenAI 兼容厂商 + 已填 Key
const canFetch = computed(() => currentVendor.value?.api_style === 'openai' && !!(form.value.api_key || '').trim());

// 厂商官网（后台厂商目录配置）：补协议兜底，供「官网注册」外跳
const vendorSiteUrl = computed(() => {
  const w = (currentVendor.value?.website || '').trim();
  return w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : '';
});

// 官网注册：H5 新窗口 / App 系统浏览器（鸿蒙走 UTS 桥，plus 在鸿蒙端不存在）；
// 小程序无法直跳任意外链（业务域名限制），退化为复制链接（端上自带「已复制」提示）
function openVendorSite() {
  if (!vendorSiteUrl.value) return;
  // #ifdef H5
  window.open(vendorSiteUrl.value, '_blank');
  // #endif
  // #ifdef APP-PLUS
  plus.runtime.openURL(vendorSiteUrl.value);
  // #endif
  // #ifdef APP-HARMONY
  openBrowserUrl(vendorSiteUrl.value, () => {
    // 起浏览器失败（极端场景）：退化为复制链接，用户可自行粘贴打开
    copyText(vendorSiteUrl.value)
      .then(() => toast(t('common.copied'), 'success'))
      .catch(() => {});
  });
  // #endif
  // #ifdef MP-WEIXIN
  copyText(vendorSiteUrl.value).catch(() => {});
  // #endif
}

function onTypeTap(key) {
  if (editingId.value) return;
  if (form.value.type === key) return;
  form.value.type = key;
  form.value.resolutions = []; // 分辨率档位仅对视频类型有意义，切类型即清空
  // 新增图像模型：params 仍为空时预填默认 size（编辑态不覆盖已存值）
  if (form.value.type === 'image' && isParamsBlank()) {
    form.value.params = IMAGE_PARAMS_DEFAULT;
  }
  // 原厂商可能不支持新类型 → 落到第一个支持的厂商
  if (!vendorOptions.value.some((v) => v.code === form.value.provider)) {
    form.value.provider = vendorOptions.value[0]?.code || '';
    form.value.model = '';
    fetchedList.value = [];
  }
}

// 分辨率档位多选（点选切换）
function toggleResolution(opt) {
  const i = form.value.resolutions.indexOf(opt);
  if (i >= 0) form.value.resolutions.splice(i, 1);
  else form.value.resolutions.push(opt);
}

function onVendorTap(v) {
  if (editingId.value || v.code === form.value.provider) return;
  form.value.provider = v.code;
  form.value.model = '';
  fetchedList.value = [];
}

function onModelChipTap(m) {
  form.value.model = m;
}

async function onFetchModels() {
  if (!canFetch.value || fetching.value) return;
  fetching.value = true;
  try {
    const res = await vendorApi.fetchModels(form.value.provider, form.value.api_key.trim(), (form.value.base_url || '').trim());
    fetchedList.value = res?.models || [];
    toast(t('settings.privateModels.fetchOk', { n: fetchedList.value.length }), 'success');
  } catch (e) {
    toastError(e);
  } finally {
    fetching.value = false;
  }
}

onLoad(async (query) => {
  editingId.value = query?.id ? Number(query.id) : null;
  // 「生成确认 → 使用自己的模型」入口带 type 参数进入（仅新增态生效），自动选中对应类型
  const presetType = !editingId.value && TYPE_KEYS.includes(query?.type) ? query.type : null;
  try {
    vendors.value = (await vendorApi.catalog()) || [];
  } catch (e) {
    vendors.value = [];
  }
  if (editingId.value) {
    try {
      const rows = (await modelApi.myList()) || [];
      const row = rows.find((r) => r.id === editingId.value);
      if (!row) {
        toastError(new Error(t('common.errorNotFound')));
        setTimeout(() => uni.navigateBack(), 800);
        return;
      }
      form.value = {
        name: row.name || '', type: row.type, provider: row.provider || '', base_url: row.base_url || '', model: row.model || '',
        api_key: '', max_size: row.max_size || '2K',
        params: JSON.stringify(row.params || {}, null, 2),
        resolutions: (Array.isArray(row.resolutions) ? row.resolutions : []).map((r) => r && r.value).filter(Boolean),
        translate_prompt_en: !!row.translate_prompt_en,
        max_input_images: row.max_input_images ?? null, max_input_audios: row.max_input_audios ?? null,
        max_input_videos: row.max_input_videos ?? null, max_concurrency: row.max_concurrency ?? null,
        is_default: !!row.is_default,
      };
    } catch (e) {
      toastError(e);
    }
  } else {
    // 新增：预选类型（有带参时）并默认选第一个支持的厂商（onTypeTap 内含图像 params 预填与厂商回落）
    if (presetType) onTypeTap(presetType);
    form.value.provider = vendorOptions.value[0]?.code || '';
  }
  ready.value = true;
});

async function onSave() {
  if (saving.value) return;
  const f = form.value;
  if (!f.provider) { toast(t('settings.privateModels.vendorRequired'), 'error'); return; }
  const model = f.model.trim();
  if (!model) { toast(t('settings.privateModels.modelRequired'), 'error'); return; }
  const key = f.api_key.trim();
  if (!editingId.value && !key) { toast(t('settings.privateModels.keyRequired'), 'error'); return; }
  let params;
  try { params = JSON.parse((f.params || '').trim() || '{}'); } catch { toast(t('model.msg.paramsJson'), 'error'); return; }
  if (!params || typeof params !== 'object' || Array.isArray(params)) { toast(t('model.msg.paramsJson'), 'error'); return; }
  saving.value = true;
  try {
    if (editingId.value) {
      const payload = { name: f.name, model, params, is_default: f.is_default };
      if (key) payload.api_key = key; // 留空保留原 Key
      payload.base_url = (f.base_url || '').trim(); // 留空恢复厂商预设（服务端归一化）
      if (f.type === 'image') payload.max_size = f.max_size;
      if (f.type === 'video') {
        payload.translate_prompt_en = f.translate_prompt_en;
        payload.resolutions = f.resolutions;
        // 上限四件套整组提交（服务端传任一字段即整组更新；null=不限）
        payload.max_input_images = numOrNull(f.max_input_images);
        payload.max_input_audios = numOrNull(f.max_input_audios);
        payload.max_input_videos = numOrNull(f.max_input_videos);
        payload.max_concurrency = numOrNull(f.max_concurrency);
      }
      await modelApi.myUpdate(editingId.value, payload);
    } else {
      const created = await modelApi.myCreate({
        name: f.name, type: f.type, provider: f.provider, base_url: (f.base_url || '').trim(), model, api_key: key,
        params,
        ...(f.type === 'image' ? { max_size: f.max_size } : {}),
        ...(f.type === 'video' ? {
          translate_prompt_en: f.translate_prompt_en, resolutions: f.resolutions,
          max_input_images: numOrNull(f.max_input_images), max_input_audios: numOrNull(f.max_input_audios),
          max_input_videos: numOrNull(f.max_input_videos), max_concurrency: numOrNull(f.max_concurrency),
        } : {}),
        is_default: f.is_default,
      });
      // 「生成确认」弹层若还开着（「使用自己的模型」入口进来）：回灌列表并自动选中刚加的模型
      genConfirmStore.refreshModels(created && created.id);
    }
    toast(t('settings.privateModels.saved'), 'success');
    setTimeout(() => uni.navigateBack(), 400);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function onRemove() {
  if (!editingId.value) return;
  const ok = await confirm({
    title: t('settings.privateModels.delete'),
    content: t('settings.privateModels.deleteConfirm', { name: form.value.name || form.value.model }),
  });
  if (!ok) return;
  try {
    await modelApi.myRemove(editingId.value);
    toast(t('common.deleteSuccess'), 'success');
    setTimeout(() => uni.navigateBack(), 400);
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <view class="ad-page" :class="themeStore.rootCls">
    <AdNavbar :title="editingId ? t('settings.privateModels.edit') : t('settings.privateModels.add')" />

    <view v-if="!ready" class="pm-loading" />

    <block v-else>
      <!-- 类型（编辑态锁定） -->
      <view class="sect-title">{{ t('settings.privateModels.type') }}</view>
      <view class="card pm-block">
        <view class="pm-chipgrid">
          <view
            v-for="opt in typeOptions"
            :key="opt.key"
            class="pm-chip"
            :class="{ on: form.type === opt.key, lock: !!editingId }"
            @tap="onTypeTap(opt.key)"
          >{{ opt.label }}</view>
        </view>
        <text v-if="editingId" class="pm-hint">{{ t('settings.privateModels.editImmutable') }}</text>
      </view>

      <!-- 厂商（编辑态锁定） -->
      <view class="sect-title">{{ t('settings.privateModels.vendor') }}</view>
      <view class="card pm-block">
        <scroll-view scroll-y class="pm-vendors">
          <view class="pm-chipgrid">
            <view
              v-for="v in vendorOptions"
              :key="v.code"
              class="pm-chip"
              :class="{ on: form.provider === v.code, lock: !!editingId }"
              @tap="onVendorTap(v)"
            >{{ v.name }}</view>
          </view>
        </scroll-view>
        <view v-if="currentVendor" class="pm-baserow">
          <text class="pm-baselab">{{ t('settings.privateModels.baseUrl') }}</text>
          <!-- 占位显示厂商预设：留空提交即恢复预设（服务端归一化） -->
          <input v-model="form.base_url" class="pm-input" :placeholder="currentVendor.base_url || 'https://...'" />
        </view>
        <view class="pm-hintrow">
          <text class="pm-hint">{{ t('settings.privateModels.baseUrlHint') }}</text>
          <text v-if="vendorSiteUrl" class="pm-sitelink" @tap="openVendorSite">{{ t('settings.privateModels.visitSite') }}</text>
        </view>
      </view>

      <!-- Key（先填 Key 才能拉取模型清单） -->
      <view class="sect-title">{{ t('settings.privateModels.apiKey') }}</view>
      <view class="card pm-block">
        <input v-model="form.api_key" class="pm-input" password :placeholder="editingId ? t('settings.privateModels.apiKeyKeep') : 'sk-...'" />
      </view>

      <!-- 模型：清单点选 + 手输兜底 -->
      <view class="sect-title">{{ t('settings.privateModels.model') }}</view>
      <view class="card pm-block">
        <scroll-view v-if="filteredModelChips.length" scroll-y class="pm-modelscroll">
          <view class="pm-chipgrid">
            <view
              v-for="m in filteredModelChips"
              :key="m"
              class="pm-chip"
              :class="{ on: form.model === m }"
              @tap="onModelChipTap(m)"
            >{{ m }}</view>
          </view>
        </scroll-view>
        <view class="pm-modelrow">
          <input v-model="form.model" class="pm-input" :placeholder="t('settings.privateModels.modelHint')" />
          <view
            v-if="!currentVendor || currentVendor.api_style === 'openai'"
            class="mbtn sm"
            :class="{ dis: !canFetch || fetching }"
            @tap="onFetchModels"
          >
            <text class="pm-fetch-t">{{ fetching ? t('settings.privateModels.fetching') : t('settings.privateModels.fetchModels') }}</text>
          </view>
        </view>
        <text v-if="currentVendor && currentVendor.api_style !== 'openai'" class="pm-hint">{{ t('settings.privateModels.fetchUnavailable') }}</text>
      </view>

      <!-- 名称 -->
      <view class="sect-title">{{ t('settings.privateModels.name') }}</view>
      <view class="card pm-block">
        <input v-model="form.name" class="pm-input" :placeholder="t('settings.privateModels.namePlaceholder')" maxlength="64" />
      </view>

      <!-- 参数设置（JSON，同名键覆盖系统默认计算值） -->
      <view class="sect-title">{{ t('model.params') }}</view>
      <view class="card pm-block">
        <textarea
          v-model="form.params"
          class="pm-input pm-textarea"
          :placeholder="paramsPlaceholder"
          auto-height
        />
        <text class="pm-hint">{{ t('settings.privateModels.paramsHint') }}</text>
      </view>

      <!-- 类型专属选项 -->
      <block v-if="form.type === 'image'">
        <view class="sect-title">{{ t('settings.privateModels.maxSize') }}</view>
        <view class="card pm-block">
          <view class="pm-chipgrid">
            <view
              v-for="opt in IMAGE_MAX_SIZE_PRESETS"
              :key="opt"
              class="pm-chip"
              :class="{ on: form.max_size === opt }"
              @tap="form.max_size = opt"
            >{{ opt }}</view>
          </view>
        </view>
      </block>
      <block v-if="form.type === 'video'">
        <view class="sect-title">{{ t('settings.privateModels.resolutions') }}</view>
        <view class="card pm-block">
          <view class="pm-chipgrid">
            <view
              v-for="opt in VIDEO_RESOLUTION_PRESETS"
              :key="opt"
              class="pm-chip"
              :class="{ on: form.resolutions.includes(opt) }"
              @tap="toggleResolution(opt)"
            >{{ opt }}</view>
          </view>
          <text class="pm-hint">{{ t('settings.privateModels.resolutionsHint') }}</text>
        </view>
        <!-- 输入上限与全局并发（仅视频类型；留空=不限）：与 admin 同款「标签在上、输入在下」，四组一行不换行 -->
        <view class="sect-title">{{ t('model.inputLimits.label') }}</view>
        <view class="card pm-block">
          <view class="pm-limitgrid">
            <view class="pm-limititem">
              <text class="pm-limitlab">{{ t('model.inputLimits.images') }}</text>
              <input v-model="form.max_input_images" class="pm-input" type="number" :placeholder="t('model.inputLimits.unlimited')" />
            </view>
            <view class="pm-limititem">
              <text class="pm-limitlab">{{ t('model.inputLimits.audios') }}</text>
              <input v-model="form.max_input_audios" class="pm-input" type="number" :placeholder="t('model.inputLimits.unlimited')" />
            </view>
            <view class="pm-limititem">
              <text class="pm-limitlab">{{ t('model.inputLimits.videos') }}</text>
              <input v-model="form.max_input_videos" class="pm-input" type="number" :placeholder="t('model.inputLimits.unlimited')" />
            </view>
            <view class="pm-limititem">
              <text class="pm-limitlab">{{ t('model.inputLimits.concurrency') }}</text>
              <input v-model="form.max_concurrency" class="pm-input" type="number" :placeholder="t('model.inputLimits.unlimited')" />
            </view>
          </view>
          <text class="pm-hint">{{ t('model.inputLimits.hint') }}</text>
        </view>
        <view class="card pm-switchrow">
          <text class="pm-switchlab">{{ t('settings.privateModels.translateEn') }}</text>
          <switch :checked="form.translate_prompt_en" color="#e0b64e" style="transform: scale(0.72);" @change="(e) => (form.translate_prompt_en = e.detail.value)" />
        </view>
      </block>

      <!-- 默认开关 -->
      <view class="card pm-switchrow">
        <text class="pm-switchlab">{{ t('settings.privateModels.isDefault') }}</text>
        <switch :checked="form.is_default" color="#e0b64e" style="transform: scale(0.72);" @change="(e) => (form.is_default = e.detail.value)" />
      </view>

      <!-- 保存 / 删除 -->
      <view class="pm-actions">
        <view class="mbtn" :class="{ dis: saving }" @tap="onSave">{{ t('common.save') }}</view>
        <view v-if="editingId" class="mbtn danger" @tap="onRemove">{{ t('settings.privateModels.delete') }}</view>
      </view>
    </block>

    <view style="height: 30px" />

    <AdDialog />
  </view>
</template>

<style scoped>
/* 与 settings/index.vue 同款分节标题（该类是页面 scoped，这里自带一份） */
.sect-title { font-family: var(--ad-font-serif); font-size: 15px; font-weight: 700; color: var(--ad-text); margin: 20px 12px 12px; }
.pm-loading { height: 200px; }
.pm-block { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }

.pm-chipgrid { display: flex; flex-wrap: wrap; gap: 7px; }
.pm-chip {
  padding: 8px 14px; border-radius: 11px; font-size: 13px; font-weight: 600; line-height: 1;
  background: var(--ad-inset, #0d0d14); border: 1px solid var(--ad-line, #26262f);
  color: var(--ad-text-soft, #b3afa3);
}
.pm-chip.on {
  background: var(--ad-brand-soft, rgba(224, 182, 78, 0.13));
  border-color: rgba(224, 182, 78, 0.35);
  color: var(--ad-brand, #e0b64e);
}
.pm-chip.lock { opacity: 0.75; }

.pm-vendors { max-height: 320px; }
.pm-modelscroll { max-height: 260px; }

.pm-baserow { display: flex; flex-direction: column; gap: 4px; }
.pm-baselab { font-size: 11px; color: var(--ad-text-mut); }
.pm-hint { font-size: 11px; line-height: 1.6; color: var(--ad-text-mut); }
.pm-hintrow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.pm-sitelink { font-size: 11px; font-weight: 600; line-height: 1.6; color: var(--ad-brand, #e0b64e); text-decoration: underline; }

.pm-modelrow { display: flex; gap: 8px; align-items: center; }
.pm-modelrow .pm-input { flex: 1; }
.pm-fetch-t { font-weight: 700; }
.pm-input {
  height: 42px; padding: 0 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 14px;
}
.pm-textarea { width: 100%; height: auto; min-height: 72px; padding: 10px 12px; line-height: 1.5; }

.pm-switchrow { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; }
.pm-switchlab { font-size: 14px; font-weight: 600; color: var(--ad-text); }

/* 输入上限四件套：与 admin 管理页同款「标签在上、输入在下」，四组固定一行不换行 */
.pm-limitgrid { display: flex; align-items: flex-end; gap: 8px; }
.pm-limititem { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.pm-limititem .pm-input { width: 100%; padding: 0 8px; }
.pm-limitlab { font-size: 11px; font-weight: 600; color: var(--ad-text-soft); white-space: nowrap; }

.pm-actions { display: flex; flex-direction: column; gap: 10px; padding: 16px 12px 0; }
.dis { opacity: 0.45; }
</style>
