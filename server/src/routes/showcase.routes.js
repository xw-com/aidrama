import { Router } from 'express';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest, forbidden, notFound, unauthorized } from '../utils/index.js';
import { authRequired, authOptional } from '../middleware/auth.js';
import { loadOwnerProject } from '../utils/ownership.js';
import { listPlayableEpisodeFilms, mapPlayableEpisodeFilms } from '../services/filmSelect.service.js';

// 展示中心：制作完成的项目一键发布，全站用户浏览/观看。
// 相对独立的新模块——只读 projects/users（实时取剧名/封面/画幅），不改任何既有表；
// 可播分集用 filmSelect.service（与工作台展示/批量下载/分享同口径）。
const router = Router();
const { ShowcaseItem, Project, User } = db;
const Op = db.Sequelize.Op;

const PUBLISHER_ATTRS = ['id', 'username', 'nickname', 'avatar'];
// style/narrative_type 一并下发：展示中心卡片/详情展示「视觉风格 + 叙事类型」（前端解析显示名）
const PROJECT_ATTRS = ['id', 'name', 'cover', 'cover_thumb', 'aspect_ratio', 'style', 'narrative_type'];

/** 按发布时勾选的分集快照过滤可播分集；episode_ids 为 null（存量记录）= 全部可播分集 */
export function filterBySelection(item, films) {
  const ids = Array.isArray(item.episode_ids) ? item.episode_ids.map(Number).filter(Number.isFinite) : null;
  if (!ids || !ids.length) return films;
  const set = new Set(ids);
  const out = films.filter((f) => set.has(f.id));
  return out;
}

// 懒清理：源项目已被删除的孤儿展示记录（项目删除不级联到展示中心）。
// 最早在每次列表请求同步执行（两条全表查询），现改为至多每小时一次的后台触发，
// 不再挂在读路径上；孤儿记录在读到时由下方 include required/left join 自然过滤 + 详情页自清
let lastPurgeAt = 0;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
function purgeOrphanItemsThrottled() {
  if (Date.now() - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = Date.now();
  purgeOrphanItems().catch(() => {});
}
async function purgeOrphanItems() {
  const ids = (await ShowcaseItem.findAll({ attributes: ['project_id'] })).map((i) => i.project_id);
  if (!ids.length) return;
  const existing = (await Project.findAll({ where: { id: ids }, attributes: ['id'] })).map((p) => p.id);
  const orphans = [...new Set(ids)].filter((id) => !existing.includes(id));
  if (orphans.length) await ShowcaseItem.destroy({ where: { project_id: orphans } });
}

// 展示列表（分页 + 关键词搜剧名/简介 + 按视觉风格/叙事类型筛选；按流量倒序，并列取新的在前；mine=1 只看我发布的）。
// authOptional：浏览免登录（展示中心即站点首页）；mine=1 需要登录态。
// 公开列表只出审核通过（approved）的记录；mine 看自己全部状态（审核中/被驳回也要能看见）
router.get('/', authOptional, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const size = Math.min(48, Math.max(1, parseInt(req.query.size || '8', 10)));
  const where = {};
  if (req.query.mine === '1' || req.query.mine === 'true') {
    if (!req.user) throw unauthorized('auth.login_required');
    where.user_id = req.user.id;
  } else {
    where.status = 'approved';
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    where[Op.or] = [
      { description: { [Op.like]: `%${q}%` } },
      { '$project.name$': { [Op.like]: `%${q}%` } },
    ];
  }
  // 分类筛选：视觉风格/叙事类型（跟项目实时字段走，与卡片展示同源）
  if (req.query.style) where['$project.style$'] = String(req.query.style);
  if (req.query.narrative_type) where['$project.narrative_type$'] = String(req.query.narrative_type);

  purgeOrphanItemsThrottled();

  const { rows, count } = await ShowcaseItem.findAndCountAll({
    where,
    include: [
      { model: Project, as: 'project', attributes: PROJECT_ATTRS, required: true },
      { model: User, as: 'publisher', attributes: PUBLISHER_ATTRS },
    ],
    order: [['view_count', 'DESC'], ['created_at', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
    distinct: true,
  });

  // 每条算当前可播分集数（按发布勾选过滤；分集无视频的记录仍展示，详情页有空态）。
  // 批量选版：一页 2 条查询取代此前每行 2 条（size=48 时 96 条 N+1）
  const filmsByProject = await mapPlayableEpisodeFilms(rows.map((it) => it.project_id));
  const list = rows.map((it) => ({
    ...it.toJSON(),
    episode_count: filterBySelection(it, filmsByProject.get(it.project_id) || []).length,
  }));
  return ok(res, { list, total: count, page, size });
}));

// 项目展示状态（工作台按钮态用：未发布/已发布（含简介与勾选分集，弹窗回填用）+ 审核状态/驳回原因）
router.get('/status', authRequired, asyncHandler(async (req, res) => {
  const projectId = parseInt(req.query.project_id, 10);
  // 归属校验：展示简介/审核状态/驳回原因仅项目 owner 可见（枚举他人 project_id 探 unpublished 内容属越权读）
  if (Number.isFinite(projectId)) await loadOwnerProject(req.user.id, projectId);
  const item = Number.isFinite(projectId)
    ? await ShowcaseItem.findOne({ where: { project_id: projectId } })
    : null;
  return ok(res, item
    ? {
      id: item.id,
      description: item.description,
      episode_ids: item.episode_ids || null,
      status: item.status,
      reject_reason: item.reject_reason || null,
    }
    : { id: null });
}));

// 一键发布（仅项目 owner；须至少一集可播成片，与一键分享同门槛）。
// episode_ids：发布时勾选的分集 id 数组（快照语义——之后再生成的新分集不会自动出现，重新发布可选入）；
// 缺省/null = 全部可播分集（存量记录语义）。幂等：重复发布=更新简介与勾选。
// 发布/每次修改都进审核：status 置回 pending 并清空上次审核痕迹，通过后才在公开列表/详情可见
router.post('/publish', authRequired, asyncHandler(async (req, res) => {
  const projectId = parseInt(req.body.project_id, 10);
  const description = String(req.body.description || '').trim().slice(0, 500) || null;
  const project = await loadOwnerProject(req.user.id, projectId);
  const films = await listPlayableEpisodeFilms(project.id);
  if (!films.length) throw badRequest('showcase.no_videos');

  // 勾选校验：只认当前可播分集；数组型入参去重后不得为空
  const playableIds = new Set(films.map((f) => f.id));
  let episodeIds = null;
  if (Array.isArray(req.body.episode_ids)) {
    episodeIds = [...new Set(req.body.episode_ids.map((v) => parseInt(v, 10)))]
      .filter((v) => Number.isFinite(v) && playableIds.has(v));
    if (!episodeIds.length) throw badRequest('showcase.no_selection');
  }

  const [item] = await ShowcaseItem.findOrCreate({
    where: { project_id: project.id },
    defaults: {
      user_id: req.user.id, description, episode_ids: episodeIds,
      status: 'pending', reject_reason: null, reviewed_at: null, reviewer_id: null,
    },
  });
  // 幂等更新：内容没变也要重新排队审核（审核口径以提交时点为准）
  await item.update({
    description, episode_ids: episodeIds,
    status: 'pending', reject_reason: null, reviewed_at: null, reviewer_id: null,
  });
  return ok(res, { id: item.id, status: item.status }, 'showcase.submitted');
}));

// 展示详情：项目实时信息 + 可播分集成片（选版同批量下载口径）；浏览量尽力 +1。
// authOptional：观看免登录（视频 URL 出口与公开分享页同口径）
router.get('/:id', authOptional, asyncHandler(async (req, res) => {
  const item = await ShowcaseItem.findByPk(req.params.id, {
    include: [
      { model: Project, as: 'project', attributes: PROJECT_ATTRS },
      { model: User, as: 'publisher', attributes: PUBLISHER_ATTRS },
    ],
  });
  if (!item) throw notFound('showcase.not_found');
  if (!item.project) { // 源项目已删：清掉孤儿记录
    await item.destroy();
    throw notFound('showcase.not_found');
  }
  // 审核门槛：未通过的记录对外不可见（404 同 not_found，不泄露存在性）；发布者本人/admin 可看
  const isOwner = req.user && req.user.id === item.user_id;
  if (item.status !== 'approved' && !isOwner && req.user?.role !== 'admin') {
    throw notFound('showcase.not_found');
  }
  ShowcaseItem.increment('view_count', { by: 1, where: { id: item.id } }).catch(() => {});
  // 播放列表按发布勾选过滤（勾选的分集后来失效——如成片被删——自然被可播口径滤掉）
  const episodes = filterBySelection(item, await listPlayableEpisodeFilms(item.project_id));
  return ok(res, { ...item.toJSON(), episodes, episode_count: episodes.length });
}));

// 下架（发布者本人或 admin——管理员有全站展示项目的下架权）
router.delete('/:id', authRequired, asyncHandler(async (req, res) => {
  const item = await ShowcaseItem.findByPk(req.params.id);
  if (!item) throw notFound('showcase.not_found');
  if (item.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden('showcase.not_owner');
  await item.destroy();
  return ok(res, null, 'showcase.removed');
}));

export default router;
