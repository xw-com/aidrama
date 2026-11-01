import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { buildAuthorization, decryptWithApiV3Key, toWxPayError } from './pay.service.js';

/**
 * 微信支付平台证书管理（GET /v3/certificates）。
 * 文档：https://pay.weixin.qq.com/docs/merchant/apis/platform-certificate/api-i-get-certificates.html
 *
 * - 请求签名复用 pay.service.js 的 buildAuthorization（商户 API 私钥，WECHATPAY2-SHA256-RSA2048）。
 * - encrypt_certificate 用 APIv3 密钥 AES-256-GCM 解密得到平台证书 PEM，取出公钥按 serial_no 缓存
 *   （内存 Map，微信证书轮换期多张并存，回调用 Wechatpay-Serial 头指定用哪张验签）。
 * - 懒拉取：首次用到才请求，避免本地无支付配置时启动报错；首次成功后装配定时刷新
 *   （默认 12 小时，WECHAT_PAY_CERT_REFRESH_HOURS）。验签序列号未命中时强制刷新一次重试（轮换容错）。
 * - 微信支付未配置（config.wechat.pay.enabled=false）时整个模块静默 no-op：不请求、不告警、不装配定时器。
 */

const BASE = 'https://api.mch.weixin.qq.com';

const envInt = (name, dft) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : dft;
};
// 平台证书定时刷新间隔（小时）：默认 12，夹在 [1, 168]；官方建议定期更新以跟进证书轮换
const REFRESH_MS = Math.min(168, Math.max(1, envInt('WECHAT_PAY_CERT_REFRESH_HOURS', 12))) * 3600 * 1000;
// 序列号未命中强制刷新的最小间隔（秒）：防伪造回调携带随机 serial 打爆证书接口；0 = 不限制（联调用）
const FORCE_REFRESH_MIN_MS = Math.max(0, envInt('WECHAT_PAY_CERT_FORCE_REFRESH_MIN_SEC', 10)) * 1000;

// serial(大写) -> { serial, publicKey, cert, effective_time, expire_time, fetchedAt }
const certs = new Map();
let loadPromise = null;   // 并发去重：同一时刻只放行一个 /v3/certificates 请求
let lastFetchAt = 0;      // 最近一次成功拉取时间戳（ms）
let lastError = null;     // 最近一次拉取失败原因（降级告警 / 运维排查用）
let refreshTimer = null;  // 定时刷新句柄（懒启动：首次成功拉取后才装配，未配置支付则永不装配）

const payEnabled = () => !!(config.wechat?.pay?.enabled);

export function hasPlatformCerts() { return certs.size > 0; }
export function lastErrorText() { return lastError || ''; }

// ===== 降级告警（每小时最多一次，防回调风暴刷屏）=====
// 可用性取舍说明：平台证书拉取失败（网络受限环境等）时，回调验签退回「仅 AES-GCM 解密校验」旧行为
// （APIv3 密钥只有微信与我方持有，伪造报文过不了解密；重放通知被订单幂等挡住），不阻断收款入账；
// 期间每小时最多 warn 一次提醒运维。设 WECHAT_PAY_VERIFY_STRICT=1 可改为直接拒绝回调（fail-closed）。
const DEGRADE_WARN_INTERVAL_MS = 3600 * 1000;
let degradeWarnAt = 0;
export function warnCertDegraded(scope, detail = '') {
  const now = Date.now();
  if (now - degradeWarnAt < DEGRADE_WARN_INTERVAL_MS) return;
  degradeWarnAt = now;
  logger.warn(
    `[wxpay] 平台证书不可用，回调用 AES-GCM 解密兜底（scope=${scope}${detail ? ` ${detail}` : ''}）。`
    + '此期间跳过平台证书 RSA 验签；证书接口恢复后自动回归严格验签。'
    + '如需 fail-closed（证书不可用即拒绝回调）设 WECHAT_PAY_VERIFY_STRICT=1。'
  );
}

// 拉取并解密平台证书列表：encrypt_certificate（AES-256-GCM，aad=certificate）解出 PEM → 取公钥
async function fetchCertificates() {
  const pathname = '/v3/certificates';
  let data;
  try {
    ({ data } = await axios.get(BASE + pathname, {
      timeout: 15000,
      headers: { Accept: 'application/json', Authorization: buildAuthorization('GET', pathname, '') },
    }));
  } catch (e) {
    throw toWxPayError(e);
  }
  const list = Array.isArray(data?.data) ? data.data : [];
  const next = new Map();
  for (const item of list) {
    const serial = String(item?.serial_no || '').trim();
    if (!serial || !item?.encrypt_certificate?.ciphertext) continue;
    let pem;
    try {
      pem = decryptWithApiV3Key(item.encrypt_certificate); // 解密失败 = 报文被篡改或 APIv3 密钥不符，跳过该张
    } catch (e) {
      logger.warn(`[wxpay] 平台证书 ${serial} 解密失败，跳过：${e.message}`);
      continue;
    }
    const publicKey = new crypto.X509Certificate(pem).publicKey; // Node >= 15.6
    next.set(serial.toUpperCase(), {
      serial, publicKey, cert: pem,
      effective_time: item.effective_time || null,
      expire_time: item.expire_time || null,
      fetchedAt: new Date().toISOString(),
    });
  }
  if (!next.size) throw new Error('平台证书列表解密后为空');
  return next;
}

function applyCerts(next) {
  certs.clear();
  for (const [k, v] of next) certs.set(k, v);
  lastFetchAt = Date.now();
  lastError = null;
  armRefreshTimer();
}

// 定时刷新（懒装配）：失败保留旧证书（轮换期内旧证书仍可验签），告警限频走 warnCertDegraded
function armRefreshTimer() {
  if (refreshTimer || !payEnabled()) return;
  refreshTimer = setInterval(() => {
    refreshPlatformCerts().then((ok) => {
      if (!ok) warnCertDegraded('refresh', `err=${lastErrorText()}`);
    });
  }, REFRESH_MS);
  refreshTimer.unref?.(); // 不阻止进程退出
}

// 拉取（或强制重拉）平台证书；并发调用合并为同一次请求。永不 reject，返回「缓存是否可用」。
export async function refreshPlatformCerts({ force = false } = {}) {
  if (!payEnabled()) return false; // 未配置微信支付：静默 no-op
  if (loadPromise) return loadPromise;
  // 最小间隔防打爆：伪造回调每条带随机 serial 都触发强刷，会被这里拦住（间隔内沿用现有证书）
  if (force && certs.size > 0 && Date.now() - lastFetchAt < FORCE_REFRESH_MIN_MS) return true;
  loadPromise = (async () => {
    try {
      applyCerts(await fetchCertificates());
      return true;
    } catch (e) {
      lastError = e?.message || String(e);
      return certs.size > 0; // 刷新失败但旧证书仍在 → 仍可用（严格验签不中断）
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

// 取序列号对应的平台证书；缓存未命中 → 强制刷新一次再查（序列号轮换容错）
export async function getCertBySerial(serial) {
  if (!payEnabled()) return null;
  const key = String(serial || '').trim().toUpperCase();
  if (!key) return null;
  const cached = certs.get(key);
  if (cached) return cached;
  await refreshPlatformCerts({ force: true }); // 首次懒拉取 / 轮换重拉都在这里发生；失败保留旧证书
  return certs.get(key) || null;
}

// 运维观测快照（admin pay-config 展示）：证书张数 / 最近成功拉取 / 最近失败原因 / 刷新间隔
export function getPlatformCertStatus() {
  return {
    enabled: payEnabled(),
    loaded: certs.size > 0,
    count: certs.size,
    serials: [...certs.values()].map((c) => c.serial),
    last_fetch_at: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
    last_error: lastError,
    refresh_hours: REFRESH_MS / 3600000,
  };
}

// ===== 以下两个钩子仅供 scripts/_tmp-refund-sign-test.mjs 本地签名联调注入测试证书，生产代码勿调 =====
export function __testInjectCerts(entries) {
  certs.clear();
  for (const e of entries) certs.set(String(e.serial).toUpperCase(), { ...e, serial: String(e.serial) });
  lastFetchAt = Date.now();
}
export function __testResetCerts() {
  certs.clear();
  lastFetchAt = 0;
  lastError = null;
  degradeWarnAt = 0;
}
