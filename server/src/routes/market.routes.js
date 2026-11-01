import { Router } from 'express';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest, forbidden, notFound, ApiError } from '../utils/index.js';
import { authRequired, requireAdmin } from '../middleware/auth.js';
import { loadOwnerProject } from '../utils/ownership.js';
import { consumeCredits } from '../services/credits.service.js';
import { roundCredits } from '../utils/credits.js';
import { assertBalance } from '../services/pricing.service.js';
import { isMaintenanceActive, getMaintenanceState } from '../services/maintenance.service.js';
import { listPlayableEpisodeFilms, mapPlayableEpisodeFilms } from '../services/filmSelect.service.js';
import { MARKET_FEATURE, marketRef, settleToWorker, refundDeposit } from '../services/market.service.js';

// 接单中心：任意用户发布任务单（需求+时长+每秒价格+分辨率，总价=时长×单价），发布时平台托管
// 总价作为保证金；其他用户接单开发 → 平台项目成片中选片交付 → 发布方验收（驳回可重交），
// 僵持走 admin 仲裁。相对独立的新模块：新表 task_orders/order_events，资金复用积分体系，
// 不改任何既有表；交付物选版复用 filmSelect.service（与批量下载/展示中心同口径）。
//
// 状态机：open（待接单）→ take → working（开发中）→ deliver → delivered（待验收）
//   delivered --reject--> working（修改重交，可循环）
//   delivered --accept--> completed（托管结算给接单方）
//   working/delivered --dispute--> disputed（仲裁中）--arbitrate--> completed|cancelled
//   open --cancel(publisher)--> cancelled（退款）；working --quit(worker)--> open（换人接）
const router = Router();
const { TaskOrder, OrderEvent, User, Project } = db;
const Op = db.Sequelize.Op;

const USER_ATTRS = ['id', 'username', 'nickname', 'avatar'];
const RESOLUTIONS = ['720p', '1080p', '4k'];
const ASPECTS = ['16:9', '9:16', '1:1'];
const STATUSES = ['open', 'working', 'delivered', 'disputed', 'completed', 'cancelled'];
const ORDER_INCLUDE = [
  { model: User, as: 'publisher', attributes: USER_ATTRS },
  { model: User, as: 'worker', attributes: USER_ATTRS },
];

// 原子状态认领：仅当仍处于 expect 状态时套用 patch（并发双接/双验收兜底），返回是否成功
function claim(orderId, expect, patch) {
  const where = Array.isArray(expect)
    ? { id: orderId, status: { [Op.in]: expect } }
    : { id: orderId, status: expect };
  return TaskOrder.update(patch, { where }).then(([n]) => n > 0);
}

async function logEvent(orderId, actorId, type, content = null, payload = null) {
  await OrderEvent.create({ order_id: orderId, actor_id: actorId, type, content, payload });
}

async function loadOrder(id) {
  const order = await TaskOrder.findByPk(id, { include: ORDER_INCLUDE });
  if (!order) throw notFound('market.not_found');
  return order;
}

// 订单列表（分页；q 搜标题；status 可为单值或 active=进行中集合；role=published/taken 只看我相关的）
router.get('/orders', authRequired, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const size = Math.min(50, Math.max(1, parseInt(req.query.size || '10', 10)));
  const where = {};
  const q = String(req.query.q || '').trim();
  if (q) where.title = { [Op.like]: `%${q}%` };
  const st = String(req.query.status || '').trim();
  if (st === 'active') where.status = { [Op.in]: ['open', 'working', 'delivered', 'disputed'] };
  else if (STATUSES.includes(st)) where.status = st;
  const role = String(req.query.role || '').trim();
  if (role === 'published') where.publisher_id = req.user.id;
  else if (role === 'taken') where.worker_id = req.user.id;

  const { rows, count } = await TaskOrder.findAndCountAll({
    where,
    include: ORDER_INCLUDE,
    order: [['created_at', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
    distinct: true,
  });
  return ok(res, { list: rows, total: count, page, size });
}));

// 发布任务单：服务端算总价 → 校验余额 → 建单 → 托管扣款（失败撤销订单行）→ 落发布事件
router.post('/orders', authRequired, asyncHandler(async (req, res) => {
  // 维护期拦截（响应形状与 createJob 一致，前端有专门提示）：发布涉及资金托管，维护期暂停
  if (isMaintenanceActive() && req.user.role !== 'admin') {
    const st = getMaintenanceState();
    throw new ApiError(503, 'maintenance.active', {
      maintenance: true, reason: st.reason || '',
      expectedEndAt: st.expectedEndAt || null, startedAt: st.startedAt,
    });
  }

  const title = String(req.body.title || '').trim();
  const requirement = String(req.body.requirement || '').trim();
  const duration = parseInt(req.body.duration_seconds, 10);
  const price = roundCredits(Number(req.body.price_per_second)); // 积分一位小数：单价支持 0.1 精度
  const resolution = String(req.body.resolution || '1080p').trim().toLowerCase();
  const aspect = req.body.aspect_ratio ? String(req.body.aspect_ratio).trim() : null;

  if (!title || title.length > 100) throw badRequest('market.title_invalid');
  if (!requirement || requirement.length > 5000) throw badRequest('market.requirement_invalid');
  if (!Number.isInteger(duration) || duration < 1 || duration > 7200) throw badRequest('market.duration_invalid');
  if (!Number.isFinite(Number(req.body.price_per_second)) || price < 0.1 || price > 100000) throw badRequest('market.price_invalid');
  if (!RESOLUTIONS.includes(resolution)) throw badRequest('market.resolution_invalid');
  if (aspect && !ASPECTS.includes(aspect)) throw badRequest('market.aspect_invalid');

  // 总价一律服务端计算（不信任客户端），发布时一次性托管
  const total = roundCredits(duration * price);
  await assertBalance(req.user, total);

  const order = await TaskOrder.create({
    publisher_id: req.user.id, title, requirement,
    duration_seconds: duration, price_per_second: price, total_price: total,
    resolution, aspect_ratio: aspect, status: 'open',
  });
  try {
    await consumeCredits(req.user.id, total, {
      feature: MARKET_FEATURE,
      refId: marketRef(order.id, 'deposit'),
      remark: `发布订单托管：「${title}」${duration}秒 × ${price}积分/秒`,
    });
  } catch (e) {
    await order.destroy(); // 尚未产生事件/资金记录，直接撤销订单行
    if (e?.name === 'InsufficientCreditsError') {
      throw new ApiError(402, 'common.insufficient_credits', e.details);
    }
    throw e;
  }
  await logEvent(order.id, req.user.id, 'publish', null, {
    total_price: total, duration_seconds: duration,
    price_per_second: price, resolution, aspect_ratio: aspect,
  });
  return ok(res, await loadOrder(order.id), 'market.created');
}));

// 我可交付的成片：名下项目 × 每集当前成片（选版同批量下载口径），交付弹窗数据源
router.get('/my-deliverables', authRequired, asyncHandler(async (req, res) => {
  const projects = await Project.findAll({
    where: { user_id: req.user.id },
    attributes: ['id', 'name', 'cover', 'aspect_ratio'],
    order: [['updated_at', 'DESC']],
  });
  const list = [];
  for (const p of projects) {
    const episodes = await listPlayableEpisodeFilms(p.id);
    if (episodes.length) list.push({ ...p.toJSON(), episodes });
  }
  return ok(res, list);
}));

// 订单详情：订单 + 事件时间线（附操作人公开信息）。
// 大厅浏览可看（接单前评估的必经页面），但 take/deliver 事件的 payload（接单方作品快照、
// 交付成片 video_url/项目分集信息）仅订单双方与 admin 可见——其余人脱敏，杜绝越权读交付物
router.get('/orders/:id', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  const isParty = order.publisher_id === req.user.id || order.worker_id === req.user.id;
  const events = await OrderEvent.findAll({ where: { order_id: order.id }, order: [['id', 'ASC']] });
  const actorIds = [...new Set(events.map((e) => e.actor_id).filter(Boolean))];
  const users = actorIds.length
    ? await User.findAll({ where: { id: actorIds }, attributes: USER_ATTRS })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const SENSITIVE_TYPES = ['take', 'deliver'];
  return ok(res, {
    order,
    events: events.map((e) => ({
      ...e.toJSON(),
      payload: !isParty && req.user.role !== 'admin' && SENSITIVE_TYPES.includes(e.type) ? null : e.payload,
      actor: userMap.get(e.actor_id) || null,
    })),
  });
}));

// 接单（open 原子认领，防并发双接；不能接自己的单）
// 门槛：接单者名下必须有本站作品（至少一个项目有可播成片，与交付/批量下载同口径）；
// 可附带自己的作品（多选项目，上限 5）供发布方评估，成片快照入 take 事件 payload
router.post('/orders/:id/take', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.publisher_id === req.user.id) throw badRequest('market.cannot_take_own');
  if (order.status !== 'open') throw badRequest('market.not_open');

  // 作品门槛（认领前校验）：批量算当前空间名下项目可播成片，避免逐项目 N+1
  const myProjects = await Project.findAll({
    where: { user_id: req.user.id },
    attributes: ['id'],
  });
  const myFilms = await mapPlayableEpisodeFilms(myProjects.map((p) => p.id));
  if (![...myFilms.values()].some((eps) => eps.length)) throw badRequest('market.no_works');

  // 附带作品（可选）：校验归属后快照每项目当前可播分集成片，之后源项目重新生成不影响评估依据
  const rawWorks = Array.isArray(req.body.works) ? req.body.works.slice(0, 5) : [];
  const wantIds = [...new Set(rawWorks.map((w) => parseInt(w?.project_id, 10)).filter(Number.isFinite))];
  let works = [];
  if (wantIds.length) {
    const owned = await Project.findAll({
      where: { id: { [Op.in]: wantIds }, user_id: req.user.id },
      attributes: ['id', 'name', 'cover', 'aspect_ratio'],
    });
    if (owned.length !== wantIds.length) throw badRequest('market.work_invalid');
    const filmMap = await mapPlayableEpisodeFilms(owned.map((p) => p.id));
    works = owned
      .map((p) => ({
        project_id: p.id, project_name: p.name, cover: p.cover,
        aspect_ratio: p.aspect_ratio, episodes: filmMap.get(p.id) || [],
      }))
      .filter((w) => w.episodes.length); // 无可播成片的项目（如刚清空）不附带
  }

  if (!(await claim(order.id, 'open', { status: 'working', worker_id: req.user.id }))) {
    throw badRequest('market.already_taken');
  }
  await logEvent(order.id, req.user.id, 'take', null, { works });
  return ok(res, await loadOrder(order.id), 'market.taken');
}));

// 取消（仅发布方，仅 open；托管全款退回）
router.post('/orders/:id/cancel', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.publisher_id !== req.user.id) throw forbidden('market.not_publisher');
  if (order.status !== 'open') throw badRequest('market.cancel_only_open');
  if (!(await claim(order.id, 'open', { status: 'cancelled', cancelled_at: new Date() }))) {
    throw badRequest('market.cancel_only_open');
  }
  try {
    await refundDeposit(order);
  } catch (e) {
    await claim(order.id, 'cancelled', { status: 'open', cancelled_at: null }); // 退款失败回滚，可重试
    throw e;
  }
  await logEvent(order.id, req.user.id, 'cancel', String(req.body.reason || '').trim().slice(0, 500) || null);
  return ok(res, await loadOrder(order.id), 'market.cancelled');
}));

// 放弃接单（仅接单方，仅 working；订单回到 open 换人接，托管不动）
router.post('/orders/:id/quit', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.worker_id !== req.user.id) throw forbidden('market.not_worker');
  if (order.status !== 'working') throw badRequest('market.not_working');
  if (!(await claim(order.id, 'working', { status: 'open', worker_id: null, delivered_at: null }))) {
    throw badRequest('market.not_working');
  }
  await logEvent(order.id, req.user.id, 'quit', String(req.body.reason || '').trim().slice(0, 500) || null);
  return ok(res, await loadOrder(order.id), 'market.quit');
}));

// 交付（仅接单方；从自己项目成片中选一集，选版同批量下载口径）
router.post('/orders/:id/deliver', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.worker_id !== req.user.id) throw forbidden('market.not_worker');
  if (order.status !== 'working') throw badRequest('market.not_working');

  const projectId = parseInt(req.body.project_id, 10);
  const episodeId = parseInt(req.body.episode_id, 10);
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  const project = await loadOwnerProject(req.user.id, projectId); // 必须是接单方自己的项目
  const films = await listPlayableEpisodeFilms(project.id);
  const film = films.find((f) => f.id === episodeId && f.video_url);
  if (!film) throw badRequest('market.no_film');

  if (!(await claim(order.id, 'working', { status: 'delivered', delivered_at: new Date() }))) {
    throw badRequest('market.not_working');
  }
  // 成片快照入事件（之后源项目重新生成不影响本次交付的验收依据）
  await logEvent(order.id, req.user.id, 'deliver', note, {
    video_url: film.video_url,
    duration: film.duration,
    project_id: project.id,
    project_name: project.name,
    episode_id: film.id,
    episode_idx: film.idx,
    episode_title: film.title,
  });
  return ok(res, await loadOrder(order.id), 'market.delivered');
}));

// 驳回（仅发布方，仅 delivered；须附意见，接单方修改后重新交付）
router.post('/orders/:id/reject', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.publisher_id !== req.user.id) throw forbidden('market.not_publisher');
  if (order.status !== 'delivered') throw badRequest('market.not_delivered');
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!reason) throw badRequest('market.reject_reason_required');
  if (!(await claim(order.id, 'delivered', { status: 'working' }))) {
    throw badRequest('market.not_delivered');
  }
  await logEvent(order.id, req.user.id, 'reject', reason);
  return ok(res, await loadOrder(order.id), 'market.rejected');
}));

// 验收通过（仅发布方，仅 delivered；托管结算给接单方）
router.post('/orders/:id/accept', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.publisher_id !== req.user.id) throw forbidden('market.not_publisher');
  if (order.status !== 'delivered') throw badRequest('market.not_delivered');
  if (!(await claim(order.id, 'delivered', { status: 'completed', completed_at: new Date() }))) {
    throw badRequest('market.not_delivered');
  }
  try {
    await settleToWorker(order);
  } catch (e) {
    await claim(order.id, 'completed', { status: 'delivered', completed_at: null }); // 结算失败回滚，可重试
    throw e;
  }
  await logEvent(order.id, req.user.id, 'accept');
  return ok(res, await loadOrder(order.id), 'market.completed');
}));

// 申请仲裁（发布方或接单方，working/delivered 状态；须说明争议点）
router.post('/orders/:id/dispute', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  const isParty = order.publisher_id === req.user.id || order.worker_id === req.user.id;
  if (!isParty) throw forbidden('market.not_party');
  if (!['working', 'delivered'].includes(order.status)) throw badRequest('market.cannot_dispute');
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!reason) throw badRequest('market.dispute_reason_required');
  if (!(await claim(order.id, ['working', 'delivered'], { status: 'disputed' }))) {
    throw badRequest('market.cannot_dispute');
  }
  await logEvent(order.id, req.user.id, 'dispute', reason);
  return ok(res, await loadOrder(order.id), 'market.disputed');
}));

// 仲裁（admin，仅 disputed）：release=放款给接单方（completed）/ refund=退回发布方（cancelled）
router.post('/orders/:id/arbitrate', authRequired, requireAdmin, asyncHandler(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.status !== 'disputed') throw badRequest('market.not_disputed');
  const decision = String(req.body.decision || '').trim();
  const note = String(req.body.note || '').trim().slice(0, 1000) || null;
  if (!['release', 'refund'].includes(decision)) throw badRequest('market.arbitration_invalid');

  const now = new Date();
  const patch = decision === 'release'
    ? { status: 'completed', completed_at: now, meta: { ...(order.meta || {}), arbitrated: 'release' } }
    : { status: 'cancelled', cancelled_at: now, meta: { ...(order.meta || {}), arbitrated: 'refund' } };
  if (!(await claim(order.id, 'disputed', patch))) throw badRequest('market.not_disputed');
  try {
    if (decision === 'release') await settleToWorker(order);
    else await refundDeposit(order);
  } catch (e) {
    await claim(order.id, patch.status, decision === 'release'
      ? { status: 'disputed', completed_at: null, meta: order.meta }
      : { status: 'disputed', cancelled_at: null, meta: order.meta }); // 资金操作失败回滚，可重试
    throw e;
  }
  await logEvent(order.id, req.user.id, 'arbitrate', note, { decision });
  return ok(res, await loadOrder(order.id), 'market.arbitrated');
}));

export default router;
