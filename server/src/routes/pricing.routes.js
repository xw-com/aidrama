import { Router } from 'express';
import { asyncHandler, ok } from '../utils/index.js';
import { authOptional } from '../middleware/auth.js';
import { listPricing } from '../services/pricing.service.js';

const router = Router();

// 定价表（登录后可见，便于前端展示各功能积分）
router.get('/', authOptional, asyncHandler(async (req, res) => {
  const rows = await listPricing();
  return ok(res, rows);
}));

export default router;
