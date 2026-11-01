// admin 支付管理：充值订单 / 全量积分流水 / 积分人工调整 / 充值档位+汇率 / 支付配置（脱敏只读） / 原路退款
import { Router } from 'express';
import { Op } from 'sequelize';
import db from '../db/index.js';
import { config } from '../config/index.js';
import { asyncHandler, ok, badRequest, notFound, ApiError } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import { adjustCredits } from '../services/credits.service.js';
import { roundCredits } from '../utils/credits.js';
import { getYuanPerCredit, getPackages, saveRechargeConfig } from '../services/rechargeConfig.service.js';
import { createRefund, queryRefund } from '../services/wechat/pay.service.js';
import {
  PaymentRefund, ensureRefundSchema, mapWxRefundStatus,
  setOrderRefundMark, getOrderRefundMark, listRefundsByOrderNos,
} from '../services/wechat/refund.service.js';
import { getPlatformCertStatus } from '../services/wechat/platformCert.service.js';

const router = Router();
const { RechargeOrder, CreditTransaction, User } = db;

const USER_INCLUDE = { model: User, as: 'user', attributes: ['id', 'username', 'nickname'] };

const maskSecret = (v) => (v ? `${String(v).slice(0, 4)}****${String(v).slice(-4)}` : null);

// 起止日期（YYYY-MM-DD）→ created_at 范围条件
function dateRange({ start, end }) {
  if (!start && !end) return undefined;
  const range = {};
  if (start) range[Op.gte] = new Date(`${start}T00:00:00`);
  if (end) range[Op.lte] = new Date(`${end}T23:59:59.999`);
  return range;
}

function paging(query) {
  return {
    page: Math.max(1, parseInt(query.page, 10) || 1),
    size: Math.min(100, Math.max(1, parseInt(query.size, 10) || 20)),
  };
}

// 充值订单列表（状态/单号或微信交易号关键词/日期筛选）
router.get('/orders', adminAuthRequired, asyncHandler(async (req, res) => {
  const { page, size } = paging(req.query);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.keyword) {
    const kw = String(req.query.keyword).trim();
    where[Op.or] = [
      { order_no: { [Op.like]: `%${kw}%` } },
      { transaction_id: { [Op.like]: `%${kw}%` } },
    ];
  }
  const created = dateRange(req.query);
  if (created) where.created_at = created;
  const { rows, count } = await RechargeOrder.findAndCountAll({
    where, include: [USER_INCLUDE], order: [['id', 'DESC']], offset: (page - 1) * size, limit: size,
  });
  // 附加退款流水（受理中/成功/失败全程），admin 列表一眼可见退款状态；退款表未就绪不影响订单列表
  let list = rows;
  try {
    await ensureRefundSchema();
    const refunds = await listRefundsByOrderNos(rows.map((r) => r.order_no));
    const byNo = new Map();
    for (const rf of refunds) {
      if (!byNo.has(rf.order_no)) byNo.set(rf.order_no, []);
      byNo.get(rf.order_no).push(rf);
    }
    list = rows.map((r) => ({ ...r.toJSON(), refunds: byNo.get(r.order_no) || [] }));
  } catch { /* 退款表/补列失败：列表退化为不带退款信息 */ }
  return ok(res, { list, total: count, page, size });
}));

// ===== 原路退款（微信 V3 /v3/refund/domestic/refunds）=====

const paidFenOf = (order) => Math.round(Number(order.amount_yuan) * 100);

// 发起原路退款：body { amount?: 元（可选部分退款，缺省全额）, reason? }。
// 服务端校验：订单必须已 paid、金额 ≤ 实付；同单已有受理中/成功退款即拒绝（out_refund_no 唯一约束兜底并发）。
// 注意：退款只退钱，不自动扣回已入账积分（积分不足不该卡死资金退款）——需追回积分走 /adjust 人工扣减。
router.post('/orders/:orderNo/refund', adminAuthRequired, asyncHandler(async (req, res) => {
  if (!config.wechat.pay.enabled) throw badRequest('微信支付未启用，无法退款');
  await ensureRefundSchema();
  const order = await RechargeOrder.findOne({ where: { order_no: String(req.params.orderNo || '').trim() } });
  if (!order) throw notFound('订单不存在');
  if (order.status !== 'paid') throw badRequest(`仅已支付订单可退款（当前状态：${order.status}）`);
  if (order.pay_method !== 'wechat') throw badRequest('仅微信支付订单支持原路退款');
  const paidFen = paidFenOf(order);
  let refundFen = paidFen; // 缺省全额退款
  if (req.body?.amount != null) {
    const yuan = Number(req.body.amount);
    if (!Number.isFinite(yuan) || yuan <= 0) throw badRequest('退款金额无效');
    refundFen = Math.round(yuan * 100);
    if (refundFen < 1) throw badRequest('退款金额至少 0.01 元');
    if (refundFen > paidFen) throw badRequest(`退款金额（${yuan} 元）超过实付金额（${(paidFen / 100).toFixed(2)} 元）`);
  }
  const outRefundNo = `rf_${order.order_no}`;
  const reason = String(req.body?.reason || '').trim().slice(0, 80) || 'admin 后台退款';

  // 幂等预检 + 并发锚点：同单已有受理中/成功的退款 → 拒绝重复退款（failed/closed/abnormal 可重试，
  // 复用同一 out_refund_no 更新，微信侧同号重提幂等）。唯一约束兜底双开并发：撞约束按「已有退款」拒绝。
  let refundRow = await PaymentRefund.findOne({ where: { out_refund_no: outRefundNo } });
  if (refundRow && ['processing', 'success'].includes(refundRow.status)) {
    throw badRequest(`该订单已有${refundRow.status === 'success' ? '成功' : '受理中'}退款（${outRefundNo}），不可重复退款`);
  }
  try {
    if (!refundRow) {
      refundRow = await PaymentRefund.create({
        order_id: order.id, order_no: order.order_no, user_id: order.user_id,
        out_refund_no: outRefundNo, refund_amount_fen: refundFen, total_fen: paidFen,
        reason, status: 'processing', operator_id: req.user.id,
      });
    } else {
      await refundRow.update({
        refund_amount_fen: refundFen, total_fen: paidFen, reason,
        status: 'processing', refund_id: null, wx_result: null, operator_id: req.user.id,
      });
    }
  } catch (e) {
    if (e?.name === 'SequelizeUniqueConstraintError') throw badRequest(`该订单已有受理中退款（${outRefundNo}），不可重复退款`);
    throw e;
  }
  await setOrderRefundMark(order.id, { refundStatus: 'processing' });

  try {
    const wxRefund = await createRefund({ orderNo: order.order_no, refundAmountFen: refundFen, totalFen: paidFen, reason });
    const status = mapWxRefundStatus(wxRefund.status);
    await refundRow.update({ refund_id: wxRefund.refund_id || null, status, wx_result: wxRefund });
    // 受理即成功（部分渠道同步返回 SUCCESS）→ 落已退款；否则保持受理中，等 refund-status 查单收敛
    if (status === 'success') await setOrderRefundMark(order.id, { refundStatus: 'refunded', refundedAt: new Date() });
    return ok(res, {
      order_no: order.order_no,
      out_refund_no: outRefundNo,
      refund_id: wxRefund.refund_id || null,
      refund_status: status === 'success' ? 'refunded' : 'processing',
      wx_status: wxRefund.status || null,
      refund_amount_fen: refundFen,
    }, '退款已受理');
  } catch (e) {
    // 微信拒单：留痕 failed（可重试）并回滚订单标记，错误透传给 admin
    await refundRow.update({ status: 'failed', wx_result: { error: e.message } }).catch(() => {});
    await setOrderRefundMark(order.id, { refundStatus: 'failed' }).catch(() => {});
    throw badRequest(`微信退款失败：${e.message}`);
  }
}));

// 退款状态查询：受理中则主动向微信查单（/v3/refund/domestic/refunds/{out_refund_no}）兜底同步终态，
// admin 手动刷新用；查单失败不阻塞，返回本地落档状态
router.get('/orders/:orderNo/refund-status', adminAuthRequired, asyncHandler(async (req, res) => {
  if (!config.wechat.pay.enabled) throw badRequest('微信支付未启用');
  await ensureRefundSchema();
  const order = await RechargeOrder.findOne({ where: { order_no: String(req.params.orderNo || '').trim() } });
  if (!order) throw notFound('订单不存在');
  const row = await PaymentRefund.findOne({ where: { order_no: order.order_no }, order: [['id', 'DESC']] });
  let refund = row ? row.toJSON() : null;
  let wxError = null;
  if (row && row.status === 'processing') {
    try {
      const wxRefund = await queryRefund({ outRefundNo: row.out_refund_no });
      const status = mapWxRefundStatus(wxRefund.status);
      await row.update({ status, refund_id: wxRefund.refund_id || row.refund_id, wx_result: wxRefund });
      if (status === 'success') await setOrderRefundMark(order.id, { refundStatus: 'refunded', refundedAt: new Date() });
      else if (status === 'closed' || status === 'abnormal') await setOrderRefundMark(order.id, { refundStatus: 'failed' });
      refund = row.toJSON();
    } catch (e) {
      wxError = e.message; // 查单失败：展示本地状态，下次刷新再试
    }
  }
  const mark = await getOrderRefundMark(order.id);
  return ok(res, {
    order_no: order.order_no,
    paid_fen: paidFenOf(order),
    refund_status: mark?.refund_status ?? null,
    refunded_at: mark?.refunded_at ?? null,
    refund,
    wx_error: wxError,
  });
}));

// 全量积分流水（类型/用户/关联 id/日期筛选）
router.get('/transactions', adminAuthRequired, asyncHandler(async (req, res) => {
  const { page, size } = paging(req.query);
  const where = {};
  if (req.query.type) where.type = req.query.type;
  if (req.query.user_id) where.user_id = parseInt(req.query.user_id, 10) || 0;
  if (req.query.ref_id) where.ref_id = String(req.query.ref_id).trim();
  const created = dateRange(req.query);
  if (created) where.created_at = created;
  const { rows, count } = await CreditTransaction.findAndCountAll({
    where, include: [USER_INCLUDE], order: [['id', 'DESC']], offset: (page - 1) * size, limit: size,
  });
  return ok(res, { list: rows, total: count, page, size });
}));

// 积分人工调整（type='adjust' 落流水；扣减不足余额 → 402）
router.post('/adjust', adminAuthRequired, asyncHandler(async (req, res) => {
  const { user_id, amount, remark } = req.body || {};
  const target = await User.findByPk(user_id, { attributes: ['id', 'username', 'nickname', 'credits'] });
  if (!target) throw notFound('admin.users.not_found');
  const n = roundCredits(Number(amount)); // 积分一位小数：归一到 0.1 精度
  if (!Number.isFinite(Number(amount)) || n === 0 || Math.abs(n) > 10000000) throw badRequest('admin.payments.adjust_invalid');
  const cleanRemark = String(remark || '').trim();
  if (!cleanRemark || cleanRemark.length > 200) throw badRequest('admin.payments.adjust_remark_required');
  let balance;
  try {
    balance = await adjustCredits(target.id, n, { feature: 'admin', remark: cleanRemark });
  } catch (e) {
    // 余额不足：转 402（错误中间件只认 ApiError，与 market.routes 同一处理惯例）
    if (e?.name === 'InsufficientCreditsError') throw new ApiError(402, 'common.insufficient_credits', e.details);
    throw e;
  }
  return ok(res, { user_id: target.id, credits: balance }, 'admin.payments.adjust_done');
}));

// 充值配置：档位列表 + 汇率（附支付方式可用性，供面板一并展示）
router.get('/packages', adminAuthRequired, asyncHandler(async (req, res) => {
  return ok(res, {
    yuan_per_credit: await getYuanPerCredit(),
    packages: await getPackages(),
    enabled: config.wechat.pay.enabled,
    payMethods: config.wechat.pay.enabled ? ['wechat'] : [],
  });
}));

// 保存充值配置（白名单校验，写后 AppConfig 缓存立即失效）
router.put('/packages', adminAuthRequired, asyncHandler(async (req, res) => {
  const saved = await saveRechargeConfig(req.body || {}, req.user.id);
  return ok(res, saved, 'admin.payments.packages_saved');
}));

// 支付配置（脱敏只读）：凭据只在 env，改后须重启；此处仅健康检查展示
router.get('/pay-config', adminAuthRequired, asyncHandler(async (req, res) => {
  const pay = config.wechat.pay;
  // 平台证书缓存状态（回调验签健康度）：张数/最近拉取/最近失败原因
  let platformCert = null;
  try { platformCert = getPlatformCertStatus(); } catch { /* 观测信息不阻塞配置展示 */ }
  return ok(res, {
    enabled: pay.enabled,
    app_id: maskSecret(pay.appId),
    mch_id: maskSecret(pay.mchId),
    serial_no_set: !!pay.serialNo,
    api_v3_key_set: !!pay.apiV3Key,
    private_key_set: !!pay.privateKey,
    notify_url: pay.notifyUrl,
    platform_cert: platformCert,
    yuan_per_credit: await getYuanPerCredit(),
  });
}));

export default router;
