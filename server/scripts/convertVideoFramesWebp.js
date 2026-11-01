/**
 * 存量「视频抽帧图」PNG → WebP 批量迁移脚本（一次性维护工具，配合 ffmpeg.service 抽帧统一 webp 化）。
 *
 * 背景：分镜关键帧(keyframe_url)/尾帧(last_frame_url)/视频素材封面(Asset.image_url, kind=video)
 * 历史上由 ffmpeg 抽帧直出 PNG（1080p 帧单张 2-6MB）。抽帧出口已改为 webp（q90 视觉近无损，
 * 约百 KB 级），本脚本把存量 PNG 迁移到同一规格：sharp 转码 → 更新 DB → 删旧 PNG。
 *
 * 范围（只动 ffmpeg 抽帧产物，AI 生成 4K 资产图/项目封面不在其列）：
 *  - StoryboardSegment.keyframe_url：本地 .png 全转；
 *  - StoryboardSegment.last_frame_url：本地 .png 且 last_frame_source != 'seedance' 才转
 *    （'seedance' 为 provider 原样落盘的尾帧图，语义上「不得修改」，保持字节原样）；
 *  - Asset(kind='video').image_url：本地 .png（上传视频素材的抽帧封面）；
 *    若 thumb_url 指向 <旧png>.thumb.webp，一并重命名为 <新webp>.thumb.webp 并更新（缩略图本体已是 webp，仅改名）。
 *
 * 幂等：目标 .webp 已存在时不重转（断点续跑只补 DB 值与删旧文件）；URL 已是 .webp 的行自动跳过。
 * 顺序保证崩溃安全：先落 .webp → 再改 DB → 最后删 .png（中途失败重跑即可收敛）。
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/convertVideoFramesWebp.js          # 干跑：只列出将变更的行，不写库不写盘
 *   node scripts/convertVideoFramesWebp.js --apply  # 实际执行（单行失败跳过继续，结束汇总）
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { sequelize, default as db } from '../src/db/index.js';
import { ensureColumns, ASSET_THUMB_COLUMNS } from '../src/db/ensureColumns.js';
import { urlToPath, toUrl } from '../src/utils/fileUtil.js';
import { logger } from '../src/utils/logger.js';

const { StoryboardSegment, Asset } = db;
const APPLY = process.argv.includes('--apply');
const WEBP_QUALITY = 90; // 与 ffmpeg.service writeFrame 同规格

// URL -> 本地绝对路径；非本地 /files 路径（远程 http 等）或文件不存在返回 null
function localPath(url) {
  try {
    const p = urlToPath(url);
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const isPng = (url) => /\.png$/i.test(String(url || ''));

/**
 * 单张迁移：png → 同名 .webp（已存在则跳过转码）；返回新 URL（无需/失败返回 null）。
 * @returns {{url:string, pngAbs:string, webpAbs:string, skippedConvert:boolean}|null}
 */
async function migrateImage(url) {
  const pngAbs = localPath(url);
  if (!pngAbs) return null;
  const webpAbs = pngAbs.replace(/\.png$/i, '.webp');
  const skippedConvert = fs.existsSync(webpAbs); // 断点续跑：webp 已落盘只补 DB/清理
  if (!skippedConvert) {
    await sharp(pngAbs).webp({ quality: WEBP_QUALITY }).toFile(webpAbs);
  }
  return { url: toUrl(webpAbs), pngAbs, webpAbs, skippedConvert };
}

async function main() {
  await sequelize.authenticate();
  // assets.thumb_url 由服务启动时 ensureColumns 幂等补列；脚本可能先于服务跑，自保一下
  await ensureColumns(sequelize, 'assets', ASSET_THUMB_COLUMNS);

  const segs = await StoryboardSegment.findAll({
    where: { video_url: { [db.Sequelize.Op.ne]: null } },
    order: [['episode_id', 'ASC'], ['idx', 'ASC']],
    attributes: ['id', 'keyframe_url', 'last_frame_url', 'last_frame_source'],
  });
  const assets = await Asset.findAll({
    where: { kind: 'video', image_url: { [db.Sequelize.Op.ne]: null } },
    attributes: ['id', 'image_url', 'thumb_url'],
  });
  logger.info(`待扫描：分镜 ${segs.length} 条（有 video_url）、视频素材 ${assets.length} 条${APPLY ? '【--apply 实写】' : '【干跑】'}`);

  let converted = 0;    // 实际转码张数
  let relinked = 0;     // webp 已存在、仅补 DB 值的行数
  let freedBytes = 0;   // 删除旧 png 释放的字节
  let skipped = 0;      // 非 png / 文件不在本机 / seedance 原样尾帧
  const failed = [];

  const handle = async (tag, url, commit) => {
    if (!isPng(url)) { skipped += 1; return; }
    const pngAbs = localPath(url);
    if (!pngAbs) { skipped += 1; return; }
    if (!APPLY) { logger.info(`  [dry] ${tag}: ${url}`); converted += 1; return; }
    try {
      const r = await migrateImage(url);
      await commit(r.url);
      const size = fs.statSync(pngAbs).size;
      fs.unlinkSync(pngAbs);
      freedBytes += size;
      if (r.skippedConvert) relinked += 1; else converted += 1;
      logger.info(`  ✓ ${tag} → ${path.basename(r.pngAbs)}${r.skippedConvert ? '（webp 已存在，仅补库）' : ''}`);
    } catch (e) {
      failed.push(`${tag}: ${e?.message || e}`);
      logger.warn(`  ✗ ${tag} 失败跳过: ${e?.message || e}`);
    }
  };

  for (const seg of segs) {
    if (isPng(seg.keyframe_url)) {
      await handle(`seg=${seg.id} keyframe`, seg.keyframe_url, (u) => seg.update({ keyframe_url: u }));
    } else skipped += 1;
    // seedance 尾帧为 provider 原样落盘图（不得修改），保持原格式
    if (isPng(seg.last_frame_url) && seg.last_frame_source !== 'seedance') {
      await handle(`seg=${seg.id} last_frame`, seg.last_frame_url, (u) => seg.update({ last_frame_url: u }));
    } else skipped += 1;
  }

  for (const a of assets) {
    if (!isPng(a.image_url)) { skipped += 1; continue; }
    const oldThumb = a.thumb_url && localPath(a.thumb_url);
    await handle(`asset=${a.id} cover`, a.image_url, async (u) => {
      // 封面改名后缩略图文件名同步归位（<旧png>.thumb.webp → <新webp>.thumb.webp），thumb_url 跟着更新
      let newThumbUrl;
      if (oldThumb && fs.existsSync(oldThumb)) {
        const newThumbAbs = oldThumb.replace(/\.png\.thumb\.webp$/i, '.webp.thumb.webp');
        if (newThumbAbs !== oldThumb && !fs.existsSync(newThumbAbs)) fs.renameSync(oldThumb, newThumbAbs);
        newThumbUrl = toUrl(newThumbAbs === oldThumb ? oldThumb : newThumbAbs);
      }
      await a.update({ image_url: u, ...(newThumbUrl ? { thumb_url: newThumbUrl } : {}) });
    });
  }

  logger.info(
    `迁移完成：转码 ${converted} 张，仅补库 ${relinked} 张，跳过 ${skipped}（非 png/不在本机/seedance 原样），失败 ${failed.length}` +
    `${freedBytes ? `，释放磁盘 ${(freedBytes / 1024 / 1024).toFixed(1)}MB` : ''}` +
    `${APPLY ? '' : '（干跑未写库未写盘，--apply 生效）'}`
  );
  if (failed.length) {
    logger.warn('失败清单：\n  ' + failed.join('\n  '));
  }
  await sequelize.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  logger.error('视频抽帧图 webp 迁移失败:', e);
  process.exit(1);
});
