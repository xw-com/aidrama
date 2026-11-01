<script setup>
/**
 * 统一「模型 + 价格」确认页（client GenConfirmDialog → 手机端底部抽屉版）。
 * 直接绑定 stores/genConfirm（与 client 同源）；由 useCostAction 驱动，各页挂一份即可。
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useGenConfirmStore } from '../../stores/genConfirm';
import { formatCredits } from '../../utils/format';
import { toAbsolute } from '../../utils/media';
import { toast, selectSheet } from '../../utils/ui';

const { t } = useI18n();
const store = useGenConfirmStore();

// 展示用积分：批量求和可能出现浮点噪声，统一格式化为 2 位小数
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

// 模型限时折扣（客户端按模型上的活动起止自行判定，供模型名称串挂优惠标签）
function modelPromoOff(m) {
  const p = Number(m && m.promo_discount);
  if (!p || p <= 0 || p >= 100) return null;
  const now = Date.now();
  const s = m.promo_start_at ? new Date(m.promo_start_at).getTime() : NaN;
  const e = m.promo_end_at ? new Date(m.promo_end_at).getTime() : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || now < s || now > e) return null;
  return Math.round((100 - p) * 100) / 100;
}

// 分辨率档位单价（有折扣时展示折后单价）
function resPrice(r) {
  if (r.price == null) return null;
  return store.promo ? (r.price * store.promo.percent) / 100 : r.price;
}

const modelLabel = computed(() => {
  if (store.modelType === 'video') return t('genConfirm.videoModel');
  if (store.modelType === 'image') return t('genConfirm.imageModel');
  if (store.modelType === 'text') return t('genConfirm.textModel');
  if (store.modelType === 'asr') return t('genConfirm.asrModel');
  return t('genConfirm.model');
});

// 分辨率档位排序权重：'480p'→480、'2K'→2000、'4K'→4000；无法识别的排最后
function resRank(v) {
  const s = String(v || '').trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)p$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)k$/);
  if (m) return Number(m[1]) * 1000;
  return Infinity;
}

// 视频模型标签项附加「最低档分辨率 + 每秒价」（档位无价时回退模型基准价；其余模型类型不加）
function lowestResText(m) {
  if (store.modelType !== 'video') return '';
  if (m.is_private) return ''; // 私有模型免费，不标每秒价
  const list = (Array.isArray(m.resolutions) ? m.resolutions : [])
    .filter((r) => r && r.value)
    .sort((a, b) => resRank(a.value) - resRank(b.value));
  const low = list[0];
  if (!low) return '';
  const raw = low.price != null ? Number(low.price) : Number(m.price) || 0;
  // 每个标签按模型自己的限时折扣折算单价；不能用当前所选模型的估价折扣（store.promo），
  // 否则切换标签后其他标签的单位价会跟着所选模型的折扣一起变
  const off = modelPromoOff(m);
  const price = off != null ? (raw * (100 - off)) / 100 : raw;
  return t('genConfirm.lowestResPrice', { res: low.value, n: formatCredits(price) });
}

const isVideoType = computed(() => store.modelType === 'video');

// 「使用自己的模型」：跳新增私有模型页（带类型参数，进入后自动选中对应类型）。
// 确认弹层保持挂起：保存后由 private-model-edit 调 store.refreshModels 回灌列表并自动选中新模型
function goAddPrivateModel() {
  if (!store.modelType) return;
  uni.navigateTo({ url: `/pages/settings/private-model-edit?type=${store.modelType}` });
}

// 模型下拉（selectSheet 底部选择面板，弃用原生 picker）
// 促销/最低档价都只能拼进纯文本名称串；选中值展示也带上，超宽走 .ad-picker-val 的省略号
const modelNames = computed(() => store.models.map((m) => {
  const off = modelPromoOff(m);
  const meta = lowestResText(m);
  return m.name
    + (m.is_private ? t('genConfirm.freeBadge') : '')
    + (m.is_default ? t('genConfirm.defaultBadge') : '')
    + (off != null ? ` -${off}%` : '')
    + (meta ? ` (${meta})` : '');
}));
// modelOpen 驱动箭头朝向（关=向下，开=向上）
const modelOpen = ref(false);
async function pickModel() {
  if (!store.models.length) return;
  modelOpen.value = true;
  try {
    const k = await selectSheet({
      title: modelLabel.value,
      items: store.models.map((m, i) => ({ key: String(m.id), label: modelNames.value[i], private: m.is_private })),
      current: store.selection?.modelConfigId != null ? String(store.selection.modelConfigId) : String(store.models[modelIndexFallback.value]?.id ?? ''),
    });
    if (k !== null) store.setModel(Number(k));
  } finally {
    modelOpen.value = false;
  }
}
const modelIndexFallback = computed(() => {
  const i = store.models.findIndex((m) => m.id === store.selection?.modelConfigId);
  return i > -1 ? i : 0;
});

// 当前所选模型是否支持参考图：已设参考图但模型不支持时，生图会静默退回纯文生图，需提示用户
const refUnsupported = computed(() => !!store.referenceImage && store.showReferenceImage && store.estimate?.supportsReferenceImages === false);
const refImgSrc = computed(() => (store.referenceImage ? toAbsolute(store.referenceImage) : ''));

function chooseRefImage() {
  uni.chooseImage({
    count: 1,
    success: (res) => {
      const file = (res.tempFiles && res.tempFiles[0]) || {};
      if (file.size && file.size / 1024 / 1024 >= 10) {
        toast(t('genConfirm.imageMaxSize'), 'error');
        return;
      }
      store.uploadReferenceImage(res.tempFilePaths[0]);
    },
  });
}

const confirmDisabled = computed(() => store.estimating || !!store.error);
</script>

<template>
  <view class="ad-mask top" :class="{ on: store.visible }" @tap="store.cancel" @touchmove.stop.prevent="() => {}" />
  <view class="ad-sheet gcs top" :class="{ on: store.visible }" @touchmove.stop="() => {}">
    <view class="grab" @tap="store.cancel" />

    <view class="gcs-title">{{ store.title }}</view>
    <view v-if="store.desc" class="gc-desc">{{ store.desc }}</view>

    <!-- 内容区独立滚动：普通 view + overflow-y（同 ad.scss .ash-body），不用 scroll-view ——
         scroll-view 的内滚裁剪在内部 div 的 height:100%/max-height:inherit 链上，抽屉被 86vh
         压缩时该链部分端失效，模型标签会溢出盖住底部按钮 -->
    <view class="gcs-body">
      <!-- 模型选择：视频模型走标签单选，其余类型走 selectSheet 下拉 -->
      <view v-if="store.showModelSelect" class="gc-field">
        <view class="gc-label">{{ modelLabel }}</view>
        <template v-if="isVideoType">
          <view v-if="store.models.length" class="gc-mtags">
            <view
              v-for="m in store.models"
              :key="m.id"
              class="gc-mtag"
              :class="{ on: m.id === store.selection?.modelConfigId, private: m.is_private }"
              @tap="store.setModel(m.id)"
            >
              <view class="gc-mtag-name">
                <text>{{ m.name }}</text>
                <text v-if="m.is_private" class="gc-mtag-free">{{ t('genConfirm.freeBadge') }}</text>
                <text v-if="m.is_default" class="gc-mtag-badge">{{ t('genConfirm.defaultBadge') }}</text>
                <text v-if="modelPromoOff(m) != null" class="gc-mtag-off">-{{ modelPromoOff(m) }}%</text>
              </view>
              <view v-if="lowestResText(m)" class="gc-mtag-meta">{{ lowestResText(m) }}</view>
            </view>
          </view>
          <view v-else class="gc-hint">{{ t('genConfirm.noModelHint', { model: modelLabel }) }}</view>
        </template>
        <template v-else>
          <view class="ad-field ad-picker" :class="{ dim: !store.models.length }" @tap="pickModel">
            <text class="ad-picker-val" :class="{ 'is-private': store.models[modelIndexFallback]?.is_private }">{{ store.models.length ? modelNames[modelIndexFallback] : t('genConfirm.noModelHint', { model: modelLabel }) }}</text>
            <m-icon :name="modelOpen ? 'up' : 'down'" :size="16" />
          </view>
          <view v-if="!store.models.length" class="gc-hint">{{ t('genConfirm.noModelHint', { model: modelLabel }) }}</view>
        </template>
        <!-- 使用自己的模型（自带 Key 不扣积分）：跳设置页新增私有模型 -->
        <view class="gc-own" @tap="goAddPrivateModel">
          <text class="gc-own-t">{{ t('genConfirm.useOwnModel') }}</text>
          <m-icon name="right" :size="12" />
        </view>
      </view>

      <!-- 分辨率选择（视频模型档位，或合成等无模型场景的静态档位） -->
      <view v-if="store.resolutions.length" class="gc-field">
        <view class="gc-label">{{ t('genConfirm.resolution') }}</view>
        <view class="gc-res-row">
          <view
            v-for="r in store.resolutions"
            :key="r.value"
            class="pchip"
            :class="{ on: store.selection?.resolution === r.value }"
            @tap="store.setResolution(r.value)"
          >{{ r.value }}</view>
        </view>
        <view v-if="store.selection?.resolution" class="gc-res-price">
          <template v-for="r in store.resolutions" :key="r.value">
            <text v-if="r.value === store.selection.resolution && r.price != null" class="gc-res-price-t">
              {{ formatCredits(resPrice(r)) }} {{ t('genConfirm.creditsPerSec') }}
            </text>
          </template>
        </view>
        <view v-if="store.resolutionHint" class="gc-hint">{{ store.resolutionHint }}</view>
      </view>

      <!-- 参考图（图生图，可选；仅图像生成为资产启用） -->
      <view v-if="store.showReferenceImage" class="gc-field">
        <view class="gc-label">{{ t('genConfirm.referenceImageLabel') }}</view>
        <view v-if="store.referenceImage" class="gc-ref-set">
          <!-- 不用 <image>：uni-h5 的 image 组件异步换图后偶发不刷新背景，改 view+内联背景（同 assets 参考图预览） -->
          <view
            class="gc-ref-img"
            :style="{ backgroundImage: `url('${refImgSrc}')`, backgroundSize: 'cover', backgroundPosition: 'center' }"
          />
          <view class="mbtn soft sm danger" :class="{ dis: store.refUploading }" @tap="!store.refUploading && store.removeReferenceImage()">
            {{ t('genConfirm.remove') }}
          </view>
        </view>
        <view v-else class="mbtn soft" :class="{ dis: store.refUploading }" @tap="!store.refUploading && chooseRefImage()">
          {{ t('genConfirm.addReferenceImage') }}
        </view>
        <view v-if="refUnsupported" class="gc-ref-warn">{{ t('genConfirm.refUnsupportedWarn') }}</view>
        <view v-else class="gc-hint">{{ t('genConfirm.refHint') }}</view>
        <view v-if="store.refError" class="gc-ref-error">{{ store.refError }}</view>
      </view>

      <!-- 本次要求（仅润色提示词入口）：填写后随任务一并提交给 LLM -->
      <view v-if="store.showRequirement" class="gc-field">
        <view class="gc-label">{{ t('genConfirm.requirementLabel') }}</view>
        <view v-if="store.requirementPresets.length" class="gc-req-presets">
          <view
            v-for="p in store.requirementPresets"
            :key="p"
            class="gc-req-chip"
            :class="{ active: store.requirement.includes(p) }"
            @tap="store.toggleRequirementPreset(p)"
          >{{ p }}</view>
        </view>
        <textarea
          class="ad-textarea"
          :value="store.requirement"
          :maxlength="800"
          :placeholder="t('genConfirm.requirementPlaceholder')"
          @input="store.setRequirement($event.detail.value)"
        />
        <view class="gc-hint">{{ t('genConfirm.requirementHint') }}</view>
      </view>

      <!-- 价格区 -->
      <view class="gc-price">
        <template v-if="store.estimating">
          <text class="gc-price-loading">{{ t('genConfirm.estimating') }}</text>
        </template>
        <template v-else-if="store.error">
          <text class="gc-price-error">{{ store.error }}</text>
        </template>
        <template v-else-if="store.isPrivateEst">
          <view class="gc-price-free">{{ t('genConfirm.privateFree') }}</view>
        </template>
        <template v-else>
          <view v-if="store.promo" class="gc-price-orig">
            {{ t('genConfirm.promoOriginal') }} <text class="gc-price-orig-n">{{ formatCredits(store.promo.originalCredits) }}</text> {{ t('common.credits') }}
            <text class="gc-promo-tag">-{{ store.promo.offPercent }}%</text>
          </view>
          <view class="gc-price-main">
            {{ t('genConfirm.estimatedCost') }} <text class="gc-price-num">{{ credits }}</text> {{ t('common.credits') }}
          </view>
          <view v-if="store.promo" class="gc-price-save">{{ t('genConfirm.promoSave', { n: formatCredits(store.promo.saved), p: store.promo.offPercent }) }}</view>
          <view v-if="detailParts.length" class="gc-price-detail">{{ detailParts.join(' · ') }}</view>
        </template>
      </view>
    </view>

    <view class="gcs-foot">
      <view class="mbtn ghost" @tap="store.cancel">{{ t('common.cancel') }}</view>
      <view class="mbtn" :class="{ dis: confirmDisabled }" @tap="!confirmDisabled && store.confirm()">
        {{ store.isPrivateEst ? t('genConfirm.confirmFree') : t('genConfirm.confirmWithCredits', { n: credits }) }}
      </view>
    </view>
  </view>
</template>

<style>
/* 非 scoped：复用 ad.scss 全局令牌的组件私有类（.gcs 前缀防冲突） */
.gcs { padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
.gcs-title {
  font-family: var(--ad-font-serif);
  font-weight: 900;
  font-size: 18px;
  color: var(--ad-text);
  padding: 0 0 8px;
}
/* 同 .ash-body 范式：高度约束与裁剪在同一元素上，flex 压缩时内滚不被突破 */
.gcs-body {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 56vh;
  overflow-y: auto;
  overscroll-behavior: contain; /* H5：滚到边界不把滚动链给背后的页面 */
  -webkit-overflow-scrolling: touch;
}
.gc-desc { font-size: 13px; color: var(--ad-text-soft); line-height: 1.7; padding-bottom: 12px; }
.gc-field { margin-bottom: 16px; }
.gc-label { display: block; font-size: 13px; font-weight: 600; color: var(--ad-text); margin-bottom: 8px; }
.gc-hint { font-size: 12px; color: var(--ad-text-mut); margin-top: 6px; line-height: 1.6; }
/* 「使用自己的模型」入口：虚线胶囊，品牌金常驻（手机端主操作路径） */
.gc-own {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  margin-top: 10px; padding: 8px 12px; border-radius: 999px;
  border: 1px dashed rgba(224, 182, 78, 0.45); color: var(--ad-brand);
}
.gc-own-t { font-size: 12px; font-weight: 600; line-height: 1.4; }
.ad-picker {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  height: 44px; padding: 0 14px; border-radius: 13px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.ad-picker-val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ad-picker.dim { opacity: 0.5; }
.ad-picker-val.is-private { color: var(--ad-accent); }
.gc-res-row { display: flex; flex-wrap: wrap; gap: 8px; }
/* 视频模型标签单选（pchip 同款胶囊 + 次行价格说明） */
.gc-mtags { display: flex; flex-wrap: wrap; gap: 8px; }
.gc-mtag {
  padding: 6px 14px; border-radius: 18px;
  background: var(--ad-elev); border: 1px solid var(--ad-line);
}
.gc-mtag.on { background: var(--ad-brand-soft); border-color: rgba(224, 182, 78, 0.35); }
/* 私有模型青色系（同「免费」徽标）：与公用模型的中性/品牌金区分 */
.gc-mtag.private { background: var(--ad-accent-soft); border-color: rgba(45, 212, 191, 0.35); }
/* 选中：底色加深一档 + 金边同公用模型（须显式声明，否则 .private 的青边同特异性下后声明胜出） */
.gc-mtag.private.on { background: var(--ad-accent-soft-strong); border-color: rgba(224, 182, 78, 0.35); }
.gc-mtag-name { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; line-height: 1.4; color: var(--ad-text-soft); white-space: nowrap; }
.gc-mtag.on .gc-mtag-name { color: var(--ad-brand); font-weight: 600; }
.gc-mtag.private .gc-mtag-name,
.gc-mtag.private.on .gc-mtag-name { font-weight: 600; }
.gc-mtag-badge { font-size: 10px; line-height: 1.6; padding: 0 7px; border-radius: 999px; background: var(--ad-brand); color: var(--ad-brand-contrast); }
.gc-mtag-free { font-size: 10px; line-height: 1.6; padding: 0 7px; border-radius: 999px; background: rgba(45, 212, 191, 0.16); color: var(--ad-accent, #2dd4bf); font-weight: 700; }
.gc-mtag-off { font-size: 11px; font-weight: 700; color: var(--ad-danger); }
.gc-mtag-meta { font-size: 10px; line-height: 1.5; color: var(--ad-text-mut); margin-top: 1px; white-space: nowrap; }
.gc-res-price { min-height: 18px; margin-top: 6px; }
.gc-res-price-t { font-size: 12px; color: var(--ad-brand); }
.gc-req-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.gc-req-chip {
  font-size: 12px; line-height: 1.5; padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--ad-line); background: var(--ad-inset); color: var(--ad-text-soft);
}
.gc-req-chip.active { background: var(--ad-brand); border-color: var(--ad-brand); color: var(--ad-brand-contrast); }
.gc-ref-set { display: flex; align-items: center; gap: 12px; }
.gc-ref-img { width: 72px; height: 72px; border-radius: 10px; border: 1px solid var(--ad-line); }
.gc-ref-error { font-size: 12px; color: var(--ad-danger); margin-top: 6px; }
.gc-ref-warn { font-size: 12px; color: var(--ad-brand); margin-top: 6px; line-height: 1.6; }
.gc-price {
  margin-top: 2px; padding: 14px 16px; border-radius: 14px;
  background: var(--ad-inset); border: 1px solid var(--ad-line); text-align: center;
}
.gc-price-main { font-size: 14px; color: var(--ad-text-soft); }
.gc-price-num { font-size: 22px; color: var(--ad-brand); margin: 0 4px; font-weight: 800; }
/* 促销：原价划线行 + 省积分行（品牌金与价格数字同屏统一） */
.gc-price-orig { font-size: 12px; color: var(--ad-text-mut); }
.gc-price-orig-n { text-decoration: line-through; }
.gc-promo-tag { margin-left: 8px; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: var(--ad-danger); color: #fff; }
.gc-price-save { font-size: 12px; font-weight: 600; margin-top: 6px; color: var(--ad-brand); }
.gc-price-detail { font-size: 12px; color: var(--ad-text-mut); margin-top: 6px; }
.gc-price-free { font-size: 14px; font-weight: 700; color: var(--ad-accent, #2dd4bf); }
.gc-price-loading { font-size: 13px; color: var(--ad-text-mut); }
.gc-price-error { font-size: 13px; color: var(--ad-danger); }
.gcs-foot { display: flex; gap: 10px; padding-top: 14px; }
.gcs-foot .mbtn { flex: 1; }
</style>
