import { Router } from 'express';
import { asyncHandler, ok, badRequest, notFound } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import db from '../db/index.js';
import { clearPricingCache } from '../services/pricing.service.js';

const router = Router();
const { Pricing } = db;

// feature 键是前后端代码里的计费契约（如 video_synthesis），建行后不可改名
const FEATURE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const MODEL_TYPES = ['text', 'image', 'video', 'asr', 'tts'];

// 归一化可编辑字段（PUT 半量更新：只认 body 里出现的字段）。
// 注意「停用/删行 = 该功能 0 积分放行」：loadPricing 只载 enabled 行，feature 查不到时
// estimateCost 返回 0——因此本路由不提供删除，下架语义就是 enabled=false，删除只会造成免费漏洞。
function sanitize(body, { withFeature = false } = {}) {
  const out = {};
  if (withFeature) {
    const feature = String(body?.feature || '').trim();
    if (!FEATURE_RE.test(feature)) throw badRequest('feature 键须字母开头，仅含字母/数字/下划线');
    out.feature = feature;
  }
  if (body?.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 128) throw badRequest('名称必填且不超过 128 字');
    out.name = name;
  }
  if (body?.unit_desc !== undefined) {
    const unitDesc = String(body.unit_desc || '').trim();
    if (!unitDesc || unitDesc.length > 64) throw badRequest('计费单位说明必填且不超过 64 字');
    out.unit_desc = unitDesc;
  }
  if (body?.credits_per_unit !== undefined) {
    const v = Number(body.credits_per_unit);
    if (!Number.isFinite(v) || v < 0 || v > 1e6) throw badRequest('积分/单位须为 0~1000000 的数字');
    out.credits_per_unit = Math.round(v * 10) / 10; // 模型列注释：一位小数精度
  }
  if (body?.unit !== undefined) {
    const v = Number(body.unit);
    if (!Number.isInteger(v) || v < 1 || v > 1e7) throw badRequest('单位大小须为 ≥1 的整数');
    out.unit = v;
  }
  if (body?.model_type !== undefined) {
    const v = body.model_type == null || body.model_type === '' ? null : String(body.model_type);
    if (v && !MODEL_TYPES.includes(v)) throw badRequest(`关联模型类型仅支持：${MODEL_TYPES.join('/')} 或空`);
    out.model_type = v;
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 须为布尔值');
    out.enabled = body.enabled;
  }
  if (body?.sort !== undefined) {
    const v = Number(body.sort);
    if (!Number.isInteger(v)) throw badRequest('排序须为整数');
    out.sort = v;
  }
  return out;
}

// 全量定价（含停用行，管理台维护用；与 /pricing 只含启用行不同）
router.get('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const rows = await Pricing.findAll({ order: [['sort', 'ASC'], ['id', 'ASC']] });
  return ok(res, rows);
}));

// 新增定价行（缺行时 estimateCost 按 0 积分放行，故代码新接的功能须在此补行）
router.post('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const payload = sanitize(req.body, { withFeature: true });
  if (!payload.name) throw badRequest('名称必填');
  if (!payload.unit_desc) throw badRequest('计费单位说明必填');
  payload.credits_per_unit ??= 1;
  payload.unit ??= 1;
  payload.sort ??= 0;
  payload.enabled ??= true;
  try {
    const row = await Pricing.create(payload);
    clearPricingCache();
    return ok(res, row);
  } catch (e) {
    if (e?.name === 'SequelizeUniqueConstraintError') throw badRequest(`feature「${payload.feature}」已存在`);
    throw e;
  }
}));

// 修改定价（feature 不接受修改；写后清定价缓存，约 5 秒内全端生效）
router.put('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await Pricing.findByPk(req.params.id);
  if (!row) throw notFound('定价行不存在');
  const payload = sanitize(req.body);
  if (!Object.keys(payload).length) throw badRequest('没有需要修改的字段');
  await row.update(payload);
  clearPricingCache();
  return ok(res, row);
}));

export default router;
