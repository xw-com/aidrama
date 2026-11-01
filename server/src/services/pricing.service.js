import db from '../db/index.js';
import { ApiError, insufficientCredits } from '../utils/response.js';
import { roundCredits, ceilCredits } from '../utils/credits.js';

const { Pricing } = db;

const cache = { data: null, ts: 0 };

async function loadPricing() {
  const now = Date.now();
  if (cache.data && now - cache.ts < 5000) return cache.data;
  const rows = await Pricing.findAll({ where: { enabled: true }, order: [['sort', 'ASC'], ['id', 'ASC']] });
  const map = {};
  rows.forEach((r) => { map[r.feature] = r.toJSON(); });
  cache.data = map;
  cache.ts = now;
  return map;
}

export function clearPricingCache() {
  cache.data = null;
  cache.ts = 0;
}

// 估算某 feature 在给定 quantity 下的积分消耗
export async function estimateCost(feature, quantity) {
  const map = await loadPricing();
  const p = map[feature];
  if (!p) return { credits: 0, pricing: null };
  const unit = Math.max(1, p.unit || 1);
  const units = Math.ceil(Number(quantity || 0) / unit);
  const credits = Math.max(0, roundCredits(units * p.credits_per_unit));
  return { credits, pricing: p };
}

/**
 * 视频按模型计费：所选分辨率的独立每秒价 > 模型默认每秒价 > 全局 segment_video
 * @param {object|null} cfg ModelConfig（toJSON），可为 null（未配置/未选定）
 * @param {number} duration 秒
 * @param {string} [resolution] 所选分辨率，如 '720p'
 * @returns {Promise<{credits:number, perSec:number, source:'model'|'global'|'private', pricing?:object}>}
 */
export async function estimateVideoCost(cfg, duration, resolution) {
  // 用户私有模型（本人自带 Key）：调用一律不计积分，显式短路——
  // 不能只靠 price=0（价格链走到底会回退全局定价扣费）
  if (cfg && cfg.is_private) return { credits: 0, perSec: 0, source: 'private' };
  const list = cfg && Array.isArray(cfg.resolutions) ? cfg.resolutions : [];
  const hit = list.find((r) => r && r.value === resolution);
  // 命中分辨率档位且明确配置过价格（含 0=该档免费）即以其价为权威，不再向模型默认价/全局价
  // 回退——0 与「未配置」混叠会把 admin 明确配置的 0 价档按更贵的默认价扣费。
  // 存量行缺 price 字段（null/undefined/''）才视为未配置，回退模型默认价
  const hasHitPrice = hit && hit.price != null && hit.price !== '';
  // 计费时长下限 1 秒：厂商侧会对 duration 做 [3,15]/[4,15] 钳位照常出片，
  // 这里若钳到 0 会形成「负/零时长 → 0 积分出片」的计费绕过
  const secs = Math.max(1, Number(duration) || 0);
  if (hasHitPrice) {
    const perSec = Math.max(0, Number(hit.price) || 0);
    return { credits: ceilCredits(perSec * secs), perSec, source: 'model' };
  }
  const perSec = cfg ? Math.max(0, Number(cfg.price) || 0) : 0;
  if (perSec > 0) {
    return { credits: ceilCredits(perSec * secs), perSec, source: 'model' };
  }
  const fb = await estimateCost('segment_video', secs);
  return { credits: fb.credits, perSec: fb.pricing ? fb.pricing.credits_per_unit : 0, source: 'global', pricing: fb.pricing };
}

/**
 * 字幕（ASR）按模型计费：模型每分钟价 > 全局 video_subtitle
 * @param {object|null} cfg ModelConfig（toJSON），可为 null（未配置/未选定，走全局定价）
 * @param {number} durationSeconds 成片时长(秒)
 * @returns {Promise<{credits:number, source:'model'|'global', pricing?:object}>}
 */
export async function estimateSubtitleCost(cfg, durationSeconds) {
  // 用户私有模型（本人自带 Key）：调用不计积分（显式短路，防回退全局定价）
  if (cfg && cfg.is_private) return { credits: 0, source: 'private' };
  const perMin = cfg ? Number(cfg.price) || 0 : 0;
  if (perMin > 0) {
    const mins = Math.max(1, Math.ceil((Number(durationSeconds) || 0) / 60));
    return { credits: Math.max(0, ceilCredits(perMin * mins)), source: 'model' };
  }
  const fb = await estimateCost('video_subtitle', Number(durationSeconds) || 0);
  return { credits: fb.credits, source: 'global', pricing: fb.pricing };
}

/**
 * 图像按模型计费：模型每张价 > 全局 asset_image
 * @param {object|null} cfg ModelConfig（toJSON），可为 null
 * @returns {Promise<{credits:number, source:'model'|'global', pricing?:object}>}
 */
export async function estimateImageCost(cfg) {
  // 用户私有模型（本人自带 Key）：调用不计积分（显式短路，防回退全局定价）
  if (cfg && cfg.is_private) return { credits: 0, source: 'private' };
  const per = cfg ? Number(cfg.price) || 0 : 0;
  if (per > 0) return { credits: roundCredits(per), source: 'model' };
  const fb = await estimateCost('asset_image', 1);
  return { credits: fb.credits, source: 'global', pricing: fb.pricing };
}

/**
 * 文本按模型计费：模型每次调用价 > 全局 feature 定价（按 quantity）
 * @param {object|null} cfg ModelConfig（toJSON），可为 null
 * @param {string} feature 全局定价 feature，如 'script_parse'
 * @param {number} quantity 全局定价用量（字符/集/条…）
 * @returns {Promise<{credits:number, source:'model'|'global', pricing?:object}>}
 */
export async function estimateTextCost(cfg, feature, quantity) {
  // 用户私有模型（本人自带 Key）：调用不计积分（显式短路，防回退全局定价）
  if (cfg && cfg.is_private) return { credits: 0, source: 'private' };
  const per = cfg ? Number(cfg.price) || 0 : 0;
  if (per > 0) return { credits: Math.max(0, ceilCredits(per)), source: 'model' };
  const fb = await estimateCost(feature, Number(quantity) || 0);
  return { credits: fb.credits, source: 'global', pricing: fb.pricing };
}

// 返回定价表（用于展示）
export async function listPricing() {
  const map = await loadPricing();
  return Object.values(map);
}

// 校验余额（余额需覆盖本次实扣额，避免任务中途失败）。
export async function assertBalance(user, required) {
  const need = ceilCredits(Number(required || 0));
  await user.reload({ attributes: ['id', 'credits'] });
  if (user.credits < need) {
    throw insufficientCredits(`积分不足，本次需要 ${need} 积分，当前余额 ${user.credits} 积分`);
  }
}

/**
 * 读模型限时折扣活动：promo_discount=计费百分比（1-99，85=付原价的 85%），起止时间内生效。
 * @param {object|null} cfg ModelConfig（toJSON 或实例，均可）
 * @param {number} [now] 当前时间戳（默认 Date.now()）
 * @returns {{percent:number, startAt:string, endAt:string}|null} 活动中返回归一化信息，否则 null
 */
export function getModelPromo(cfg, now = Date.now()) {
  if (!cfg) return null;
  const percent = Number(cfg.promo_discount);
  if (!percent || percent <= 0 || percent >= 100) return null;
  const start = cfg.promo_start_at ? new Date(cfg.promo_start_at).getTime() : NaN;
  const end = cfg.promo_end_at ? new Date(cfg.promo_end_at).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (now < start || now > end) return null;
  return {
    percent: Math.round(percent * 100) / 100,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
  };
}

/**
 * 按模型促销活动把名义原价折算为应扣积分（折后价，向上取整；无活动原样 ceil 返回）。
 * 估价路由与实扣路由都必须走这里，保证「确认页展示价 = 实扣价」同一口径。
 * @param {object|null} cfg ModelConfig
 * @param {number} nominalCredits 名义原价积分
 * @returns {number}
 */
export function applyModelPromo(cfg, nominalCredits) {
  const nominal = Math.max(0, roundCredits(Number(nominalCredits || 0)));
  const promo = getModelPromo(cfg);
  if (!promo) return nominal;
  return Math.max(0, ceilCredits((nominal * promo.percent) / 100));
}

/**
 * 为名义积分附加定价信息：原价 / 应扣价 / 折扣率 / 档位。
 * 会员体系已下线，全员原价（discount 恒为 0）；传入带折扣活动的模型 cfg 时，
 * 返回折后价 discountedCredits 与 promo 信息，供前端确认页展示原价/折后价/优惠幅度。
 * @param {object|null} user req.user（authOptional 路由可能为空；仅保留签名兼容）
 * @param {number} nominalCredits 名义原价积分
 * @param {object|null} [cfg] 本次计费所用 ModelConfig（有限时折扣活动时生效）
 * @returns {Promise<{tier:string, discount:number, originalCredits:number, discountedCredits:number, promo?:object}>}
 */
export async function attachTierPricing(user, nominalCredits, cfg = null) {
  const nominal = Math.max(0, roundCredits(Number(nominalCredits || 0)));
  const promo = getModelPromo(cfg);
  if (!promo) {
    return { tier: 'diamond', discount: 0, originalCredits: nominal, discountedCredits: nominal };
  }
  const discounted = Math.max(0, ceilCredits((nominal * promo.percent) / 100));
  return {
    tier: 'diamond',
    discount: Math.round((1 - promo.percent / 100) * 10000) / 10000,
    originalCredits: nominal,
    discountedCredits: discounted,
    promo: { percent: promo.percent, start_at: promo.startAt, end_at: promo.endAt },
  };
}

export { loadPricing };
