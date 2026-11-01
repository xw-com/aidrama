<script setup>
/**
 * 项目全局字幕设置弹层（client SubtitleSettingsDialog 移植）：
 * 字体选择 / 字号 / 离底边距；未设置字段回退服务端公式默认（随项目横竖屏不同）。
 * 数值为短边 1080 基准像素，预览按同一公式等比渲染，所见即所得。
 * props: projectId / aspectRatio / subtitle(project.settings?.subtitle)；emit updated。
 */
import { ref, reactive, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { projectApi } from '../../api';
import { defaultSubtitleStyle, SUBTITLE_STYLE_LIMITS } from '../../utils/subtitleStyle';
import { toast, confirm, selectSheet } from '../../utils/ui';
import AdSheet from '../ad-sheet/ad-sheet.vue';

const props = defineProps({
  projectId: { type: [Number, String], default: null },
  aspectRatio: { type: String, default: '9:16' },
  subtitle: { type: Object, default: null },
});
const emit = defineEmits(['updated']);
const show = defineModel('show', { type: Boolean, default: false });

const { t } = useI18n();

// 预设常用 CJK 字体（value = libass/fontconfig 匹配的字体族名，需服务器已安装）
const FONT_PRESETS = [
  { value: 'Noto Sans CJK SC', label: '思源黑体 · Noto Sans CJK SC' },
  { value: 'Noto Serif CJK SC', label: '思源宋体 · Noto Serif CJK SC' },
  { value: 'Source Han Sans SC', label: '思源黑体（Adobe 版）' },
  { value: 'Source Han Serif SC', label: '思源宋体（Adobe 版）' },
  { value: 'WenQuanYi Micro Hei', label: '文泉驿微米黑' },
  { value: 'WenQuanYi Zen Hei', label: '文泉驿正黑' },
  { value: 'SimHei', label: '黑体 · SimHei' },
  { value: 'SimSun', label: '宋体 · SimSun' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'KaiTi', label: '楷体 · KaiTi' },
  { value: 'PingFang SC', label: '苹方 · PingFang SC（mac）' },
  { value: 'Songti SC', label: '宋体-简 · Songti SC（mac）' },
];

// 编辑副本：null = 未自定义（走默认）；打开时从 project 设置初始化
const form = reactive({ font: '', fontSize: null, marginV: null });
watch(show, (visible) => {
  if (!visible) return;
  form.font = props.subtitle?.font || '';
  form.fontSize = props.subtitle?.fontSize ?? null;
  form.marginV = props.subtitle?.marginV ?? null;
});

const defaults = computed(() => defaultSubtitleStyle(props.aspectRatio));
const customized = computed(() => !!(form.font || form.fontSize != null || form.marginV != null));

// 预览：短边固定 200px，与烧录同公式「值/1080×短边」等比渲染
const stageStyle = computed(() => {
  if (props.aspectRatio === '16:9') return { height: '200px', width: '356px' };
  if (props.aspectRatio === '1:1') return { width: '220px', height: '220px' };
  return { width: '120px', height: '213px' };
});
const stageShort = computed(() => (props.aspectRatio === '9:16' ? 120 : props.aspectRatio === '1:1' ? 220 : 200));
const subStyle = computed(() => {
  const s = stageShort.value;
  return {
    fontSize: `${(((form.fontSize ?? defaults.value.fontSize) / 1080) * s).toFixed(1)}px`,
    bottom: `${(((form.marginV ?? defaults.value.marginV) / 1080) * s).toFixed(1)}px`,
    fontFamily: form.font ? `'${form.font.replace(/'/g, '')}', sans-serif` : 'sans-serif',
  };
});

const saving = ref(false);

async function save() {
  saving.value = true;
  try {
    const patch = {};
    if (form.font) patch.font = form.font;
    if (form.fontSize != null) patch.fontSize = form.fontSize;
    if (form.marginV != null) patch.marginV = form.marginV;
    await projectApi.update(props.projectId, { settings: { subtitle: Object.keys(patch).length ? patch : null } });
    toast(t('project.subtitleSettings.updated'), 'success');
    show.value = false;
    emit('updated');
  } catch (err) {
    toast(err?.message || t('project.subtitleSettings.updateFailed'), 'error');
  } finally {
    saving.value = false;
  }
}

// 字体下拉（selectSheet 底部选择面板，弃用原生 picker）：0 号位 = 跟随服务器默认
async function pickFont() {
  const items = [{ key: '', label: t('project.subtitleSettings.fontDefault') }, ...FONT_PRESETS.map((f) => ({ key: f.value, label: f.label }))];
  const k = await selectSheet({ title: t('project.subtitleSettings.font'), items, current: form.font || '' });
  if (k !== null) form.font = k;
}
async function resetDefault() {
  const ok = await confirm({ title: t('common.tip'), content: t('project.subtitleSettings.resetConfirm') });
  if (!ok) return;
  form.font = '';
  form.fontSize = null;
  form.marginV = null;
}
</script>

<template>
  <AdSheet v-model:show="show" :title="t('project.subtitleSettings.title')">
    <view class="sss">
      <text class="sss-hint">{{ t('project.subtitleSettings.hint') }}</text>

      <!-- 预览舞台 -->
      <view class="sss-stagewrap">
        <view class="sss-stage" :style="stageStyle">
          <text class="sss-sample" :style="subStyle">{{ t('project.subtitleSettings.previewText') }}</text>
        </view>
      </view>

      <!-- 字体 -->
      <view class="sss-row" @tap="pickFont">
        <text class="sss-lab">{{ t('project.subtitleSettings.font') }}</text>
        <text class="sss-val">{{ form.font ? (FONT_PRESETS.find((f) => f.value === form.font) || {}).label || form.font : t('project.subtitleSettings.fontDefault') }}</text>
        <text class="sss-caret">▸</text>
      </view>
      <text class="sss-fieldhint">{{ t('project.subtitleSettings.fontHint') }}</text>

      <!-- 字号 / 离底距离 -->
      <view class="sss-numrow">
        <view class="sss-num">
          <view class="sss-numhead">
            <text class="sss-lab">{{ t('project.subtitleSettings.fontSize') }}</text>
            <text v-if="form.fontSize == null" class="sss-deftag">{{ t('project.subtitleSettings.defaultTag') }} {{ defaults.fontSize }}</text>
          </view>
          <view class="sss-stepper">
            <view class="sss-stbtn" @tap="form.fontSize = Math.max(SUBTITLE_STYLE_LIMITS.fontSize[0], (form.fontSize ?? defaults.fontSize) - 2)">−</view>
            <text class="sss-stval mono">{{ form.fontSize ?? defaults.fontSize }}</text>
            <view class="sss-stbtn" @tap="form.fontSize = Math.min(SUBTITLE_STYLE_LIMITS.fontSize[1], (form.fontSize ?? defaults.fontSize) + 2)">+</view>
          </view>
        </view>
        <view class="sss-num">
          <view class="sss-numhead">
            <text class="sss-lab">{{ t('project.subtitleSettings.marginV') }}</text>
            <text v-if="form.marginV == null" class="sss-deftag">{{ t('project.subtitleSettings.defaultTag') }} {{ defaults.marginV }}</text>
          </view>
          <view class="sss-stepper">
            <view class="sss-stbtn" @tap="form.marginV = Math.max(SUBTITLE_STYLE_LIMITS.marginV[0], (form.marginV ?? defaults.marginV) - 10)">−</view>
            <text class="sss-stval mono">{{ form.marginV ?? defaults.marginV }}</text>
            <view class="sss-stbtn" @tap="form.marginV = Math.min(SUBTITLE_STYLE_LIMITS.marginV[1], (form.marginV ?? defaults.marginV) + 10)">+</view>
          </view>
        </view>
      </view>
      <text class="sss-fieldhint">{{ t('project.subtitleSettings.scaleHint') }}</text>

      <!-- 操作 -->
      <view class="sss-foot">
        <view class="mbtn ghost sm" :class="{ dis: !customized }" @tap="resetDefault">{{ t('project.subtitleSettings.reset') }}</view>
        <view class="mbtn sm sss-save" :class="{ dis: saving }" @tap="save">{{ t('common.save') }}</view>
      </view>
    </view>
  </AdSheet>
</template>

<style scoped>
.sss { display: flex; flex-direction: column; gap: 10px; }
.sss-hint { font-size: 12px; color: var(--ad-text-mut); }
.sss-stagewrap { display: flex; justify-content: center; padding: 4px 0; }
.sss-stage { position: relative; background: #000; border-radius: 10px; overflow: hidden; }
.sss-sample {
  position: absolute; left: 6px; right: 6px; text-align: center; color: #fff; font-weight: 700; line-height: 1.25;
  text-shadow: 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
}
.sss-row { display: flex; align-items: center; gap: 8px; padding: 11px 12px; border: 1px solid var(--ad-line); border-radius: 11px; background: var(--ad-inset); }
.sss-lab { font-size: 12px; color: var(--ad-text-mut); }
.sss-val { flex: 1; text-align: right; font-size: 12px; color: var(--ad-text); }
.sss-caret { color: var(--ad-brand); font-size: 11px; }
.sss-fieldhint { font-size: 11px; color: var(--ad-text-mut); }
.sss-numrow { display: flex; gap: 10px; }
.sss-num { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.sss-numhead { display: flex; align-items: center; gap: 6px; }
.sss-deftag { font-size: 10px; color: var(--ad-text-mut); border: 1px solid var(--ad-line); border-radius: 999px; padding: 1px 6px; }
.sss-stepper { display: flex; align-items: center; gap: 8px; }
.sss-stbtn {
  width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
  background: var(--ad-inset); border: 1px solid var(--ad-line); color: var(--ad-text); font-size: 15px;
}
.sss-stval { min-width: 42px; text-align: center; font-size: 14px; color: var(--ad-brand); font-weight: 700; }
.sss-foot { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.sss-foot .mbtn:first-child { margin-right: auto; }
.sss-save { min-width: 120px; display: flex; align-items: center; justify-content: center; }
.dis { opacity: 0.6; }
</style>
