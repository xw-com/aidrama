<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 封面素材选择弹窗（AI 生成封面的第一步，之后才进「模型+价格」确认页）。
 * 三类素材（角色/场景/道具）多选，默认勾选「使用地方最多」的一个（候选列表首项，后端已按出镜次数降序）；
 * 可附一句补充描述。三类各至少选一项才能下一步。
 */
const props = defineProps({
  modelValue: Boolean, // v-model 弹窗显隐
  materials: { type: Object, default: null }, // 候选 { characters, scenes, props, synopsis_count }
});
const emit = defineEmits(['update:modelValue', 'confirm']);

const { t } = useI18n();

const KINDS = ['character', 'scene', 'prop'];
const groups = computed(() => [
  { key: 'character', label: t('project.coverPickCharacters'), items: props.materials?.characters || [] },
  { key: 'scene', label: t('project.coverPickScenes'), items: props.materials?.scenes || [] },
  { key: 'prop', label: t('project.coverPickProps'), items: props.materials?.props || [] },
]);

const selected = reactive({ character: [], scene: [], prop: [] });
const description = ref('');

// 每次打开重置为默认：每类勾选首项（出镜最多）
watch(() => props.modelValue, (v) => {
  if (!v) return;
  description.value = '';
  for (const g of groups.value) selected[g.key] = g.items.length ? [g.items[0].id] : [];
});

function toggle(kind, id) {
  const arr = selected[kind];
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
}

const valid = computed(() => KINDS.every((k) => selected[k].length > 0));

function confirm() {
  if (!valid.value) return;
  emit('confirm', {
    characterIds: [...selected.character],
    sceneIds: [...selected.scene],
    propIds: [...selected.prop],
    description: description.value.trim(),
  });
}

const dialogVisible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t('project.coverPickTitle')"
    width="min(600px, 94vw)"
    append-to-body
    :close-on-click-modal="false"
    align-center
    class="cover-pick"
  >
    <div class="cp-hint">{{ t('project.coverPickHint') }}</div>

    <div v-for="g in groups" :key="g.key" class="cp-group">
      <label class="cp-label">
        {{ g.label }}
        <span class="cp-count">{{ t('project.coverPickSelected', { n: selected[g.key].length }) }}</span>
      </label>
      <div class="cp-items">
        <button
          v-for="a in g.items"
          :key="a.id"
          type="button"
          class="cp-item"
          :class="{ on: selected[g.key].includes(a.id) }"
          @click="toggle(g.key, a.id)"
        >
          <img :src="a.image_url" :alt="a.name" class="cp-img" />
          <span class="cp-meta">
            <span class="cp-name">{{ a.name }}</span>
            <span class="cp-refs">{{ t('project.coverPickUsed', { n: a.ref_count }) }}</span>
          </span>
          <span class="cp-check"><el-icon><Check /></el-icon></span>
        </button>
      </div>
    </div>

    <div class="cp-group">
      <label class="cp-label">{{ t('project.coverPickDescLabel') }}</label>
      <el-input
        v-model="description"
        type="textarea"
        :rows="2"
        maxlength="200"
        show-word-limit
        :placeholder="t('project.coverPickDescPlaceholder')"
      />
    </div>

    <template #footer>
      <el-button size="large" @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button size="large" type="primary" class="btn-ink" :disabled="!valid" @click="confirm">
        {{ t('project.coverPickNext') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cp-hint { font-size: 13px; color: var(--ad-text-muted); line-height: 1.7; margin-bottom: 16px; }
.cp-group { margin-bottom: 16px; }
.cp-label { display: flex; align-items: baseline; gap: 8px; font-size: 13px; font-weight: 600; color: var(--ad-text); margin-bottom: 8px; }
.cp-count { font-size: 12px; font-weight: 400; color: var(--ad-text-muted); }
.cp-items { display: flex; flex-wrap: wrap; gap: 10px; }
/* 素材卡：缩略图 + 名称/次数，选中态 indigo 描边 + 角标 */
.cp-item {
  position: relative; display: flex; align-items: center; gap: 10px; padding: 5px 12px 5px 5px;
  border: 1.5px solid var(--ad-border); border-radius: 10px; background: var(--ad-bg);
  cursor: pointer; transition: border-color .15s, box-shadow .15s; text-align: left;
}
.cp-item:hover { border-color: var(--ad-brand); }
.cp-item.on { border-color: var(--ad-brand); background: var(--ad-brand-soft); }
.cp-item:focus-visible { outline: 2px solid var(--ad-accent); outline-offset: 1px; }
.cp-img { width: 48px; height: 48px; object-fit: cover; border-radius: 7px; flex: none; background: var(--ad-bg-soft); }
.cp-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cp-name { font-size: 13px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
.cp-refs { font-size: 12px; color: var(--ad-text-muted); }
.cp-check {
  display: none; position: absolute; top: -7px; right: -7px; width: 18px; height: 18px;
  align-items: center; justify-content: center; border-radius: 50%;
  background: var(--ad-brand); color: var(--ad-brand-contrast); font-size: 11px;
}
.cp-item.on .cp-check { display: inline-flex; }
/* 窄屏：卡片收窄、名称可换行区域变短 */
@media (max-width: 768px) {
  .cp-item { padding: 4px 8px 4px 4px; gap: 8px; }
  .cp-img { width: 40px; height: 40px; }
  .cp-name { max-width: 96px; }
}
</style>
