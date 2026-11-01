import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger, maskKey } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 提交留档根目录（admin 日志管理共用，勿各自另算）
export const LOGS_ROOT = path.resolve(__dirname, '../../logs');

/**
 * 把每次提交给大模型/视频厂商的完整数据写入日志文件（不截断）。
 * 目录：server/logs/<YYYY-MM-DD>/
 * 文件名：<HHmmss_SSS>_<type>_u<userId>_<mode>.json
 * headers 中的 API Key 仍做脱敏处理（Bearer 与裸 token 均脱敏），避免密钥落盘。
 * 异步写入、写失败仅告警，绝不影响主调用流程。
 * @param {object} info { userId, type, mode, url, model, provider?, apiStyle?, msgs?, promptChars?, headers, body, extra? }
 *   provider：视频厂商归位（Seedance/DashScope/MiniMax/ComfyUI/Generic），文本提交不传；
 *   extra：额外并入 payload 的排查字段（如视频提交的 contentTypes/promptHead/genCtx）。
 * @returns {string} 留档文件绝对路径（供 writeResponseLog 经 reqFile 精确配对；构建失败返回空串）
 */
export function writeSubmissionLog(info) {
  try {
    const { now, file } = newLogFile(info, info.mode || 'req');

    // 脱敏 headers 中的鉴权头，避免明文密钥落盘（ComfyUI 契约为裸 token、无 Bearer 前缀）
    const safeHeaders = { ...info.headers };
    if (safeHeaders.Authorization != null) {
      const raw = String(safeHeaders.Authorization);
      safeHeaders.Authorization = /^Bearer\s+/i.test(raw)
        ? `Bearer ${maskKey(raw.replace(/^Bearer\s+/i, ''))}`
        : maskKey(raw);
    }

    const payload = {
      timestamp: now.toISOString(),
      userId: info.userId,
      type: info.type,
      mode: info.mode || 'req',
      provider: info.provider || null,
      url: info.url,
      model: info.model,
      apiStyle: info.apiStyle || null,
      msgs: info.msgs,
      promptChars: info.promptChars,
      headers: safeHeaders,
      body: info.body,
      ...(info.extra || null),
    };
    fs.writeFile(file, JSON.stringify(payload, null, 2), (err) => {
      if (err) logger.warn('[提交日志→写入失败]', file, err.message);
    });
    return file;
  } catch (e) {
    logger.warn('[提交日志→写入异常]', e.message);
    return '';
  }
}

// 生成留档文件绝对路径：<日期目录>/<HHmmss_SSS>_<type>_u<userId>_<mode>.json（目录不存在则创建）
// @returns { now: Date, file: string }
function newLogFile(info, mode) {
  const now = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const dateDir = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`;
  const safeType = String(info.type || 'text').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeUser = String(info.userId ?? 'anon').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(LOGS_ROOT, dateDir);
  fs.mkdirSync(dir, { recursive: true });
  return { now, file: path.join(dir, `${time}_${safeType}_u${safeUser}_${mode}.json`) };
}

// 响应留档 base64 折叠阈值：b64_json 等大产物只留头部 + 长度占位；正文文本不在此截断
const RESP_B64_KEEP = 2000;

// 递归折叠响应中的 base64 长串（data:URL 与裸 base64，单图可达数 MB），其余字符串原样保留
function collapseBase64(value, depth = 0) {
  if (typeof value === 'string') {
    const isB64 = /^data:[^,]{0,64};base64,/i.test(value) || /^[A-Za-z0-9+/=\r\n]+$/.test(value);
    if (isB64 && value.length > RESP_B64_KEEP) {
      return `${value.slice(0, RESP_B64_KEEP)}…(base64，共${value.length}字符已截断)`;
    }
    return value;
  }
  if (Array.isArray(value)) return depth >= 6 ? '[…]' : value.map((v) => collapseBase64(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth >= 6) return '{…}';
    const out = {};
    for (const k of Object.keys(value)) out[k] = collapseBase64(value[k], depth + 1);
    return out;
  }
  return value;
}

/**
 * 把提交后厂商/模型返回的结果写入留档（与 writeSubmissionLog 同目录同机制，文件名 mode 段为 res）。
 * resp 经 base64 折叠（大产物只留头部占位），文本内容保持完整；reqFile 传 writeSubmissionLog
 * 的返回值即可与提交留档精确配对；durationMs 记录本次调用耗时。异步写入、写失败仅告警。
 * @param {object} info { userId, type, provider?, url, model, apiStyle?, resp, reqFile?, durationMs?, extra? }
 * @returns {string} 留档文件绝对路径（构建失败返回空串）
 */
export function writeResponseLog(info) {
  try {
    const { now, file } = newLogFile(info, 'res');
    const payload = {
      timestamp: now.toISOString(),
      userId: info.userId,
      type: info.type,
      mode: 'res',
      provider: info.provider || null,
      url: info.url,
      model: info.model,
      apiStyle: info.apiStyle || null,
      reqFile: info.reqFile || null,
      durationMs: info.durationMs ?? null,
      resp: collapseBase64(info.resp),
      ...(info.extra || null),
    };
    fs.writeFile(file, JSON.stringify(payload, null, 2), (err) => {
      if (err) logger.warn('[返回日志→写入失败]', file, err.message);
    });
    return file;
  } catch (e) {
    logger.warn('[返回日志→写入异常]', e.message);
    return '';
  }
}
