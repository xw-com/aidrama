<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLocaleStore } from '../stores/locale';

const locale = useLocaleStore();
const { t } = useI18n();

// 当前语言：从 SUPPORTED_LOCALES 里匹配出展示名
const current = computed(
  () => locale.languages.find((l) => l.value === locale.locale) || locale.languages[0]
);

function pick(value) {
  locale.setLocale(value);
}
</script>

<template>
  <el-dropdown trigger="click" placement="bottom-end" @command="pick">
    <div class="locale-switch" :title="t('settings.languageTitle')">
      <el-icon class="locale-icon"><Comment /></el-icon>
      <span class="locale-label">{{ current.label }}</span>
    </div>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="lang in locale.languages"
          :key="lang.value"
          :command="lang.value"
          :style="current.value === lang.value ? { color: 'var(--ad-brand)', fontWeight: 700 } : null"
        >
          <span>{{ lang.label }}</span>
          <el-icon v-if="current.value === lang.value" style="margin-left: 6px"><Check /></el-icon>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
/* 与 ThemeSwitch 的 pill 风格保持一致 */
.locale-switch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--ad-bg-soft);
  border: 1px solid var(--ad-border);
  color: var(--ad-text-soft);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.locale-switch:hover {
  color: var(--ad-text);
  background: var(--ad-bg-elevated);
}
.locale-icon { font-size: 15px; }

/* 窄屏只保留图标，和 .uname 的隐藏处理一致 */
@media (max-width: 640px) {
  .locale-label { display: none; }
  .locale-switch { padding: 0 9px; }
}
</style>
