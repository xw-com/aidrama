<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useThemeStore } from '../stores/theme';

const theme = useThemeStore();
const { t } = useI18n();

const options = [
  { value: 'light', labelKey: 'theme.light', icon: 'Sunny' },
  { value: 'dark', labelKey: 'theme.dark', icon: 'Moon' },
  { value: 'auto', labelKey: 'theme.auto', icon: 'Monitor' },
];

const current = computed(() => theme.mode);
function pick(v) {
  theme.setMode(v);
}
</script>

<template>
  <div class="theme-switch">
    <button
      v-for="o in options"
      :key="o.value"
      class="ts-btn"
      :class="{ active: current === o.value }"
      :title="t(o.labelKey)"
      @click="pick(o.value)"
    >
      <el-icon><component :is="o.icon" /></el-icon>
    </button>
  </div>
</template>

<style scoped>
.theme-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: var(--ad-bg-soft);
  border: 1px solid var(--ad-border);
}
.ts-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 50%;
  cursor: pointer;
  color: var(--ad-text-soft);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.ts-btn:hover { color: var(--ad-text); }
.ts-btn.active {
  background: var(--ad-primary);
  color: var(--ad-primary-contrast);
}
</style>
