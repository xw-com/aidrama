/** 积分数字格式化：消浮点噪声，最多两位小数（从 client/utils/format.js 原样移植） */
export function formatCredits(n) {
  if (n === null || n === undefined || n === '') return '0';
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(Math.round(v * 100) / 100);
}

/** 秒 → m:ss / h:mm:ss */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** 时间码 / 镜号等宽格式 */
export function formatClock(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}`;
}

/** 毫秒 → mm:ss.mmm / h:mm:ss.mmm（剪辑器播放头读数；自 client VideoEditorView fmtMs 移植） */
export function formatTimecode(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mmm = String(ms % 1000).padEnd(3, '0').slice(0, 3);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}.${mmm}` : `${pad(m)}:${pad(s)}.${mmm}`;
}

/**
 * 播放量紧凑展示：zh 系用 万/亿，其余用 K/M（万 unit 无对应译名）
 */
export function formatViews(n, locale = 'zh-CN') {
  const num = Number(n) || 0;
  const zh = /^zh/i.test(locale);
  if (zh) {
    if (num >= 1e8) return (num / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (num >= 1e4) return (num / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  } else {
    if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return String(num);
}
