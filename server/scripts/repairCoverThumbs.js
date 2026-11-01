/**
 * 存量「项目封面缩略图失配」修复脚本（一次性维护工具）。
 *
 * 背景：AI 生成封面 Job 曾只写 project.cover 不重算 cover_thumb，导致列表卡片
 * （三端均 cover_thumb || cover）永久显示旧封面；写点已修复（cover.service.js /
 * project.routes.js PUT /:id），但存量行的 cover_thumb 仍指向旧封面缩略图，
 * 且缩略图扫描线程只补 cover_thumb IS NULL 的行，不会自愈。
 *
 * 判定：cover_thumb 应等于当前 cover 同名旁路缩略图（<cover 路径>.thumb.webp）。
 * 不一致的行一律按当前 cover 重算（makeThumbUrl 幂等）并更新，旧失配文件一并删除。
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/repairCoverThumbs.js          # 干跑：只列出将修复的行，不写库不写盘
 *   node scripts/repairCoverThumbs.js --apply  # 实际执行（单行失败跳过继续，结束汇总）
 */
import { sequelize, default as db } from '../src/db/index.js';
import { ensureColumns, PROJECT_COVER_THUMB_COLUMNS } from '../src/db/ensureColumns.js';
import { urlToPath, toUrl, deleteUrlFiles } from '../src/utils/fileUtil.js';
import { makeThumbUrl } from '../src/services/thumbnail.service.js';
import { logger } from '../src/utils/logger.js';

const apply = process.argv.includes('--apply');

async function main() {
  await ensureColumns(sequelize, 'projects', PROJECT_COVER_THUMB_COLUMNS);
  const projects = await db.Project.findAll({
    where: { cover: { [db.Sequelize.Op.ne]: null } },
    attributes: ['id', 'name', 'cover', 'cover_thumb'],
  });

  let fixed = 0;
  for (const p of projects) {
    const expected = toUrl(`${urlToPath(p.cover)}.thumb.webp`); // 当前 cover 对应的正确缩略图 URL
    if ((p.cover_thumb || '') === expected) continue; // 已一致（含约定位置），跳过
    const staleThumb = p.cover_thumb || '';
    const thumbUrl = await makeThumbUrl(p.cover);
    if (!thumbUrl) {
      logger.warn(`[跳过] 项目 #${p.id}《${p.name}》封面文件缺失或非图片: ${p.cover}`);
      continue;
    }
    logger.info(`[修复] 项目 #${p.id}《${p.name}》cover_thumb: ${staleThumb || '(空)'} → ${thumbUrl}`);
    if (apply) {
      await p.update({ cover_thumb: thumbUrl }, { silent: true });
      // 失配旧缩略图按 URL 删文件（若与正确位置不同名；相同则 makeThumbUrl 幂等复用，不会误删）
      deleteUrlFiles([staleThumb], [thumbUrl]);
    }
    fixed += 1;
  }

  logger.info(`共 ${projects.length} 个有封面项目，${fixed} 个需修复${apply ? '' : '（干跑，未写库；加 --apply 执行）'}`);
  await sequelize.close();
}

main().catch((e) => {
  logger.error(`修复失败: ${e.message}`);
  process.exit(1);
});
