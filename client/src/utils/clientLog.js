/**
 * 前端异常/告警统一上报通道：reportClientLog(level, message, stack)
 * - 开发环境只走 console（不打后端，避免本地联调噪音）
 * - 生产环境 POST /api/client-log（204、无需鉴权）；裸 fetch 不带鉴权头，
 *   失败静默（_silent 语义天然成立，绝不上报失败再报错形成递归）
 * - 30 秒窗口最多 5 条，超限静默丢弃，防止循环报错刷爆服务端
 */

const DEV = import.meta.env.DEV;
const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const WINDOW_MS = 30000;
const MAX_PER_WINDOW = 5;

let windowStart = 0;
let sentInWindow = 0;

// 统一转字符串并截断（Error 取 message，其余 String()），避免超大负载打爆请求体
function toStr(v, max) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : (typeof v === 'object' && typeof v.message === 'string' ? v.message : String(v));
  return s.slice(0, max);
}

export function reportClientLog(level, message, stack) {
  const lv = level === 'warn' ? 'warn' : 'error';
  const text = toStr(message, 2000) || '(no message)';
  // 本地始终留痕：开发排错 / 生产远程控制台都能看到
  if (lv === 'warn') console.warn(`[client] ${text}`);
  else console.error(`[client] ${text}`);
  if (DEV) return;

  const now = Date.now();
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= MAX_PER_WINDOW) return; // 防风暴：超限丢弃
  sentInWindow += 1;

  try {
    const body = { level: lv, message: text, url: window.location.href };
    const st = toStr(stack, 8000);
    if (st) body.stack = st;
    fetch(`${API_BASE}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* 上报失败静默 */ });
  } catch { /* 上报永不影响主流程 */ }
}

function fmtErr(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return toStr(err, 2000) || '(unknown error)';
}

/**
 * 安装全局兜底：app.config.errorHandler + window unhandledrejection / error。
 * 前台与 admin 两个独立入口的 main.js 各自调用一次。
 */
export function installGlobalErrorReporting(app) {
  if (app) {
    app.config.errorHandler = (err, _instance, info) => {
      reportClientLog('error', `[vue:${info}] ${fmtErr(err)}`, err instanceof Error ? err.stack : undefined);
    };
  }
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    reportClientLog('error', `[unhandledrejection] ${fmtErr(r)}`, r instanceof Error ? r.stack : undefined);
  });
  window.addEventListener('error', (e) => {
    // e.target 存在且非 window 的多为资源加载失败（img/script/video 404 等），降级为 warn
    const t = e?.target;
    if (t && t !== window && (t.src || t.href)) {
      reportClientLog('warn', `[resource] ${(t.tagName || '').toLowerCase()} load failed: ${t.src || t.href}`);
      return;
    }
    reportClientLog('error', `[window.error] ${fmtErr(e?.error || e?.message)}`, e?.error instanceof Error ? e.error.stack : undefined);
  });
}
