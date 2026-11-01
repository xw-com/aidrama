/**
 * 存量分镜「尾帧」回填脚本（一次性维护工具）。
 *
 * 背景：跨镜首尾帧延续已放宽为「上一镜有尾帧即作起始帧参考图」（不再要求 last_frame_source='seedance'），
 * 但存量分镜普遍缺 last_frame_url / last_frame_source（历史生成早于该字段），导致单段/批量生成依旧不带起始帧。
 *
 * 本脚本对「已生成视频且视频文件在本机存在」的分镜做两类回填（幂等，可重复执行）：
 *  1) last_frame_url 为空或其文件已丢失 → ffmpeg 抽最后一帧落 uploads，回填 url + last_frame_source='ffmpeg'；
 *  2) last_frame_url 与文件均在、仅 last_frame_source 为空（历史抽帧早于来源字段）→ 只补记 last_frame_source='ffmpeg'。
 * 视频文件不在本机的分镜（如生产部署上的成片）跳过并告警——须在对应部署机上运行本脚本才能覆盖。
 *
 * 用法：
 *   node scripts/backfillLastFrames.js          # 干跑：只统计与列出将变更的行，不写库不落文件
 *   node scripts/backfillLastFrames.js --apply  # 实际写库（逐段 update，单段失败跳过继续）
 */
import fs from 'fs';
import { sequelize, default as db } from '../src/db/index.js';
import { config } from '../src/config/index.js';
import { logger } from '../src/utils/logger.js';
import { setFfmpegPath, extractLastFrame } from '../src/services/ffmpeg.service.js';
import { toUrl, urlToPath, genFilePath } from '../src/utils/fileUtil.js';

const { StoryboardSegment } = db;
const APPLY = process.argv.includes('--apply');

// URL -> 本地绝对路径；非本地 /files 路径（远程 http 等）返回 null
function localPath(url) {
  try {
    const p = urlToPath(url);
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

async function main() {
  if (config.ffmpegPath) setFfmpegPath(config.ffmpegPath);
  await sequelize.authenticate();

  const segs = await StoryboardSegment.findAll({
    where: { video_url: { [db.Sequelize.Op.ne]: null } },
    order: [['episode_id', 'ASC'], ['idx', 'ASC']],
  });
  logger.info(`待扫描分镜 ${segs.length} 条（有 video_url）${APPLY ? '【--apply 实写】' : '【干跑】'}`);

  let extracted = 0;   // 补抽尾帧 + 回填
  let labeled = 0;     // 仅补记 last_frame_source
  let skippedRemote = 0; // 视频不在本机，跳过
  let skippedDone = 0; // 已完整，无需处理
  let failed = 0;

  for (const seg of segs) {
    const videoPath = localPath(seg.video_url);
    if (!videoPath) {
      skippedRemote += 1;
      if (APPLY === false && skippedRemote <= 3) logger.warn(`  例：seg=${seg.id} 视频不在本机，跳过: ${seg.video_url}`);
      continue;
    }

    const lastOk = seg.last_frame_url && localPath(seg.last_frame_url);
    // 2) 尾帧文件在、仅来源空：补记来源即可，无需重抽
    if (lastOk && !seg.last_frame_source) {
      if (APPLY) await seg.update({ last_frame_source: 'ffmpeg' });
      labeled += 1;
      continue;
    }
    // 已完整（有尾帧有来源）：幂等跳过
    if (lastOk && seg.last_frame_source) { skippedDone += 1; continue; }

    // 1) 无尾帧（或尾帧文件丢失）：ffmpeg 抽最后一帧
    try {
      if (!APPLY) { extracted += 1; continue; }
      const { absPath } = genFilePath(config.uploadDir, 'webp', 'seg');
      await extractLastFrame(videoPath, absPath);
      await seg.update({ last_frame_url: toUrl(absPath), last_frame_source: 'ffmpeg' });
      extracted += 1;
    } catch (e) {
      failed += 1;
      logger.warn(`seg=${seg.id} 抽帧失败，跳过: ${e?.message || e}`);
    }
  }

  logger.info(`回填完成：补抽尾帧 ${extracted}，仅补记来源 ${labeled}，已完整跳过 ${skippedDone}，视频不在本机跳过 ${skippedRemote}，失败 ${failed}${APPLY ? '' : '（干跑未写库，--apply 生效）'}`);
  await sequelize.close();
  process.exit(0);
}

main().catch((e) => {
  logger.error('尾帧回填失败:', e);
  process.exit(1);
});
