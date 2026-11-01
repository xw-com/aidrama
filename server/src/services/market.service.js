import db from '../db/index.js';
import { addCredits, refundCredits } from './credits.service.js';

// 接单中心资金助手：保证金托管（发布时扣）→ 验收结算（给接单方）/ 退款（给发布方）。
// 复用现有积分体系：扣减走 consumeCredits（type=consume），入账走 addCredits/refundCredits；
// 幂等沿用段级计费的 ref_id 两记录对账模式——同一订单同一动作只入账一次（重试/并发兜底）。
const { CreditTransaction } = db;

export const MARKET_FEATURE = 'market_order';
export const marketRef = (orderId, action) => `mkt:${orderId}:${action}`;

// 流水幂等检查：同 user + ref_id + type 已存在即视为已入账
async function hasCreditTx(userId, refId, type) {
  return (await CreditTransaction.count({ where: { user_id: userId, ref_id: refId, type } })) > 0;
}

/**
 * 验收/仲裁放款：把托管的总价结算给接单方（type=settle）。
 * 调用前订单状态已被原子认领为终态；此处幂等入账，重复调用安全。
 */
export async function settleToWorker(order) {
  const refId = marketRef(order.id, 'settle');
  if (await hasCreditTx(order.worker_id, refId, 'settle')) return;
  await addCredits(order.worker_id, order.total_price, {
    type: 'settle',
    feature: MARKET_FEATURE,
    refId,
    remark: `接单结算：「${order.title}」成片时长 ${order.duration_seconds} 秒`,
  });
}

/**
 * 无人接取消 / 仲裁退款：把托管的总价退回发布方托管账户（type=refund）。幂等。
 */
export async function refundDeposit(order) {
  const refId = marketRef(order.id, 'refund');
  if (await hasCreditTx(order.publisher_id, refId, 'refund')) return;
  await refundCredits(order.publisher_id, order.total_price, {
    feature: MARKET_FEATURE,
    refId,
    remark: `订单退款：「${order.title}」`,
  });
}
