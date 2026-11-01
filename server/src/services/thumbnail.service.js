import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import { urlToPath, toUrl } from '../utils/fileUtil.js';
import { extractFilmCover } from './ffmpeg.service.js';
import { logger } from '../utils/logger.js';

// 列表卡片缩略图管道：把本地图片（资产主图/服饰图/项目封面）生成一张 webp 缩略图，
// 落盘在原图旁边（<原名>.thumb.webp），URL 写入 thumb_url / cover_thumb 列。
// 背景：资产图为 4K 画质 PNG（实测单张 0.5-17MB），资产库/项目卡/展示中心列表直接引用原图，
// 一屏卡片就要拉几十 MB；短边 480 的 webp 约 20-60KB（省 95%+ 流量）。
//
// 两级机制：
//  1) 交互热路径（上传主图/服饰图/封面、AI 生成完成）内联调用 makeThumbUrl 即时生成；
//  2) startThumbScanner 后台线程兜底：补齐存量数据与遗漏写入点（沿用 videoGenScanner 模式）。
// 图片公开直读（mediaSign 只签音视频），thumb_url 无需签名处理。
//
// 成片封面（episode_videos.cover_url）同挂本线程兜底：合成/烧录/剪辑导出时已在写入点即时生成，
// 扫描只补存量行（cover_url 为 null 且已有视频的行）——抽帧比图片缩放慢一个量级，每轮限量。
// 封面生成失败落 ''（falsy，前端回退视频预览），避免对坏片无限重试。

const THUMB_EDGE = 480; // 短边 480：卡片两级显示尺寸的 2x，足够清晰
const SOURCE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.tiff', '.gif']);
const SCAN_INTERVAL_MS = 15 * 1000;
const SCAN_BATCH = 24; // 每轮处理的行数上限（控制 CPU 占用，sharp 单张 4K PNG 约百毫秒级）
const IDLE_INTERVAL_MS = 10 * 60 * 1000; // 无待补行时的复查间隔（新写入点漏挂时最长 10 分钟补上）

/**
 * 为一张本地图片生成缩略图 URL（幂等：已存在直接返回；外链/非图片/失败返回 null）。
 * @param {string} imageUrl /files/... 或绝对路径
 * @returns {Promise<string|null>}
 */
export async function makeThumbUrl(imageUrl) {
  const src = urlToPath(imageUrl);
  if (!src || !SOURCE_EXT.has(path.extname(src).toLowerCase())) return null;
  const thumbAbs = `${src}.thumb.webp`;
  try {
    if (!fs.existsSync(thumbAbs)) {
      await sharp(src)
        .rotate() // 按 EXIF 方向摆正
        .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(thumbAbs);
    }
    return toUrl(thumbAbs);
  } catch (e) {
    logger.warn(`缩略图生成失败（跳过，列表回退原图）: ${path.basename(src)} :: ${e.message}`);
    return null;
  }
}

// ===== 后台扫描线程：补齐存量/遗漏的缩略图 =====
let scanTimer = null;
let scanning = false;

/** 处理一批待补行（三个表轮询）；返回本轮处理的行数（0 = 全部补齐） */
async function processBatch() {
  const { Asset, AssetImage, Project } = db;
  let done = 0;

  const assets = await Asset.findAll({
    where: { image_url: { [db.Sequelize.Op.ne]: null }, thumb_url: null },
    limit: SCAN_BATCH,
    attributes: ['id', 'image_url'],
  });
  for (const a of assets) {
    const u = await makeThumbUrl(a.image_url);
    // 失败也落 ''（falsy，前端回退原图）：避免扫描线程对坏图无限重试
    await a.update({ thumb_url: u || '' }, { silent: true }); // silent：不踩 updated_at，避免打乱「最近更新」排序
    done += 1;
  }
  if (done >= SCAN_BATCH) return done;

  const costumes = await AssetImage.findAll({
    where: { image_url: { [db.Sequelize.Op.ne]: null }, thumb_url: null },
    limit: SCAN_BATCH - done,
    attributes: ['id', 'image_url'],
  });
  for (const c of costumes) {
    const u = await makeThumbUrl(c.image_url);
    await c.update({ thumb_url: u || '' }, { silent: true });
    done += 1;
  }
  if (done >= SCAN_BATCH) return done;

  const projects = await Project.findAll({
    where: { cover: { [db.Sequelize.Op.ne]: null }, cover_thumb: null },
    limit: SCAN_BATCH - done,
    attributes: ['id', 'cover'],
  });
  for (const p of projects) {
    const u = await makeThumbUrl(p.cover);
    await p.update({ cover_thumb: u || '' }, { silent: true });
    done += 1;
  }
  if (done >= SCAN_BATCH) return done;

  // 成片封面兜底：给存量成片行补第一帧封面（封面生成慢，每轮最多兜 4 行防挤压图片队列）
  const { EpisodeVideo: Film, Project: Proj } = db;
  const films = await Film.findAll({
    where: { video_url: { [db.Sequelize.Op.ne]: null }, cover_url: null, hidden: false },
    limit: Math.min(4, SCAN_BATCH - done),
    attributes: ['id', 'video_url', 'project_id'],
  });
  if (films.length) {
    // 画幅按各自项目的 aspect_ratio 算（批量一次拉齐，避免逐行查询）
    const projIds = [...new Set(films.map((f) => f.project_id).filter(Boolean))];
    const aspects = new Map((await Proj.findAll({
      where: { id: { [db.Sequelize.Op.in]: projIds } },
      attributes: ['id', 'aspect_ratio'],
    })).map((p) => [p.id, p.aspect_ratio]));
    for (const f of films) {
      let u = null;
      try {
        const src = urlToPath(f.video_url);
        if (src && fs.existsSync(src)) u = toUrl(await extractFilmCover(src, aspects.get(f.project_id) || '9:16'));
      } catch (e) {
        logger.warn(`成片封面生成失败（跳过）: film#${f.id} :: ${e.message}`);
      }
      // 失败也落 ''（falsy，前端回退视频预览）：避免扫描线程对坏片无限重试
      await f.update({ cover_url: u || '' }, { silent: true });
      done += 1;
    }
  }
  return done;
}

async function tick() {
  if (scanning) return;
  scanning = true;
  try {
    const n = await processBatch();
    // 还有剩余 → 保持快间隔继续；补齐了 → 拉长间隔省 CPU（新数据通常由写入点即时生成）
    reschedule(n > 0 ? SCAN_INTERVAL_MS : IDLE_INTERVAL_MS);
  } catch (e) {
    logger.warn(`缩略图扫描线程异常（下轮重试）: ${e.message}`);
    reschedule(IDLE_INTERVAL_MS);
  } finally {
    scanning = false;
  }
}

function reschedule(ms) {
  if (!scanTimer) return; // 已 stop
  clearInterval(scanTimer);
  scanTimer = setInterval(tick, ms);
}

export function startThumbScanner() {
  if (scanTimer) return;
  scanTimer = setInterval(tick, SCAN_INTERVAL_MS);
  // 启动后先给正常请求让路，稍等再开扫
  setTimeout(tick, 5 * 1000);
}

export function stopThumbScanner() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}
