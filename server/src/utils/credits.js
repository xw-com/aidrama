/**
 * 积分精度工具：积分统一支持一位小数（步进 0.1）。
 * - 所有写入 DB / 参与计费比较的积分数值必须先经 roundCredits 归一，消除浮点误差尾巴；
 * - 计费扣减沿用「向上取整」语义（原整数 Math.ceil），现为向上取整到 0.1（ceilCredits）；
 * - DB 侧积分列已由 INTEGER 升级为 DOUBLE（见 db/ensureColumns.js 的 ensureDecimalColumns）。
 */
export const CREDIT_STEP = 0.1;
export const CREDIT_SCALE = 10;

/** 归一到 0.1 精度（四舍五入）。非有限输入归 0。 */
export function roundCredits(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * CREDIT_SCALE) / CREDIT_SCALE;
}

/** 向上取整到 0.1 精度（计费口径：不小于名义值的最小 0.1 倍数）。 */
export function ceilCredits(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  // 先在更细粒度上消除浮点噪声（如 1.3000000000000003），再按 0.1 向上取整
  const clean = Math.round(n * 1e6) / 1e6;
  return Math.ceil(clean * CREDIT_SCALE) / CREDIT_SCALE;
}

/** 展示/文案用：去掉多余尾零（13.0 → "13"，13.5 → "13.5"）。 */
export function fmtCredits(x) {
  return String(roundCredits(x));
}
