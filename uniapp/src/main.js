import { createSSRApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import i18n from './i18n';
import { useThemeStore } from './stores/theme';

export function createApp() {
  const app = createSSRApp(App);
  app.use(createPinia());
  app.use(i18n);
  // App 端页面 webview 创建时按 pages.json(白字) 重置原生状态栏字色，
  // 页面每次上屏后按当前主题矫正一次（主题切换的即时生效由 theme.apply 负责）
  app.mixin({
    onShow() {
      try { useThemeStore().applyNative(); } catch (e) { /* pinia 未就绪时静默 */ }
    },
  });
  return { app };
}
