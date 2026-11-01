<script setup>
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useThemeStore } from '../stores/theme';
import { useLocaleStore } from '../stores/locale';
import { useAdminAuthStore } from './stores/auth';
import { isAdminArea } from '../utils/authContext';

const theme = useThemeStore();
const locale = useLocaleStore();
const auth = useAdminAuthStore();
const { t } = useI18n();
const route = useRoute();

onMounted(() => {
  theme.init();
  locale.init();
  // 档案补拉：刷新页面后恢复登录态（管理令牌有效但内存 user 为空）；失败静默回登录页
  if (auth.token && !auth.user) auth.fetchMe();
});

// 根据当前路由与语言更新浏览器标签页标题
watch(
  () => [route.meta?.titleKey, locale.locale],
  () => {
    const key = route.meta?.titleKey;
    const title = key ? t(key) : '';
    document.title = title ? `${title} · ${t('admin.title')}` : `${t('admin.title')} · XW.COM`;
  },
  { immediate: true },
);

// 防呆：admin 入口误被非 /admin 路径访问（理论不可达，守底）
if (!isAdminArea()) console.warn('[admin] admin entry served outside /admin path');
</script>

<template>
  <el-config-provider :locale="locale.elementLocale">
    <router-view />
  </el-config-provider>
</template>
