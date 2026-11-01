import { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminAuthRoutes from './adminAuth.routes.js';
import captchaRoutes from './captcha.routes.js';
import appRoutes from './app.routes.js';
import projectRoutes from './project.routes.js';
import scriptRoutes from './script.routes.js';
import assetRoutes from './asset.routes.js';
import storyboardRoutes from './storyboard.routes.js';
import videoRoutes from './video.routes.js';
import modelConfigRoutes from './modelconfig.routes.js';
import modelVendorRoutes from './modelvendor.routes.js';
import voiceRoutes from './voice.routes.js';
import scriptDraftRoutes from './scriptDraft.routes.js';
import creditRoutes from './credit.routes.js';
import rechargeRoutes from './recharge.routes.js';
import pricingRoutes from './pricing.routes.js';
import pricingAdminRoutes from './pricingAdmin.routes.js';
import artStyleRoutes from './artstyle.routes.js';
import characterOptionRoutes from './characterOption.routes.js';
import jobRoutes from './job.routes.js';
import maintenanceRoutes from './maintenance.routes.js';
import logRoutes from './log.routes.js';
import assistantRoutes from './assistant.routes.js';
import publicRoutes from './public.routes.js';
import memberRoutes from './member.routes.js';
import showcaseRoutes from './showcase.routes.js';
import showcaseAdminRoutes from './showcaseAdmin.routes.js';
import marketRoutes from './market.routes.js';
import paymentAdminRoutes from './paymentAdmin.routes.js';
import userAdminRoutes from './userAdmin.routes.js';
import jobAdminRoutes from './jobAdmin.routes.js';
import videoGenAdminRoutes from './videoGenAdmin.routes.js';
import { rateLimit } from '../utils/rateLimit.js';
import { resolveUserByToken } from '../middleware/auth.js';
// 注：通用 OAuth2 与微信扫码登录已下线；账号体系为本地注册/登录（/auth/register|login，
// 账号密码 + 点选验证码）。/auth/oauth/* 仅剩 App 端第三方一键登录（Apple/Google）与本地
// 会话刷新。services/wechat 仍在用（微信支付）。

const router = Router();

// —— AI 生成入口限频：每用户 60s 内最多 AI_RATE_LIMIT_PER_MIN 次（env 可调，默认 30），超限 429 ——
// 只拦「会调 job.service.createJob 的用户侧 POST 端点」（白名单正则，键为登录用户 id）；
// admin 路由（/admin/*，含风格示例图/角色选项示例图的 admin AI 生成）与读取类 GET 一律不拦。
// 挂载点在本文件（各 AI 路由 router 前置）：鉴权在路由级 authRequired 完成，此处按令牌
// resolveUserByToken 取用户 id（本地 JWT 验签，开销可忽略）。
const AI_RATE_PER_MIN = Math.max(1, parseInt(process.env.AI_RATE_LIMIT_PER_MIN, 10) || 30);
const AI_JOB_POST_RE = new RegExp([
  '^/projects/[^/]+/script/(import|parse-js)$',
  '^/projects/[^/]+/(extract|characters/custom|cover/ai)$',
  '^/projects/[^/]+/episodes/[^/]+/extract$',
  '^/scripts/[^/]+/(outline|episodes/split)$',
  '^/scripts/[^/]+/episodes/[^/]+/detail$',
  '^/episodes/[^/]+/(generate-storyboard|compose)$',
  '^/episodes/[^/]+/segments/generate-video-batch(-concurrent)?$',
  '^/segments/[^/]+/(generate|generate-video|erase-subtitle|generate-prompt)$',
  '^/assets/[^/]+/(generate-image|generate-prompt)$',
  '^/assets/[^/]+/costumes/[^/]+/generate-image(-by-requirement)?$',
  '^/videos/[^/]+/(subtitle|subtitle/correct|subtitle/burn|edit)$',
].join('|'));
const aiJobUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AI_RATE_PER_MIN,
  keyFn: async (req) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return `ip:${req.ip}`; // 无令牌请求稍后会被 authRequired 拒绝，此处按 IP 兜底限频
    const user = await resolveUserByToken(token);
    if (!user) return `ip:${req.ip}`;
    if (user.role === 'admin') return null; // admin 豁免
    return `u:${user.id}`;
  },
  status: 429,
  message: `AI 生成请求过于频繁，请稍后再试（每分钟最多 ${AI_RATE_PER_MIN} 次）`,
});
const aiJobRateLimit = (req, res, next) => {
  if (req.method !== 'POST' || !AI_JOB_POST_RE.test(req.path)) return next();
  return aiJobUserLimiter(req, res, next);
};

router.use('/auth', authRoutes);
router.use('/admin/auth', adminAuthRoutes); // /admin/auth/login 管理台专属登录（公开，限频+验证码）
router.use('/captcha', captchaRoutes); // /captcha/challenge|verify 点选验证码（公开）
router.use('/', appRoutes); // /app/check-update 版本检查 + /client-log 客户端日志上报（均公开）

// AI 生成入口限频（见上方说明）：置于公开路由之后、业务/AI 路由之前
router.use(aiJobRateLimit);
router.use('/', artStyleRoutes);   // /art-styles
router.use('/', characterOptionRoutes); // /character-options, /projects/:id/characters/custom
router.use('/jobs', jobRoutes);    // /jobs
router.use('/assistant', assistantRoutes); // /assistant/chat（星网助理 SSE）
router.use('/projects', projectRoutes);
router.use('/', scriptRoutes);          // /projects/:id/script/*, /episodes/:eid
router.use('/', assetRoutes);            // /projects/:id/assets, /assets/:aid
router.use('/', storyboardRoutes);       // /episodes/:eid/segments, /segments/:sid
router.use('/', videoRoutes);            // /episodes/:eid/compose
router.use('/', memberRoutes);           // /projects/:id/members, /invitations, /users/lookup（团队共享）
router.use('/model-configs', modelConfigRoutes);
router.use('/model-vendors', modelVendorRoutes);
router.use('/voices', voiceRoutes);
router.use('/scripts', scriptDraftRoutes);
router.use('/credits', creditRoutes);
router.use('/recharge', rechargeRoutes);
router.use('/pricing', pricingRoutes);
router.use('/admin/pricing', pricingAdminRoutes); // /admin/pricing/* 功能定价 CRUD（admin）
router.use('/public', publicRoutes); // /public/share/:token 免登录分享数据
router.use('/admin/maintenance', maintenanceRoutes); // /admin/maintenance/* 服务器维护（admin）
router.use('/admin/logs', logRoutes); // /admin/logs/* AI 提交留档日志管理（admin）
router.use('/showcase', showcaseRoutes); // /showcase/* 展示中心（发布/浏览/观看）
router.use('/admin/showcase', showcaseAdminRoutes); // /admin/showcase/* 展示审核：列表/通过/驳回（admin）
router.use('/market', marketRoutes);     // /market/* 接单中心（任务单+托管+验收+仲裁）
router.use('/admin/payments', paymentAdminRoutes); // /admin/payments/* 支付管理：订单/流水/调整/档位/配置（admin）
router.use('/admin/users', userAdminRoutes);        // /admin/users/* 用户管理：列表/封禁/登录日志（admin）
router.use('/admin/jobs', jobAdminRoutes);          // /admin/jobs/* 任务管理：全员任务列表/取消/删除（admin）
router.use('/admin/video-generations', videoGenAdminRoutes); // /admin/video-generations/* 视频生成留档：列表/详情（admin）

export default router;
