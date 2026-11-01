// 点选文字验证码（公开接口，登录/发验证码前的人机校验）
import { Router } from 'express';
import { asyncHandler, ok } from '../utils/index.js';
import { rateLimit } from '../utils/rateLimit.js';
import { createChallenge, verifyChallenge } from '../services/captcha.service.js';

const router = Router();

// 出题/校验共用限频：进程内滑动窗口（每来源 60s 内最多 120 次），统一走 rateLimit 工厂。
// key 用 req.ip：app.js 已开 trust proxy（nginx 单层反代），req.ip 即真实客户端 IP，
// XFF 可伪造首段不再参与取键。
const challengeLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: 'captcha.rate_limited' });

// 取题：返回 SVG dataURL + 提示字（字符池按请求 locale 自动分组）
router.post('/challenge', challengeLimiter, asyncHandler(async (req, res) => {
  return ok(res, createChallenge(req.locale), 'captcha.challenge_created');
}));

// 校验：通过则签发短期 ticket（前端随登录/注册请求体透传，服务端 verifyTicket 验签消费）
router.post('/verify', challengeLimiter, asyncHandler(async (req, res) => {
  const { ticket } = verifyChallenge(req.body?.id, req.body?.points);
  return ok(res, { verified: true, ticket }, 'captcha.verified');
}));

export default router;
