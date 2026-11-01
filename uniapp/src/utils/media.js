/**
 * 媒体地址工具：服务端 DB 存 /files 相对路径，出口带 secure_link 签名。
 * uniapp 端不是同源（尤其小程序/App），播放与展示前统一转绝对 URL。
 */
import { API_ORIGIN } from '../api/config';
// H5 端 API_ORIGIN 随 VITE_API_BASE：相对路径时为当前源站（走代理），绝对地址时为该源站
const ORIGIN = API_ORIGIN;

export function toAbsolute(url) {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  if (url.startsWith('/')) return ORIGIN + url;
  return url;
}

/** 生成 CSS 渐变兜底封面色（从 client ShowcaseView COVER_PALETTES 移植） */
export const COVER_PALETTES = [
  'linear-gradient(160deg,#171129 0%,#241539 55%,#3a1d54 100%)',
  'linear-gradient(160deg,#0d1e26 0%,#123240 60%,#155e63 100%)',
  'linear-gradient(160deg,#2a0f1a 0%,#401525 60%,#591c2e 100%)',
  'linear-gradient(160deg,#1d1709 0%,#33260d 55%,#4a3a14 100%)',
  'linear-gradient(160deg,#101d18 0%,#153028 60%,#1d4a3c 100%)',
  'linear-gradient(160deg,#0f1424 0%,#16204a 60%,#233a7a 100%)',
];
export function coverPalette(seed) {
  const n = String(seed || '')
    .split('')
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  return COVER_PALETTES[n % COVER_PALETTES.length];
}

/** 画幅字符串 → 数字比例（client ShowcaseDetailView L40-45 移植） */
export function aspectRatioOf(str) {
  const [w, h] = String(str || '9:16').split(':').map((x) => parseFloat(x));
  if (!w || !h) return 9 / 16;
  return w / h;
}
