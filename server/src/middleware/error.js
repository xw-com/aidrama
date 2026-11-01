import { ApiError } from '../utils/response.js';
import { tReq } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

// 统一错误处理
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.code && err.code >= 400 ? err.code : 200).json({
      code: err.code,
      message: tReq(req, err.message, err.params),
      data: err.details || null,
    });
  }

  // InsufficientCreditsError(credits.service 直抛,非 ApiError):统一按 402 返回,
  // 客户端据 402 弹「立即充值」引导
  if (err?.code === 402) {
    return res.status(402).json({
      code: 402,
      message: tReq(req, 'common.insufficient_credits'),
      data: err.details || null,
    });
  }

  // body-parser / multer 等 http-errors 类错误（坏 JSON、超 8MB 请求体、字段超限等）：
  // err.status/statusCode 已带正确 4xx 状态码，不识别会一律落到 500（误导排障 + 监控误报服务端故障）
  const httpStatus = Number(err?.status || err?.statusCode);
  if (Number.isFinite(httpStatus) && httpStatus >= 400 && httpStatus < 500) {
    return res.status(httpStatus).json({ code: httpStatus, message: tReq(req, 'common.bad_request'), data: null });
  }

  // Sequelize 唯一约束
  if (err && err.name === 'SequelizeUniqueConstraintError') {
    return res.status(200).json({ code: 409, message: tReq(req, 'error.data_duplicate_prefix') + (err.errors?.[0]?.message || ''), data: null });
  }
  if (err && err.name === 'SequelizeValidationError') {
    return res.status(200).json({ code: 400, message: tReq(req, 'error.validation_failed_prefix') + (err.errors?.[0]?.message || ''), data: null });
  }

  // 注意：Sequelize 会用内部 errForStack 的裸 stack 覆盖真实错误对象的 stack，
  // 只打 stack 会得到一个空消息的 "Error"（真实原因被吞），须额外打出底层字段
  const orig = err?.original || err?.parent;
  logger.error('Unhandled error:', err?.stack || err, {
    name: err?.name,
    message: err?.message,
    errno: orig?.errno,
    code: orig?.code || err?.code,
    sqlMessage: orig?.sqlMessage,
    sql: err?.sql,
  });
  const serverMsg = process.env.NODE_ENV === 'production' ? tReq(req, 'error.server') : (err?.message || tReq(req, 'error.server'));
  return res.status(500).json({ code: 500, message: serverMsg, data: null });
};

// 404
export const notFoundHandler = (req, res) => {
  res.status(404).json({ code: 404, message: `${tReq(req, 'error.not_found_api')}: ${req.method} ${req.originalUrl}`, data: null });
};
