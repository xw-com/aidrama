import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { roundCredits, ceilCredits } from '../utils/credits.js';

const { User, CreditTransaction, Job } = db;

/**
 * 内部：扣减个人积分（不做折扣）。并发安全：行级 UPDATE + 条件。
 * 所有扣减（含 withCredits 预扣）最终都走这里。
 * 「扣减 → 读回余额 → 落流水」包同一事务：行锁串行化并发扣减，保证 balance_after
 * 审计口径不被并发交易交错污染（金额增减本身由条件 UPDATE 保证，此处加固的是对账列）。
 */
async function _subtract(userId, units, meta = {}) {
  if (!units || units <= 0) return getCurrentBalance(userId);
  const balance = await db.sequelize.transaction(async (t) => {
    const [updated] = await User.update(
      { credits: db.sequelize.literal('credits - ' + units) },
      { where: { id: userId, credits: { [db.Sequelize.Op.gte]: units } }, transaction: t }
    );
    if (updated === 0) {
      const u = await User.findByPk(userId, { attributes: ['credits'], transaction: t });
      throw new InsufficientCreditsError(units, u?.credits || 0);
    }
    const u = await User.findByPk(userId, { attributes: ['credits'], transaction: t });
    await CreditTransaction.create({
      user_id: userId,
      type: 'consume',
      amount: -units,
      balance_after: u.credits,
      feature: meta.feature || null,
      ref_id: meta.refId ? String(meta.refId) : null,
      remark: meta.remark || null,
    }, { transaction: t });
    return u.credits;
  });
  return balance;
}

/**
 * 扣减积分（公开）。按量原价扣减。
 * @param {number} userId 用户
 * @param {number} nominalCredits 名义积分数
 * @param {object} meta { feature, refId, remark }
 * @returns 新余额
 */
export async function consumeCredits(userId, nominalCredits, meta = {}) {
  if (!nominalCredits || nominalCredits <= 0) return getCurrentBalance(userId);
  const charged = ceilCredits(nominalCredits); // 积分一位小数：向上取整到 0.1
  return _subtract(userId, charged, meta);
}

/** 内部：增加个人积分（充值/退款到账，字面量，不打折）。可选 meta.transaction 参与外部事务。 */
async function _add(userId, credits, meta = {}) {
  credits = roundCredits(credits); // 归一到 0.1 精度，消除浮点尾巴
  if (!credits || credits === 0) return getCurrentBalance(userId);
  const t = meta.transaction || null;

  // 「改余额」与「落流水」必须原子：两段写无事务时，写 1 成功、写 2 失败会留下
  // 无流水的余额变动——幂等对账（hasCreditTx/refundJobHold）查不到流水，
  // 调用方的补偿重试会再次入账（双倍结算/退款）。
  const run = async (txOpt) => {
    const sign = credits > 0 ? '+' : '-';
    await User.update(
      { credits: db.sequelize.literal(`credits ${sign} ${Math.abs(credits)}`) },
      { where: { id: userId }, ...(txOpt || {}) }
    );
    const user = await User.findByPk(userId, { attributes: ['credits'], ...(txOpt || {}) });
    const balanceAfter = user.credits;

    await CreditTransaction.create({
      user_id: userId,
      type: meta.type || (credits > 0 ? 'recharge' : 'refund'),
      amount: credits,
      balance_after: balanceAfter,
      feature: meta.feature || null,
      ref_id: meta.refId ? String(meta.refId) : null,
      remark: meta.remark || null,
    }, txOpt);
    return balanceAfter;
  };

  const balanceAfter = t ? await run({ transaction: t }) : await db.sequelize.transaction(run);

  return balanceAfter;
}

/** 增加积分（公开；充值/退款，字面量）。 */
export async function addCredits(userId, credits, meta = {}) {
  return _add(userId, credits, meta);
}

/** 退款（失败时回滚 / 任务取消退款）。 */
export async function refundCredits(userId, credits, meta = {}) {
  if (!credits || credits <= 0) return getCurrentBalance(userId);
  return _add(userId, credits, { ...meta, type: 'refund' });
}

/**
 * 管理员人工调整个人积分（±，type='adjust'）。amount 须为路由层预校验过的非零整数。
 * 扣减不允许把余额扣成负数（沿用 InsufficientCreditsError 402 语义）。
 */
export async function adjustCredits(userId, amount, meta = {}) {
  if (amount < 0) {
    const balance = await getCurrentBalance(userId);
    if (balance + amount < 0) throw new InsufficientCreditsError(Math.abs(amount), balance);
  }
  return _add(userId, amount, { ...meta, type: 'adjust' });
}

/**
 * 最近一条 Job 预扣流水（ref_id=job:<id> 的 consume）：读「该任务实际预扣额」用，
 * 重启恢复的任务据此回填 credits_used（原 withCredits 预扣在重启前已落，不重复扣）。无则 null。
 */
export async function findJobHold(userId, jobId) {
  return CreditTransaction.findOne({
    where: { user_id: userId, type: 'consume', ref_id: `job:${jobId}` },
    order: [['id', 'DESC']],
  });
}

// 任务级退款幂等键：所有该任务的退款（预扣全退/结算差额退）统一挂同一 ref，
// 先查后退，杜绝「取消退款 × withCredits 结算/失败退款」双退。
// 实际==预扣时不产生退款流水，结算落 type='settle' 零额标记挂同一 ref：
// 否则重启清理的 refundJobHold 查无退款记录，会对已交付任务把预扣全额重退一遍。
const jobRefundRef = (jobId) => `refund:job:${jobId}`;

/** 任务已结算标记（type='settle' 零额流水，挂退款幂等键；幂等可重入） */
export async function markJobSettled(userId, jobId, meta = {}) {
  const ref = jobRefundRef(jobId);
  const marked = await CreditTransaction.findOne({
    where: { user_id: userId, type: 'settle', ref_id: ref },
  });
  if (marked) return;
  await CreditTransaction.create({
    user_id: userId,
    type: 'settle',
    amount: 0,
    balance_after: await getCurrentBalance(userId),
    feature: meta.feature || null,
    ref_id: ref,
    remark: '任务结算与预扣一致（防双退标记）',
  });
}

/**
 * 退还任务实际预扣的积分（最近一条 ref_id=job:<id> 的 consume 记录），返回退款额（无记录返回 0）。
 * 超时取消、僵尸取消、重启清理与恢复失败共用，保证同一退款口径。
 * 幂等：已存在该任务的退款/结算标记流水（refund:job:<id>）时直接返回 0——hold 的 consume 流水永久存在，
 * 无标记时「withCredits 已结算/已退 + 重启清理再退」会在崩溃窗口内对同一预扣退两次。
 */
export async function refundJobHold(userId, jobId, feature, remark) {
  const refunded = await CreditTransaction.findOne({
    where: { user_id: userId, type: { [db.Sequelize.Op.in]: ['refund', 'settle'] }, ref_id: jobRefundRef(jobId) },
  });
  if (refunded) return 0;
  const tx = await findJobHold(userId, jobId);
  if (!tx || tx.amount >= 0) return 0;
  const refund = Math.abs(tx.amount);
  await _add(userId, refund, { feature, type: 'refund', refId: jobRefundRef(jobId), remark });
  return refund;
}

export async function getCurrentBalance(userId) {
  const u = await User.findByPk(userId, { attributes: ['credits'] });
  return u?.credits || 0;
}

/**
 * 高阶：执行一个需要消耗积分的任务（按量预扣 + 可被任务取消退款）。
 *  - 预扣名义 estimate
 *  - 执行 fn()
 *  - 成功：按 fn 返回的 _actualCredits（名义）结算，差额退还；失败：全退预扣
 *  - 若任务被外部取消（cancelJob 已退款）：结算时跳过自身退款，杜绝重复
 * 返回 { result, spent, balance }
 */
export async function withCredits(userId, estimateNominal, meta, fn) {
  const estCharged = ceilCredits(estimateNominal || 0);
  const jobId = meta && meta.jobId ? String(meta.jobId) : null;
  const label = `${meta.remark || meta.feature || ''} 预扣`.trim();

  const balance0 = await getCurrentBalance(userId);
  if (balance0 < estCharged) {
    throw new InsufficientCreditsError(estCharged, balance0);
  }

  // 预扣 charged（关联 jobId，供取消时对账退款）
  await _subtract(userId, estCharged, jobId ? { ...meta, refId: `job:${jobId}`, remark: label } : { ...meta, remark: label });

  try {
    const result = await fn();

    // 已被外部取消并退款 → 跳过结算（避免重复退款）
    if (jobId) {
      const j = await Job.findByPk(jobId, { attributes: ['status'] });
      if (j && j.status === 'cancelled') {
        const balance = await getCurrentBalance(userId);
        return { result: null, spent: 0, balance };
      }
    }

    const actualNominal = (result && typeof result === 'object' && typeof result._actualCredits === 'number')
      ? result._actualCredits : estimateNominal;
    const actualCharged = ceilCredits(actualNominal || 0);
    if (actualCharged < estCharged) {
      // 差额退款同样挂任务幂等键：与 cancelJob 的全额退款互斥（后到的一方查到已有退款即跳过），
      // 堵住「超时取消退款 × 迟到结算退差额」毫秒级竞态下的双退
      await _add(userId, estCharged - actualCharged, {
        ...meta, type: 'refund', ...(jobId ? { refId: jobRefundRef(jobId) } : {}), remark: `${meta.remark || meta.feature} 退还差额`,
      });
    } else if (jobId) {
      // 实际==/超预估时无退款流水可挂幂等键，落显式结算标记——否则重启清理窗口内
      // refundJobHold 查无退款，会对已交付任务把预扣全额重退（毫秒级窗口的资损闭环）
      await markJobSettled(userId, jobId, meta);
    }
    const balance = await getCurrentBalance(userId);
    return { result: stripCost(result), spent: actualCharged, balance };
  } catch (e) {
    // 失败：若已被外部取消退款则不再退
    if (jobId) {
      const j = await Job.findByPk(jobId, { attributes: ['status'] });
      if (j && j.status === 'cancelled') {
        logger.warn(`withCredits for job ${jobId} failed but already cancelled/refunded:`, e?.message || e);
        throw e;
      }
    }
    await _add(userId, estCharged, {
      ...meta, type: 'refund', ...(jobId ? { refId: jobRefundRef(jobId) } : {}), remark: `${meta.remark || meta.feature} 失败退还`,
    });
    logger.warn(`withCredits task failed, refunded ${estCharged} credits for user ${userId}:`, e?.message || e);
    throw e;
  }
}

function stripCost(r) {
  if (r && typeof r === 'object' && '_actualCredits' in r) {
    const { _actualCredits, ...rest } = r;
    return rest;
  }
  return r;
}

/** 积分不足（402）：个人余额不足，引导自行充值。 */
export class InsufficientCreditsError extends Error {
  constructor(need, have) {
    super(`积分不足，需要 ${need}，当前余额 ${have}`);
    this.code = 402;
    this.name = 'InsufficientCreditsError';
    this.details = { need, have };
  }
}
