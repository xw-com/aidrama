/**
 * 积分展示格式化：消除浮点累加噪声（如 9 项 4.2 求和得 37.800000000000004），
 * 最多保留 2 位小数并去掉末尾多余的 0。
 * @param {number|string} n 积分数（可为小数单价×数量的结果）
 * @returns {string} 如「38」「37.8」「4.2」
 */
export function formatCredits(n) {
  const v = Number(n) || 0;
  return String(Math.round(v * 100) / 100);
}

/**
 * 秒数 → 「m:ss」/「h:mm:ss」时长文案（展示中心播放列表 / 接单中心时长展示用）
 * @param {number} seconds
 * @returns {string} 如「0:45」「12:03」「1:02:30」
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
