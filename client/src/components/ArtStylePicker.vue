<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { artStyleApi } from '../api';

const { t } = useI18n();

// 视觉风格 + 画面比例 选择器（复用于「新建/编辑项目」与「剧本导出项目」）
const props = defineProps({
  modelValue: { type: String, default: '' },     // style key（v-model）
  aspect: { type: String, default: '9:16' },      // aspect_ratio（v-model:aspect）
  defaultStyle: { type: String, default: '' },    // 初始默认风格（当 modelValue 为空时）
  showAspect: { type: Boolean, default: true },   // 是否展示画面比例选择
  expand: { type: Boolean, default: false },      // 风格网格不限高（由外层容器滚动，避免嵌套滚动条）
  hint: { type: String, default: '' },            // 风格区顶部提示文案
  columns: { type: Number, default: 0 },          // 固定列数（0 = 自适应 auto-fill）
});
const emit = defineEmits(['update:modelValue', 'update:aspect']);

// 风格大类（顺序即页签顺序）：写实 / 动漫
const styleCategoryCodes = ['realistic', 'anime'];
const STYLE_CATEGORIES = computed(() =>
  styleCategoryCodes.map((value) => ({ value, label: t(`style.option.${value}`) })),
);
// 画面比例：附带按真实宽高比绘制的矩形图标
const ASPECT_BOX = 36;
const aspectDefs = [
  { value: '9:16', key: 'portrait', w: 9, h: 16 },
  { value: '16:9', key: 'landscape', w: 16, h: 9 },
  { value: '1:1', key: 'square', w: 1, h: 1 },
];
const aspects = computed(() =>
  aspectDefs.map((a) => ({ ...a, label: t(`style.aspect.${a.key}`) })),
);

const artStyles = ref([]);
const styleLoading = ref(false);
// 当前激活的风格大类页签（默认写实）
const activeCategory = ref('realistic');

// 按大类分组的风格（保留 artStyles 原顺序）
const stylesByCategory = computed(() => {
  const groups = { realistic: [], anime: [] };
  artStyles.value.forEach((s) => { (groups[s.category] || groups.anime).push(s); });
  return groups;
});
// 页签列表（写实 / 动漫，附数量）
const styleCategories = computed(() =>
  STYLE_CATEGORIES.value.map((c) => ({ ...c, count: (stylesByCategory.value[c.value] || []).length })),
);
// 取某风格 key 所属大类，未命中回退 'realistic'
const categoryOf = (key) => artStyles.value.find((s) => s.key === key)?.category || 'realistic';

const aspectSize = (a) => {
  if (a.w >= a.h) return { width: ASPECT_BOX + 'px', height: Math.round((ASPECT_BOX * a.h) / a.w) + 'px' };
  return { height: ASPECT_BOX + 'px', width: Math.round((ASPECT_BOX * a.w) / a.h) + 'px' };
};

function selectStyle(key) { emit('update:modelValue', key); }
function selectAspect(v) { emit('update:aspect', v); }
// 风格大图预览（右上角小按钮触发，不选中风格）
const stylePreviewUrl = ref('');
function openStylePreview(url) { stylePreviewUrl.value = url; }
// 切换大类页签：若当前选中风格不在新分组里，则自动选中该分组首个风格（保证有可见高亮）
function onCategoryChange(name) {
  const group = stylesByCategory.value[name] || [];
  if (group.length && !group.some((s) => s.key === props.modelValue)) {
    emit('update:modelValue', group[0].key);
  }
}

async function loadStyles() {
  styleLoading.value = true;
  try {
    artStyles.value = await artStyleApi.list();
    // 初始化：外部未指定风格时，用 defaultStyle（须存在）或列表首个
    if (!props.modelValue) {
      const init = props.defaultStyle && artStyles.value.some((s) => s.key === props.defaultStyle)
        ? props.defaultStyle
        : (artStyles.value[0]?.key || '');
      if (init) emit('update:modelValue', init);
    }
    activeCategory.value = props.modelValue ? categoryOf(props.modelValue) : 'realistic';
  } finally {
    styleLoading.value = false;
  }
}

// 外部 style 变化（如编辑回填）时，同步分类页签
watch(() => props.modelValue, (v) => {
  if (v && artStyles.value.length) {
    const c = categoryOf(v);
    if (c !== activeCategory.value) activeCategory.value = c;
  }
});

onMounted(loadStyles);
</script>

<template>
  <div class="art-picker">
    <div v-if="hint" class="style-hint ad-sub">{{ hint }}</div>
    <el-tabs v-model="activeCategory" class="style-tabs" @tab-change="onCategoryChange">
      <el-tab-pane
        v-for="cat in styleCategories"
        :key="cat.value"
        :name="cat.value"
        :label="`${cat.label} · ${cat.count}`"
      >
        <div
          v-loading="styleLoading"
          class="style-grid"
          :class="{ 'is-expand': expand }"
          :style="columns > 0 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : {}"
        >
          <div
            v-for="s in stylesByCategory[cat.value]"
            :key="s.key"
            class="style-card"
            :class="{ active: modelValue === s.key }"
            @click="selectStyle(s.key)"
          >
            <div class="style-thumb">
              <img :src="s.thumbnailUrl" :alt="s.name" loading="lazy" />
              <button
                type="button"
                class="style-preview"
                :title="t('style.preview')"
                :aria-label="t('style.preview')"
                @click.stop="openStylePreview(s.previewUrl)"
              >
                <el-icon><ZoomIn /></el-icon>
              </button>
              <transition name="fade-check">
                <div v-if="modelValue === s.key" class="style-check">
                  <el-icon><Check /></el-icon>
                </div>
              </transition>
            </div>
            <div class="style-name" :title="s.name">{{ s.name }}</div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <div v-if="showAspect" class="aspect-section">
      <div class="aspect-title ad-sub">{{ t('style.aspectRatio') }}</div>
      <div class="aspect-grid">
        <div
          v-for="a in aspects"
          :key="a.value"
          class="aspect-card"
          :class="{ active: aspect === a.value }"
          @click="selectAspect(a.value)"
        >
          <div class="aspect-icon">
            <span class="aspect-box" :style="aspectSize(a)"></span>
          </div>
          <div class="aspect-label">{{ a.label }}</div>
          <div class="ad-sub aspect-ratio-text">{{ a.value }}</div>
        </div>
      </div>
    </div>

    <!-- 风格大图预览 -->
    <el-image-viewer
      v-if="stylePreviewUrl"
      :url-list="[stylePreviewUrl]"
      hide-on-click-modal
      teleported
      @close="stylePreviewUrl = ''"
    />
  </div>
</template>

<style scoped>
/* 视觉风格选择器 */
.style-hint { margin: -4px 0 10px; font-size: 12px; }
/* 风格大类页签：软底容器 + 选中态实心品牌色胶囊，醒目 */
.style-tabs :deep(.el-tabs__header) {
  margin: 0 0 14px;
  background: var(--ad-brand-soft);
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius);
  padding: 5px;
}
.style-tabs :deep(.el-tabs__nav-wrap)::after { background: transparent; }
.style-tabs :deep(.el-tabs__nav) { border: none !important; gap: 4px; }
.style-tabs :deep(.el-tabs__active-bar) { display: none; }
.style-tabs :deep(.el-tabs__item) {
  height: 40px;
  line-height: 40px;
  font-size: 15px;
  font-weight: 700;
  padding: 0 26px !important;
  margin: 0 !important;
  color: var(--ad-text-soft);
  border: none !important;
  border-radius: var(--ad-radius-sm);
  transition: color 0.18s, background 0.18s, box-shadow 0.18s;
}
.style-tabs :deep(.el-tabs__item:hover) { color: var(--ad-text); }
.style-tabs :deep(.el-tabs__item.is-active) {
  color: var(--ad-brand-contrast);
  background: var(--ad-brand);
  box-shadow: 0 6px 16px var(--ad-brand-soft);
}
.style-tabs :deep(.el-tabs__item.is-active:hover) { color: var(--ad-brand-contrast); }
.style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(177px, 1fr));
  gap: 12px;
  width: 100%;
  max-height: 430px;
  overflow-y: auto;
  padding: 2px;
}
.style-grid.is-expand { max-height: none; overflow: visible; }
.style-card {
  cursor: pointer;
  border: 2px solid var(--ad-border);
  border-radius: var(--ad-radius);
  overflow: hidden;
  background: var(--ad-bg-elevated);
  transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
}
.style-card:hover {
  border-color: var(--ad-border-strong);
  transform: translateY(-2px);
  box-shadow: var(--ad-shadow-hover);
}
.style-card.active {
  border-color: var(--ad-accent);
  box-shadow: 0 0 0 3px var(--ad-brand-soft-2);
}
.style-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: var(--ad-bg-soft);
  overflow: hidden;
}
.style-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s;
}
.style-card:hover .style-thumb img { transform: scale(1.05); }
/* 大图预览小按钮（右上角，常驻可点；不触发选卡） */
.style-preview {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: rgba(15, 18, 34, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  cursor: pointer;
  box-shadow: var(--ad-shadow-sm);
  transition: background 0.18s, transform 0.18s;
}
.style-preview:hover { background: var(--ad-accent); transform: scale(1.08); }
.style-check {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ad-accent);
  color: var(--ad-accent-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  box-shadow: var(--ad-shadow-sm);
}
.style-name {
  padding: 8px 8px 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ad-text);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fade-check-enter-active, .fade-check-leave-active { transition: opacity 0.15s, transform 0.15s; }
.fade-check-enter-from, .fade-check-leave-to { opacity: 0; transform: scale(0.6); }

/* 画面比例选择器 */
.aspect-section { margin-top: 18px; }
.aspect-title { margin-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--ad-text-soft); }
.aspect-grid { display: flex; gap: 12px; flex-wrap: wrap; }
.aspect-card {
  cursor: pointer;
  border: 2px solid var(--ad-border);
  border-radius: var(--ad-radius);
  background: var(--ad-bg-elevated);
  padding: 14px 10px 11px;
  width: 92px;
  text-align: center;
  transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
}
.aspect-card:hover {
  border-color: var(--ad-border-strong);
  transform: translateY(-2px);
  box-shadow: var(--ad-shadow-hover);
}
.aspect-card.active {
  border-color: var(--ad-accent);
  box-shadow: 0 0 0 3px var(--ad-brand-soft-2);
}
.aspect-icon { height: 40px; display: flex; align-items: center; justify-content: center; }
.aspect-box {
  display: block;
  border: 2px solid var(--ad-text-muted);
  border-radius: 4px;
  background: var(--ad-bg-soft);
  transition: border-color 0.18s, background 0.18s;
}
.aspect-card.active .aspect-box { border-color: var(--ad-accent); background: var(--ad-brand-soft-2); }
.aspect-label { margin-top: 8px; font-size: 13px; font-weight: 600; color: var(--ad-text); }
.aspect-ratio-text { font-size: 11px; margin-top: 2px; }
</style>
