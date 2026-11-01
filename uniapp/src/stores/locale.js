import { defineStore } from 'pinia';
import i18n, { SUPPORTED_LOCALES, DEFAULT_LOCALE, setLocale as applyLocale } from '../i18n';

// 语言偏好 store：i18n/index.js 的 setLocale 负责装载语言包 + 落盘，这里只维护响应式状态
export const useLocaleStore = defineStore('locale', {
  state: () => ({
    locale: DEFAULT_LOCALE,
  }),
  getters: {
    languages: () => SUPPORTED_LOCALES,
  },
  actions: {
    init() {
      // i18n 实例创建时已根据存储/系统语言推断过 locale，这里同步状态
      this.locale = i18n.global.locale.value || DEFAULT_LOCALE;
      /* #ifdef H5 */
      document.documentElement.lang = this.locale;
      /* #endif */
    },
    async setLocale(locale) {
      if (!SUPPORTED_LOCALES.some((l) => l.value === locale)) return;
      // 非 zh-CN 语言包懒加载，切换前先注入避免闪现回退文案；
      // 装载/写入失败会抛出（如鸿蒙端 locale 未生效），由调用方提示而非静默
      await applyLocale(locale);
      this.locale = locale;
      /* #ifdef H5 */
      document.documentElement.lang = locale;
      /* #endif */
    },
  },
});
