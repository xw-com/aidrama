import { Router } from 'express';
import axios from 'axios';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired, adminAuthRequired } from '../middleware/auth.js';
import { joinUrl } from '../services/llm.service.js';
import { normalizeMyBaseUrl } from '../services/modelConfig.service.js';

const router = Router();
const { ModelVendor } = db;

// 模型清单清洗：字符串数组 / trim / 去空 / 去重 / 上限 500 条
function normalizeVendorModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const m of models) {
    const s = String(m || '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 500) break;
  }
  return out;
}

// 用户侧厂商目录（所有登录用户可见，仅启用项）：私有模型配置页「厂商由系统列出」的数据源；
// 携带 base_url（展示为默认预设值，可改）、website（厂商官网注册入口）与 models 模型清单（用户选模型用）
router.get('/catalog', authRequired, asyncHandler(async (req, res) => {
  const rows = await ModelVendor.findAll({ where: { enabled: true }, order: [['sort', 'asc'], ['id', 'asc']] });
  return ok(res, rows.map((r) => {
    const o = r.toJSON();
    return {
      id: o.id, name: o.name, code: o.code, base_url: o.base_url, website: o.website,
      api_style: o.api_style, supported_types: o.supported_types || [],
      models: Array.isArray(o.models) ? o.models : [],
      logo_url: o.logo_url, description: o.description,
    };
  }));
}));

// 用用户密钥实时拉取厂商模型清单（仅 OpenAI 兼容厂商）：私有模型配置页「拉取最新模型」用。
// 密钥仅用于本次出站请求，不落库、不回显；base_url 可由用户传自定义端点（与私有模型同款
// normalizeMyBaseUrl 校验：仅公网 http(s)，防内网 SSRF），缺省取系统厂商预设地址
router.post('/fetch-models', authRequired, asyncHandler(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const apiKey = String(req.body?.api_key || '').trim();
  if (!code) throw badRequest('vendor.code_required');
  if (!apiKey) throw badRequest('vendor.api_key_required');
  const vendor = await ModelVendor.findOne({ where: { code, enabled: true } });
  if (!vendor) throw badRequest('common.not_found');
  if (vendor.api_style !== 'openai') throw badRequest('vendor.fetch_not_openai');
  const baseUrl = await normalizeMyBaseUrl(req.body?.base_url, vendor.base_url);
  if (!baseUrl) throw badRequest('vendor.base_url_missing');
  try {
    const resp = await axios.get(joinUrl(baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
    const list = Array.isArray(resp.data?.data) ? resp.data.data : [];
    const models = [...new Set(list.map((m) => String(m?.id || '').trim()).filter(Boolean))].sort();
    return ok(res, { models });
  } catch (err) {
    const status = err.response?.status;
    const msg = typeof err.response?.data === 'string'
      ? err.response.data.slice(0, 200)
      : (err.response?.data?.error?.message || err.response?.data?.message || err.message || '');
    throw badRequest('vendor.fetch_failed', { message: String(msg || (status ? `HTTP ${status}` : 'network error')).slice(0, 200) });
  }
}));

// 列表（全局共享，所有登录用户可见）
router.get('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const rows = await ModelVendor.findAll({
    order: [['sort', 'asc'], ['id', 'asc']],
  });
  return ok(res, rows);
}));

// 新建
router.post('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const { name, code, base_url, api_style, supported_types, models, logo_url, website, description, enabled, sort } = req.body;
  if (!name || !code) throw badRequest('vendor.name_code_required');
  const dup = await ModelVendor.findOne({ where: { code } });
  if (dup) throw badRequest('vendor.code_exists');
  const row = await ModelVendor.create({
    name, code, base_url: base_url || '',
    api_style: api_style || 'openai',
    supported_types: Array.isArray(supported_types) ? supported_types : [],
    models: normalizeVendorModels(models),
    logo_url: logo_url || null, website: website || null, description: description || null,
    enabled: enabled !== false, sort: Number(sort) || 0,
  });
  return ok(res, row, 'vendor.created');
}));

// 更新
router.put('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await ModelVendor.findByPk(req.params.id);
  if (!row) throw badRequest('common.not_found');
  const { name, code, base_url, api_style, supported_types, models, logo_url, website, description, enabled, sort } = req.body;
  if (code && code !== row.code) {
    const dup = await ModelVendor.findOne({ where: { code } });
    if (dup) throw badRequest('vendor.code_exists');
  }
  await row.update({
    ...(name !== undefined && { name }),
    ...(code !== undefined && { code }),
    ...(base_url !== undefined && { base_url }),
    ...(api_style !== undefined && { api_style }),
    ...(supported_types !== undefined && { supported_types: Array.isArray(supported_types) ? supported_types : [] }),
    ...(models !== undefined && { models: normalizeVendorModels(models) }),
    ...(logo_url !== undefined && { logo_url }),
    ...(website !== undefined && { website }),
    ...(description !== undefined && { description }),
    ...(enabled !== undefined && { enabled }),
    ...(sort !== undefined && { sort: Number(sort) || 0 }),
  });
  return ok(res, row, 'vendor.updated');
}));

// 删除
router.delete('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await ModelVendor.findByPk(req.params.id);
  if (!row) throw badRequest('common.not_found');
  await row.destroy();
  return ok(res, null, 'vendor.deleted');
}));

// 导出（全部厂商目录；不含敏感字段）
router.get('/export', adminAuthRequired, asyncHandler(async (req, res) => {
  const rows = await ModelVendor.findAll({ order: [['sort', 'asc'], ['id', 'asc']] });
  const data = rows.map((r) => {
    const o = r.toJSON();
    delete o.id;
    return o;
  });
  return ok(res, { version: 1, exported_at: new Date().toISOString(), vendors: data });
}));

// 导入（按 code 幂等 upsert，避免重复创建）
router.post('/import', adminAuthRequired, asyncHandler(async (req, res) => {
  const payload = req.body?.vendors || (Array.isArray(req.body) ? req.body : []);
  if (!Array.isArray(payload) || !payload.length) throw badRequest('vendor.no_import_data');
  const upserted = [];
  for (const item of payload) {
    if (!item.code) continue;
    const existing = await ModelVendor.findOne({ where: { code: item.code } });
    const fields = {
      name: item.name || item.code,
      base_url: item.base_url || '',
      api_style: item.api_style || 'openai',
      supported_types: Array.isArray(item.supported_types) ? item.supported_types : [],
      logo_url: item.logo_url || null,
      website: item.website || null,
      description: item.description || null,
      enabled: item.enabled !== false,
      sort: Number(item.sort) || 0,
    };
    if (existing) {
      await existing.update(fields);
      upserted.push(existing);
    } else {
      upserted.push(await ModelVendor.create({ code: item.code, ...fields }));
    }
  }
  return ok(res, { imported: upserted.length, vendors: upserted }, 'vendor.imported', { count: upserted.length });
}));

export default router;
