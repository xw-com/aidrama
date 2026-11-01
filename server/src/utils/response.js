// 统一响应封装 + 错误类
import { tr } from '../i18n/index.js';

export class ApiError extends Error {
  constructor(code, message, details, params) {
    super(message);
    this.code = code;
    this.details = details;
    this.params = params; // 可选：用于 {name} 插值的参数
  }
}

// message 可为 i18n 键或字面量；未命中键时按字面量原样返回（向后兼容尚未迁移的中文/英文文案）
// params（可选）：用于 {name} 等占位符插值
export const ok = (res, data = null, message = 'common.success', params) =>
  res.json({ code: 0, message: tr(res, message, params), data });

export const fail = (res, code = 1, message = 'common.error', data = null, params) =>
  res.status(typeof code === 'number' && code >= 400 ? code : 200).json({ code, message: tr(res, message, params), data });

// 业务错误快捷构造（默认消息改为 i18n 键，由 errorHandler 按请求 locale 翻译）
// params（可选）：用于 {name} 等占位符插值
export const badRequest = (msg = 'common.bad_request', params) => new ApiError(400, msg, undefined, params);
export const unauthorized = (msg = 'common.unauthorized', params) => new ApiError(401, msg, undefined, params);
export const forbidden = (msg = 'common.forbidden', params) => new ApiError(403, msg, undefined, params);
export const notFound = (msg = 'common.not_found', params) => new ApiError(404, msg, undefined, params);
export const insufficientCredits = (msg = 'common.insufficient_credits', params) => new ApiError(402, msg, undefined, params);
