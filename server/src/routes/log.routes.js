import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { asyncHandler, ok, badRequest, notFound } from '../utils/index.js';
import { adminAuthRequired } from '../middleware/auth.js';
import { LOGS_ROOT } from '../utils/submitLog.js';

const router = Router();

// 目录名与文件名走严格白名单校验，杜绝路径穿越（date 为日期目录、name 为 submitLog 生成的文件名）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/;
// <HHmmss_SSS>_<type>_u<userId>_<mode>.json（如 082726_142_text_u1_req.json）
const FILE_RE = /^(\d{6}_\d{3})_([A-Za-z0-9_-]+)_u([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)\.json$/;

function assertDate(date) {
  if (!DATE_RE.test(String(date || ''))) throw badRequest();
  return String(date);
}

function assertName(name) {
  const s = String(name || '');
  if (!NAME_RE.test(s) || s.includes('..')) throw badRequest();
  return s;
}

function resolveFile(date, name) {
  return path.join(LOGS_ROOT, assertDate(date), assertName(name));
}

// 解析文件名 → { time, type, userId, mode }；不合式（历史/人工文件）字段留空仍可见
function parseFileName(name) {
  const m = FILE_RE.exec(name);
  if (!m) return { time: '', type: '', userId: '', mode: '' };
  return { time: m[1].replace('_', '.'), type: m[2], userId: m[3], mode: m[4] };
}

async function listDateFiles(date) {
  const dir = path.join(LOGS_ROOT, date);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    return []; // 目录不存在按空处理
  }
  const files = await Promise.all(
    names
      .filter((n) => NAME_RE.test(n) && !n.includes('..'))
      .map(async (n) => {
        const st = await fs.promises.stat(path.join(dir, n));
        return st.isFile()
          ? { name: n, sizeBytes: st.size, mtimeMs: st.mtimeMs, ...parseFileName(n) }
          : null;
      })
  );
  // 文件名前缀即时间戳，字典序倒序 = 新的在前
  return files.filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
}

// 日期目录概览（含每日文件数/占用），供下拉选择与磁盘统计
router.get('/dates', adminAuthRequired, asyncHandler(async (req, res) => {
  let dates = [];
  try {
    dates = (await fs.promises.readdir(LOGS_ROOT)).filter((d) => DATE_RE.test(d));
  } catch (e) {
    return ok(res, { list: [], totalCount: 0, totalBytes: 0 }); // 根目录尚不存在
  }
  const list = await Promise.all(dates.map(async (date) => {
    const files = await listDateFiles(date);
    return {
      date,
      count: files.length,
      sizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    };
  }));
  list.sort((a, b) => b.date.localeCompare(a.date));
  return ok(res, {
    list,
    totalCount: list.reduce((s, d) => s + d.count, 0),
    totalBytes: list.reduce((s, d) => s + d.sizeBytes, 0),
  });
}));

// 某日文件列表（type 筛选 + page/size 分页，遵循项目分页约定）
router.get('/files', adminAuthRequired, asyncHandler(async (req, res) => {
  const date = assertDate(req.query.date);
  const type = String(req.query.type || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const size = Math.min(200, Math.max(1, parseInt(req.query.size || '20', 10)));
  let files = await listDateFiles(date);
  const types = [...new Set(files.map((f) => f.type).filter(Boolean))].sort();
  if (type) files = files.filter((f) => f.type === type);
  return ok(res, {
    list: files.slice((page - 1) * size, page * size).map(({ mtimeMs, ...f }) => f),
    total: files.length,
    types,
    page,
    size,
  });
}));

// 单文件详情：后端解析好 JSON（写盘时即为格式化 JSON），解析失败兜底原始文本
router.get('/detail', adminAuthRequired, asyncHandler(async (req, res) => {
  const file = resolveFile(req.query.date, req.query.name);
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    throw notFound();
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) { /* 保留原始文本 */ }
  const st = await fs.promises.stat(file);
  return ok(res, {
    name: path.basename(file),
    date: assertDate(req.query.date),
    sizeBytes: st.size,
    parsed: parsed !== null,
    content: parsed !== null ? parsed : text,
  });
}));

// 删除单个留档文件
router.delete('/file', adminAuthRequired, asyncHandler(async (req, res) => {
  const file = resolveFile(req.query.date, req.query.name);
  await fs.promises.unlink(file).catch((e) => {
    if (e.code === 'ENOENT') throw notFound();
    throw e;
  });
  return ok(res, { name: path.basename(file) });
}));

// 清理整个日期目录
router.delete('/date/:date', adminAuthRequired, asyncHandler(async (req, res) => {
  const date = assertDate(req.params.date);
  const dir = path.join(LOGS_ROOT, date);
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw notFound();
  await fs.promises.rm(dir, { recursive: true });
  return ok(res, { date });
}));

export default router;
