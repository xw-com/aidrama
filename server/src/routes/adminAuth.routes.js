// 管理后台专属登录（/admin 管理台）：账号（手机号/用户名/邮箱）+ 密码 + 点选验证码
// → 签发 admt_ 前缀管理令牌（config.adminAuth，独立于前台用户令牌体系）。
// 管理员账号即 User.role='admin' 的既有账号，不另设账号体系；首次启动 seed 会自动创建
// 初始管理员（见 seeders/seed.js），密码遗忘可在「用户管理」重置或跑 scripts/setAdminPassword.js。
import { Router } from 'express';
import { Op } from 'sequelize';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest, unauthorized, forbidden } from '../utils/index.js';
import { rateLimit } from '../utils/rateLimit.js';
import { signAdminToken } from '../middleware/auth.js';
import { verifyTicket } from '../services/captcha.service.js';
import { recordLoginLog } from '../services/loginLog.service.js';
import { logger } from '../utils/logger.js';

const router = Router();
const { User } = db;

// 登录限频：进程内滑动窗口（每来源 60s 内最多 10 次），统一走 rateLimit 工厂。
// 密码爆破面比出题接口窄得多，阈值收紧；验证码为主防线。
// key 用 req.ip（app.js trust proxy 后即真实客户端 IP）。保持历史 400 + captcha.rate_limited
// 文案口径（管理台按该文案提示「尝试过多」），状态码不另改避免前端回归。
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, status: 400, message: 'captcha.rate_limited' });

// 管理台登录（账号 + 密码）。失败口径统一 401/403 文案，不区分「账号不存在/密码错误」防枚举
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const identity = String(req.body?.phone || '').trim(); // 字段名沿用 phone，兼容旧前端；实为「账号」
  const password = String(req.body?.password || '');
  const captchaTicket = req.body?.captcha_ticket;
  if (!identity || !password || !captchaTicket) throw badRequest('admin.auth.missing_fields');

  // 人机校验：验证码 ticket（verifyChallenge 签发，5 分钟内有效）由本服务端直接验签消费
  verifyTicket(captchaTicket);

  // phone 无唯一约束，按 id 升序取最早注册的同号账号，命中结果确定可复现
  const user = await User.findOne({
    where: { [Op.or]: [{ phone: identity }, { username: identity }, { email: identity.toLowerCase() }] },
    order: [['id', 'ASC']],
  });
  // 占位哈希（第三方登录无本地密码）compare 必然失败，与账号不存在同口径
  const passOk = user ? await bcrypt.compare(password, user.password_hash || '') : false;
  if (!user || !passOk) throw unauthorized('auth.credentials_invalid');
  if (user.role !== 'admin') throw forbidden('admin.auth.not_admin');
  if (user.status === 'banned') throw forbidden('auth.account_banned');

  // 登录日志：fire-and-forget，不阻塞登录
  recordLoginLog({
    userId: user.id,
    method: 'admin_password',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }).catch((e) => logger.warn(`登录日志写入失败: ${e?.message || e}`));

  const { password_hash, ...safeUser } = user.toJSON();
  return ok(res, { token: signAdminToken(user), user: safeUser }, 'admin.auth.logged_in');
}));

export default router;
