<script setup>
import { computed, onUnmounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useGenConfirmStore } from '../stores/genConfirm';
import { formatCredits } from '../utils/format';

const { t } = useI18n();
const store = useGenConfirmStore();

// v-model 桥接：用户主动关闭(X/ESC/点遮罩) → 走 cancel()；程序设置 visible=false → 不触发 set
const dialogVisible = computed({
  get: () => store.visible,
  set: (v) => { if (!v) store.cancel(); else store.visible = true; },
});

// 展示用积分：批量求和可能出现浮点噪声（37.800000000000004），统一格式化为 2 位小数
const credits = computed(() => formatCredits(store.credits));

// 单价/计费来源明细（有折扣时每秒单价按折后价展示）
const detailParts = computed(() => {
  const est = store.estimate;
  if (!est) return [];
  const parts = [];
  if (est.count) parts.push(t('genConfirm.countItems', { n: est.count }));
  if (Number(est.perSec) > 0) {
    const ps = store.promo ? (est.perSec * store.promo.percent) / 100 : est.perSec;
    parts.push(t('genConfirm.perSec', { n: formatCredits(ps) }));
  }
  if (est.source === 'global') parts.push(t('genConfirm.globalPricing'));
  return parts;
});

// 模型限时折扣（客户端按模型上的活动起止自行判定，供模型下拉里挂优惠标签）
function modelPromoOff(m) {
  const p = Number(m && m.promo_discount);
  if (!p || p <= 0 || p >= 100) return null;
  const now = Date.now();
  const s = m.promo_start_at ? new Date(m.promo_start_at).getTime() : NaN;
  const e = m.promo_end_at ? new Date(m.promo_end_at).getTime() : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || now < s || now > e) return null;
  return Math.round((100 - p) * 100) / 100;
}

// 分辨率选项单价（有折扣时展示折后单价）
function resLabel(r) {
  if (r.price == null) return r.value;
  const p = store.promo ? (r.price * store.promo.percent) / 100 : r.price;
  return `${r.value} · ${formatCredits(p)} ${t('genConfirm.creditsPerSec')}`;
}

// 私有模型（用户自带 Key）：调用不计积分——标签/选项挂「免费」徽标，价格区与确认钮按免费口径
const isPrivateEst = computed(() => store.estimate?.source === 'private');

const modelLabel = computed(() => {
  if (store.modelType === 'video') return t('genConfirm.videoModel');
  if (store.modelType === 'image') return t('genConfirm.imageModel');
  if (store.modelType === 'text') return t('genConfirm.textModel');
  if (store.modelType === 'asr') return t('genConfirm.asrModel');
  return t('genConfirm.model');
});

const confirmDisabled = computed(() => store.estimating || !!store.error);

// 分辨率档位排序权重：'480p'→480、'2K'→2000、'4K'→4000；无法识别的排最后
function resRank(v) {
  const s = String(v || '').trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)p$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)k$/);
  if (m) return Number(m[1]) * 1000;
  return Infinity;
}

// 视频模型标签项的附加信息：最低档分辨率 + 对应每秒价（档位无价时回退模型基准价；其余模型类型不展示）。
// 每个标签按模型自己的限时折扣折算；不能用当前所选模型的估价折扣（store.promo），否则切标签会连带改其他标签的价
function lowestResMeta(m) {
  if (store.modelType !== 'video') return '';
  if (m.is_private) return ''; // 私有模型免费，不展示价格说明（由「免费」徽标表达）
  const list = (Array.isArray(m.resolutions) ? m.resolutions : [])
    .filter((r) => r && r.value)
    .sort((a, b) => resRank(a.value) - resRank(b.value));
  const low = list[0];
  if (!low) return '';
  const raw = low.price != null ? Number(low.price) : Number(m.price) || 0;
  const off = modelPromoOff(m);
  const price = off != null ? (raw * (100 - off)) / 100 : raw;
  return t('genConfirm.lowestResPrice', { res: low.value, n: formatCredits(price) });
}

const isVideoType = computed(() => store.modelType === 'video');

// 「使用自己的模型」：始终新开窗口到设置页直接弹出新增私有模型弹窗（自动选中对应类型）；
// 本页确认框保持打开、原页面不丢上下文，加完模型切回本窗口时由 focus 监听刷新候选列表并选中新模型
function goAddPrivateModel() {
  if (!store.modelType) return;
  window.open(`/settings?addPrivateModel=${store.modelType}`, '_blank');
}

// 确认框打开期间监听窗口重新聚焦：用户很可能刚从设置页加完模型切回来，刷新一次候选列表。
// 未加模型时仅多一次列表请求，无副作用
function onWinFocus() {
  store.refreshModels();
}
watch(() => store.visible, (v) => {
  if (v) window.addEventListener('focus', onWinFocus);
  else window.removeEventListener('focus', onWinFocus);
});
onUnmounted(() => window.removeEventListener('focus', onWinFocus));

// 当前所选模型是否支持参考图：已设参考图但模型不支持时，生图会静默退回纯文生图，需提示用户
const refUnsupported = computed(() => !!store.referenceImage && store.showReferenceImage && store.estimate?.supportsReferenceImages === false);

// 参考图上传前校验
function beforeRefUpload(file) {
  const isImg = file.type && file.type.startsWith('image/');
  const under10M = file.size / 1024 / 1024 < 10;
  if (!isImg) ElMessage.error(t('genConfirm.imageOnly'));
  else if (!under10M) ElMessage.error(t('genConfirm.imageMaxSize'));
  return isImg && under10M;
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="store.title"
    width="min(440px, 94vw)"
    :close-on-click-modal="false"
    align-center
    class="gen-confirm"
  >
    <!-- 描述 -->
    <div v-if="store.desc" class="gc-desc">{{ store.desc }}</div>

    <!-- 模型选择：视频模型走标签单选，其余类型仍用下拉 -->
    <div v-if="store.showModelSelect" class="gc-field">
      <label class="gc-label">{{ modelLabel }}</label>
      <template v-if="isVideoType">
        <div v-if="store.models.length" class="gc-mtags">
          <button
            v-for="m in store.models"
            :key="m.id"
            type="button"
            class="gc-mtag"
            :class="{ on: m.id === store.selection.modelConfigId }"
            @click="store.setModel(m.id)"
          >
            <span class="gc-mtag-name">{{ m.name }}
              <span v-if="m.is_private" class="gc-mtag-free">{{ t('genConfirm.freeBadge') }}</span>
              <span v-if="m.is_default" class="gc-mtag-badge">{{ t('genConfirm.defaultBadge') }}</span>
              <span v-if="modelPromoOff(m) != null" class="gc-mtag-off">-{{ modelPromoOff(m) }}%</span>
            </span>
            <span v-if="lowestResMeta(m)" class="gc-mtag-meta">{{ lowestResMeta(m) }}</span>
          </button>
        </div>
        <div v-else class="gc-hint">{{ t('genConfirm.noModelHint', { model: modelLabel }) }}</div>
      </template>
      <template v-else>
        <el-select
          :model-value="store.selection.modelConfigId"
          :placeholder="t('genConfirm.selectModel')"
          size="large"
          class="gc-select"
          :disabled="!store.models.length"
          @update:model-value="store.setModel"
        >
          <el-option
            v-for="m in store.models"
            :key="m.id"
            :label="m.name + (m.is_default ? t('genConfirm.defaultBadge') : '')"
            :value="m.id"
          >
            <div class="gc-opt">
              <span class="gc-opt-name">{{ m.name }}{{ m.is_default ? t('genConfirm.defaultBadge') : '' }}</span>
              <span v-if="m.is_private" class="gc-opt-free">{{ t('genConfirm.freeBadge') }}</span>
              <span v-if="modelPromoOff(m) != null" class="gc-opt-promo">-{{ modelPromoOff(m) }}%</span>
              <span v-if="lowestResMeta(m)" class="gc-opt-meta">{{ lowestResMeta(m) }}</span>
            </div>
          </el-option>
        </el-select>
        <div v-if="!store.models.length" class="gc-hint">{{ t('genConfirm.noModelHint', { model: modelLabel }) }}</div>
      </template>
      <!-- 使用自己的模型（自带 Key 不扣积分）：新开窗口到设置页新增私有模型，本页确认框保持打开 -->
      <button type="button" class="gc-own-model" @click="goAddPrivateModel">
        <el-icon><Key /></el-icon> {{ t('genConfirm.useOwnModel') }}
      </button>
    </div>

    <!-- 分辨率选择（视频模型档位，或合成等无模型场景的静态档位） -->
    <div v-if="store.resolutions.length" class="gc-field">
      <label class="gc-label">{{ t('genConfirm.resolution') }}</label>
      <el-select
        :model-value="store.selection.resolution"
        :placeholder="t('genConfirm.resolution')"
        size="large"
        class="gc-select"
        @update:model-value="store.setResolution"
      >
        <el-option
          v-for="r in store.resolutions"
          :key="r.value"
          :label="resLabel(r)"
          :value="r.value"
        />
      </el-select>
      <div v-if="store.resolutionHint" class="gc-hint">{{ store.resolutionHint }}</div>
    </div>

    <!-- 参考图（图生图，可选；仅图像生成为资产启用） -->
    <div v-if="store.showReferenceImage" class="gc-field">
      <label class="gc-label">{{ t('genConfirm.referenceImageLabel') }}</label>
      <div v-if="store.referenceImage" class="gc-ref-set">
        <img :src="store.referenceImage" :alt="t('genConfirm.refImage')" class="gc-ref-img" />
        <el-button text type="danger" size="small" :disabled="store.refUploading" @click="store.removeReferenceImage">{{ t('genConfirm.remove') }}</el-button>
      </div>
      <el-upload
        v-else
        :show-file-list="false"
        :auto-upload="true"
        :before-upload="beforeRefUpload"
        :http-request="(o) => store.uploadReferenceImage(o.file)"
        accept="image/*"
      >
        <el-button :loading="store.refUploading"><el-icon><Upload /></el-icon> {{ t('genConfirm.addReferenceImage') }}</el-button>
      </el-upload>
      <div v-if="refUnsupported" class="gc-ref-warn">{{ t('genConfirm.refUnsupportedWarn') }}</div>
      <div v-else class="gc-hint">{{ t('genConfirm.refHint') }}</div>
      <div v-if="store.refError" class="gc-ref-error">{{ store.refError }}</div>
    </div>

    <!-- 本次要求（仅润色提示词入口）：填写后随任务一并提交给 LLM -->
    <div v-if="store.showRequirement" class="gc-field">
      <label class="gc-label">{{ t('genConfirm.requirementLabel') }}</label>
      <!-- 快捷输入：点击追加到输入框，再次点击移除（激活态高亮） -->
      <div v-if="store.requirementPresets.length" class="gc-req-presets">
        <button
          v-for="p in store.requirementPresets"
          :key="p"
          type="button"
          class="gc-req-chip"
          :class="{ active: store.requirement.includes(p) }"
          @click="store.toggleRequirementPreset(p)"
        >{{ p }}</button>
      </div>
      <el-input size="large"
        :model-value="store.requirement"
        type="textarea"
        :rows="3"
        maxlength="800"
        show-word-limit
        :placeholder="t('genConfirm.requirementPlaceholder')"
        @update:model-value="store.setRequirement"
      />
      <div class="gc-hint">{{ t('genConfirm.requirementHint') }}</div>
    </div>

    <!-- 价格区 -->
    <div class="gc-price">
      <template v-if="store.estimating">
        <span class="gc-price-loading"><el-icon class="is-loading"><Loading /></el-icon> {{ t('genConfirm.estimating') }}</span>
      </template>
      <template v-else-if="store.error">
        <span class="gc-price-error">{{ store.error }}</span>
      </template>
      <template v-else-if="isPrivateEst">
        <div class="gc-price-main gc-price-free"><el-icon><CircleCheckFilled /></el-icon> {{ t('genConfirm.privateFree') }}</div>
      </template>
      <template v-else>
        <div v-if="store.promo" class="gc-price-orig">
          {{ t('genConfirm.promoOriginal') }} <s>{{ formatCredits(store.promo.originalCredits) }}</s> {{ t('common.credits') }}
          <span class="gc-promo-tag">-{{ store.promo.offPercent }}%</span>
        </div>
        <div class="gc-price-main">{{ t('genConfirm.estimatedCost') }} <b>{{ credits }}</b> {{ t('common.credits') }}</div>
        <div v-if="store.promo" class="gc-price-save">{{ t('genConfirm.promoSave', { n: formatCredits(store.promo.saved), p: store.promo.offPercent }) }}</div>
        <div v-if="detailParts.length" class="gc-price-detail">{{ detailParts.join(' · ') }}</div>
      </template>
    </div>

    <template #footer>
      <el-button size="large" @click="store.cancel">{{ t('common.cancel') }}</el-button>
      <el-button size="large" type="primary" class="btn-ink" :disabled="confirmDisabled" @click="store.confirm">
        {{ isPrivateEst ? t('genConfirm.confirmFree') : t('genConfirm.confirmWithCredits', { n: credits }) }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.gc-desc { font-size: 14px; color: var(--ad-text-soft); line-height: 1.7; margin-bottom: 18px; }
.gc-field { margin-bottom: 16px; }
.gc-label { display: block; font-size: 13px; font-weight: 600; color: var(--ad-text); margin-bottom: 8px; }
.gc-select { width: 100%; }
/* 视频模型标签单选：胶囊标签 + 次行价格说明（选中态品牌金） */
.gc-mtags { display: flex; flex-wrap: wrap; gap: 8px; }
.gc-mtag {
  padding: 6px 14px; border-radius: 18px;
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border);
  cursor: pointer; transition: all .15s ease; text-align: left;
}
.gc-mtag:hover { border-color: var(--ad-brand); }
.gc-mtag.on { background: var(--ad-brand-soft); border-color: var(--ad-brand); }
.gc-mtag-name { display: block; font-size: 12px; font-weight: 500; line-height: 1.4; color: var(--ad-text-soft); white-space: nowrap; }
.gc-mtag.on .gc-mtag-name { color: var(--ad-brand); font-weight: 600; }
.gc-mtag-badge { display: inline-block; font-size: 10px; line-height: 1.6; padding: 0 7px; margin-left: 4px; border-radius: 999px; background: var(--ad-brand); color: var(--ad-brand-contrast, #221a04); }
/* 私有模型「免费」徽标：成功绿与默认金区分 */
.gc-mtag-free { display: inline-block; font-size: 10px; line-height: 1.6; padding: 0 7px; margin-left: 4px; border-radius: 999px; background: var(--el-color-success); color: #fff; }
.gc-mtag-off { display: inline-block; margin-left: 4px; font-size: 11px; font-weight: 700; color: var(--el-color-danger); }
.gc-mtag-meta { display: block; font-size: 11px; line-height: 1.5; color: var(--ad-text-muted); margin-top: 1px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.gc-hint { font-size: 12px; color: var(--ad-text-muted); margin-top: 6px; line-height: 1.6; }
/* 「使用自己的模型」入口：虚线胶囊链接，品牌金色 hover 加深 */
.gc-own-model {
  display: inline-flex; align-items: center; gap: 5px;
  margin-top: 10px; padding: 5px 14px; border-radius: 999px; font-size: 12px; font-weight: 600;
  border: 1px dashed var(--ad-brand); background: transparent; color: var(--ad-brand);
  cursor: pointer; transition: all .15s ease;
}
.gc-own-model:hover { background: var(--ad-brand-soft); }
/* 快捷输入 chips：点击追加/移除，激活态品牌色填充 */
.gc-req-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.gc-req-chip {
  font-size: 12px; line-height: 1.5; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--ad-border); background: var(--ad-bg-soft); color: var(--ad-text-soft);
  cursor: pointer; transition: all .15s ease;
}
.gc-req-chip:hover { border-color: var(--ad-brand); color: var(--ad-brand); }
.gc-req-chip.active {
  background: var(--ad-brand); border-color: var(--ad-brand); color: var(--ad-brand-contrast);
}
.gc-ref-set { display: flex; align-items: center; gap: 12px; }
.gc-ref-img { width: 72px; height: 72px; object-fit: cover; border-radius: var(--ad-radius-sm); border: 1px solid var(--ad-border); }
.gc-ref-error { font-size: 12px; color: var(--el-color-danger); margin-top: 6px; }
.gc-ref-warn { font-size: 12px; color: var(--ad-warning); margin-top: 6px; line-height: 1.6; }
.gc-price {
  margin-top: 6px; padding: 14px 16px; border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-soft); border: 1px solid var(--ad-border); text-align: center;
}
.gc-price-main { font-size: 15px; color: var(--ad-text-soft); }
.gc-price-main b { font-size: 22px; color: var(--ad-warning); margin: 0 4px; font-variant-numeric: tabular-nums; }
.gc-price-free { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 15px; font-weight: 600; color: var(--el-color-success); }
.gc-price-detail { font-size: 12px; color: var(--ad-text-muted); margin-top: 6px; }
.gc-price-orig { font-size: 13px; color: var(--ad-text-muted); }
.gc-price-orig s { text-decoration-color: var(--ad-text-muted); }
.gc-price-save { font-size: 12px; font-weight: 600; margin-top: 6px; color: var(--ad-brand); }
/* 促销标签：划线价行内的小徽标（模型下拉选项的促销徽标在 popper 里，见文末非 scoped 块） */
.gc-promo-tag {
  margin-left: 8px; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 999px;
  background: var(--ad-brand); color: var(--ad-brand-contrast, #221a04);
}
.gc-upgrade-link { color: var(--ad-brand); font-weight: 600; }
.gc-upgrade-link:hover { opacity: 0.8; }
.gc-price-loading, .gc-price-error { font-size: 14px; }
.gc-price-loading { color: var(--ad-text-muted); }
.gc-price-error { color: var(--el-color-danger); }
</style>

<style>
/* 模型下拉选项在 el-select 的 popper 里（teleport 到 body），scoped 样式作用不到，须放非 scoped 块（gc- 前缀防冲突） */
.gc-opt { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.gc-opt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-opt-meta { flex-shrink: 0; font-size: 12px; color: var(--ad-text-muted); font-variant-numeric: tabular-nums; }
.gc-opt-promo {
  flex-shrink: 0; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 999px;
  background: var(--ad-brand); color: var(--ad-brand-contrast, #221a04);
}
.gc-opt-free {
  flex-shrink: 0; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 999px;
  background: var(--el-color-success); color: #fff;
}
</style>
