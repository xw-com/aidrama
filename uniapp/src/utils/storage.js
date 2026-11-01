/**
 * 存储适配层：H5 直用 localStorage（键名与 client/miniclient 一致、存裸值，
 * 同域部署时三端共享登录态）；小程序 / App 走 uni storage。
 */
/* #ifdef H5 */
const ls = window.localStorage;
export function getItem(key) {
  try {
    return ls.getItem(key);
  } catch (e) {
    return null;
  }
}
export function rawItem(key) {
  try {
    return ls.getItem(key);
  } catch (e) {
    return null;
  }
}
export function setItem(key, value) {
  try {
    ls.setItem(key, value);
  } catch (e) {
    /* 忽略隐私模式写失败 */
  }
}
export function removeItem(key) {
  try {
    ls.removeItem(key);
  } catch (e) {}
}
export function cacheKeys() {
  try {
    const out = [];
    for (let i = 0; i < ls.length; i++) out.push(ls.key(i));
    return out;
  } catch (e) {
    return [];
  }
}
/* #endif */

/* #ifndef H5 */
export function getItem(key) {
  try {
    const v = uni.getStorageSync(key);
    return v === '' || v === undefined || v === null ? null : String(v);
  } catch (e) {
    return null;
  }
}
export function rawItem(key) {
  try {
    return uni.getStorageSync(key);
  } catch (e) {
    return null;
  }
}
export function setItem(key, value) {
  try {
    uni.setStorageSync(key, value);
  } catch (e) {}
}
export function removeItem(key) {
  try {
    uni.removeStorageSync(key);
  } catch (e) {}
}
export function cacheKeys() {
  try {
    return uni.getStorageInfoSync().keys || [];
  } catch (e) {
    return [];
  }
}
/* #endif */

/* 键名约定与 client 端完全一致（privacy 为 uniapp App 端独有：首启隐私同意标记） */
export const KEYS = {
  token: 'aidrama-token',
  refresh: 'aidrama-refresh-token',
  locale: 'aidrama-locale',
  theme: 'aidrama-theme',
  privacy: 'privacy_agreed_v1',
};

/* 缓存清理：登录态与用户偏好（语言/主题）保留，其余键一律视为缓存。
 * H5 端与 client/miniclient 同域共享 localStorage，故会连带清掉同域其他键。 */
const PRESERVE_KEYS = new Set(Object.values(KEYS));

function entryBytes(key, value) {
  if (value == null) return key.length;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return key.length + s.length; // 字符数近似字节数，仅作展示估算
}

/** 可清理部分的估算大小（字节） */
export function getCacheSize() {
  try {
    let total = 0;
    for (const k of cacheKeys()) {
      if (PRESERVE_KEYS.has(k)) continue;
      total += entryBytes(k, rawItem(k));
    }
    return total;
  } catch (e) {
    return 0;
  }
}

/** 清空缓存（保留 PRESERVE_KEYS），返回清除的键数 */
export function clearCache() {
  try {
    let n = 0;
    for (const k of cacheKeys()) {
      if (PRESERVE_KEYS.has(k)) continue;
      removeItem(k);
      n++;
    }
    return n;
  } catch (e) {
    return 0;
  }
}
