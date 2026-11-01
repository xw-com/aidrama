import { Router } from 'express';
import { asyncHandler, ok } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { listJobs, getJob, cancelJob, cleanupJobs } from '../services/job.service.js';

const router = Router();

// 任务列表（支持 status / project_id 过滤；传 page/size 走分页）
router.get('/', authRequired, asyncHandler(async (req, res) => {
  // limit 非法值（非数字/负数）回落默认 50：NaN 透传给 Sequelize 的 limit 会直接 500
  const limitNum = Number(req.query.limit);
  const jobs = await listJobs(req.user.id, {
    status: req.query.status,
    projectId: req.query.project_id,
    limit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 50,
    page: req.query.page ? Number(req.query.page) : undefined,
    size: req.query.size ? Number(req.query.size) : undefined,
  });
  return ok(res, jobs);
}));

// 批量删除历史任务（仅 succeeded/failed；status: all|succeeded|failed，before: week|month|year）
router.post('/cleanup', authRequired, asyncHandler(async (req, res) => {
  const r = await cleanupJobs(req.user.id, { status: req.body?.status, before: req.body?.before });
  return ok(res, r, 'job.cleaned', { count: r.deleted });
}));

// 单个任务
router.get('/:id', authRequired, asyncHandler(async (req, res) => {
  const job = await getJob(req.user.id, req.params.id);
  return ok(res, job);
}));

// 取消任务（仅 pending）
router.post('/:id/cancel', authRequired, asyncHandler(async (req, res) => {
  const job = await cancelJob(req.user.id, req.params.id);
  return ok(res, job, 'job.cancelled');
}));

export default router;
