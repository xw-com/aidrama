// 客户端公共支撑接口：版本检查（/app/check-update）+ 客户端日志上报（/client-log）。
// 两者均 authOptional（公开）：版本检查供启动页/设置页未登录即可调用；日志上报在登录过期时也要能收。
// 注意：AppConfig KV 只在 admin 后台维护（本文件只读），无写入端点。
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authOptional } from '../middleware/auth.js';
import { rateLimit } from '../utils/rateLimit.js';
import { getConfig } from '../services/appConfig.service.js';
import { LOGS_ROOT } from '../utils/submitLog.js';

const router = Router();

// —— 版本检查：GET /api/app/check-update?platform=android|ios|harmony&current=x.y.z ——
// 数据源：AppConfig KV key=app_release（admin 后台可改），值为 JSON：
//   { "version": "1.2.0", "notes": "更新说明", "url_android": "https://...", "url_ios": "https://...", "url_harmony": "https://...", "force": false }
// 响应 data：{ hasUpdate, latest, notes, url, force }；url 按 platform 选，
// iOS 未配 url_ios 时 hasUpdate 仍可为 true 但 url 为空（客户端 iOS 据此不弹更新框）。
// 无 KV 记录 / platform 非法 / JSON 坏 → hasUpdate:false（客户端静默跳过）。

/** 简单 semver 比较点分数字逐段比：latest > current → true（非数字段按 0，前缀 v 容忍） */
function isNewerVersion(latest, current) {
  const parse = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map((n) => {
    const i = parseInt(n, 10);
    return Number.isFinite(i) ? i : 0;
  });
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

const noUpdate = { hasUpdate: false, latest: null, notes: null, url: null, force: false };

router.get('/app/check-update', authOptional, asyncHandler(async (req, res) => {
  const platform = ['android', 'ios', 'harmony'].includes(req.query.platform) ? req.query.platform : null;
  if (!platform) return ok(res, noUpdate);

  const raw = await getConfig('app_release', null);
  if (!raw) return ok(res, noUpdate);
  let rel = null;
  try { rel = JSON.parse(raw); } catch { return ok(res, noUpdate); }
  const latest = String(rel?.version || '').trim();
  if (!latest) return ok(res, noUpdate);

  const hasUpdate = isNewerVersion(latest, req.query.current);
  const urlKey = platform === 'android' ? 'url_android' : platform === 'ios' ? 'url_ios' : 'url_harmony';
  const url = String(rel?.[urlKey] || '').trim() || null;
  // iOS 未配 url_ios：hasUpdate 仍按版本号判定为 true，url 为空由客户端 iOS 侧「不弹」
  return ok(res, { hasUpdate, latest, notes: String(rel?.notes || '') || null, url, force: !!rel?.force });
}));

// —— 客户端日志上报：POST /api/client-log ——
// body 白名单 { level('error'|'warn'), message(≤2000字), stack(≤8000), url(≤500) }，
// 追加写 logs/client/<YYYY-MM-DD>.jsonl（带 ts/ip/ua），响应 204。目录自动创建。
// 限频：每 IP 30 次/分钟（公开接口，防刷爆磁盘；key 用 req.ip，trust proxy 后即真实客户端 IP）
const clientLogLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, keyFn: (req) => req.ip, message: 'common.too_many_requests' });

const CLIENT_LOG_DIR = path.join(LOGS_ROOT, 'client');

/** 本地日期（按服务器时区，与运维日志日期口径一致），非 UTC */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

router.post('/client-log', authOptional, clientLogLimiter, asyncHandler(async (req, res) => {
  const level = req.body?.level;
  if (level !== 'error' && level !== 'warn') throw badRequest('common.bad_request');
  const message = String(req.body?.message || '').trim();
  if (!message) throw badRequest('common.bad_request');
  const stack = String(req.body?.stack || '').slice(0, 8000);
  const url = String(req.body?.url || '').slice(0, 500);
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(stack ? { stack } : {}),
    ...(url ? { url } : {}),
    ip: req.ip,
    ua: String(req.headers['user-agent'] || ''),
  });

  // 追加写（异步，失败仅告警——日志上报绝不能反过来打断客户端请求）
  try {
    fs.mkdirSync(CLIENT_LOG_DIR, { recursive: true });
    fs.appendFile(path.join(CLIENT_LOG_DIR, `${localDate()}.jsonl`), entry + '\n', () => {});
  } catch (e) {
    console.warn('[client-log] 写入失败:', e?.message || e);
  }
  return res.status(204).end();
}));

export default router;
