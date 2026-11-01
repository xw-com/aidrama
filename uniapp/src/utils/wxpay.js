// 微信支付 H5 工具（自 miniclient 移植）：微信内 JSAPI 拉起 + 授权回跳续起。
// 仅 H5 端调用（小程序端支付走 pages/pay/mini 原生壳页；模块顶层无浏览器 API，双端可安全 import）。
import { rechargeApi } from '../api';

const OPENID_KEY = 'wxpay_openid';
const PENDING_KEY = 'wxpay_pending';

export function inWechat() {
  // #ifdef H5
  return /MicroMessenger/i.test(navigator.userAgent);
  // #endif
  // #ifndef H5
  return false;
  // #endif
}

export function cachedOpenid() {
  try { return sessionStorage.getItem(OPENID_KEY) || ''; } catch (e) { return ''; }
}

// 从 URL 提取并消费授权回跳 code（仅认 state=wxpay）；换 openid 并清洗 URL
export async function consumeAuthCode() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code') || '';
  if (!code || url.searchParams.get('state') !== 'wxpay') return '';
  const { openid } = await rechargeApi.jsapiOpenid(code);
  try { sessionStorage.setItem(OPENID_KEY, openid); } catch (e) { /* 隐私模式忽略 */ }
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, '', url);
  return openid;
}

// 确保 openid；拿不到则记录待支付意图并整页跳授权（snsapi_base 静默）
export async function ensureOpenid(pendingIntent = null) {
  let openid = cachedOpenid();
  if (openid) return openid;
  openid = await consumeAuthCode();
  if (openid) return openid;
  if (pendingIntent) { try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingIntent)); } catch (e) { /* 忽略 */ } }
  const redirect = new URL(window.location.href);
  redirect.searchParams.delete('code');
  redirect.searchParams.delete('state');
  const { auth_url } = await rechargeApi.jsapiAuthUrl(redirect.toString());
  window.location.href = auth_url;
  return new Promise(() => {}); // 整页跳走，由回跳后的新会话续起
}

// 取出待支付意图（授权回跳回来后调用；取出即清除）
export function takePendingWxPay() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// WeixinJSBridge 拉起支付 → 'ok' | 'cancel' | 'fail'（prepay_id 2 小时内可重复拉起）
export function bridgePay(payParams) {
  return new Promise((resolve) => {
    const go = () => {
      // eslint-disable-next-line no-undef
      WeixinJSBridge.invoke('getBrandWCPayRequest', payParams, (res) => {
        const r = String(res.get_brand_wcpay_request || res.err_msg || '');
        if (r.includes('ok')) resolve('ok');
        else resolve(r.includes('cancel') ? 'cancel' : 'fail');
      });
    };
    if (typeof WeixinJSBridge === 'undefined') {
      document.addEventListener('WeixinJSBridgeReady', go, false);
      setTimeout(() => { if (typeof WeixinJSBridge === 'undefined') resolve('fail'); }, 5000);
    } else {
      go();
    }
  });
}
