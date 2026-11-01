import { DataTypes, Op } from 'sequelize';
import db from '../../db/index.js';
import { ensureColumns } from '../../db/ensureColumns.js';

/**
 * 微信退款落档（payment_refunds）+ 订单退款标记。
 *
 * - 退款流水独立成表（与 recharge_orders 解耦，同 episode_videos 与 jobs 解耦的范式）：
 *   受理中/成功/失败全程留痕，out_refund_no 唯一约束天然充当「同一订单并发退款」的幂等锚点。
 * - 订单表不塞退款状态进 status ENUM（该列语义是支付生命周期 pending/paid/failed/canceled，
 *   且扩 ENUM 须动模型与启动迁移，越出本次改动范围）——改加两个标记列：
 *   refund_status（null=未退款 | processing=受理中 | refunded=已退款 | failed=失败/关闭可重试）、
 *   refunded_at。两列不在 RechargeOrder 模型里（模型文件不在改动范围），读写走参数化原生 SQL。
 * - 表结构懒初始化：首次用到退款接口时 CREATE TABLE IF NOT EXISTS + 补列（幂等，进程内只跑一次）；
 *   新表在启动期 sequelize.sync() 时也会按模型建出，这里只是旧库/时序兜底。
 */

// PaymentRefund 退款流水（payment_refunds）
const PaymentRefund = db.sequelize.define('PaymentRefund', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  order_id: { type: DataTypes.INTEGER, allowNull: false }, // recharge_orders.id
  order_no: { type: DataTypes.STRING(64), allowNull: false }, // 商户订单号（对账/按单查退款）
  user_id: { type: DataTypes.INTEGER, allowNull: false }, // 归属用户（冗余，列表展示/审计）
  out_refund_no: { type: DataTypes.STRING(64), allowNull: false, unique: true }, // rf_<order_no>，微信幂等键
  refund_id: { type: DataTypes.STRING(64), allowNull: true }, // 微信退款单号（受理成功后回填）
  refund_amount_fen: { type: DataTypes.INTEGER, allowNull: false }, // 退款金额（分）
  total_fen: { type: DataTypes.INTEGER, allowNull: false }, // 原订单金额（分）
  reason: { type: DataTypes.STRING(255), allowNull: true }, // 退款原因（微信限 80 字符）
  // processing=受理中 | success=退款成功 | abnormal=异常(需人工) | closed=关闭 | failed=受理失败(可重试)
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'processing' },
  wx_result: { type: DataTypes.JSON, allowNull: true }, // 最近一次微信响应/报错快照（查单留档）
  operator_id: { type: DataTypes.INTEGER, allowNull: true }, // 发起退款的 admin 用户 id
}, { tableName: 'payment_refunds' });

// recharge_orders 退款标记列（ensureColumns 幂等补列；存量行 NULL=未退款）
export const ORDER_REFUND_MARK_COLUMNS = {
  refund_status: DataTypes.STRING(16),
  refunded_at: DataTypes.DATE,
};

let schemaPromise = null;
// 懒初始化（幂等）：建退款表 + 给 recharge_orders 补退款标记列。失败清空缓存允许下次重试。
export function ensureRefundSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await PaymentRefund.sync(); // CREATE TABLE IF NOT EXISTS（新表；启动 sync 也会建，此处兜底）
      await ensureColumns(db.sequelize, 'recharge_orders', ORDER_REFUND_MARK_COLUMNS);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

// 微信退款状态 → 本地落档状态（未知状态按受理中处理，等下次查单收敛）
export function mapWxRefundStatus(wxStatus) {
  return {
    SUCCESS: 'success',
    PROCESSING: 'processing',
    ABNORMAL: 'abnormal',
    CLOSED: 'closed',
  }[String(wxStatus || '').toUpperCase()] || 'processing';
}

// 读写订单退款标记列（模型未定义，走参数化原生 SQL；两方言通用）
export async function setOrderRefundMark(orderId, { refundStatus, refundedAt = null } = {}) {
  await db.sequelize.query(
    'UPDATE recharge_orders SET refund_status = ?, refunded_at = ? WHERE id = ?',
    { replacements: [refundStatus, refundedAt, orderId] }
  );
}

export async function getOrderRefundMark(orderId) {
  const [rows] = await db.sequelize.query(
    'SELECT refund_status, refunded_at FROM recharge_orders WHERE id = ?',
    { replacements: [orderId] }
  );
  return rows?.[0] || null;
}

// 一批订单号的退款流水（admin 订单列表附加展示；按 id 倒序，首条为最新一笔）
export async function listRefundsByOrderNos(orderNos) {
  if (!orderNos?.length) return [];
  return PaymentRefund.findAll({ where: { order_no: { [Op.in]: orderNos } }, order: [['id', 'DESC']] });
}

export { PaymentRefund };
