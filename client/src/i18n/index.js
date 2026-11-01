import { createI18n } from 'vue-i18n';

// 仅默认/回退语言 zh-CN 随主包同步加载；其余 8 种语言（合计约 700KB JSON）
// 按需 import() 拆成独立 chunk，用户切到时才下载。
import zhCN from '../locales/zh-CN.json';

// 支持的语言：value 为 i18n locale，label 为母语显示名（切换器中始终用母语）
export const SUPPORTED_LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ru', label: 'Русский' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'pt', label: 'Português' },
];

export const DEFAULT_LOCALE = 'zh-CN';
// 浏览器语言不在支持列表时的回退语言
export const DETECT_FALLBACK_LOCALE = 'en';
export const LOCALE_STORAGE_KEY = 'aidrama-locale';

// 根据浏览器语言推断初始 locale：用户手动选过则优先；否则按浏览器语言列表
// （navigator.languages 从 preferred 到 fallback）依次匹配支持语言；都不支持则回退 English
function matchNavLocale(nav) {
  if (!nav) return null;
  const lang = nav.toLowerCase();
  if (lang.startsWith('zh-tw') || lang.startsWith('zh-hk') || lang.startsWith('zh-hant')) return 'zh-TW';
  if (lang.startsWith('zh')) return 'zh-CN';
  const hit = SUPPORTED_LOCALES.find((l) => lang.startsWith(l.value.toLowerCase()));
  return hit ? hit.value : null;
}

export function detectLocale() {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved && SUPPORTED_LOCALES.some((l) => l.value === saved)) return saved;
  const candidates = [...(navigator.languages || []), navigator.language].filter(Boolean);
  for (const nav of candidates) {
    const matched = matchNavLocale(nav);
    if (matched) return matched;
  }
  return DETECT_FALLBACK_LOCALE;
}

const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': zhCN,
  },
});

// 已加载（或加载中）的语言 → Promise，避免并发切换时重复拉取同一 chunk
const loadedLocales = new Set([DEFAULT_LOCALE]);
const pendingLoads = new Map();

// 确保某语言的文案已注入 i18n（幂等）。切换语言 / 应用启动时调用。
export async function ensureLocaleMessages(locale) {
  if (!SUPPORTED_LOCALES.some((l) => l.value === locale)) return;
  if (loadedLocales.has(locale)) return;
  if (pendingLoads.has(locale)) return pendingLoads.get(locale);
  const p = import(`../locales/${locale}.json`)
    .then((mod) => {
      i18n.global.setLocaleMessage(locale, mod.default);
      loadedLocales.add(locale);
    })
    .finally(() => {
      pendingLoads.delete(locale);
    });
  pendingLoads.set(locale, p);
  return p;
}

export default i18n;
