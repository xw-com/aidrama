import net from 'node:net';
import { lookup } from 'node:dns/promises';
import db from '../db/index.js';
import { notFound, forbidden, badRequest } from '../utils/response.js';

const { ModelConfig } = db;
const Op = db.Sequelize.Op;

/**
 * 共享模型归属（哨兵值）：admin 后台添加的模型 user_id 统一为 NULL（无属主、全员共享、积分计费）。
 * 不再记在 admin 账号名下——否则 admin 名下同时存在「共享模型」与「admin 自己的私有模型」
 * 两种语义无法区分；归 NULL 后 admin 也能像普通用户一样在前台添加私有模型（自带 Key、0 积分）。
 * 不用 0：user_id 对 users.id 有外键约束（associations.js belongsTo），0 会违反约束；
 * NULL 天然合法，且正是模型列注释「null = 全局/系统默认」的原生语义。
 * Sequelize 对 { user_id: null } 自动生成 IS NULL，查询无需特判。
 */
export const SHARED_USER_ID = null;

// 图片模型「最大支持尺寸」档位（ModelConfig.max_size）：档位 -> 长边像素。
// 生图提交形态为 size=档位字符串（如 '2K'）+ ratio=画幅，像素由厂商按档位×比例换算；
// ladder 保留用于档位合法性校验（normalizeMaxSize）与比较
export const IMAGE_MAX_SIZE_LADDER = { '1K': 1024, '2K': 2048, '3K': 3072, '4K': 3840, '8K': 7680 };

/**
 * max_size 归一化：非法/缺省值一律回退 '2K'（默认档）。
 * 旧库经 ensureColumns 裸加列无默认值、存量行为 NULL，读取侧统一走这里兜底。
 */
export function normalizeMaxSize(v) {
  return IMAGE_MAX_SIZE_LADDER[v] ? v : '2K';
}

/**
 * 视频生成分辨率白名单校验：模型配置了 resolutions 列表（非空）时，客户端提交的分辨率
 * 必须命中其中一项，否则抛错拒绝提交——防止旧客户端/直连接口用未配置档位提交（按默认价
 * 兜底计费或被厂商静默降级）。列表为空/缺省=未配置=不限（存量模型行为不变）。
 * 与 estimateVideoCost 同口径精确匹配（大小写敏感），命中档位才按独立每秒价计费。
 * @param {object|null} cfg ModelConfig（toJSON），null=未选定模型（走全局定价，不校验）
 * @param {string} resolution 提交分辨率（调用方已补默认档，如 '720p'/'4K'）
 */
export function assertResolutionAllowed(cfg, resolution) {
  const list = cfg && Array.isArray(cfg.resolutions) ? cfg.resolutions : [];
  if (!list.length) return;
  const values = list.map((r) => r && r.value).filter(Boolean);
  if (values.includes(resolution)) return;
  throw badRequest('video.generate_resolution_invalid', { values: values.join('/') });
}

// params 中的服务端内部开关（仅作本地能力判定，不作为厂商提交参数下发）
const INTERNAL_PARAM_KEYS = new Set(['supportsReferenceImages']);

/**
 * 提交用 params：剔除内部开关后的副本。
 * 各线（text/image/video）统一「params 全覆盖」语义——同名键以 params 为准，
 * 合并前须先过这里，避免内部开关原样发给厂商导致 400。
 */
export function vendorParams(params) {
  if (!params || typeof params !== 'object') return {};
  return Object.fromEntries(Object.entries(params).filter(([k]) => !INTERNAL_PARAM_KEYS.has(k)));
}

/**
 * 解析「系统默认」模型配置（共享侧，user_id=NULL、admin 后台维护），与请求用户无关：
 * 共享默认(is_default)优先，其次共享侧任意 enabled（早建优先）。
 * 找不到返回 null 不抛错，由调用方决定兜底行为。
 * 用于必须保证质量的内部链路（如视频提示词英译）：私有模型自带 Key、能力参差，
 * 这类环节固定走 admin 配置的共享模型，不跟随用户私有模型。
 */
export async function resolveSystemConfig(type) {
  let row = await ModelConfig.findOne({
    where: { user_id: SHARED_USER_ID, type, enabled: true, is_default: true },
    order: [['id', 'ASC']],
  });
  if (!row) {
    row = await ModelConfig.findOne({
      where: { user_id: SHARED_USER_ID, type, enabled: true },
      order: [['id', 'ASC']],
    });
  }
  return row;
}

/**
 * 为指定用户解析某类型(text/image/video/tts)的有效模型配置
 * 只使用该用户在数据库中自行创建的配置，不回退到任何全局/.env 默认值：
 * 1. 用户自己的默认 → 2. 用户自己的任意 enabled → 3. 共享模型（系统默认）
 */
export async function resolveConfig(userId, type) {
  // 1. 用户自己的默认
  let row = await ModelConfig.findOne({
    where: { user_id: userId, type, enabled: true, is_default: true },
  });
  // 2. 用户任意启用项（最新的优先）
  if (!row) {
    row = await ModelConfig.findOne({
      where: { user_id: userId, type, enabled: true },
      order: [['id', 'DESC']],
    });
  }
  // 3. 用户自己没有 → 回退到共享模型（user_id=NULL，admin 后台管理、全员积分消费）
  if (!row) row = await resolveSystemConfig(type);

  if (!row) {
    throw notFound(`未配置 ${type} 类型的可用模型，请先在「大模型配置」中添加并启用`);
  }
  return withPrivateFlag(row, userId);
}

/**
 * 按 id 取当前用户的指定模型配置（用于生成时让用户显式选定某个模型）
 * 仅限本人配置；不存在则抛 notFound。
 */
export async function getConfig(userId, id) {
  let row = await ModelConfig.findOne({ where: { id, user_id: userId } });
  // 本人没有 → 回退到共享配置（允许用户选用 admin 配好的共享模型）
  if (!row) row = await ModelConfig.findOne({ where: { id, user_id: SHARED_USER_ID } });
  if (!row) throw notFound('模型配置不存在');
  // 已被禁用的模型不允许选用（防止确认页缓存/记忆的默认模型绕过列表直接提交）
  if (!row.enabled) throw forbidden('该模型已被停用，请更换模型后重试');
  return withPrivateFlag(row, userId);
}

/**
 * 私有模型标志：本人名下的配置（用户自带 Key 的私有模型，调用不计积分）。
 * 共享模型归属 user_id=0，不会等于任何真实用户 id，故 admin 的私有模型也按此口径
 * 正确标记（admin 自用免费）；共享模型任何人调用都计积分。
 * pricing.service 的四个 estimate 函数据此短路返回 0 积分，估价与实扣天然同口径。
 */
function withPrivateFlag(row, userId) {
  const o = row.toJSON ? row.toJSON() : { ...row };
  o.is_private = o.user_id === userId;
  return o;
}

export async function listConfigs(userId, type, { enabledOnly = false } = {}) {
  // 当前用户自己的配置 + 共享模型（user_id 为 NULL，全员可选用）
  // 注意不能用 Op.in：SQL 的 IN 列表不匹配 NULL 行，须用 OR + IS NULL
  // enabledOnly：生成确认页下拉用（只见可用的）；admin 管理页不传，需看到禁用项以便重新启用
  const where = { [Op.or]: [{ user_id: userId }, { user_id: SHARED_USER_ID }] };
  if (type) where.type = type;
  if (enabledOnly) where.enabled = true;
  const rows = await ModelConfig.findAll({ where, order: [['type', 'ASC'], ['is_default', 'DESC'], ['id', 'ASC']] });
  // 私有模型置顶：类型分组内本人配置排在前（稳定排序，组内保持原 is_default/id 序）；
  // 每行带 is_private 标志（前端免费徽标用）。生成确认页按单类型拉取，即「私有模型在最前」
  const flagged = rows.map((r) => withPrivateFlag(r, userId));
  flagged.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return (b.is_private ? 1 : 0) - (a.is_private ? 1 : 0);
  });
  return flagged;
}

// 列表输出时隐藏完整 api_key
export function maskConfig(row) {
  const o = row.toJSON ? row.toJSON() : { ...row };
  if (o.api_key) {
    o.api_key_masked = o.api_key.slice(0, 4) + '****' + o.api_key.slice(-4);
    o.has_api_key = true;
    delete o.api_key;
  } else {
    o.has_api_key = false;
    o.api_key_masked = '';
  }
  return o;
}

// ===================== 私有模型自定义 Base URL 校验 =====================
// 私有模型允许改接兼容端点（中转/代理站）：服务端会按该地址出站请求（生成调用、拉模型清单），
// 属经典 SSRF 入口，因此入库前统一走此校验：仅放行 http(s)，且域名解析结果不得命中
// 回环/内网/链路本地等保留段（防探内网服务与云元数据 169.254.169.254）。
// 先 resolve 再判段：裸 IP、八进制/十进制整数型 IP 变体都会以真实解析结果命中黑名单。
const BLOCKED_BASE_URL_HOST_RE = /^(localhost$|.*\.localhost$|.*\.local$|.*\.internal$|.*\.lan$)/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // 本机/私网
    if (a === 169 && b === 254) return true; // 链路本地（含云厂商元数据）
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 192 && b === 168) return true; // 私网
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  const s = String(ip).toLowerCase();
  if (s === '::' || s === '::1') return true; // 未指定/回环
  if (s.startsWith('fe80')) return true; // 链路本地
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // ULA 私网
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)); // IPv4 映射
  return false;
}

/**
 * 归一化用户自填 Base URL：留空回落 fallback（厂商预设）；非空须为公网 http(s) 地址。
 * POST/PUT /my 与 fetch-models 的用户透传统一走此校验。
 */
export async function normalizeMyBaseUrl(raw, fallback = '') {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  if (s.length > 255) throw badRequest('model.my_base_url_invalid'); // ModelConfig.base_url 为 STRING(255)
  let u;
  try { u = new URL(s); } catch { throw badRequest('model.my_base_url_invalid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('model.my_base_url_invalid');
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, ''); // IPv6 字面量去方括号
  if (!host || BLOCKED_BASE_URL_HOST_RE.test(host)) throw badRequest('model.my_base_url_invalid');
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch { throw badRequest('model.my_base_url_invalid'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw badRequest('model.my_base_url_invalid');
  return s;
}
