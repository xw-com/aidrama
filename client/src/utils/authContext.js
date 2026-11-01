// 运行区判定：前台（index.html 入口）与管理后台（admin.html 入口，路径前缀 /admin）共用同一份
// api/stores/组件代码，仅令牌存储键与会话失效兜底行为不同。管理端令牌独立存 aidrama-admin-token，
// 与前台 aidrama-token 互不覆盖——同一浏览器可同时登录两端。
// 以 URL 前缀判定，模块加载期即固定（两端互跳都是整页跳转，不存在运行中漂移）。
export const CLIENT_TOKEN_KEY = 'aidrama-token';
export const CLIENT_REFRESH_KEY = 'aidrama-refresh-token';
export const ADMIN_TOKEN_KEY = 'aidrama-admin-token';

export function isAdminArea() {
  const p = window.location.pathname;
  return p === '/admin' || p === '/admin/' || p.startsWith('/admin/');
}

// 当前运行区应使用的令牌键（http 请求拦截 / 会话清理共用）
export function tokenKey() {
  return isAdminArea() ? ADMIN_TOKEN_KEY : CLIENT_TOKEN_KEY;
}
