/**
 * xworld 账号服务直连（响应格式 { success, message, data }）。
 * 认证全链路走这里：登录/注册/发码/重置/刷新/登出 + 改密（表单认证，契约见
 * docs/xworld-direct-auth-api.md）。平台 JWT 由账号中心签发，AIDrama 服务端
 * 按共享密钥本地验签，与 OAuth 令牌同权。
 */
const baseURL = import.meta.env.VITE_XWORLD_API_BASE || 'https://auth.example.com/api/v1';
import { getItem, KEYS } from '../utils/storage';

/**
 * POST 信封请求。token 语义：
 * - 缺省（undefined）→ 取本地存储令牌（鉴权接口用）
 * - 显式传 null → 公开接口，不带 Authorization 头
 * - 显式传字符串 → 用传入令牌（登出时须在清本地前捕获，故显式指定）
 */
function xpost(path, data, token = getItem(KEYS.token)) {
  return new Promise((resolve, reject) => {
    const header = {
      'Content-Type': 'application/json',
      'Accept-Language': uni.getLocale?.() || 'zh-CN',
    };
    if (token) header.Authorization = 'Bearer ' + token;
    uni.request({
      url: baseURL + path,
      method: 'POST',
      timeout: 15000,
      header,
      data,
      success: (res) => {
        const body = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.success) resolve(body.data);
        // 透出 HTTP 状态码（401 凭证错误 / 409 已注册 / 422 校验失败 / 429 限频），message 服务端已本地化
        else reject(Object.assign(new Error(body?.message || `HTTP ${res.statusCode}`), { status: res.statusCode }));
      },
      fail: (e) => reject(Object.assign(new Error(e?.errMsg || 'network error'), { status: 0 })),
    });
  });
}

export function xworldChangePassword({ oldPassword, newPassword }) {
  return xpost('/users/me/password', { current_password: oldPassword, new_password: newPassword });
}

// ===== 直连认证 =====

/** 账号密码登录（identity = 手机号/邮箱/用户名）→ { user, tokens } */
export function directLogin({ identity, password, captcha_ticket }) {
  return xpost('/auth/login', {
    identity,
    password,
    // 服务端当前「提供才校验」；点选验证码通过后随请求透传
    ...(captcha_ticket ? { captcha_ticket } : {}),
  }, null);
}

/** 验证码注册，成功即登录 → { user, tokens }。payload = { phone|email, code, password } */
export function directRegister(payload) {
  return xpost('/auth/register', payload, null);
}

/** 发送验证码。payload = { phone|email, type: 'register'|'reset_password', captcha_ticket? } → { message, expires_in } */
export function directSendCode(payload) {
  return xpost('/auth/send-code', payload, null);
}

/** 忘记密码重置（成功不自动登录）。payload = { phone|email, code, password } */
export function directResetPassword(payload) {
  return xpost('/auth/reset-password', payload, null);
}

/** 刷新访问令牌 → { access_token, expires_in }。平台 JWT 的 refresh 不轮换，响应无新 refresh_token，继续用原值 */
export function directRefresh(refreshToken) {
  return xpost('/auth/refresh', { refresh_token: refreshToken }, null);
}

/** 登出（撤销账号中心 auth_sessions 会话）。token 须显式传入；best-effort，失败不阻塞本地登出 */
export function directLogout(accessToken) {
  return xpost('/auth/logout', {}, accessToken).catch(() => {});
}
