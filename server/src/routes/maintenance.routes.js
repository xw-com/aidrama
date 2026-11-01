import { Router } from 'express';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import {
  getMaintenanceState,
  enableMaintenance,
  disableMaintenance,
  listActiveJobs,
} from '../services/maintenance.service.js';

const router = Router();

// 当前维护状态（admin 维护页展示）
router.get('/status', adminAuthRequired, (req, res) => {
  return ok(res, getMaintenanceState());
});

// 开启维护（重复调用 = 覆盖状态，幂等）
router.post('/start', adminAuthRequired, asyncHandler(async (req, res) => {
  const { reason, expectedEndAt } = req.body || {};
  let endAt = null;
  if (expectedEndAt != null && expectedEndAt !== '') {
    const d = new Date(expectedEndAt);
    if (Number.isNaN(d.getTime())) throw badRequest('maintenance.invalid_expected_end');
    endAt = d.toISOString();
  }
  const state = enableMaintenance({ reason, expectedEndAt: endAt, startedBy: req.user });
  return ok(res, state, 'maintenance.started');
}));

// 结束维护
router.post('/stop', adminAuthRequired, (req, res) => {
  return ok(res, disableMaintenance(), 'maintenance.stopped');
});

// 处理中任务列表（admin 判断何时排空可重启）
router.get('/tasks', adminAuthRequired, asyncHandler(async (req, res) => {
  return ok(res, await listActiveJobs());
}));

export default router;
