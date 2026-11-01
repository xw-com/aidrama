// admin 展示审核：待审列表 / 通过 / 驳回（发布侧流程见 showcase.routes.js——发布与修改都进 pending）
import { Router } from 'express';
import { Op } from 'sequelize';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest, notFound } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import { mapPlayableEpisodeFilms } from '../services/filmSelect.service.js';
import { filterBySelection } from './showcase.routes.js';

const router = Router();
const { ShowcaseItem, Project, User } = db;

const PUBLISHER_ATTRS = ['id', 'username', 'nickname', 'avatar'];
// 与公开列表同口径：剧名/封面/画幅/风格实时取自项目
const PROJECT_ATTRS = ['id', 'name', 'cover', 'cover_thumb', 'aspect_ratio', 'style', 'narrative_type'];

// 审核列表（status 筛选：pending/approved/rejected，缺省=全部；q 搜剧名/简介；created_at 倒序）
router.get('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
  const where = {};
  if (req.query.status && ['pending', 'approved', 'rejected'].includes(req.query.status)) {
    where.status = req.query.status;
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    where[Op.or] = [
      { description: { [Op.like]: `%${q}%` } },
      { '$project.name$': { [Op.like]: `%${q}%` } },
    ];
  }
  const { rows, count } = await ShowcaseItem.findAndCountAll({
    where,
    include: [
      { model: Project, as: 'project', attributes: PROJECT_ATTRS, required: true },
      { model: User, as: 'publisher', attributes: PUBLISHER_ATTRS },
    ],
    order: [['created_at', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
    distinct: true,
  });
  const filmsByProject = await mapPlayableEpisodeFilms(rows.map((it) => it.project_id));
  const list = rows.map((it) => ({
    ...it.toJSON(),
    episode_count: filterBySelection(it, filmsByProject.get(it.project_id) || []).length,
  }));
  return ok(res, { list, total: count, page, size });
}));

// 审核：通过 / 驳回（驳回必填原因；pending 不在此设置——重新发布自然回到待审）
router.put('/:id/status', adminAuthRequired, asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) throw badRequest('admin.showcase.invalid_status');
  const reason = String(req.body.reason || '').trim().slice(0, 255) || null;
  if (status === 'rejected' && !reason) throw badRequest('admin.showcase.reason_required');
  const item = await ShowcaseItem.findByPk(req.params.id);
  if (!item) throw notFound('admin.showcase.not_found');
  item.status = status;
  item.reject_reason = status === 'rejected' ? reason : null;
  item.reviewed_at = new Date();
  item.reviewer_id = req.user.id;
  await item.save();
  return ok(res, { id: item.id, status: item.status }, status === 'approved' ? 'admin.showcase.approved' : 'admin.showcase.rejected');
}));

export default router;
