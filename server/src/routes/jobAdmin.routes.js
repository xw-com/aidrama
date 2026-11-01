// admin 任务管理：全员任务列表/详情 / 取消（可强制）/ 单条删除 / 批量清理终态记录
import { Router } from 'express';
import { asyncHandler, ok } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import {
  adminListJobs, adminGetJob, adminDeleteJob, adminCleanupJobs, cancelJob,
} from '../services/job.service.js';

const router = Router();

// 全员任务列表（status 可逗号多值 / type / user_id / keyword 匹配属主用户；page/size 分页）
router.get('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const data = await adminListJobs({
    status: req.query.status,
    type: req.query.type,
    userId: req.query.user_id,
    keyword: req.query.keyword,
    page: req.query.page,
    size: req.query.size,
  });
  return ok(res, data);
}));

// 批量清理终态任务记录（先于 /:id 定义；可选 user_id 收窄范围）
router.post('/cleanup', adminAuthRequired, asyncHandler(async (req, res) => {
  const r = await adminCleanupJobs({
    status: req.body?.status,
    before: req.body?.before,
    userId: req.body?.user_id,
  });
  return ok(res, r, 'job.cleaned', { count: r.deleted });
}));

// 任务详情（含属主信息与 result/meta）
router.get('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  return ok(res, await adminGetJob(req.params.id));
}));

// 取消任务（admin：pending 撤队；running 绕过 10 分钟强制取消，退款给属主）
router.post('/:id/cancel', adminAuthRequired, asyncHandler(async (req, res) => {
  const job = await cancelJob(req.user.id, req.params.id, { admin: true });
  return ok(res, job, 'job.cancelled');
}));

// 删除单条终态任务记录
router.delete('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const r = await adminDeleteJob(req.params.id);
  return ok(res, r, 'job.admin_deleted', { id: r.id });
}));

export default router;
