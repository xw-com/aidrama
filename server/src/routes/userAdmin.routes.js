// admin 用户管理：用户列表/搜索 / 封禁·解封 / 登录密码重置 / 登录日志 / 登录配置（脱敏只读）
// 管理台专属接口：仅接受 admt_ 管理令牌（adminAuthRequired）
import { Router } from 'express';
import { Op } from 'sequelize';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { config } from '../config/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { adminAuthRequired, signToken } from '../middleware/auth.js';
import { listLoginLogs, recordLoginLog } from '../services/loginLog.service.js';
import { logger } from '../utils/logger.js';

const router = Router();
const { User } = db;

// 代登令牌有效期：代替用户登录的令牌泄露面比本人会话大，签短时效（2 小时足够排障/代操作）
const LOGIN_AS_TTL = '2h';

// 用户列表（关键词：username/nickname/external_id/phone 模糊 + 纯数字精确 id；状态筛选）
router.get('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
  const where = {};
  const keyword = String(req.query.keyword || '').trim();
  if (keyword) {
    if (/^\d+$/.test(keyword)) {
      where[Op.or] = [{ id: parseInt(keyword, 10) }, { username: { [Op.like]: `%${keyword}%` } }];
    } else {
      where[Op.or] = ['username', 'nickname', 'external_id', 'phone'].map((f) => ({ [f]: { [Op.like]: `%${keyword}%` } }));
    }
  }
  if (req.query.status) where.status = req.query.status;
  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: { exclude: ['password_hash'] },
    order: [['id', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
  });
  const list = rows.map((u) => u.toJSON());
  return ok(res, { list, total: count, page, size });
}));

// 封禁/解封（admin 账号免疫、不可自封；生效点在 adminAuthRequired/authRequired 每请求检查）
router.put('/:id/status', adminAuthRequired, asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'banned'].includes(status)) throw badRequest('admin.users.invalid_status');
  const target = await User.findByPk(req.params.id);
  if (!target) throw badRequest('admin.users.not_found');
  if (target.id === req.user.id) throw badRequest('admin.users.cannot_ban_self');
  if (target.role === 'admin') throw badRequest('admin.users.cannot_ban_admin');
  target.status = status;
  await target.save();
  return ok(res, { id: target.id, status: target.status }, status === 'banned' ? 'admin.users.ban_done' : 'admin.users.unban_done');
}));

// 设置/重置登录密码（管理台密码登录用）。经 xworld 晋级的 admin 本地密码为随机占位，
// 须经此设置后才能登录管理台；可对自己或他人操作（admin 之间互设属预期管理能力）
router.put('/:id/password', adminAuthRequired, asyncHandler(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 8 || password.length > 64) throw badRequest('admin.users.password_invalid');
  const target = await User.findByPk(req.params.id);
  if (!target) throw badRequest('admin.users.not_found');
  target.password_hash = await bcrypt.hash(password, 10);
  await target.save();
  return ok(res, { id: target.id }, 'admin.users.password_set');
}));

// 一键登录用户前端：为指定用户签发短时效前台令牌（本地 JWT，sub=external_id，
// resolveUserByToken 可本地验签），管理台携之跳前台即以该用户身份进入首页（排障/代操作用）。
// 仅限 external_id 用户：无外部身份的旧本地账号 JWT sub 回退本地 id，验签端会按 external_id
// 懒创建出「影子账号」而不是本人，绝不签发。
router.post('/:id/login-as', adminAuthRequired, asyncHandler(async (req, res) => {
  const target = await User.findByPk(req.params.id);
  if (!target) throw badRequest('admin.users.not_found');
  if (target.status === 'banned') throw badRequest('admin.users.banned_no_login');
  if (!target.external_id) throw badRequest('admin.users.no_external_id');

  // 登录日志留痕：method=login_as，与用户本人登录区分（fire-and-forget，不阻塞签发）
  recordLoginLog({
    userId: target.id,
    method: 'login_as',
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown',
    userAgent: req.headers['user-agent'],
  }).catch((e) => logger.warn(`登录日志写入失败: ${e?.message || e}`));

  return ok(res, { token: signToken(target, LOGIN_AS_TTL) }, 'admin.users.login_as_done');
}));

// 登录日志（用户/方式/日期筛选）
router.get('/login-logs', adminAuthRequired, asyncHandler(async (req, res) => {
  return ok(res, await listLoginLogs(req.query));
}));

// 登录配置（脱敏只读）：当前账号体系统一走 xworld，微信登录通道仅剩 env 配置残留（扫码登录已下线未挂载）。
// 展示 config.wechat.login（WECHAT_APP_ID/SECRET）健康状态 + 用户/管理令牌有效期，供 admin 核对配置面。
router.get('/login-config', adminAuthRequired, asyncHandler(async (req, res) => {
  const login = config.wechat.login;
  return ok(res, {
    wechat_login_enabled: login.enabled,
    wechat_app_id: login.appId ? `${String(login.appId).slice(0, 4)}****${String(login.appId).slice(-4)}` : null,
    wechat_secret_set: !!login.appSecret,
    jwt_expires_in: config.jwt.expiresIn,
    admin_token_expires_in: config.adminAuth.expiresIn,
  });
}));

export default router;
