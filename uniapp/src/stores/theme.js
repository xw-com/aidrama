import { defineStore } from 'pinia';
import { getItem, setItem, KEYS } from '../utils/storage';

/**
 * 主题 store：深色「放映厅」/ 浅色「暖纸色」/ 跟随系统 三档。
 * mode 是用户偏好（持久化），system 是系统实际主题；resolved 为最终生效值。
 * 落地方式：浅色时页面根 view 挂 .theme-light 类（styles/ad.scss 重定义全部
 * --ad-* 令牌，覆盖整页子树）；H5 另切 <html> 类给 body 底色；原生栏 /
 * 窗口底色走 uni.setBackgroundColor / setNavigationBarColor（best-effort）。
 */
const MODES = ['system', 'light', 'dark'];

export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'dark', // 用户偏好
    system: 'dark', // 系统主题（跟随模式下生效）
  }),
  getters: {
    resolved: (s) => (s.mode === 'system' ? s.system : s.mode),
    isDark() {
      return this.resolved === 'dark';
    },
    /** 页面根 view 绑定用：浅色挂 .theme-light，深色走 page 默认 */
    rootCls() {
      return this.isDark ? '' : 'theme-light';
    },
    navBg() {
      return this.isDark ? '#0a0a0f' : '#f6f4ee';
    },
    navFront() {
      return this.isDark ? '#ffffff' : '#000000';
    },
  },
  actions: {
    init() {
      const saved = getItem(KEYS.theme);
      this.mode = MODES.includes(saved) ? saved : 'dark'; // 旧版只存过 dark
      this.watchSystem();
      this.apply();
    },
    setMode(mode) {
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      setItem(KEYS.theme, mode);
      this.apply();
    },
    /** 监听系统主题：App 端读 osTheme（无 theme 字段），小程序端读 theme（需 manifest darkmode:true），H5 走 matchMedia */
    watchSystem() {
      /* #ifdef APP-PLUS */
      // iOS 需先把应用 UI 风格设为跟随系统，osTheme 才取得到、onThemeChange 才会回调
      try { if (typeof plus !== 'undefined') plus.nativeUI.setUIStyle('auto'); } catch (e) { /* 旧基座无此 API */ }
      /* #endif */
      try {
        const info = uni.getSystemInfoSync() || {};
        const t = info.osTheme || info.theme; // App 平台只有 osTheme；微信小程序在 darkmode:true 时才有 theme
        if (t === 'light' || t === 'dark') this.system = t;
      } catch (e) { /* 取不到则保持默认，H5 下方 matchMedia 兜底 */ }
      /* #ifdef H5 */
      const mq = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      this.system = mq.matches ? 'dark' : 'light';
      const onScheme = (e) => {
        this.system = e.matches ? 'dark' : 'light';
        if (this.mode === 'system') this.apply();
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme); // 旧 Safari
      return;
      /* #endif */
      if (typeof uni.onThemeChange === 'function') {
        try {
          uni.onThemeChange((res) => {
            this.system = res && res.theme === 'light' ? 'light' : 'dark';
            if (this.mode === 'system') this.apply();
          });
        } catch (e) { /* 不支持时停留在初始值 */ }
      }
    },
    apply() {
      /* #ifdef H5 */
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('theme-light', !this.isDark);
        // 浏览器地址栏 / PWA 主题色跟随
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', this.navBg);
      }
      /* #endif */
      this.applyNative();
    },
    /** 原生栏同步（主题切换时由 apply 调；页面每次 onShow 由 main.js 全局 mixin 再调）。
     *  App 端每个页面 webview 创建时都会按 pages.json 的 navigationBarTextStyle(white)
     *  重置状态栏字色，launch 时设的一次会被首页创建覆盖 → 必须页面上屏后再设回来。 */
    applyNative() {
      /* #ifdef APP-PLUS */
      // plus 专属 API：'light'=白字 'dark'=黑字，不受 navigationStyle custom 影响
      try { if (typeof plus !== 'undefined') plus.navigator.setStatusBarStyle(this.isDark ? 'light' : 'dark'); } catch (e) { /* 旧基座无此 API */ }
      /* #endif */
      // 原生窗口底 / 原生导航栏（仅 pay/mini 用默认导航）：失败静默，页面本体由根 view 背景覆盖
      try {
        Promise.resolve(uni.setBackgroundColor({ backgroundColor: this.navBg })).catch(() => {});
      } catch (e) { /* 平台不支持 */ }
      try {
        Promise.resolve(uni.setNavigationBarColor({ frontColor: this.navFront, backgroundColor: this.navBg })).catch(() => {});
      } catch (e) { /* 无原生栏 */ }
    },
  },
});
