// /files 媒体防盗链：nginx secure_link 时效签名（deploy/nginx.conf 同密钥校验）。
// 仅视频/音频需要签名，图片公开直读；扩展名清单与 nginx 侧正则须保持同步：
// 覆盖上传白名单（voice.routes / asset.routes 的 mime→ext）与生成产物（mp4/mp3 等）。
// 未配置 FILE_SIGN_SECRET 时一律原样返回（本地开发零影响，nginx 侧也就不部署校验块）。
import crypto from 'crypto';
import { config } from '../config/index.js';

// 须签名的媒体扩展名（与 deploy/nginx.conf 的 secure_link location 正则保持一致）
const MEDIA_EXT_RE = /^\/files\/[^\s?#]*\.(mp4|mov|webm|m4v|avi|mkv|ts|mp3|wav|m4a|aac|flac|ogg)$/i;

// 前端出口 TTL：须覆盖一次播放会话（拖动进度条会带原 URL 重发 Range 请求，过期即中断）
export const MEDIA_SIGN_TTL_MS = 6 * 60 * 60 * 1000;
// 提交厂商拉取 TTL：厂商任务与重试可能耗时数小时，放长到 24h
export const MEDIA_SIGN_PROVIDER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 给本服务 /files 媒体 URL（相对或绝对均可）追加时效签名：?expires=<秒>&sign=<base64url>。
 * 算法与 nginx secure_link_md5 "$secure_link_expires$uri <SECRET>" 一字不差：
 * md5(expires + 解码后路径 + 空格 + 密钥) → base64url（+/→-_、去 padding）。
 * 非媒体（图片/外链/已带签名的 URL）原样返回，幂等安全。
 */
export function signMediaUrl(url, ttlMs = MEDIA_SIGN_TTL_MS) {
  const raw = String(url || '');
  if (!config.fileSignSecret) return raw;
  const bare = raw.split('?')[0].split('#')[0];
  let pathname = null;
  if (MEDIA_EXT_RE.test(bare)) {
    pathname = bare;
  } else if (/^https?:\/\//i.test(bare)) {
    try {
      const u = new URL(bare);
      if (MEDIA_EXT_RE.test(u.pathname)) pathname = u.pathname;
    } catch { /* 非法 URL 原样返回 */ }
  }
  if (!pathname) return raw;
  // expires 按小时取桶（整点 + TTL）：同一桶内所有响应签名完全一致，前端轮询/刷新
  // 拿到的 URL 字符串不变，<video :src> 不会因签名差异被整表替换触发重载重播。
  // 实际有效期在 ttl ~ ttl+1h 之间，nginx secure_link 只校验未过期，语义不变。
  const HOUR_MS = 3600 * 1000;
  const bucket = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
  const expires = Math.floor((bucket + ttlMs) / 1000);
  let uri = pathname;
  try { uri = decodeURIComponent(pathname); } catch { /* 非法编码序列按原路径签 */ }
  const sign = crypto.createHash('md5')
    .update(`${expires}${uri} ${config.fileSignSecret}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${bare}?expires=${expires}&sign=${sign}`;
}

// 递归遍历响应体，就地给媒体 URL 追加签名；非字符串/非媒体节点零改动
function walkSign(node) {
  if (node == null) return node;
  if (typeof node === 'string') return signMediaUrl(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = walkSign(node[i]);
    return node;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = walkSign(node[k]);
    return node;
  }
  return node;
}

/**
 * API 出口统一签名中间件：拦一层 res.json 递归签名（所有路由均经 ok()/res.json 出参）。
 * DB 与内部流转始终存裸路径，签名只发生在出参瞬间；SSE 流（纯文本 delta）不经 res.json，天然不受影响。
 */
export const mediaSignMiddleware = (req, res, next) => {
  if (!config.fileSignSecret) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    try { walkSign(body); } catch { /* 签名异常不阻断响应 */ }
    return origJson(body);
  };
  next();
};
