import { Router } from 'express';
import db from '../db/index.js';
import { asyncHandler, ok, notFound, ApiError } from '../utils/index.js';
import { listPlayableEpisodeFilms } from '../services/filmSelect.service.js';

// 公开（免登录）只读接口：分享播放页 /share/:token 的数据出口。
// 注意：本文件任何路由都不挂 authRequired/authOptional；必须严格字段白名单，绝不透出 user_id/raw_script 等私有数据。
const router = Router();

// 分享数据：按令牌取剧信息 + 可播分集（无可播分集返回 200 + 空数组，由前端渲染专属错误态，避免拦截器弹 toast）
router.get('/share/:token', asyncHandler(async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) throw notFound('share.not_found'); // 先正则拦截，避免脏值进 DB

  const project = await db.Project.findOne({
    where: { share_token: token },
    attributes: ['id', 'name', 'cover', 'aspect_ratio', 'share_issued_at'],
  });
  if (!project) throw notFound('share.not_found');

  // 分享链接 24 小时有效（与签发处共用 Project.SHARE_TTL_MS）；410 Gone 让播放页展示专属「已过期」错误态
  const issuedAt = project.share_issued_at ? new Date(project.share_issued_at).getTime() : 0;
  if (!issuedAt || issuedAt + db.Project.SHARE_TTL_MS <= Date.now()) {
    throw new ApiError(410, 'share.expired');
  }

  // 可播分集选版逻辑已抽到 filmSelect.service.js（展示中心/接单交付复用同一口径）
  const episodes = await listPlayableEpisodeFilms(project.id);

  return ok(res, { ...project.toJSON(), episode_count: episodes.length, episodes });
}));

export default router;
