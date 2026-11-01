<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { projectApi } from '../api';
import { defaultSubtitleStyle, SUBTITLE_STYLE_LIMITS } from '../utils/subtitleStyle';

/**
 * 项目全局字幕设置（存 project.settings.subtitle，对本项目所有分集的字幕烧录生效）：
 * 字体选择 / 字体大小 / 离底边距；未设置的字段回退服务端公式默认（随项目横竖屏不同）。
 * 数值为短边 1080 基准像素，烧录时按视频分辨率等比缩放——预览用同一公式渲染，所见即所得。
 */
const props = defineProps({
  projectId: { type: [Number, String], default: null },
  aspectRatio: { type: String, default: '9:16' },
  subtitle: { type: Object, default: null }, // project.settings?.subtitle
});
const emit = defineEmits(['updated']);
const model = defineModel({ type: Boolean, default: false });

const { t } = useI18n();

// 预设常用 CJK 字体（value = libass/fontconfig 匹配的字体族名，需服务器已安装；可自由输入）
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

// 编辑副本：null/undefined = 未自定义（走默认）；打开时从 project 设置初始化
const form = reactive({ font: '', fontSize: null, marginV: null });
watch(model, (visible) => {
  if (!visible) return;
  form.font = props.subtitle?.font || '';
  form.fontSize = props.subtitle?.fontSize ?? null;
  form.marginV = props.subtitle?.marginV ?? null;
});

// 公式默认值（随项目横竖屏：9:16→87/480，16:9→68/108，1:1→49/270）
const defaults = computed(() => defaultSubtitleStyle(props.aspectRatio));
const customized = computed(() => !!(form.font || form.fontSize != null || form.marginV != null));

// 预览画布：短边固定像素（竖屏宽 200 / 横屏高 200 / 方形宽 230），与烧录同公式「值/1080×短边」等比渲染
const stageShort = computed(() => (props.aspectRatio === '1:1' ? 230 : 200));
const stageStyle = computed(() => {
  if (props.aspectRatio === '16:9') return { height: '200px', aspectRatio: '16 / 9', maxWidth: '100%' };
  if (props.aspectRatio === '1:1') return { width: '230px', aspectRatio: '1 / 1' };
  return { width: '200px', aspectRatio: '9 / 16' };
});
const subStyle = computed(() => {
  const s = stageShort.value;
  return {
    fontSize: `${(((form.fontSize ?? defaults.value.fontSize) / 1080) * s).toFixed(1)}px`,
    bottom: `${(((form.marginV ?? defaults.value.marginV) / 1080) * s).toFixed(1)}px`,
    fontFamily: form.font ? `'${form.font.replace(/'/g, '')}', sans-serif` : undefined,
  };
});

const saving = ref(false);

// 保存：任一字段已设置 → 写入子树；全部为空 → subtitle 传 null（服务端删除子树恢复默认）
async function save() {
  saving.value = true;
  try {
    const patch = {};
    if (form.font) patch.font = form.font;
    if (form.fontSize != null) patch.fontSize = form.fontSize;
    if (form.marginV != null) patch.marginV = form.marginV;
    await projectApi.update(props.projectId, { settings: { subtitle: Object.keys(patch).length ? patch : null } });
    ElMessage.success(t('project.subtitleSettings.updated'));
    model.value = false;
    emit('updated');
  } catch (err) {
    ElMessage.error(err?.message || t('project.subtitleSettings.updateFailed'));
  } finally {
    saving.value = false;
  }
}

// 恢复默认：确认后清空表单（预览/默认 tag 即时回退），点保存才真正生效，可反悔
async function resetDefault() {
  try {
    await ElMessageBox.confirm(t('project.subtitleSettings.resetConfirm'), t('common.tip'), { type: 'warning' });
  } catch { return; } // 用户取消
  form.font = '';
  form.fontSize = null;
  form.marginV = null;
}
</script>

<template>
  <el-dialog v-model="model" :title="t('project.subtitleSettings.title')" width="min(560px, 94vw)" append-to-body destroy-on-close>
    <div class="ss-editor">
      <div class="ss-hint">{{ t('project.subtitleSettings.hint') }}</div>
      <div class="ss-stage-wrap">
        <div class="ss-stage" :style="stageStyle">
          <div class="ss-sample" :style="subStyle">{{ t('project.subtitleSettings.previewText') }}</div>
        </div>
      </div>
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('project.subtitleSettings.font')">
          <el-select v-model="form.font" filterable allow-create clearable :placeholder="t('project.subtitleSettings.fontDefault')">
            <el-option v-for="f in FONT_PRESETS" :key="f.value" :label="f.label" :value="f.value" />
          </el-select>
          <div class="ss-field-hint">{{ t('project.subtitleSettings.fontHint') }}</div>
        </el-form-item>
        <div class="ss-row">
          <el-form-item :label="t('project.subtitleSettings.fontSize')">
            <div class="ss-num">
              <el-input-number v-model="form.fontSize" :min="SUBTITLE_STYLE_LIMITS.fontSize[0]" :max="SUBTITLE_STYLE_LIMITS.fontSize[1]" :step="1" controls-position="right" style="width: 100%" />
              <el-tag v-if="form.fontSize == null" size="small" type="info">{{ t('project.subtitleSettings.defaultTag') }} {{ defaults.fontSize }}</el-tag>
            </div>
          </el-form-item>
          <el-form-item :label="t('project.subtitleSettings.marginV')">
            <div class="ss-num">
              <el-input-number v-model="form.marginV" :min="SUBTITLE_STYLE_LIMITS.marginV[0]" :max="SUBTITLE_STYLE_LIMITS.marginV[1]" :step="1" controls-position="right" style="width: 100%" />
              <el-tag v-if="form.marginV == null" size="small" type="info">{{ t('project.subtitleSettings.defaultTag') }} {{ defaults.marginV }}</el-tag>
            </div>
          </el-form-item>
        </div>
        <div class="ss-field-hint">{{ t('project.subtitleSettings.scaleHint') }}</div>
      </el-form>
    </div>
    <template #footer>
      <div class="ss-footer">
        <el-button size="small" :disabled="!customized" @click="resetDefault">{{ t('project.subtitleSettings.reset') }}</el-button>
        <el-button @click="model = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.ss-editor { display: flex; flex-direction: column; gap: 10px; }
.ss-hint { font-size: 12px; color: var(--ad-text-muted); }
.ss-stage-wrap { display: flex; justify-content: center; padding: 4px 0; }
.ss-stage { position: relative; background: #000; border-radius: 10px; overflow: hidden; }
/* 白字黑边粗体，模拟烧录样式（BorderStyle=1 描边 + Bold）；bottom/字号由 subStyle 按比例注入 */
.ss-sample { position: absolute; left: 6px; right: 6px; text-align: center; color: #fff; font-weight: 700; line-height: 1.25; white-space: nowrap; text-shadow: 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; }
.ss-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.ss-num { display: flex; align-items: center; gap: 8px; width: 100%; }
.ss-field-hint { font-size: 12px; color: var(--ad-text-muted); }
.ss-footer { display: flex; align-items: center; gap: 8px; }
.ss-footer > .el-button:first-child { margin-right: auto; }
@media (max-width: 768px) {
  .ss-row { grid-template-columns: 1fr; }
}
</style>
