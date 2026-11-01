import { Router } from 'express';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired, adminAuthRequired } from '../middleware/auth.js';
import { resolveConfig, listConfigs, maskConfig, normalizeMaxSize, normalizeMyBaseUrl, SHARED_USER_ID } from '../services/modelConfig.service.js';
import { VIDEO_QUERY_HANDLERS, videoVendorOf, vendorQueryCapture } from '../services/video.service.js';

const router = Router();
const { ModelConfig, ModelVendor } = db;
const TYPES = ['text', 'image', 'video', 'tts', 'asr'];
// 用户私有模型配置数量上限（防滥用；每人每类型实际用量很小）
const MY_CONFIG_LIMIT = 20;

/**
 * 促销活动字段归一化（限时折扣：折扣百分比 + 起止时间，三字段一体保存）。
 * 请求未带促销字段 → 返回 {}（不动原值）；折扣为空 → 三字段全清；填折扣则起止必填且结束须晚于开始。
 * strict=false（导入用）：非法促销不抛错，整组置空，保证导入不被单条脏数据阻断。
 */
function normalizePromo(body, { strict = true } = {}) {
  const has = ['promo_discount', 'promo_start_at', 'promo_end_at'].some((k) => body[k] !== undefined);
  if (!has) return {};
  const raw = body.promo_discount;
  if (raw === null || raw === undefined || raw === '') {
    return { promo_discount: null, promo_start_at: null, promo_end_at: null };
  }
  const discount = Number(raw);
  const start = body.promo_start_at ? new Date(body.promo_start_at) : null;
  const end = body.promo_end_at ? new Date(body.promo_end_at) : null;
  const validTime = start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();
  if (!Number.isFinite(discount) || discount < 1 || discount > 99 || !validTime) {
    if (strict) throw badRequest(Number.isFinite(discount) && discount >= 1 && discount <= 99 ? 'model.promo_time_invalid' : 'model.promo_invalid');
    return { promo_discount: null, promo_start_at: null, promo_end_at: null };
  }
  return { promo_discount: discount, promo_start_at: start, promo_end_at: end };
}

/**
 * 视频模型输入上限 + 全局并发归一化（仅 video 消费；其他类型一律 null）。
 * NULL=不限（存量行保持原有行为）；0=该类输入弃用；正整数=上限。非法值/未传 → null。
 */
function normalizeInputLimits(body, type) {
  if (type !== 'video') {
    return { max_input_images: null, max_input_audios: null, max_input_videos: null, max_concurrency: null };
  }
  const norm = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    max_input_images: norm(body.max_input_images),
    max_input_audios: norm(body.max_input_audios),
    max_input_videos: norm(body.max_input_videos),
    max_concurrency: norm(body.max_concurrency),
  };
}

// 列表（当前用户的 + admin 共享的；读开放给所有登录用户，确认页下拉需用）
// ?enabled=1 只回启用项（生成确认页下拉用）；admin 管理页不传，需看到禁用项以便重新启用
router.get('/', authRequired, asyncHandler(async (req, res) => {
  const rows = await listConfigs(req.user.id, req.query.type, { enabledOnly: req.query.enabled === '1' });
  return ok(res, rows.map(maskConfig));
}));

// 测试某类型当前生效配置
router.get('/active/:type', authRequired, asyncHandler(async (req, res) => {
  const cfg = await resolveConfig(req.user.id, req.params.type);
  return ok(res, maskConfig(cfg));
}));

// 新建（admin 后台添加共享模型：归属 user_id=NULL，全员可用、积分计费；不占用 admin 账号名，
// admin 自己的私有模型走 /my 前台入口）
router.post('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const { name, type, provider, base_url, api_key, model, api_style, params, price, resolutions, max_size, translate_prompt_en, enabled, is_default } = req.body;
  if (!name || !type || !TYPES.includes(type)) throw badRequest('model.name_type_invalid');
  if (!base_url) throw badRequest('model.base_url_required');
  if (is_default) await clearDefault(SHARED_USER_ID, type);
  const row = await ModelConfig.create({
    user_id: SHARED_USER_ID, name, type, provider: provider || 'openai', base_url,
    api_key: api_key || null, model: model || null, api_style: api_style || 'openai',
    params: params || {}, price: Number(price) || 0,
    // 支持尺寸已下线（图像生成统一按 max_size 档位换算）：image 不再保存 resolutions
    resolutions: type === 'image' ? [] : (Array.isArray(resolutions) ? resolutions : []),
    max_size: normalizeMaxSize(max_size), // 仅 image 消费；非法值回退默认档 2K
    translate_prompt_en: !!translate_prompt_en,
    ...normalizeInputLimits(req.body, type), // 仅 video 消费；其他类型一律 null
    ...normalizePromo(req.body),
    enabled: enabled !== false, is_default: !!is_default,
  });
  return ok(res, maskConfig(row), 'model.created');
}));

// 更新（只操作共享模型 user_id IS NULL；admin 自己的私有模型在 /my 管理）
router.put('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await ModelConfig.findOne({ where: { id: req.params.id, user_id: SHARED_USER_ID } });
  if (!row) throw badRequest('common.not_found');
  const { name, provider, base_url, api_key, model, api_style, params, price, resolutions, max_size, translate_prompt_en, enabled, is_default } = req.body;
  if (is_default && !row.is_default) await clearDefault(SHARED_USER_ID, row.type);
  await row.update({
    ...(name !== undefined && { name }),
    ...(provider !== undefined && { provider }),
    ...(base_url !== undefined && { base_url }),
    ...(api_key !== undefined && { api_key: api_key || null }), // 传空串则清除
    ...(model !== undefined && { model }),
    ...(api_style !== undefined && { api_style }),
    ...(params !== undefined && { params }),
    ...(price !== undefined && { price: Number(price) || 0 }),
    // 支持尺寸已下线（图像生成统一按 max_size 档位换算）：image 类型传入也一律清空
    ...(resolutions !== undefined && { resolutions: row.type === 'image' ? [] : (Array.isArray(resolutions) ? resolutions : []) }),
    ...(max_size !== undefined && { max_size: normalizeMaxSize(max_size) }), // 仅 image 消费；非法值回退默认档 2K
    ...(Object.hasOwn(req.body, 'max_input_images') || Object.hasOwn(req.body, 'max_input_audios')
      || Object.hasOwn(req.body, 'max_input_videos') || Object.hasOwn(req.body, 'max_concurrency')
      ? normalizeInputLimits(req.body, row.type) : {}), // 仅 video 消费；传了任一上限字段才整组更新
    ...normalizePromo(req.body),
    ...(translate_prompt_en !== undefined && { translate_prompt_en: !!translate_prompt_en }),
    ...(enabled !== undefined && { enabled }),
    ...(is_default !== undefined && { is_default }),
  });
  return ok(res, maskConfig(row), 'model.updated');
}));

// 删除（只操作共享模型 user_id IS NULL）
router.delete('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await ModelConfig.findOne({ where: { id: req.params.id, user_id: SHARED_USER_ID } });
  if (!row) throw badRequest('common.not_found');
  await row.destroy();
  return ok(res, null, 'model.deleted');
}));

// 导出（共享模型全集；导出时不含 api_key 明文，由可选参数控制）
router.get('/export', adminAuthRequired, asyncHandler(async (req, res) => {
  const withKey = req.query.keys === '1';
  const rows = (await listConfigs(req.user.id)).filter((r) => r.user_id === SHARED_USER_ID);
  const data = rows.map((r) => {
    const o = r.toJSON ? r.toJSON() : { ...r }; // listConfigs 已返回普通对象，兼容两种形态
    if (!withKey) delete o.api_key;
    delete o.id; delete o.user_id;
    return o;
  });
  return ok(res, { version: 1, exported_at: new Date().toISOString(), configs: data });
}));

// 导入（导入为共享模型，归属 user_id=NULL）
router.post('/import', adminAuthRequired, asyncHandler(async (req, res) => {
  const payload = req.body?.configs || (Array.isArray(req.body) ? req.body : []);
  if (!Array.isArray(payload) || !payload.length) throw badRequest('model.no_import_data');
  const created = [];
  for (const item of payload) {
    if (!item.type || !TYPES.includes(item.type) || !item.base_url) continue;
    if (item.is_default) await clearDefault(SHARED_USER_ID, item.type);
    const row = await ModelConfig.create({
      user_id: SHARED_USER_ID,
      name: item.name || `${item.type}-${Date.now()}`,
      type: item.type,
      provider: item.provider || 'openai',
      base_url: item.base_url,
      api_key: item.api_key || null,
      model: item.model || null,
      api_style: item.api_style || 'openai',
      params: item.params || {},
      price: Number(item.price) || 0,
      // 支持尺寸已下线（图像生成统一按 max_size 档位换算）：image 存量值导入时一并清空
      resolutions: item.type === 'image' ? [] : (Array.isArray(item.resolutions) ? item.resolutions : []),
      max_size: normalizeMaxSize(item.max_size),
      ...normalizeInputLimits(item, item.type), // 导入带上限配置（非法值归 null，不阻断导入）
      ...normalizePromo(item, { strict: false }),
      translate_prompt_en: !!item.translate_prompt_en,
      enabled: item.enabled !== false,
      is_default: !!item.is_default,
    });
    created.push(maskConfig(row));
  }
  return ok(res, { imported: created.length, configs: created }, 'model.imported', { count: created.length });
}));

// ===================== 用户私有模型配置（/my） =====================
// 用户在个人设置里录入自带 API Key 的私有模型：厂商由系统厂商目录决定，接入地址（base_url）
// 默认取厂商预设、可改为公网 http(s) 兼容端点（normalizeMyBaseUrl 校验防内网 SSRF），
// 模型从厂商清单选择，Key 用户自填；调用私有模型不计积分（pricing 按 is_private 短路），
// 且在模型选择列表中置顶展示。与 admin 路由分离，字段白名单收敛。
// admin 账号同样可用：后台添加的共享模型已归属 user_id=NULL，admin 名下只有自己的私有模型，
// 两种语义不再混在同一个 user_id 上。

// 私有视频模型可选分辨率档位（从高到低；生成确认页默认取首档=最高档，未选则服务端按 '4K' 兜底）
const MY_VIDEO_RESOLUTIONS = ['4K', '2K', '1080p', '720p', '480p'];
// 归一化：只收档位内值、去重并按档位降序；统一存 { value, price: null } 与共享模型同构
//（私有模型调用不计积分，price 置 null：确认页分辨率项不挂「0 积分/秒」价签）
function normalizeMyResolutions(raw) {
  const vals = (Array.isArray(raw) ? raw : [])
    .map((r) => String((r && typeof r === 'object' ? r.value : r) || '').trim())
    .filter((v) => MY_VIDEO_RESOLUTIONS.includes(v));
  return [...new Set(vals)]
    .sort((a, b) => MY_VIDEO_RESOLUTIONS.indexOf(a) - MY_VIDEO_RESOLUTIONS.indexOf(b))
    .map((value) => ({ value, price: null }));
}

// 私有模型 params 归一化：必须是 JSON 对象（键值对）。各线提交语义为「params 同名键覆盖
// 默认计算值」（如 image 的 size 像素串、video 的 resolution）；内部开关由 vendorParams 剔除
function normalizeMyParams(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('model.params_invalid');
  return raw;
}

// 校验厂商并返回（必须启用且支持该模型类型）
async function loadMyVendor(provider, type) {
  const vendor = await ModelVendor.findOne({ where: { code: String(provider || '').trim(), enabled: true } });
  if (!vendor) throw badRequest('model.my_vendor_invalid');
  const types = Array.isArray(vendor.supported_types) ? vendor.supported_types : [];
  if (!types.includes(type)) throw badRequest('model.my_vendor_type');
  return vendor;
}

// 我的私有模型列表（仅本人；key 脱敏）
router.get('/my', authRequired, asyncHandler(async (req, res) => {
  const rows = await ModelConfig.findAll({
    where: { user_id: req.user.id },
    order: [['type', 'ASC'], ['is_default', 'DESC'], ['id', 'ASC']],
  });
  return ok(res, rows.map((r) => maskConfig({ ...r.toJSON(), is_private: true })));
}));

// 新增私有模型
router.post('/my', authRequired, asyncHandler(async (req, res) => {
  const { name, type, provider, base_url, model, api_key, max_size, params, resolutions, translate_prompt_en, is_default } = req.body;
  if (!type || !TYPES.includes(type)) throw badRequest('model.name_type_invalid');
  const modelName = String(model || '').trim();
  if (!modelName) throw badRequest('model.my_model_required');
  if (modelName.length > 128) throw badRequest('model.my_model_too_long');
  const apiKey = String(api_key || '').trim();
  if (!apiKey) throw badRequest('model.my_key_required');
  if (apiKey.length > 255) throw badRequest('model.my_key_too_long');
  const vendor = await loadMyVendor(provider, type);
  const count = await ModelConfig.count({ where: { user_id: req.user.id } });
  if (count >= MY_CONFIG_LIMIT) throw badRequest('model.my_limit', { count: MY_CONFIG_LIMIT });

  // 名称缺省 =「厂商名 模型名」；is_default 与本人同类型其余配置互斥
  const finalName = (String(name || '').trim() || `${vendor.name} ${modelName}`).slice(0, 128);
  if (is_default) await clearDefault(req.user.id, type);
  // Base URL 可自定（改接兼容中转/代理端点；走 normalizeMyBaseUrl 防内网 SSRF），留空取厂商预设；
  // 接入方式 api_style 仍由厂商目录锁定
  const finalBaseUrl = await normalizeMyBaseUrl(base_url, vendor.base_url);
  const row = await ModelConfig.create({
    user_id: req.user.id,
    name: finalName, type,
    provider: vendor.code, base_url: finalBaseUrl, api_style: vendor.api_style,
    api_key: apiKey, model: modelName,
    params: normalizeMyParams(params), price: 0,
    resolutions: type === 'video' ? normalizeMyResolutions(resolutions) : [],
    max_size: type === 'image' ? normalizeMaxSize(max_size) : '2K',
    ...normalizeInputLimits(req.body, type), // 仅 video 消费；非 video 一律 null（NULL=不限）
    translate_prompt_en: type === 'video' ? !!translate_prompt_en : false,
    promo_discount: null, promo_start_at: null, promo_end_at: null,
    enabled: true, is_default: !!is_default,
  });
  return ok(res, maskConfig({ ...row.toJSON(), is_private: true }), 'model.my_created');
}));

// 更新私有模型（厂商/类型不可改；base_url 可改，留空恢复厂商预设；如需更换厂商请删除后重新添加）
router.put('/my/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await ModelConfig.findOne({ where: { id: req.params.id, user_id: req.user.id } });
  if (!row) throw badRequest('common.not_found');
  const { name, base_url, model, api_key, max_size, params, resolutions, translate_prompt_en, enabled, is_default } = req.body;
  const modelName = model !== undefined ? String(model || '').trim() : undefined;
  if (modelName !== undefined) {
    if (!modelName) throw badRequest('model.my_model_required');
    if (modelName.length > 128) throw badRequest('model.my_model_too_long');
  }
  let apiKey;
  if (api_key !== undefined) {
    apiKey = String(api_key || '').trim();
    if (!apiKey) throw badRequest('model.my_key_required'); // 不允许清空：私有模型必须带 Key
    if (apiKey.length > 255) throw badRequest('model.my_key_too_long');
  }
  if (is_default && !row.is_default) await clearDefault(req.user.id, row.type);
  // Base URL 可改：非空须为公网 http(s) 地址；留空恢复厂商预设（厂商可能已被停用/删除，取不到预设则保持原值）
  let finalBaseUrl;
  if (base_url !== undefined) {
    const vendor = await ModelVendor.findOne({ where: { code: row.provider } });
    finalBaseUrl = await normalizeMyBaseUrl(base_url, vendor?.base_url || row.base_url);
  }
  await row.update({
    ...(name !== undefined && { name: (String(name || '').trim() || row.name).slice(0, 128) }),
    ...(finalBaseUrl !== undefined && { base_url: finalBaseUrl }),
    ...(modelName !== undefined && { model: modelName }),
    ...(apiKey !== undefined && { api_key: apiKey }),
    ...(max_size !== undefined && row.type === 'image' && { max_size: normalizeMaxSize(max_size) }),
    ...(params !== undefined && { params: normalizeMyParams(params) }),
    ...(resolutions !== undefined && row.type === 'video' && { resolutions: normalizeMyResolutions(resolutions) }),
    // 与 admin 更新同款守卫：传了任一上限字段才整组更新（video 消费；非 video 归 null）
    ...(Object.hasOwn(req.body, 'max_input_images') || Object.hasOwn(req.body, 'max_input_audios')
      || Object.hasOwn(req.body, 'max_input_videos') || Object.hasOwn(req.body, 'max_concurrency')
      ? normalizeInputLimits(req.body, row.type) : {}),
    ...(translate_prompt_en !== undefined && row.type === 'video' && { translate_prompt_en: !!translate_prompt_en }),
    ...(enabled !== undefined && { enabled: !!enabled }),
    ...(is_default !== undefined && { is_default: !!is_default }),
  });
  return ok(res, maskConfig({ ...row.toJSON(), is_private: true }), 'model.my_updated');
}));

// 删除私有模型（在途任务引用该配置时会取不到 Key 而失败，私有模型计费为 0、退款即为 0，无资损）
router.delete('/my/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await ModelConfig.findOne({ where: { id: req.params.id, user_id: req.user.id } });
  if (!row) throw badRequest('common.not_found');
  await row.destroy();
  return ok(res, null, 'model.my_deleted');
}));

// 查询视频厂商任务状态（admin 调试用）：输入厂商侧任务 ID，按模型配置的厂商契约转发查询，
// 原样返回厂商原始响应文本（raw_text，含 HTTP 状态/归一化状态/视频地址），不做任何业务消费
router.post('/:id/task-query', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await ModelConfig.findByPk(req.params.id);
  if (!row) throw badRequest('common.not_found');
  // 只读调试操作：与列表可见范围同口径（共享模型 + 本人私有配置，逐条校验归属）
  if (row.user_id !== SHARED_USER_ID && row.user_id !== req.user.id) throw badRequest('common.not_found');
  if (row.type !== 'video') throw badRequest('model.task_query.not_video');
  const taskId = String(req.body?.task_id || '').trim();
  if (!taskId) throw badRequest('model.task_query.task_id_required');

  const vendor = videoVendorOf(row);
  const handler = VIDEO_QUERY_HANDLERS[vendor] || VIDEO_QUERY_HANDLERS.generic;
  // 按调用上下文捕获「提交给厂商」的出站请求（URL/方法/头/超时，鉴权头已脱敏），供前端输出展示
  const captured = [];
  let q;
  try {
    q = await vendorQueryCapture.run(captured, () => handler(row, taskId));
  } catch (err) {
    // 查询层失败（网络/HTTP 错误）也原样透出：厂商错误体即最关键的排查信息
    q = {
      state: 'error',
      vendorStatus: null,
      httpStatus: err.response?.status ?? null,
      raw: err.response?.data ?? { message: err.message },
      message: err.message,
    };
  }
  return ok(res, {
    vendor,
    taskId,
    state: q.state,
    vendorStatus: q.vendorStatus ?? null,
    httpStatus: q.httpStatus ?? null,
    videoUrl: q.videoUrl || null,
    message: q.message || null,
    // 提交给厂商的请求信息（多行文本：方法 URL / 头 / 超时；未捕获到则不下发）
    request_text: captured.length ? formatOutboundRequest(captured[0]) : null,
    // 原始返回文本：厂商响应体原样（对象则格式化 JSON，字符串原样输出）
    raw_text: typeof q.raw === 'string' ? q.raw : JSON.stringify(q.raw ?? null, null, 2),
  });
}));

// 出站请求描述 -> 多行展示文本：方法 + URL / 逐行请求头 / 超时
function formatOutboundRequest(r) {
  const lines = [`${r.method} ${r.url}`, '', 'Headers:'];
  for (const [k, v] of Object.entries(r.headers || {})) lines.push(`  ${k}: ${v}`);
  if (r.timeout != null) lines.push('', `Timeout: ${r.timeout}ms`);
  return lines.join('\n');
}

async function clearDefault(userId, type) {
  await ModelConfig.update({ is_default: false }, { where: { user_id: userId, type } });
}

export default router;
