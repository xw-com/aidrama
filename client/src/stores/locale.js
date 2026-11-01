import { defineStore } from 'pinia';
import i18n, { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_STORAGE_KEY, ensureLocaleMessages } from '../i18n';
import elementLocaleMap from '../i18n/element-locales';

// 语言偏好 store，参照 stores/theme.js 的模式：localStorage 持久化 + init() 在 App 挂载时调用
export const useLocaleStore = defineStore('locale', {
  state: () => ({
    locale: DEFAULT_LOCALE,
  }),
  getters: {
    // 当前语言对应的 Element Plus 语言包，供 <el-config-provider :locale> 使用
    elementLocale: (s) => elementLocaleMap[s.locale] || elementLocaleMap[DEFAULT_LOCALE],
    languages: () => SUPPORTED_LOCALES,
  },
  actions: {
    init() {
      // i18n 实例创建时已根据 localStorage / 浏览器语言推断过 locale，这里同步状态
      this.locale = i18n.global.locale.value || DEFAULT_LOCALE;
      this.applyHtmlLang();
    },
    async setLocale(locale) {
      if (!SUPPORTED_LOCALES.some((l) => l.value === locale)) return;
      // 非 zh-CN 语言的文案是懒加载 chunk，切换前先确保已注入，避免界面闪现回退文案
      await ensureLocaleMessages(locale);
      this.locale = locale;
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      i18n.global.locale.value = locale;
      this.applyHtmlLang();
    },
    applyHtmlLang() {
      document.documentElement.lang = this.locale;
    },
  },
});
