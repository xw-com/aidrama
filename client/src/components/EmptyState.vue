<script setup>
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
defineProps({
  icon: { type: String, default: '📂' },     // emoji 或文字
  iconComponent: { type: String, default: '' }, // el-icon 组件名（须已在 icons.js 登记）；设置后优先于 emoji
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  actionLabel: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['action']);
</script>

<template>
  <div class="empty-state">
    <div class="es-icon" :class="{ 'is-component': !!iconComponent }">
      <el-icon v-if="iconComponent" :size="28" color="var(--ad-brand)"><component :is="iconComponent" /></el-icon>
      <template v-else>{{ icon }}</template>
    </div>
    <div class="es-title">{{ title || t('empty.title') }}</div>
    <div v-if="description" class="es-desc">{{ description }}</div>
    <el-button
      v-if="actionLabel"
      type="primary"
      class="btn-ink es-action"
      :disabled="disabled"
      @click="emit('action')"
    >
      <slot name="action-icon" />
      {{ actionLabel }}
    </el-button>
    <div v-if="$slots.extra" class="es-extra"><slot name="extra" /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 56px 24px;
  grid-column: 1 / -1;
}
.es-icon {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 38px;
  background: var(--ad-brand-soft);
  margin-bottom: 16px;
}
.es-icon.is-component { font-size: initial; }
.es-title { font-family: var(--ad-font-display); font-size: 17px; font-weight: 700; color: var(--ad-text); }
.es-desc { font-size: 13px; color: var(--ad-text-soft); margin: 8px 0 20px; max-width: 380px; line-height: 1.6; }
.es-action { min-width: 140px; }
.es-extra { margin-top: 14px; }
</style>
