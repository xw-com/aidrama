/**
 * App 首启隐私合规门禁（应用商店上架要求：同意《用户协议》《隐私政策》前不发任何网络请求）。
 * - 仅 APP-PLUS 启用；H5/小程序/鸿蒙 isPrivacyAgreed 恒真、waitPrivacyAgreed 立即放行；
 * - 同意状态落盘 storage（privacy_agreed_v1），进入 KEYS 白名单（clearCache 不清）；
 * - http 层所有出网请求先过 waitPrivacyAgreed()：未同意时挂起不发包，同意后统一放行；
 * - 门禁弹窗（App.vue）与协议页「同意并继续」（pages/agreement）都走 agreePrivacy() 落盘。
 */
import { getItem, setItem, KEYS } from './storage';

let agreed = null; // null = 尚未读 storage
let waiters = [];

export function isPrivacyAgreed() {
  /* #ifdef APP-PLUS */
  if (agreed === null) agreed = String(getItem(KEYS.privacy) || '') === '1';
  return agreed;
  /* #endif */
  /* #ifndef APP-PLUS */
  return true;
  /* #endif */
}

/** 未同意时返回挂起中的 Promise，agreePrivacy() 后统一 resolve（已同意则立即 resolve） */
export function waitPrivacyAgreed() {
  if (isPrivacyAgreed()) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** 写入同意状态并放行所有挂起中的请求（首启弹窗「同意」与协议页「同意并继续」共用） */
export function agreePrivacy() {
  agreed = true;
  setItem(KEYS.privacy, '1');
  const list = waiters;
  waiters = [];
  list.forEach((resolve) => resolve());
}
