import { Router } from 'express';
import jwt from 'jsonwebtoken';
import db from '../db/index.js';
import { asyncHandler, ok } from '../utils/index.js';
import { authRequired, createXworldUser, signAppTokens, APP_TOKEN_PREFIX } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { recordLoginLog } from '../services/loginLog.service.js';
import { verifyAppleIdentityToken, verifyGoogleCredential } from '../services/oauthLogin.service.js';
import { config } from '../config/index.js';
import { ApiError, badRequest, forbidden, unauthorized } from '../utils/response.js';
import { rateLimit } from '../utils/rateLimit.js';

const router = Router();
const { User, UserOauth } = db;

// 可镜像的 xworld 档案字段（身份展示用）；external_id 以令牌为准，积分/角色/会员服务端自有不被覆盖
const PROFILE_FIELDS = ['email', 'phone', 'nickname', 'avatar'];

// ===== 第三方一键登录（App 端原生：iOS Sign in with Apple / Android Google）=====
// 本路由为各 provider 共享：随机昵称兜底（建号时 + 复登空昵称回填）对所有 provider 生效，
// 新接入 provider（如微信 code2session）在此登记即可继承，勿在别处自建号逻辑
// 客户端 uni.login 取上游凭证 → 本端点验签 → 找/建本地账号 → 签发 axt_ 会话令牌（与直连
// /auth/login 的 { user, tokens } 信封同构，前端 applyAuthResult 无差别落会话）。
// 账号映射落 user_oauth（provider + provider_user_id 唯一），external_id = "<provider>:<sub>"
//（带前缀避免与 xworld 数字 id 撞车）。首次建号复用 createXworldUser：占位用户名 + 首登赠 66 积分。
const PROVIDERS = {
  apple: {
    // uni.login 的 authResult：{ identityToken, authorizationCode, user, fullName, email, ... }；
    // 个别 DCloud 桥版本把 identityToken 落在通用 access_token 字段（两者同值并存）
    extract: (ar) => ar.identityToken || ar.access_token || null,
    verify: (v) => verifyAppleIdentityToken(v),
    enabled: () => !!config.oauthNative.apple.bundleId,
    // Apple 姓名只在首次授权返回，identityToken 内没有，从 authResult 单独归一
    displayName: (ar) => [ar.fullName?.givenName, ar.fullName?.familyName].filter(Boolean).join(' ').trim() || null,
  },
  google: {
    // authResult 各版本字段：idToken / id_token（新版）或 access_token（旧版，回源 userinfo 换身份）
    extract: (ar) => ({ idToken: ar.idToken || ar.id_token || null, accessToken: ar.access_token || ar.accessToken || null }),
    verify: (v) => verifyGoogleCredential(v),
    enabled: () => config.oauthNative.google.clientIds.length > 0,
    displayName: (ar) => null, // name 在 idToken/userinfo 内，verify 已带回
  },
};

// 第三方登录未带回姓名时的随机昵称（Apple 姓名仅首登回传，复登/静默授权常为空；
// Google 一般有 name）。剧组角色风贴合产品定位；nickname 无唯一约束，纯随机即可
const NICK_PREFIXES = ['神秘', '热血', '文艺', '赛博', '慵懒', '清醒', '机灵', '温柔', '倔强', '浪漫'];
const NICK_ROLES = ['导演', '编剧', '监制', '摄影师', '剪辑师', '场记', '配音员', '主演', '灯光师', '配乐师'];
const randomNickname = () => `${NICK_PREFIXES[Math.floor(Math.random() * NICK_PREFIXES.length)]}` +
  `${NICK_ROLES[Math.floor(Math.random() * NICK_ROLES.length)]}${1000 + Math.floor(Math.random() * 9000)}`;

// 登录换取限频：每 IP 10 次/分（与 xworld 账号中心认证接口同档）
const oauthLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyFn: (req) => req.ip,
  status: 429,
  message: '登录尝试过于频繁，请稍后再试',
});
// 静默刷新限频：每 IP 60 次/分（正常使用远低于此；防脚本刷端点）
const oauthRefreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => req.ip,
  status: 429,
  message: '请求过于频繁，请稍后再试',
});

// 静默刷新：axt_ refresh 换新 access（refresh 不轮换，原样返回继续用）。
// 必须注册在 /oauth/:provider 之前，避免 refresh 被当 provider 名吃掉
router.post('/oauth/refresh', oauthRefreshLimiter, asyncHandler(async (req, res) => {
  const raw = String(req.body?.refresh_token || '');
  if (!raw.startsWith(APP_TOKEN_PREFIX)) throw unauthorized('auth.login_expired');
  let payload;
  try {
    payload = jwt.verify(raw.slice(APP_TOKEN_PREFIX.length), config.jwt.secret);
  } catch {
    throw unauthorized('auth.login_expired');
  }
  if (payload?.typ !== 'refresh' || !payload.sub) throw unauthorized('auth.login_expired');
  // 不懒创建：refresh 换新只认既有账号（账号已删即登录过期）
  const user = await User.findOne({ where: { external_id: String(payload.sub) } });
  if (!user) throw unauthorized('auth.login_expired');
  if (user.status === 'banned') throw forbidden('auth.account_banned');
  const tokens = signAppTokens(user);
  return ok(res, {
    access_token: tokens.access_token,
    refresh_token: raw, // 不轮换，继续用原 refresh
    token_type: 'Bearer',
    expires_in: tokens.expires_in,
  });
}));

// 邮箱回填：第三方身份带邮箱时补写本地档案（email 全局唯一，撞车即跳过——
// 不阻断登录主体；Apple 私信转发地址天然不撞，Google 邮箱可能与既有 xworld 账号同邮箱）
async function backfillEmail(user, email) {
  if (!email || user.email === email) return;
  try {
    const clash = await User.findOne({ where: { email }, attributes: ['id'] });
    if (!clash) await user.update({ email });
  } catch (e) {
    logger.warn(`第三方登录邮箱回填失败（不影响登录）：${e?.message || e}`);
  }
}

router.post('/oauth/:provider', oauthLoginLimiter, asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  const def = PROVIDERS[provider];
  if (!def) throw badRequest('auth.oauth_unsupported');
  if (!def.enabled()) throw new ApiError(503, 'auth.oauth_not_configured');

  // 凭证在 authResult 内（uni.login 原样透传）；兼容客户端直接平铺字段的调用方式。
  // 部分 uni 运行时会把 authResult 回传成 JSON 字符串——统一解开再用
  let ar = (req.body && typeof req.body === 'object' && req.body.authResult) || req.body || {};
  if (typeof ar === 'string') {
    try { ar = JSON.parse(ar); } catch { ar = {}; }
  }
  const credential = def.extract(ar);
  if (!credential) {
    // 只记 key 名不落 token 值；据此可判断客户端到底送来了什么形态
    const keys = req.body && typeof req.body === 'object' ? Object.keys(req.body).join(',') : typeof req.body;
    logger.warn(`[oauth] ${provider} 缺少凭证：body keys=[${keys}]`);
    throw badRequest('auth.oauth_missing');
  }

  const identity = await def.verify(credential);
  const providerUserId = String(identity.sub);

  let link = await UserOauth.findOne({ where: { provider, provider_user_id: providerUserId } });
  let user = link ? await User.findByPk(link.user_id) : null;
  let created = false;
  if (!user) {
    // 兜底：user_oauth 行缺失但 external_id 已有账号（如旧数据/中断）——直接认领，不重复建号
    const externalId = `${provider}:${providerUserId}`;
    user = await User.findOne({ where: { external_id: externalId } });
    if (!user) {
      const nickname = identity.name || def.displayName(ar) || randomNickname();
      user = await createXworldUser(externalId, {
        username: `${provider === 'apple' ? 'apl' : 'ggl'}_${providerUserId}`,
        nickname,
        ...(identity.picture ? { avatar: identity.picture } : {}),
      });
      created = true;
    }
    link = await UserOauth.create({
      user_id: user.id,
      provider,
      provider_user_id: providerUserId,
      provider_account_name: identity.email || identity.name || null,
    });
  }
  await backfillEmail(user, identity.email);
  // 存量第三方账号昵称为空（随机昵称上线前建的号）时补一个；仅空才补，用户自改的昵称绝不覆盖
  if (!String(user.nickname || '').trim()) {
    await user.update({ nickname: randomNickname() });
  }
  if (user.status === 'banned') throw forbidden('auth.account_banned');

  recordLoginLog({
    userId: user.id,
    method: provider,
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null,
    userAgent: req.headers['user-agent'],
  }).catch((e) => logger.warn(`登录日志写入失败: ${e?.message || e}`));

  return ok(res, { user: publicUser(user), tokens: signAppTokens(user) }, created ? 'auth.register_success' : 'auth.login_success');
}));


// 当前用户（刷新页面时前端调用，返回本地档案 + AIDrama 业务字段）
// authRequired 已据令牌内的 external_id 懒同步本地 User，此处直接复用。
router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  return ok(res, { ...publicUser(user) });
}));

/**
 * 登录/注册后由前端立即调用：把 xworld 档案镜像到本地 User。
 * external_id 取自令牌（不信 body 的 id）；仅镜像展示字段，绝不覆盖积分/角色/会员。
 */
router.post('/sync', authRequired, asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return ok(res, publicUser(null));


  const patch = {};
  for (const f of PROFILE_FIELDS) {
    const v = req.body[f];
    if (v !== undefined && v !== null && String(v).trim() !== '' && user[f] !== v) {
      patch[f] = v;
    }
  }
  // email 有唯一约束：与他人冲突时跳过该字段（不影响登录主体）
  if (patch.email) {
    const clash = await User.findOne({ where: { email: patch.email }, attributes: ['id'] });
    if (clash && clash.id !== user.id) delete patch.email;
  }
  if (Object.keys(patch).length) await user.update(patch);

  const fresh = await User.findByPk(user.id);
  // 登录日志：前端在 xworld 登录/注册成功后调 /sync（改昵称也会走 sync，同属档案同步事件）
  // fire-and-forget，绝不影响登录主流程
  recordLoginLog({
    userId: user.id,
    method: 'xworld_sync',
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null,
    userAgent: req.headers['user-agent'],
  }).catch((e) => logger.warn(`登录日志写入失败: ${e?.message || e}`));
  return ok(res, publicUser(fresh), 'auth.synced');
}));

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u.toJSON ? u.toJSON() : u;
  return rest;
}

export default router;
