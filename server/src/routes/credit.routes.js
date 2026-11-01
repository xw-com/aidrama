import { Router } from 'express';
import db from '../db/index.js';
import { asyncHandler, ok } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
const { User, CreditTransaction } = db;

// 余额（下发时保留一位小数，与 credits 列精度一致）
router.get('/balance', authRequired, asyncHandler(async (req, res) => {
  await req.user.reload({ attributes: ['credits'] });
  return ok(res, { credits: Math.round(req.user.credits * 10) / 10 });
}));

// 流水
router.get('/transactions', authRequired, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const size = Math.min(100, Math.max(1, parseInt(req.query.size || '20', 10)));
  const { rows, count } = await CreditTransaction.findAndCountAll({
    where: { user_id: req.user.id },
    order: [['id', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
  });
  return ok(res, { list: rows, total: count, page, size });
}));

export default router;
