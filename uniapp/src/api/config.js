/**
 * API 地址配置。业务代码一律使用相对路径（/api、/files），
 * 由本模块负责在各端拼出可请求的完整地址：
 * - H5：保持相对路径走 dev proxy / nginx 同源转发（与 client/miniclient 一致）
 * - 小程序 / App：无同源概念，用 VITE_SERVER_ORIGIN 拼绝对地址
 */
const RAW_BASE = import.meta.env.VITE_API_BASE || '/api';

/* #ifdef H5 */
export const API_BASE = RAW_BASE;
// VITE_API_BASE 为绝对地址时（如直连线上站），/files 媒体也拼到该源站；
// 相对路径时用 VITE_SERVER_ORIGIN（与 App 端语义一致），未配置才同源走 dev proxy
const SERVER_ORIGIN = (import.meta.env.VITE_SERVER_ORIGIN || '').replace(/\/$/, '');
function detectOrigin() {
  if (/^https?:\/\//.test(RAW_BASE)) {
    const m = RAW_BASE.match(/^https?:\/\/[^/]+/);
    if (m) return m[0];
  }
  return SERVER_ORIGIN || window.location.origin;
}
/* #endif */
/* #ifndef H5 */
/* 缺 VITE_SERVER_ORIGIN 时绝不能静默兜底 localhost：App/小程序包发到用户设备后
 * 会去请求 127.0.0.1 全部失败且难排查，必须在构建期/启动期立即抛错暴露配置缺失 */
const RAW_ORIGIN = (import.meta.env.VITE_SERVER_ORIGIN || '').trim();
if (!RAW_ORIGIN) {
  throw new Error('构建配置缺失：请在 .env 配置 VITE_SERVER_ORIGIN（服务端源站地址，App/小程序端拼 /api 与 /files 绝对地址依赖它），参考 .env.example');
}
const SERVER_ORIGIN = RAW_ORIGIN.replace(/\/$/, '');
export const API_BASE = /^https?:\/\//.test(RAW_BASE) ? RAW_BASE : SERVER_ORIGIN + RAW_BASE;
function detectOrigin() {
  if (/^https?:\/\//.test(RAW_BASE)) {
    const m = RAW_BASE.match(/^https?:\/\/[^/]+/);
    if (m) return m[0];
  }
  return SERVER_ORIGIN;
}
/* #endif */

/** 服务端源站（/files 媒体绝对地址拼接用） */
export const API_ORIGIN = detectOrigin();
