import { createI18n } from 'vue-i18n';
import zhCN from '../locales/zh-CN.json';
import { getItem, setItem, KEYS } from '../utils/storage';

/* mp-weixin 开关：主包体积受限，仅内置 简中/繁中/英 三种语言，
   其余语言包不参与打包（下方 LOADERS 条件编译配合），语言选择器也只列这三种 */
/* #ifdef MP-WEIXIN */
export const SUPPORTED_LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];
/* #endif */
/* #ifndef MP-WEIXIN */
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
/* #endif */
export const DEFAULT_LOCALE = 'zh-CN';
export const DETECT_FALLBACK_LOCALE = 'en';
const SUPPORTED = new Set(SUPPORTED_LOCALES.map((l) => l.value));

/** 语言检测：已存偏好 → 系统/浏览器语言 → en */
export function detectLocale() {
  const stored = getItem(KEYS.locale);
  if (stored && SUPPORTED.has(stored)) return stored;
  const candidates = [];
  /* #ifdef H5 */
  candidates.push(...(navigator.languages || []));
  /* #endif */
  /* #ifndef H5 */
  try {
    const info = uni.getSystemInfoSync();
    candidates.push(info.hostLanguage || info.language || '');
  } catch (e) {}
  /* #endif */
  for (const raw of candidates) {
    const tag = String(raw || '').toLowerCase();
    if (!tag) continue;
    if (/^zh(-.*(tw|hk|hant))?/.test(tag)) return /tw|hk|hant/.test(tag) ? 'zh-TW' : 'zh-CN';
    const base = tag.split(/[-_]/)[0];
    if (base === 'zh') return 'zh-CN';
    const hit = SUPPORTED_LOCALES.find((l) => l.value === base);
    if (hit) return hit.value;
  }
  return DETECT_FALLBACK_LOCALE;
}

/* uni-app 在 App/鸿蒙端会把 vue-i18n 别名到内置 runtime 桩（uni-cli-shared/lib/vue-i18n），
 * 其 messageCompiler 把消息原样返回、不做插值，{n}/{name} 等占位符会原样显示。
 * 把消息统一预编译成函数消息（两种构建都原生支持）即可绕开该桩。 */
const NAMED_RE = /\{(\w+)\}/g;

function compileMessage(str) {
  return (ctx) =>
    str.replace(NAMED_RE, (raw, name) => {
      const val = ctx.named(name);
      return val == null ? raw : String(val);
    });
}

function compileMessages(msgs) {
  for (const key in msgs) {
    const val = msgs[key];
    if (typeof val === 'string') msgs[key] = compileMessage(val);
    else if (val && typeof val === 'object') compileMessages(val);
  }
  return msgs;
}

const loadedLocales = new Set(['zh-CN']);
const pendingLoads = new Map();
/* H5 懒加载语言包；app 端 IIFE 单包不支持 code-splitting，改为静态导入内联 */
/* #ifdef H5 */
const LOADERS = {
  'zh-TW': () => import('../locales/zh-TW.json'),
  en: () => import('../locales/en.json'),
  ja: () => import('../locales/ja.json'),
  ko: () => import('../locales/ko.json'),
  ru: () => import('../locales/ru.json'),
  es: () => import('../locales/es.json'),
  fr: () => import('../locales/fr.json'),
  pt: () => import('../locales/pt.json'),
};
/* #endif */
/* #ifndef H5 || MP-WEIXIN */
import zhTW from '../locales/zh-TW.json';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import ru from '../locales/ru.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import pt from '../locales/pt.json';
const LOADERS = {
  'zh-TW': () => ({ default: zhTW }),
  en: () => ({ default: en }),
  ja: () => ({ default: ja }),
  ko: () => ({ default: ko }),
  ru: () => ({ default: ru }),
  es: () => ({ default: es }),
  fr: () => ({ default: fr }),
  pt: () => ({ default: pt }),
};
/* #endif */
/* #ifdef MP-WEIXIN */
import zhTW from '../locales/zh-TW.json';
import en from '../locales/en.json';
const LOADERS = {
  'zh-TW': () => ({ default: zhTW }),
  en: () => ({ default: en }),
};
/* #endif */

/** 幂等 + 并发去重地装载语言包 */
export async function ensureLocaleMessages(locale) {
  if (loadedLocales.has(locale)) return;
  if (pendingLoads.has(locale)) return pendingLoads.get(locale);
  const load = LOADERS[locale];
  if (!load) return;
  // App/小程序端 LOADERS 返回的是字面量对象而非 Promise（H5 才是真动态 import），
  // 必须包一层 Promise.resolve，否则 load().then 直接 TypeError，切换链整体静默挂掉
  const p = Promise.resolve(load())
    .then((mod) => {
      i18n.global.setLocaleMessage(locale, compileMessages(mod.default));
      loadedLocales.add(locale);
    })
    .finally(() => pendingLoads.delete(locale));
  pendingLoads.set(locale, p);
  return p;
}

const initial = detectLocale();
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initial,
  fallbackLocale: 'en',
  messages: { 'zh-CN': compileMessages(zhCN) },
  missingWarn: false,
  fallbackWarn: false,
});

/** 切换语言（装载 → 落盘 → 写 i18n → 写后读回校验）。
 * 先落盘：composer.locale 是可写 computed，App/鸿蒙端走内置桩 + 运行时注入的
 * 全局 Vue，写不生效时静默无异常，若先落盘至少冷启动仍按新语言；
 * 写后读回，未生效则抛错，避免调用方以为成功而界面毫无反应。 */
export async function setLocale(locale) {
  await ensureLocaleMessages(locale);
  setItem(KEYS.locale, locale);
  let applied = null;
  try {
    i18n.global.locale.value = locale;
    applied = i18n.global.locale.value;
  } catch (e) {
    console.error('[i18n] locale 赋值异常:', e);
  }
  /* #ifndef H5 */
  try {
    uni.setLocale?.(locale);
  } catch (e) {}
  /* #endif */
  if (applied !== locale) {
    throw new Error(`locale 写入未生效: 期望 ${locale}, 实际 ${applied}`);
  }
  return locale;
}

export default i18n;
