// xworld OAuth2 客户端凭据的消费方：服务端代理令牌交换（换码/刷新/吊销）。
// 浏览器只经手授权码与 PKCE verifier；client_secret 只存在于此服务端，向授权服务器
// 证明客户端身份（机密客户端）。与 middleware/auth.js 的分工：这里负责「拿令牌」，
// 令牌校验统一在 resolveUserByToken 收口，两种令牌（xwat_ / 平台 JWT）一视同仁。
import axios from 'axios';
import { config } from '../config/index.js';
import { ApiError, badRequest } from '../utils/response.js';

const FORM_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };

// 回跳地址白名单：只允许本系统登记的前端源（CLIENT_ORIGIN + PUBLIC_BASE_URL，生产同域部署
// 即 PUBLIC_BASE_URL）与桌面壳回调源（xworldOauth.desktopOrigins）。真正的 redirect_uri
// 逐字节一致性由授权服务器校验，这里只防本代理被当作任意站点换码的跳板
const allowedOrigins = () => new Set([
  ...config.clientOrigin,
  config.publicBaseUrl,
  ...config.xworldOauth.desktopOrigins,
].filter(Boolean));

// 解析回跳地址的 origin：http(s) 用 URL.origin；app:// 等非特 schemee 的 URL.origin 恒为
// "null"（桌面壳回调 app://xw-client/... 即此形态），退回 protocol//host 拼接（URL 已归一小写）
function originOf(redirectUri) {
  try {
    const u = new URL(String(redirectUri));
    if (u.origin && u.origin !== 'null') return u.origin;
    return u.host ? `${u.protocol}//${u.host}` : '';
  } catch { /* 非法 URL 按空处理 */ }
  return '';
}

function assertAllowedRedirect(redirectUri) {
  const origin = originOf(redirectUri);
  if (!origin || !allowedOrigins().has(origin)) throw badRequest('redirect_uri_not_allowed');
}

// 组装客户端身份：client_id 配置优先，回退请求体（前端 VITE_OAUTH_CLIENT_ID 本就是公开信息）；
// client_secret 只取服务端配置，绝不接受请求体传入——留空即公开客户端直通（本地开发零影响）
function clientAuth(bodyClientId) {
  const clientId = config.xworldOauth.clientId || String(bodyClientId || '').trim();
  if (!clientId) throw badRequest('oauth_client_id_missing');
  const form = { client_id: clientId };
  if (config.xworldOauth.clientSecret) form.client_secret = config.xworldOauth.clientSecret;
  return form;
}

// 调授权服务器令牌端点：4xx（invalid_grant 等）原状态透传、上游文案透出，供回调页直接展示
async function postTokenEndpoint(form) {
  try {
    const { data } = await axios.post(`${config.xworldApi.apiBase}/oauth/token`, new URLSearchParams(form).toString(), {
      timeout: 15000,
      headers: FORM_HEADERS,
    });
    return data;
  } catch (e) {
    const status = e.response?.status;
    const d = e.response?.data;
    if (d && typeof d === 'object' && (d.error || d.error_description)) {
      throw new ApiError(status >= 400 && status < 500 ? status : 502, d.error_description || d.error);
    }
    throw new ApiError(502, 'token_endpoint_unreachable');
  }
}

function assertTokens(data) {
  if (!data || !data.access_token) {
    throw new ApiError(502, data?.error_description || data?.error || 'token_exchange_failed');
  }
  return data;
}

// 授权码换令牌：code 一次性；redirect_uri 须与授权请求逐字节一致（前端传自己的 redirectUri()）；
// PKCE verifier 由前端持有、在此转发
export async function exchangeCode({ code, codeVerifier, redirectUri, bodyClientId }) {
  if (!code || !codeVerifier || !redirectUri) throw badRequest('oauth_exchange_params_missing');
  assertAllowedRedirect(redirectUri);
  const data = await postTokenEndpoint({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: String(redirectUri),
    code_verifier: String(codeVerifier),
    ...clientAuth(bodyClientId),
  });
  return assertTokens(data);
}

// 刷新令牌：OAuth 流程每次轮换，返回全新 access + refresh（旧 refresh 立即失效），
// 客户端必须双落盘（见 client/miniclient api/http.js）
export async function refreshToken(refreshToken) {
  if (!refreshToken) throw badRequest('oauth_refresh_params_missing');
  const data = await postTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken),
    ...clientAuth(),
  });
  return assertTokens(data);
}

// 吊销令牌（登出时调用）：RFC 7009 成功即 200 空 body，客户端本就 best-effort，这里同样
// 不因上游异常阻塞登出主流程
export async function revokeToken(token) {
  if (!token) return { revoked: false };
  const form = { token: String(token), ...clientAuth() };
  try {
    await axios.post(`${config.xworldApi.apiBase}/oauth/revoke`, new URLSearchParams(form).toString(), {
      timeout: 10000,
      headers: FORM_HEADERS,
    });
  } catch { /* 吊销失败不阻塞登出：令牌有自身有效期，且登出后本地会话已清 */ }
  return { revoked: true };
}
