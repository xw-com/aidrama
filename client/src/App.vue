<script setup>
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useThemeStore } from './stores/theme';
import { useLocaleStore } from './stores/locale';

const theme = useThemeStore();
const locale = useLocaleStore();
const { t } = useI18n();
const route = useRoute();

onMounted(() => {
  theme.init();
  locale.init();
});

// 根据当前路由与语言更新浏览器标签页标题
watch(
  () => [route.meta?.titleKey, locale.locale],
  () => {
    const key = route.meta?.titleKey;
    const title = key ? t(key) : '';
    document.title = title ? `${title} · XW.COM` : 'XW.COM · AI Drama';
  },
  { immediate: true },
);
</script>

<template>
  <el-config-provider :locale="locale.elementLocale">
    <router-view />
  </el-config-provider>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', Helvetica, Arial,
    'Microsoft YaHei', sans-serif;
}
#app {
  -webkit-font-smoothing: antialiased;
}
</style>
