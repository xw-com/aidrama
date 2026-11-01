import { createApp } from 'vue';
import { createPinia } from 'pinia';
// Element Plus 组件与样式由 unplugin-vue-components（vite.config.js 的 ElementPlusResolver）
// 按使用量自动引入，这里不再全量 app.use(ElementPlus)；仅暗色主题变量需全局引入
import 'element-plus/theme-chalk/dark/css-vars.css';
// ElMessage / ElMessageBox 是脚本里手动 import 的（resolver 不会为其注入样式），样式需显式引入；
// loading 的样式同时兜底 25 处 v-loading 指令
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/es/components/loading/style/css';

import App from './App.vue';
import router from './router';
import i18n, { ensureLocaleMessages } from './i18n';
import { registerIcons } from './icons';
import { installGlobalErrorReporting } from './utils/clientLog';
import './styles/theme.scss';

async function bootstrap() {
  // 默认/回退语言 zh-CN 的文案已随主包同步加载；用户选了其他语言时按需拉对应 chunk
  await ensureLocaleMessages(i18n.global.locale.value);

  const app = createApp(App);
  app.use(createPinia());
  app.use(i18n);
  app.use(router);
  registerIcons(app);
  // 全局错误兜底：vue errorHandler + unhandledrejection / window.error，统一上报 /api/client-log
  installGlobalErrorReporting(app);

  app.mount('#app');
}

bootstrap();
