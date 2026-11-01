/**
 * 本地认证 API（账号密码登录/注册、改密、会话刷新）。
 * 全部走本系统 /api（统一 { code, message, data } 信封），会话令牌为本服务端自签的
 * axt_ JWT（access + refresh，refresh 不轮换）。注册需过点选验证码（captcha_ticket）。
 * 原 xworld 账号中心直连认证已随 OAuth 解耦下线。
 */
import http from './http.js';

/** 账号密码登录（identity = 用户名/邮箱/手机号）→ { user, tokens }。_silent：错误由页面就地提示 */
export function localLogin({ identity, password, captcha_ticket }) {
  return http.post('/auth/login', {
    identity,
    password,
    // 服务端「提供才校验」；点选验证码通过后随请求透传
    ...(captcha_ticket ? { captcha_ticket } : {}),
  }, { _silent: true });
}

/** 注册（用户名 + 密码，邮箱选填；captcha_ticket 为点选验证码 ticket），成功即登录 → { user, tokens } */
export function localRegister({ username, password, email, captcha_ticket }) {
  return http.post('/auth/register', {
    username,
    password,
    ...(email ? { email } : {}),
    captcha_ticket,
  }, { _silent: true });
}

/** 修改密码（登录态）：验旧密码后更新 */
export function localChangePassword({ oldPassword, newPassword }) {
  return http.post('/auth/password', { oldPassword, newPassword }, { _silent: true });
}

/** 刷新访问令牌 → { access_token, refresh_token, expires_in }。refresh 不轮换，原值继续用 */
export function localRefresh(refreshToken) {
  return http.post('/auth/oauth/refresh', { refresh_token: refreshToken }, { _silent: true });
}

/** 登出。axt_ 会话为无状态 JWT，无服务端会话可撤销，本地清令牌即可（封禁由服务端每请求重查兜底） */
export function localLogout() {
  return Promise.resolve();
}
