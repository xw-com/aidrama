/**
 * 第三方一键登录凭证验签（App 端原生登录：iOS Sign in with Apple / Android Google）。
 *
 * 客户端 uni.login 拿到上游凭证后交由本服务端验签：
 * - Apple：identityToken（RS256 JWT）→ Apple 官方 JWKS 公钥验签 + iss/aud 校验；
 *   aud 必须等于本 App 的 iOS Bundle ID（APPLE_BUNDLE_ID），故无需申请 p8 密钥/Service ID。
 * - Google：优先验 idToken（RS256 JWT，Google JWKS 验签，aud 须在 GOOGLE_CLIENT_IDS 白名单）；
 *   凭证只有 access_token 时回源 /oauth2/v3/userinfo 换取用户标识。
 *
 * 验签通过返回归一身份 { sub, email, name, picture }，账号映射与发令牌在 auth.routes.js。
 * 防重放：Apple identityToken 有效期短（约 10 分钟）且 uni.login 无法携带 nonce，
 * 理论上存在令牌有效期内重放窗口；登录本身无副作用（幂等），风险可接受（文档已注明）。
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { ApiError, unauthorized } from '../utils/response.js';
import { logger } from '../utils/logger.js';

// ===== JWKS 拉取与缓存（进程内，按 URL 分桶；kid 未命中强制刷新一次，兼容厂商轮换密钥） =====
const jwksCache = new Map(); // url -> { keys, fetchedAt }
const JWKS_FETCH_TIMEOUT_MS = 10000;

async function fetchJwks(url, { force = false } = {}) {
  const cached = jwksCache.get(url);
  if (!force && cached && Date.now() - cached.fetchedAt < config.oauthNative.jwksCacheTtlMs) {
    return cached.keys;
  }
  let keys;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    keys = Array.isArray(body?.keys) ? body.keys : null;
    if (!keys?.length) throw new Error('empty keys');
  } catch (e) {
    // 拉取失败时保留旧缓存兜底（密钥未轮换期间验签不受厂商侧抖动影响）
    if (cached) return cached.keys;
    logger.warn(`[oauthLogin] JWKS 拉取失败 ${url}: ${e?.message || e}`);
    throw new ApiError(502, 'auth.oauth_upstream');
  }
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys;
}

/** 按 kid 取验签公钥（JWK）；未命中强制刷新一次（厂商密钥轮换场景） */
async function jwkForKid(url, kid) {
  let jwk = (await fetchJwks(url)).find((k) => k.kid === kid);
  if (!jwk) {
    jwk = (await fetchJwks(url, { force: true })).find((k) => k.kid === kid);
  }
  return jwk || null;
}

/** 用 JWK 组装 Node 公钥并验签 RS256 JWT（Node 原生支持 JWK 导入，无需额外依赖） */
function verifyWithJwk(token, jwk, opts) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return jwt.verify(token, publicKey, { algorithms: ['RS256'], ...opts });
}

/** 解出 JWT header（不验签，仅为取 kid 选公钥）；格式非法返回 null */
function decodeHeader(token) {
  try {
    return jwt.decode(token, { complete: true })?.header || null;
  } catch {
    return null;
  }
}

// ===== Apple =====

/**
 * 验签 Apple identityToken（uni.login provider=apple 的 authResult.identityToken）。
 * 校验：RS256 签名（Apple JWKS）、iss=https://appleid.apple.com、aud=本 App Bundle ID、exp。
 * 返回 { sub, email, name: null }——Apple 的姓名（fullName）只在首次授权返回，由路由层从
 * authResult 单独取，不进本函数。
 */
export async function verifyAppleIdentityToken(identityToken) {
  const cfg = config.oauthNative.apple;
  if (!cfg.bundleId) throw new ApiError(503, 'auth.oauth_not_configured');

  const header = decodeHeader(identityToken);
  if (!header?.kid) throw unauthorized('auth.oauth_invalid');
  const jwk = await jwkForKid(cfg.jwksUrl, header.kid);
  if (!jwk) throw unauthorized('auth.oauth_invalid');

  let payload;
  try {
    payload = verifyWithJwk(identityToken, jwk, {
      issuer: 'https://appleid.apple.com',
      audience: cfg.bundleId,
    });
  } catch {
    throw unauthorized('auth.oauth_invalid');
  }
  if (!payload.sub) throw unauthorized('auth.oauth_invalid');
  return {
    sub: String(payload.sub),
    email: payload.email || null,
    name: null,
    picture: null,
  };
}

// ===== Google =====

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * 验签 Google 凭证：优先 idToken（uni.login 新版返回，完整 OIDC 验签），
 * 否则回源 userinfo 端点校验 access_token（旧版只回 access_token 的场景）。
 * 返回 { sub, email, name, picture }。
 */
export async function verifyGoogleCredential({ idToken, accessToken }) {
  const cfg = config.oauthNative.google;
  if (!cfg.clientIds.length) throw new ApiError(503, 'auth.oauth_not_configured');

  if (idToken) {
    const header = decodeHeader(idToken);
    if (!header?.kid) throw unauthorized('auth.oauth_invalid');
    const jwk = await jwkForKid(cfg.jwksUrl, header.kid);
    if (!jwk) throw unauthorized('auth.oauth_invalid');
    let payload;
    try {
      payload = verifyWithJwk(idToken, jwk, {
        issuer: GOOGLE_ISSUERS,
        audience: cfg.clientIds, // 数组：命中任一已登记客户端（Android/iOS/Web）即可
      });
    } catch {
      throw unauthorized('auth.oauth_invalid');
    }
    if (!payload.sub) throw unauthorized('auth.oauth_invalid');
    return { sub: String(payload.sub), email: payload.email || null, name: payload.name || null, picture: payload.picture || null };
  }

  if (accessToken) {
    let info = null;
    try {
      const resp = await fetch(cfg.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
      });
      if (resp.ok) info = await resp.json();
    } catch { /* 网络异常按凭证无效处理 */ }
    if (!info?.sub) throw unauthorized('auth.oauth_invalid');
    return { sub: String(info.sub), email: info.email || null, name: info.name || null, picture: info.picture || null };
  }

  throw unauthorized('auth.oauth_missing');
}
