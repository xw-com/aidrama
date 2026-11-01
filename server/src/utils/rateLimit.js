// 通用内存滑动窗口限频中间件工厂。
// 范式抽自 captcha.routes.js / adminAuth.routes.js / xworldOauth.routes.js / member.routes.js
// 顶部的四份手写实现，收口为一个可复用工广；不引外部依赖（单进程部署，重启即清零）。
import { ApiError } from './response.js';
import { logger } from './logger.js';

// 键容量上限：key 可能取自可伪造的来源（XFF/令牌），无上限时随机 key 可让 Map 无限增长
// （未认证接口 = 内存 DoS），超限按插入序 FIFO 淘汰（Map 遍历即插入序，范式同 auth.js oauthVerifyCache）
const DEFAULT_MAX_KEYS = 10000;

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs=60000] 滑动窗口时长（毫秒）
 * @param {number} [opts.max=60] 窗口内最大命中次数，超限抛 ApiError
 * @param {(req) => (string|null|Promise<string|null>)} [opts.keyFn] 限频键提取；
 *   返回 null/空串表示跳过该请求（不计数，如 admin 豁免）。默认 req.ip（配合 app.js trust proxy 取真实客户端 IP）
 * @param {number} [opts.status=429] 超限 HTTP 状态码
 * @param {string} [opts.message='common.too_many_requests'] 超限 message（i18n 键或中文字面量，未命中键按字面量返回）
 * @param {number} [opts.maxKeys] 键容量上限（FIFO 淘汰，默认 10000）
 * @returns {(req, res, next) => void} Express 中间件
 */
export function rateLimit({
  windowMs = 60 * 1000,
  max = 60,
  keyFn = (req) => req.ip,
  status = 429,
  message = 'common.too_many_requests',
  maxKeys = DEFAULT_MAX_KEYS,
} = {}) {
  const hits = new Map(); // key -> [timestamp, ...]（仅保留窗口内命中时间戳）
  return async (req, res, next) => {
    let key = null;
    try {
      key = await keyFn(req);
    } catch (e) {
      // keyFn 异常按「限频器不可用」放行（fail-open），不阻塞业务；仅告警便于发现配置问题
      logger.warn('[rateLimit] keyFn 失败，本请求跳过限频:', e?.message || e);
      return next();
    }
    if (!key) return next();
    try {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        throw new ApiError(status, message);
      }
      arr.push(now);
      hits.set(key, arr);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return next();
    } catch (err) {
      return next(err); // 超限 ApiError 原样上抛，走统一错误处理（i18n + 状态码）
    }
  };
}
