// xworld OAuth2 令牌代理（公开接口，无需本系统登录态）：换码 / 刷新 / 吊销。
// 前端 oauth.js 不再直连授权服务器令牌端点，client_secret 只存在于此服务端（config.xworldOauth）。
// 授权跳转与 userinfo 仍由浏览器直连授权中心，本代理只收口令牌端点。
import { Router } from 'express';
import { asyncHandler, ok } from '../utils/index.js';
import { rateLimit } from '../utils/rateLimit.js';
import { exchangeCode, refreshToken, revokeToken } from '../services/xworldOauth.service.js';

const router = Router();

// 限频：进程内滑动窗口（每来源 60s 内最多 60 次），统一走 rateLimit 工厂。
// key 用 req.ip：app.js 已开 trust proxy（nginx 单层反代），req.ip 即真实客户端 IP，
// 无 XFF 直连与被代理场景口径一致，不再有「共享回环桶」问题。
const tokenLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: 'common.too_many_requests' });

// 授权码换令牌：body { code, code_verifier, redirect_uri, client_id? }
// 返回与授权服务器同构的令牌载荷 { access_token, refresh_token, token_type, expires_in, ... }
router.post('/token', tokenLimiter, asyncHandler(async (req, res) => {
  const data = await exchangeCode({
    code: req.body?.code,
    codeVerifier: req.body?.code_verifier,
    redirectUri: req.body?.redirect_uri,
    bodyClientId: req.body?.client_id,
  });
  return ok(res, data);
}));

// 刷新令牌（轮换）：body { refresh_token } → 全新 access + refresh，客户端须双落盘
router.post('/refresh', tokenLimiter, asyncHandler(async (req, res) => {
  const data = await refreshToken(req.body?.refresh_token);
  return ok(res, data);
}));

// 吊销令牌：body { token }（登出场景，客户端 best-effort 调用）
router.post('/revoke', tokenLimiter, asyncHandler(async (req, res) => {
  return ok(res, await revokeToken(req.body?.token));
}));

export default router;
