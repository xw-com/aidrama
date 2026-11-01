import { defineStore } from 'pinia';

const STORAGE_KEY = 'aidrama-theme';
const SIDEBAR_KEY = 'aidrama-sidebar-collapsed';
const html = document.documentElement;

function systemDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(mode) {
  // mode: 'light' | 'dark' | 'auto'
  const isDark = mode === 'dark' || (mode === 'auto' && systemDark());
  html.classList.toggle('dark', isDark);
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'light',
    sidebarCollapsed: false,
  }),
  actions: {
    init() {
      // CINEMA STUDIO：默认旗舰深色；已有偏好（含 auto）照旧
      const saved = localStorage.getItem(STORAGE_KEY) || 'dark';
      this.setMode(saved);
      this.sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
      // 监听系统主题变化（auto 模式下自动跟随）
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.mode === 'auto') apply('auto');
      });
    },
    setMode(mode) {
      this.mode = mode;
      localStorage.setItem(STORAGE_KEY, mode);
      apply(mode);
    },
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      localStorage.setItem(SIDEBAR_KEY, this.sidebarCollapsed ? '1' : '0');
    },
  },
  getters: {
    isDark: (s) => s.mode === 'dark' || (s.mode === 'auto' && systemDark()),
  },
});
