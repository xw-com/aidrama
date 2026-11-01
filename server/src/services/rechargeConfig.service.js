// 充值配置：充值档位 + 汇率（AppConfig KV，键前缀 recharge:），admin 后台可改。
// 原为 recharge.routes.js 硬编码常量，改为 DB 配置后用户侧 /recharge/packages、/create 动态读取。
// 注意：微信支付凭据（appid/mchid/密钥）仍只走 env —— 本服务刻意不提供 getWxPayConfig()，
// 若未来需要 DB 覆盖 env，须把 pay.service.js 的模块级解构改为逐请求动态读取，属高风险改造。
import { getConfig, getConfigInt, setConfigs } from './appConfig.service.js';
import { badRequest } from '../utils/index.js';
import { roundCredits } from '../utils/credits.js';

const RATE_KEY = 'recharge:yuan_per_credit';
const PACKAGES_KEY = 'recharge:packages';

export const DEFAULT_YUAN_PER_CREDIT = 10;

// 与旧硬编码 PACKAGES 完全一致（未配置时回退，保证行为不变）
export const DEFAULT_PACKAGES = [
  { id: 'p10', yuan: 1, credits: 10, bonus: 0, label: '体验包' },
  { id: 'p50', yuan: 50, credits: 500, bonus: 50, label: '标准包' },
  { id: 'p100', yuan: 100, credits: 1000, bonus: 200, label: '超值包' },
  { id: 'p500', yuan: 500, credits: 5000, bonus: 1500, label: '专业包' },
];

const PKG_ID_RE = /^[a-z0-9_]{1,32}$/;

/** 当前生效汇率：1 元 = N 积分（钳 1..10000） */
export async function getYuanPerCredit() {
  const n = await getConfigInt(RATE_KEY, DEFAULT_YUAN_PER_CREDIT);
  return Math.max(1, Math.min(10000, n));
}

/** 当前充值档位列表（存档损坏/缺字段时整体回退默认档，保证下单可用） */
export async function getPackages() {
  const raw = await getConfig(PACKAGES_KEY, null);
  if (!raw) return DEFAULT_PACKAGES;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return DEFAULT_PACKAGES;
    const out = [];
    for (const p of arr) {
      const yuan = Number(p.yuan);
      // roundCredits 会把非有限输入归 0，非法值须先显式判 NaN 拒绝
      if (!Number.isFinite(Number(p.credits)) || !Number.isFinite(Number(p.bonus))) return DEFAULT_PACKAGES;
      const credits = roundCredits(p.credits); // 积分一位小数：档位积分支持 0.1 精度
      const bonus = roundCredits(p.bonus);
      const label = String(p.label || '').trim();
      if (!PKG_ID_RE.test(String(p.id || '')) || !Number.isFinite(yuan) || yuan <= 0
        || !Number.isFinite(credits) || credits < 0 || bonus < 0 || !label) {
        return DEFAULT_PACKAGES;
      }
      out.push({ id: p.id, yuan, credits, bonus, label });
    }
    return out;
  } catch {
    return DEFAULT_PACKAGES;
  }
}

/** admin 保存充值配置：档位列表整体校验（拒绝非法而非静默钳制），汇率钳制 */
export async function saveRechargeConfig({ yuan_per_credit, packages } = {}, adminId = null) {
  const entries = {};

  if (yuan_per_credit !== undefined) {
    let n = parseInt(yuan_per_credit, 10);
    if (!Number.isFinite(n)) throw badRequest('admin.payments.rate_invalid');
    entries[RATE_KEY] = String(Math.max(1, Math.min(10000, n)));
  }

  if (packages !== undefined) {
    if (!Array.isArray(packages) || packages.length < 1 || packages.length > 20) {
      throw badRequest('admin.payments.packages_invalid');
    }
    const seen = new Set();
    const cleaned = packages.map((p) => {
      const id = String(p?.id || '').trim();
      const yuan = Number(p?.yuan);
      const label = String(p?.label || '').trim();
      if (!PKG_ID_RE.test(id) || seen.has(id)) throw badRequest('admin.payments.packages_invalid');
      seen.add(id);
      if (!Number.isFinite(yuan) || yuan < 0.01 || yuan > 100000) throw badRequest('admin.payments.packages_invalid');
      // roundCredits 会把非有限输入归 0，非法值须先显式判 NaN 拒绝
      if (!Number.isFinite(Number(p?.credits)) || !Number.isFinite(Number(p?.bonus))) throw badRequest('admin.payments.packages_invalid');
      const credits = roundCredits(p?.credits); // 积分一位小数：档位积分支持 0.1 精度
      const bonus = roundCredits(p?.bonus);
      if (!Number.isFinite(credits) || credits < 0 || credits > 10000000) throw badRequest('admin.payments.packages_invalid');
      if (!Number.isFinite(bonus) || bonus < 0 || bonus > 10000000) throw badRequest('admin.payments.packages_invalid');
      if (!label || label.length > 32) throw badRequest('admin.payments.packages_invalid');
      return { id, yuan, credits, bonus, label };
    });
    entries[PACKAGES_KEY] = JSON.stringify(cleaned);
  }

  if (Object.keys(entries).length) await setConfigs(entries, adminId);
  return { yuan_per_credit: await getYuanPerCredit(), packages: await getPackages() };
}
