// 后端 i18n：按 Accept-Language 解析 locale，并提供 t() 翻译
import zhCN from './locales/zh-CN.js';
import zhTW from './locales/zh-TW.js';
import en from './locales/en.js';
import ja from './locales/ja.js';
import ko from './locales/ko.js';
import ru from './locales/ru.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import pt from './locales/pt.js';

export const DEFAULT_LOCALE = 'zh-CN';
export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ru', 'es', 'fr', 'pt'];

const catalogs = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
  ru,
  es,
  fr,
  pt,
};

// 解析 Accept-Language 头，映射到受支持的 locale
export function resolveLocale(acceptLanguage) {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const langs = String(acceptLanguage)
    .toLowerCase()
    .split(',')
    .map((s) => s.split(';')[0].trim())
    .filter(Boolean);
  for (const l of langs) {
    if (l === 'zh-cn' || l === 'zh-sg' || l === 'zh-hans') return 'zh-CN';
    if (l === 'zh-tw' || l === 'zh-hk' || l === 'zh-mo' || l === 'zh-hant') return 'zh-TW';
    if (l.startsWith('zh')) return 'zh-CN';
    if (l.startsWith('en')) return 'en';
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('ko')) return 'ko';
    if (l.startsWith('ru')) return 'ru';
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('fr')) return 'fr';
    if (l.startsWith('pt')) return 'pt';
  }
  return DEFAULT_LOCALE;
}

function interpolate(str, params) {
  if (!params || typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

// 翻译：命中键返回本地化文本；未命中按字面量原样返回（向后兼容尚未迁移的中文/英文文案）
export function t(locale, key, params) {
  const dict = catalogs[locale] || catalogs[DEFAULT_LOCALE];
  let val = dict[key];
  if (val == null) val = catalogs[DEFAULT_LOCALE][key];
  if (val == null) return interpolate(key, params);
  return interpolate(val, params);
}

// 从响应对象取 locale 并翻译（供 ok / fail 使用）
export function tr(res, key, params) {
  const locale = (res && res.locals && res.locals.locale) || DEFAULT_LOCALE;
  return t(locale, key, params);
}

// 从请求对象取 locale 并翻译（供 errorHandler 使用）
export function tReq(req, key, params) {
  const locale = (req && req.locale) || DEFAULT_LOCALE;
  return t(locale, key, params);
}
