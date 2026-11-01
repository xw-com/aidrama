// 全局 KV 配置（app_configs 表）：admin 后台可改的运行时参数统一存这里。
// 值一律以字符串落库，读取方按需 parse；带 30s 内存缓存（同 pricing.service 范式）。
import db from '../db/index.js';

const { AppConfig } = db;

const CACHE_TTL_MS = 30 * 1000;
const cache = { data: null, ts: 0 };

/** 读全部配置（前缀过滤可选），返回 { key: value(字符串) } */
async function loadAll(prefix) {
  const now = Date.now();
  if (!cache.data || now - cache.ts >= CACHE_TTL_MS) {
    const rows = await AppConfig.findAll();
    const map = {};
    rows.forEach((r) => { map[r.key] = r.value; });
    cache.data = map;
    cache.ts = now;
  }
  if (!prefix) return cache.data;
  const out = {};
  for (const [k, v] of Object.entries(cache.data)) {
    if (k.startsWith(prefix)) out[k] = v;
  }
  return out;
}

/** 读单个配置（未配置返回默认值）；数值场景请用 getConfigInt/getConfigBool */
export async function getConfig(key, def = null) {
  const map = await loadAll(null);
  const v = map[key];
  return v === undefined || v === null ? def : v;
}

export async function getConfigInt(key, def = 0) {
  const v = await getConfig(key, null);
  if (v === null) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export async function getConfigBool(key, def = false) {
  const v = await getConfig(key, null);
  if (v === null) return def;
  return v === 'true' || v === '1';
}

/**
 * 批量写入配置（upsert）。写入后立即失效缓存，读侧下次直读新值。
 * @param {Record<string, string>} entries 键值对（值须已序列化为字符串）
 * @param {number|null} adminId 操作人（审计）
 */
export async function setConfigs(entries, adminId = null) {
  const pairs = Object.entries(entries || {}).filter(([k]) => k && typeof k === 'string');
  for (const [key, value] of pairs) {
    await AppConfig.upsert({ key, value: String(value ?? ''), updated_by: adminId });
  }
  cache.data = null;
  cache.ts = 0;
}

export function clearAppConfigCache() {
  cache.data = null;
  cache.ts = 0;
}

export { loadAll };
