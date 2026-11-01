<script setup>
/**
 * 视觉风格 + 画面比例选择器（client ArtStylePicker 移植，复用于新建/编辑项目与剧本导出）。
 * 大类页签（写实/动漫）+ 风格卡片网格 + 比例卡；大图预览用 uni.previewImage。
 */
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { artStyleApi } from '../../api';
import { toAbsolute } from '../../utils/media';
import MIcon from '../m-icon/m-icon.vue';

const props = defineProps({
  modelValue: { type: String, default: '' },     // style key（v-model）
  aspect: { type: String, default: '9:16' },      // aspect_ratio（v-model:aspect）
  defaultStyle: { type: String, default: '' },    // 初始默认风格（当 modelValue 为空时）
  showAspect: { type: Boolean, default: true },   // 是否展示画面比例选择
  hint: { type: String, default: '' },            // 风格区顶部提示文案
});
const emit = defineEmits(['update:modelValue', 'update:aspect']);
const { t } = useI18n();

// 风格大类（顺序即页签顺序）：写实 / 动漫
const styleCategoryCodes = ['realistic', 'anime'];
const styleCategories = computed(() => styleCategoryCodes.map((value) => ({ value, label: t(`style.option.${value}`) })));
// 画面比例：附带按真实宽高比绘制的矩形图标
const ASPECT_BOX = 30;
const aspectDefs = [
  { value: '9:16', key: 'portrait', w: 9, h: 16 },
  { value: '16:9', key: 'landscape', w: 16, h: 9 },
  { value: '1:1', key: 'square', w: 1, h: 1 },
];
const aspects = computed(() => aspectDefs.map((a) => ({ ...a, label: t(`style.aspect.${a.key}`) })));

const artStyles = ref([]);
const styleLoading = ref(false);
const activeCategory = ref('realistic');

// 按大类分组的风格（保留原顺序）
const stylesByCategory = computed(() => {
  const groups = { realistic: [], anime: [] };
  artStyles.value.forEach((s) => { (groups[s.category] || groups.anime).push(s); });
  return groups;
});
const catCount = (c) => (stylesByCategory.value[c] || []).length;
// 取某风格 key 所属大类，未命中回退 'realistic'
const categoryOf = (key) => artStyles.value.find((s) => s.key === key)?.category || 'realistic';

const aspectSize = (a) => {
  if (a.w >= a.h) return { width: ASPECT_BOX + 'px', height: Math.round((ASPECT_BOX * a.h) / a.w) + 'px' };
  return { height: ASPECT_BOX + 'px', width: Math.round((ASPECT_BOX * a.w) / a.h) + 'px' };
};

function selectStyle(key) { emit('update:modelValue', key); }
function selectAspect(v) { emit('update:aspect', v); }
function openStylePreview(url) { uni.previewImage({ urls: [toAbsolute(url)] }); }
// 切换大类页签：若当前选中风格不在新分组里，则自动选中该分组首个风格（保证有可见高亮）
function onCategoryChange(value) {
  activeCategory.value = value;
  const group = stylesByCategory.value[value] || [];
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
  <view class="asp">
    <view v-if="hint" class="asp-hint">{{ hint }}</view>

    <!-- 大类页签 -->
    <view class="asp-tabs">
      <view
        v-for="cat in styleCategories"
        :key="cat.value"
        class="asp-tab"
        :class="{ on: activeCategory === cat.value }"
        @tap="onCategoryChange(cat.value)"
      >{{ cat.label }} · {{ catCount(cat.value) }}</view>
    </view>

    <view v-if="styleLoading" class="asp-loading">{{ t('common.loading') }}</view>
    <view v-else class="asp-grid">
      <view
        v-for="s in (stylesByCategory[activeCategory] || [])"
        :key="s.key"
        class="asp-card"
        :class="{ active: modelValue === s.key }"
        @tap="selectStyle(s.key)"
      >
        <view class="asp-thumb">
          <image :src="toAbsolute(s.thumbnailUrl || s.previewUrl)" mode="aspectFill" class="asp-thumb-img" lazy-load />
          <view class="asp-eye" @tap.stop="openStylePreview(s.previewUrl)">
            <m-icon name="search" :size="12" color="#fff" />
          </view>
          <view v-if="modelValue === s.key" class="asp-check">
            <m-icon name="check" :size="13" color="#1a1205" :sw="2.4" />
          </view>
        </view>
        <view class="asp-name">{{ s.name }}</view>
      </view>
    </view>

    <!-- 画面比例 -->
    <view v-if="showAspect" class="asp-sec">
      <view class="asp-sec-title">{{ t('style.aspectRatio') }}</view>
      <view class="asp-aspects">
        <view
          v-for="a in aspects"
          :key="a.value"
          class="asp-aspect"
          :class="{ active: aspect === a.value }"
          @tap="selectAspect(a.value)"
        >
          <view class="asp-aspect-ico">
            <view class="asp-aspect-box" :style="aspectSize(a)" />
          </view>
          <view class="asp-aspect-label">{{ a.label }}</view>
          <view class="asp-aspect-ratio">{{ a.value }}</view>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.asp-hint { font-size: 12px; color: var(--ad-text-mut); margin-bottom: 10px; }
.asp-tabs {
  display: flex; gap: 6px; padding: 5px; margin-bottom: 14px;
  background: var(--ad-inset); border: 1px solid var(--ad-line); border-radius: 14px;
}
.asp-tab {
  flex: 1; height: 36px; line-height: 36px; text-align: center;
  font-size: 14px; font-weight: 700; color: var(--ad-text-soft); border-radius: 10px;
}
.asp-tab.on { color: #1a1205; background: linear-gradient(135deg, #f2d489 0%, #e0b64e 45%, #b3871f 100%); }
.asp-loading { padding: 30px 0; text-align: center; color: var(--ad-text-mut); font-size: 13px; }
.asp-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.asp-card {
  width: calc((100% - 20px) / 3);
  border: 2px solid var(--ad-line); border-radius: 14px; overflow: hidden;
  background: var(--ad-panel);
}
.asp-card.active { border-color: var(--ad-brand); box-shadow: 0 0 0 3px rgba(224, 182, 78, 0.16); }
.asp-thumb { position: relative; width: 100%; height: 0; padding-bottom: 75%; background: var(--ad-inset); }
.asp-thumb-img { position: absolute; top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; }
.asp-eye {
  position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; border-radius: 50%;
  background: rgba(10, 10, 15, 0.55); display: flex; align-items: center; justify-content: center;
}
.asp-check {
  position: absolute; top: 5px; left: 5px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--ad-brand); display: flex; align-items: center; justify-content: center;
}
.asp-name {
  padding: 7px 6px 8px; font-size: 12px; font-weight: 600; color: var(--ad-text);
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.asp-sec { margin-top: 18px; }
.asp-sec-title { margin-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--ad-text-soft); }
.asp-aspects { display: flex; gap: 10px; }
.asp-aspect {
  flex: 1; border: 2px solid var(--ad-line); border-radius: 14px; background: var(--ad-panel);
  padding: 12px 8px 10px; text-align: center;
}
.asp-aspect.active { border-color: var(--ad-brand); box-shadow: 0 0 0 3px rgba(224, 182, 78, 0.16); }
.asp-aspect-ico { height: 34px; display: flex; align-items: center; justify-content: center; }
.asp-aspect-box { display: block; border: 2px solid var(--ad-text-mut); border-radius: 4px; background: var(--ad-inset); }
.asp-aspect.active .asp-aspect-box { border-color: var(--ad-brand); }
.asp-aspect-label { margin-top: 7px; font-size: 12px; font-weight: 600; color: var(--ad-text); }
.asp-aspect-ratio { font-size: 11px; margin-top: 2px; color: var(--ad-text-mut); }
</style>
