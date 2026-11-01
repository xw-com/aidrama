import axios from 'axios';

/**
 * xworld OAuth2 授权服务器客户端（授权码模式 + PKCE，RFC 6749 / 7636）。
 *
 * 端点分两类：
 * - 授权跳转（/oauth/authorize|register 托管页）与 userinfo（凭 Bearer 即可）：浏览器直连授权中心，
 *   走下方 oauthHttp 实例（OAuth 规范原生 JSON，无 { code, message, data } 包装）；
 * - 令牌端点（换码/刷新/吊销）：改走本系统服务端代理 /api/oauth/*（机密客户端）——
 *   client_secret 只存在服务端（server config.xworldOauth），绝不入前端包，
 *   浏览器只提交授权码 + PKCE verifier，服务端负责附带客户端凭据。
 * 与 api/xworld.js 的区别：那是账号直连 API（{ success, message, data } 信封）。
 */
const baseURL = import.meta.env.VITE_XWORLD_API_BASE || 'https://auth.example.com/api/v1';
// 管理后台登记的 client_id（授权跳转用；换码时的客户端身份由服务端凭据承担）
export const OAUTH_CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID || '';
// 授权完成后回跳地址（须与登记的回调逐字节一致）
const redirectUri = () => `${window.location.origin}/oauth/callback`;
// 请求的 scope：profile 基本资料 + email 邮箱 + account 账号管理（改密等 /users/me 写操作）
const OAUTH_SCOPE = 'profile email account';

// 会话内暂存 state/verifier/回跳目标（标签页隔离，防多标签互相覆盖）
const PENDING_KEY = 'aidrama-oauth-pending';

const oauthHttp = axios.create({
  baseURL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});

// 令牌代理实例：指向本系统 API。刻意不走 api/http.js——其 401 拦截器会再调 refreshAccessToken，
// 令牌请求必须直来直去，避免递归
const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const apiHttp = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
});

// 本系统统一信封 { code, message, data } 拆包：code!==0 抛错（回调页直接展示 message）
function unwrap(body) {
  if (body && typeof body === 'object' && 'code' in body) {
    if (body.code !== 0) {
      throw Object.assign(new Error(body.message || 'token request failed'), { code: 'proxy_error' });
    }
    return body.data;
  }
  return body; // 防御：非信封响应原样返回，交给 assertToken 判定
}

// ===== PKCE（S256） =====

// 43~128 位 code_verifier，字符集 [A-Za-z0-9\-._~]
function randomVerifier(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

// BASE64URL(SHA256(verifier))，去 = 填充
async function challengeFrom(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  new Uint8Array(digest).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ===== 授权流程 =====

/**
 * 发起第三方登录/注册：生成 state/verifier 暂存 sessionStorage，302 跳授权中心托管页。
 * 注册走授权中心托管注册页（/oauth/register）：注册即登录，成功后 303 回授权端点发码，
 * 与登录共用同一套授权码 + PKCE 流程，回调处理完全一致。
 * @param {string} [redirect] 登录成功后的站内回跳地址（如路由守卫带来的 ?redirect）
 * @param {boolean} [register] true 跳注册页，否则跳登录页
 */
export async function startLogin(redirect, register = false) {
  if (!OAUTH_CLIENT_ID) throw new Error('missing oauth client id');
  const state = randomVerifier(32).replace(/[^A-Za-z0-9]/g, '');
  const verifier = randomVerifier();
  const codeChallenge = await challengeFrom(verifier);
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, redirect: redirect || '' }));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: OAUTH_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const page = register ? '/oauth/register' : '/oauth/authorize';
  window.location.href = `${baseURL}${page}?${params.toString()}`;
}

/**
 * 回调页处理：校验 state（防 CSRF）→ 授权码换令牌 → 取 userinfo。
 * @param {object} query 回调 URL 上的 query（code/state/error 等）
 * @returns {Promise<{tokens: object, user: object}>} 与旧 xworld 登录同构：tokens 含 access_token/refresh_token
 */
export async function handleCallback(query = {}) {
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  sessionStorage.removeItem(PENDING_KEY);
  if (query.error) {
    throw new Error(query.error_description || query.error);
  }
  if (!pending || !query.state || query.state !== pending.state) {
    throw Object.assign(new Error('state_mismatch'), { code: 'state_mismatch' });
  }
  if (!query.code) {
    throw Object.assign(new Error('missing_code'), { code: 'missing_code' });
  }
  const tokens = await exchangeCode({ code: query.code, verifier: pending.verifier });
  const user = await fetchUserInfo(tokens.access_token);
  return { tokens, user, redirect: pending.redirect };
}

// 授权码换令牌：经本系统服务端代理（附 PKCE verifier 防截持；client_secret 由服务端附加，
// 不下发浏览器）。redirect_uri 须与授权请求逐字节一致，故由前端原样上送
export async function exchangeCode({ code, verifier }) {
  const { data } = await apiHttp.post('/oauth/token', {
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(),
    client_id: OAUTH_CLIENT_ID || undefined,
  });
  return assertToken(unwrap(data));
}

// 刷新令牌（每次返回全新 access + refresh，旧 refresh 立即轮换失效）：经本系统服务端代理
export async function refreshAccessToken(refreshToken) {
  const { data } = await apiHttp.post('/oauth/refresh', { refresh_token: refreshToken });
  return assertToken(unwrap(data));
}

// OIDC 风格用户信息（sub 恒返回，其余按 scope 过滤）
export async function fetchUserInfo(accessToken) {
  const { data } = await oauthHttp.get('/oauth/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

// 退出登录时吊销令牌（best-effort；失败不阻塞本地登出）：经本系统服务端代理。
// 用 fetch keepalive：登出会紧接整页跳授权中心 /oauth/logout 清 SSO 会话，
// keepalive 保证吊销请求不因页面卸载被浏览器掐断
export function revokeToken(token) {
  try {
    return fetch(`${API_BASE}/oauth/revoke`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  } catch { return Promise.resolve(); }
}

// 授权中心统一登出地址（GET /oauth/logout）：清 SSO 会话 Cookie（结束 OAuth2 登录连接，
// 下次进授权页需重新登录而非静默放行），成功后 302 回本站登录页，需整页跳转触发
export function endSessionUrl() {
  const back = `${window.location.origin}/login`;
  return `${baseURL}/oauth/logout?redirect=${encodeURIComponent(back)}`;
}

function assertToken(data) {
  if (!data || !data.access_token) {
    const desc = data?.error_description || data?.error || 'token exchange failed';
    throw Object.assign(new Error(desc), { code: data?.error || 'oauth_error' });
  }
  return data;
}
