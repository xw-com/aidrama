// admin 视频生成留档（video_generations）：全员列表/详情，只读。
import { Router } from 'express';
import { asyncHandler, ok } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import { adminListVideoGenerations, adminGetVideoGeneration } from '../services/videoGenAdmin.service.js';

const router = Router();

// 全员视频生成留档列表（status / vendor / feature / user_id / keyword 匹配属主用户；page/size 分页）
router.get('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const data = await adminListVideoGenerations({
    status: req.query.status,
    vendor: req.query.vendor,
    feature: req.query.feature,
    userId: req.query.user_id,
    keyword: req.query.keyword,
    page: req.query.page,
    size: req.query.size,
  });
  return ok(res, data);
}));

// 留档详情（含大 JSON params/submit_response/result 与关联对象细节）
router.get('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  return ok(res, await adminGetVideoGeneration(req.params.id));
}));

export default router;
