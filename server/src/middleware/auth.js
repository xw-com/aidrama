import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';
import db from '../db/index.js';
import { unauthorized, forbidden } from '../utils/response.js';

const { User, CreditTransaction } = db;

// authRequired / authOptional 仅加载到 req.user 的字段集（含 external_id 与 status，封禁检查用）
const USER_ATTRS = ['id', 'external_id', 'username', 'role', 'credits', 'status'];

// 新用户首次登录赠送积分数
const WELCOME_CREDITS = 66;

/**
 * 从签发的 JWT payload 中稳健提取用户 id。
 * 令牌通常把用户 id 放在 sub；同时兼容 user_id / uid / userId / id 等常见 claim（旧令牌兼容）。
 */
export const extractExternalId = (payload) => {
  if (!payload) return null;
  const v = payload.sub ?? payload.user_id ?? payload.uid ?? payload.userId ?? payload.id;
  return v === undefined || v === null ? null : String(v);
};

// ===== 管理后台专用令牌（admt_ 前缀 + typ:'admin'，独立密钥 config.adminAuth.secret）=====
// 管理台（/admin）经专属登录页（账号密码 + 验证码）换取本令牌；与前台用户令牌完全隔离，
// 同一浏览器两端可各自持有会话（前端 aidrama-token / 管理端 aidrama-admin-token）。

// 签发管理令牌：uid 存本地 User 主键（管理账号按本地行直查，不走 external_id 懒创建）。
// 前缀必须与 resolveAdminByToken 的 startsWith('admt_') 校验一致
export const signAdminToken = (user) =>
  'admt_' + jwt.sign({ uid: user.id, typ: 'admin', role: user.role }, config.adminAuth.secret, { expiresIn: config.adminAuth.expiresIn });

// 解析管理令牌 → 本地 User。typ 必须为 'admin'；查无此人（账号已删）返回 null，绝不懒创建
export async function resolveAdminByToken(token) {
  if (!token.startsWith('admt_')) return null;
  let payload;
  try {
    payload = jwt.verify(token.slice(5), config.adminAuth.secret);
  } catch {
    return null;
  }
  if (payload?.typ !== 'admin' || !payload.uid) return null;
  return User.findByPk(payload.uid, { attributes: USER_ATTRS });
}

// 管理台专用鉴权：只接受 admt_ 管理令牌。前台用户令牌直达管理台 API 属越权而非登录过期，
// 显式 403（若返回 401，前端会当成「登录过期」走刷新/兜底循环）。须在路由级单独使用（替代
// authRequired+requireAdmin 组合），不能叠在 authRequired 之后。
export const adminAuthRequired = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token || !token.startsWith('admt_')) throw forbidden('admin.auth.console_token_only');
    const user = await resolveAdminByToken(token);
    if (!user) throw unauthorized('auth.login_expired');
    // 封禁拦截：每请求重查用户行，封禁对已签发管理令牌立即生效
    if (user.status === 'banned') throw forbidden('auth.account_banned');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * 解析令牌并解析出本地 User：
 * 1) admt_ 前缀 → 管理台令牌，按本地主键直查（管理台以本人身份调用共享用户端点：
 *    GET /model-configs、GET /voices、/jobs 轮询等）；
 * 2) axt_ 前缀 → 本地会话令牌（账号密码登录/注册、第三方登录 Apple/Google 共用），
 *    本地验签且 typ 必须为 access（refresh 令牌不得当 access 用）；
 *    其余按本系统密钥验证签发的 JWT（兼容旧客户端/管理台代登令牌）；
 * 3) 按用户 id（external_id）查本地 User；
 * 4) 未找到则懒创建（占位用户名 xw_<id>，赠送 WELCOME_CREDITS 积分），保证后续业务数据可挂载。
 *
 * @param {string} token Bearer 令牌
 * @returns {Promise<object|null>} 本地 User 实例；令牌无效返回 null
 */
export const resolveUserByToken = async (token) => {
  if (token.startsWith('admt_')) {
    return resolveAdminByToken(token);
  }
  let externalId;
  if (token.startsWith('axt_')) {
    try {
      const payload = jwt.verify(token.slice(4), config.jwt.secret);
      if (payload?.typ !== 'access') return null; // 本地签发的 refresh 令牌只能走 /auth/oauth/refresh 换新
      externalId = extractExternalId(payload);
    } catch {
      return null;
    }
  } else {
    try {
      externalId = extractExternalId(jwt.verify(token, config.jwt.secret));
    } catch {
      return null;
    }
  }
  if (!externalId) return null;

  let user = await User.findOne({ where: { external_id: externalId }, attributes: USER_ATTRS });
  if (!user) user = await createExternalUser(externalId);
  return user;
};

/**
 * 懒创建：为外部身份（第三方登录等）建本地账号（external_id 唯一，占位用户名据此生成，避免冲突），
 * 并落首登赠送积分流水。本地注册的账号在注册时已建好，不经过本函数。
 * 并发首登（两请求同时查不到用户、同时 create）时其一会撞唯一索引：
 * 捕获唯一约束冲突后改为查询既有用户幂等返回——赠送积分由先建成功的一方落账，不重复发。
 */
export async function createExternalUser(externalId, extra = {}) {
  const { username: extraUsername, ...rest } = extra;
  const base = extraUsername || `xw_${externalId}`;
  let username = base.slice(0, 64);
  while (await User.findOne({ where: { username }, attributes: ['id'] })) {
    username = `${base.slice(0, 60)}${crypto.randomBytes(2).toString('hex')}`.slice(0, 64);
  }
  try {
    const user = await User.create({
      external_id: externalId,
      username,
      ...rest,
      // 注册显式携带 email 时入库；懒创建（无注册档案）保持为空（email 全局唯一，占位值会撞库）
      email: rest.email || null,
      // password_hash 在旧库可能为 NOT NULL；无本地密码的账号写入随机占位以满足约束（compare 必然失败）
      password_hash: rest.password_hash || crypto.randomBytes(24).toString('hex'),
      credits: WELCOME_CREDITS,
    });
    // 首次登录赠送积分，同步落一条流水（type 沿用 recharge，remark 标注赠送来源）
    await CreditTransaction.create({
      user_id: user.id,
      type: 'recharge',
      amount: WELCOME_CREDITS,
      balance_after: WELCOME_CREDITS,
      remark: '新用户首次登录赠送',
    });
    return user;
  } catch (e) {
    if (e?.name !== 'SequelizeUniqueConstraintError') throw e;
    const existing = await User.findOne({ where: { external_id: externalId }, attributes: USER_ATTRS });
    if (existing) return existing; // 并发首登：账号已由另一请求建好
    throw e; // 非 external_id 冲突（如用户名撞库）：罕见，原样抛出走 5xx/重试
  }
}

// 解析 JWT，挂载 req.user（必须鉴权）
export const authRequired = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    const user = await resolveUserByToken(token);
    if (!user) throw unauthorized('auth.login_expired');
    // 封禁拦截：每请求重查用户行，封禁对已发 JWT 立即生效（authOptional 刻意不拦，公开浏览不受限）
    if (user.status === 'banned') throw forbidden('auth.account_banned');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

// 可选鉴权：有 token 就挂载，没有则跳过。
// 必须整体 try/catch：Express 4 不捕获 async 中间件的 rejection——无保护时 token 解析/建号
// 过程中的 DB 瞬断会让 next() 永不调用（请求悬挂）且 rejection 无人接管，进程直接退出
export const authOptional = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      const user = await resolveUserByToken(token); // 失败按匿名处理（可选鉴权语义）
      if (user) {
        req.user = user;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

// 管理员鉴权：须在 authRequired 之后使用；非 admin 返回 403
export const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  next(forbidden('common.forbidden'));
};

// 签发用户 JWT（管理台「一键登录用户前端」代登等残留场景）：sub 取 external_id
// （resolveUserByToken 按它回查用户）。常规登录/注册一律走下方 signAppTokens（axt_ 会话）。
export const signToken = (user, expiresIn) =>
  jwt.sign({ sub: user.external_id ?? String(user.id), role: user.role }, config.jwt.secret, { expiresIn: expiresIn || config.jwt.expiresIn });

// ===== 本地会话令牌（账号密码登录/注册 + 第三方登录 Apple/Google 共用）：axt_ 前缀 + typ claim =====
// 与 resolveUserByToken 的 axt_ 分支及 POST /auth/oauth/refresh 配套。refresh 不轮换，
// access 过期由客户端携 refresh 静默换新（http.js 按前缀分流）。
export const APP_TOKEN_PREFIX = 'axt_';

export const signAppTokens = (user) => {
  const access = jwt.sign(
    { sub: user.external_id, role: user.role, typ: 'access' },
    config.jwt.secret,
    { expiresIn: config.jwt.appAccessExpiresIn },
  );
  const refresh = jwt.sign(
    { sub: user.external_id, typ: 'refresh' },
    config.jwt.secret,
    { expiresIn: config.jwt.appRefreshExpiresIn },
  );
  const decoded = jwt.decode(access) || {};
  return {
    access_token: APP_TOKEN_PREFIX + access,
    refresh_token: APP_TOKEN_PREFIX + refresh,
    token_type: 'Bearer',
    // 与直连登录响应同构；客户端以 401 → 刷新兜底为准，勿拿它做定时刷新
    expires_in: (decoded.exp || 0) - (decoded.iat || 0),
  };
};
