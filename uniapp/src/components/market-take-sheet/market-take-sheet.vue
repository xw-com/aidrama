<script setup>
/**
 * 接单作品选择抽屉：接单前勾选自己名下项目（多选，上限 5）供发布方评估。
 * 数据源 marketApi.myDeliverables()（名下有可播成片的项目 + 分集成片，与交付同口径）。
 */
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { marketApi } from '../../api';
import { toast, toastError } from '../../utils/ui';
import { toAbsolute } from '../../utils/media';
import AdSheet from '../ad-sheet/ad-sheet.vue';
import MIcon from '../m-icon/m-icon.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  acting: { type: Boolean, default: false },
});
const emit = defineEmits(['update:show', 'submit']);

const MAX = 5;
const { t } = useI18n();
const loading = ref(false);
const projects = ref([]);
const picked = ref([]); // 已选 project_id
const loaded = ref(false);

watch(() => props.show, (v) => { if (v) load(); });

async function load() {
  if (loaded.value) return;
  loading.value = true;
  try {
    projects.value = await marketApi.myDeliverables();
    loaded.value = true;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

const isPicked = (id) => picked.value.includes(id);
function toggle(p) {
  if (props.acting) return;
  if (isPicked(p.id)) {
    picked.value = picked.value.filter((x) => x !== p.id);
    return;
  }
  if (picked.value.length >= MAX) {
    toast(t('market.takeSheet.limit'));
    return;
  }
  picked.value = [...picked.value, p.id];
}
function submit() {
  emit('submit', picked.value.map((id) => ({ project_id: id })));
}
</script>

<template>
  <AdSheet :show="show" :title="t('market.takeSheet.title')" @update:show="emit('update:show', $event)">
    <view class="mts">
      <view class="mts-tip">{{ t('market.takeSheet.tip') }}</view>

      <view v-if="loading && !projects.length" class="mts-empty"><text>{{ t('common.loading') }}</text></view>

      <scroll-view v-else-if="projects.length" scroll-y class="mts-list">
        <view
          v-for="p in projects"
          :key="p.id"
          class="mts-item"
          :class="{ on: isPicked(p.id) }"
          @tap="toggle(p)"
        >
          <image v-if="p.cover" :src="toAbsolute(p.cover)" class="mts-cover" mode="aspectFill" />
          <view v-else class="mts-cover mts-cover-ph"><m-icon name="film" :size="18" /></view>
          <view class="mts-body">
            <text class="mts-name">{{ p.name }}</text>
            <text class="mts-count">{{ t('market.takeSheet.episodeCount', { n: p.episodes.length }) }}</text>
          </view>
          <view class="mts-check" :class="{ on: isPicked(p.id) }">
            <m-icon v-if="isPicked(p.id)" name="check" :size="13" color="#fff" />
          </view>
        </view>
      </scroll-view>

      <view v-else class="mts-empty"><text>{{ t('market.takeSheet.empty') }}</text></view>

      <view
        v-if="projects.length"
        class="mbtn"
        :class="{ dis: acting }"
        @tap="!acting && submit()"
      >{{ t('market.takeSheet.submit') }}</view>
    </view>
  </AdSheet>
</template>

<style scoped>
.mts-tip { font-size: 12px; color: var(--ad-text-mut); margin-bottom: 10px; }
.mts-list { max-height: 46vh; }
.mts-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px; border-radius: 14px; margin-bottom: 8px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.mts-item.on { border-color: var(--ad-brand); }
.mts-cover {
  flex: none; width: 56px; height: 42px; border-radius: 8px;
  background: var(--ad-inset); overflow: hidden;
}
.mts-cover-ph { display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
.mts-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mts-name { font-size: 14px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mts-count { font-size: 11px; color: var(--ad-text-mut); }
.mts-check {
  flex: none; width: 20px; height: 20px; border-radius: 50%;
  border: 1.5px solid var(--ad-line); display: flex; align-items: center; justify-content: center;
}
.mts-check.on { background: var(--ad-brand); border-color: var(--ad-brand); }
.mts-empty { padding: 40px 20px; text-align: center; font-size: 13px; color: var(--ad-text-mut); }
</style>
