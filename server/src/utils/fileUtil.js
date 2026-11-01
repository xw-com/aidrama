import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';

export function ensureDirs() {
  [config.uploadDir, config.outputDir].forEach((d) => {
    fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true });
  });
}

// 生成安全的文件名
export function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// 生成唯一文件路径
export function genFilePath(dir, ext, prefix = 'file') {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${prefix}_${stamp}_${rand}.${ext.replace(/^\./, '')}`;
  const absDir = path.resolve(process.cwd(), dir);
  fs.mkdirSync(absDir, { recursive: true });
  return { filename, absPath: path.join(absDir, filename) };
}

// 把本地相对/绝对路径转换为可访问的 URL
// 注意：统一返回相对路径（/files/...），不拼接 publicBaseUrl——
// 入库 URL 保持相对，避免换域名/端口后历史数据失效；外部 http(s) URL 原样透传
export function toUrl(absPath) {
  if (!absPath) return null;
  if (/^https?:\/\//.test(absPath)) return absPath;
  const cwd = process.cwd();
  let rel = path.isAbsolute(absPath) ? path.relative(cwd, absPath) : absPath;
  rel = rel.replace(/\\/g, '/');
  if (rel.startsWith('data/')) rel = rel.replace(/^data\//, '');
  return `/files/${rel}`;
}

// 把 URL 转换回本地绝对路径（用于后续 ffmpeg 处理）。
// 仅接受两类输入：本服务相对路径 /files/<...>；本服务绝对 URL（localhost/127.0.0.1 或与
// PUBLIC_BASE_URL 同源）且路径以 /files/ 开头。其余（外链、仅含 "/files/" 字样的任意绝对 URL）一律
// 返回 null，避免被误映射成本地文件；解码后须仍落在 data 根目录内（防 ../ 越界读写任意文件）。
export function urlToPath(url) {
  if (!url) return null;
  const raw = String(url);
  let pathname = null;
  if (raw.startsWith('/files/')) {
    pathname = raw.split('?')[0].split('#')[0]; // 相对路径无 URL 解析器兜底，手动剥 query/fragment
  } else if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      let ours = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
      if (!ours && config.publicBaseUrl) {
        try { ours = u.origin === new URL(config.publicBaseUrl).origin; } catch { /* base 非法视为不同源 */ }
      }
      if (ours) pathname = u.pathname;
    } catch {
      return null;
    }
  }
  if (!pathname || !pathname.startsWith('/files/')) return null;
  let rel = pathname.slice('/files/'.length);
  try { rel = decodeURIComponent(rel); } catch { return null; } // 非法编码序列不猜
  const root = path.resolve(process.cwd(), 'data');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null; // 越界（../ 等）拒绝
  return abs;
}

// 批量删除一批 URL 对应的本地磁盘文件（删除记录时同步清理，避免孤儿文件）：
// 自动去重、跳过空值与外链；keepUrls 为仍被其他记录引用的 URL，保留不删；文件缺失不阻断
export function deleteUrlFiles(urls, keepUrls = []) {
  const keep = new Set(keepUrls.filter(Boolean));
  const seen = new Set();
  for (const url of urls) {
    if (!url || seen.has(url) || keep.has(url)) continue;
    seen.add(url);
    const p = urlToPath(url);
    if (!p) continue;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 文件缺失不阻断 */ }
  }
}
