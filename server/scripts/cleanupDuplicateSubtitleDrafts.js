/**
 * 存量「同源重复字幕草稿」清理脚本（一次性维护工具）。
 *
 * 背景：字幕提取后端曾不做查重（防重只靠前端禁用 CC 入口），多端/多标签与
 * 任务完成到成片列表刷新的间隙下重复提交，同一成片落了多张内容相同的字幕
 * 草稿（episode_videos，kind='subtitle'、source_job_id 相同）。提交侧已加
 * 幂等拦截（POST /videos/:jobId/subtitle → video.subtitle_exists），本脚本
 * 清理存量重复行。
 *
 * 判定（两轮，各自独立分组，组内 >1 条即为重复）：
 *   ① 按 job_id 分组（同一提取 Job 只应落一行；source_job_id 为 NULL 的行只有这轮能查到）
 *   ② 按 source_job_id 分组（不同提取任务落在同一源成片上）
 * 每组按保留优先级留一条，其余软隐藏（hidden=1，行保留供审计，不物理删行）：
 *   已烧录(video_url 非空) > 已智能校正(corrected) > created_at 新 > id 大。
 * 不同 source_job_id（如原片与其剪辑版各提一条草稿）不算重复，不动。
 *
 * 用法（在 server/ 目录下执行，MySQL / sqlite 皆可，走 ORM）：
 *   node scripts/cleanupDuplicateSubtitleDrafts.js           # 干跑：只列出重复组与保留/隐藏计划
 *   node scripts/cleanupDuplicateSubtitleDrafts.js --apply   # 实际执行
 *   加 --files 一并删除被隐藏行的 mp4/srt/ass 文件（默认保留文件，仅软隐藏）
 *   node scripts/cleanupDuplicateSubtitleDrafts.js --audit   # 只审计：按集列出全部字幕行与源成片归属链
 */
import { sequelize, default as db } from '../src/db/index.js';
import { deleteUrlFiles } from '../src/utils/fileUtil.js';
import { logger } from '../src/utils/logger.js';

const apply = process.argv.includes('--apply');
const cleanFiles = process.argv.includes('--files');
const audit = process.argv.includes('--audit');

// 保留优先级：烧录 2 > 校正 1 > 纯草稿 0（同分再比 created_at 新、id 大）
const rank = (r) => (r.video_url ? 2 : 0) + (r.corrected ? 1 : 0);
const ts = (r) => new Date(r.created_at).getTime();
const desc = (r) =>
  `#${r.id} job=${r.job_id ?? '-'} ${r.video_url ? '已烧录' : r.corrected ? '已校正草稿' : '草稿'} ` +
  `${new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ')} ${r.segments_count ?? 0}段`;

// 审计模式：按集列出全部成片行与字幕行的源归属链（不改任何数据）。
// 用于定位「一张草稿卡看起来重复」到底是两行不同来源的草稿，还是别的问题。
async function auditMode() {
  const [rows, projects, episodes] = await Promise.all([
    db.EpisodeVideo.findAll({ order: [['created_at', 'ASC']] }),
    db.Project.findAll({ attributes: ['id', 'name'] }),
    db.Episode.findAll({ attributes: ['id', 'idx', 'title'] }),
  ]);
  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const epLabel = new Map(episodes.map((e) => [e.id, `${e.idx ?? '?'}-${e.title || ''}`]));
  const kindName = { compose: '原片', edit: '剪辑版', subtitle: '字幕', segment: '分镜' };
  const byJob = new Map(); // job_id -> 行（源链回溯用；含已隐藏行，标「已删」）
  for (const r of rows) if (r.job_id != null) byJob.set(String(r.job_id), r);
  const chainOf = (srcId, depth = 0) => {
    if (srcId == null || depth > 5) return '';
    const f = byJob.get(String(srcId));
    if (!f) return `← job=${srcId}(无落档行)`;
    return `← ${kindName[f.kind] || f.kind}(job=${f.job_id}${f.hidden ? ',已删' : ''})${chainOf(f.source_job_id, depth + 1)}`;
  };

  const groups = new Map(); // "项目id/集id" -> 未隐藏行
  for (const r of rows) {
    if (r.hidden) continue;
    const k = `${r.project_id ?? '-'}/${r.episode_id ?? '-'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let flagged = 0;
  for (const [k, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const subs = list.filter((r) => r.kind === 'subtitle');
    const drafts = subs.filter((r) => !r.video_url);
    const [pid, eid] = k.split('/').map(Number);
    logger.info(`■ 项目#${pid}《${projName.get(pid) || '?'}》 集#${eid}《${epLabel.get(eid) || '?'}》 成片 ${list.length} 行（字幕 ${subs.length}，草稿 ${drafts.length}）`);
    for (const r of list) {
      const label = r.kind === 'subtitle' ? (r.video_url ? '字幕版' : '字幕草稿') : (kindName[r.kind] || r.kind);
      logger.info(
        `   ${label} #${r.id} job=${r.job_id ?? '-'} src=${r.source_job_id ?? '-'}${chainOf(r.source_job_id)}` +
        ` | ${r.corrected ? '已校正 ' : ''}${r.segments_count || 0}段/${Math.round(r.duration || 0)}s | ${new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ')}`,
      );
    }
    if (drafts.length > 1) {
      flagged += 1;
      logger.info(`   ⚠ 同集 ${drafts.length} 条草稿：源成片不同（提交侧按归属各自放行），列表会出现多张「草稿」卡——按上方 src= 归属链核对各自来自哪条成片`);
    }
  }
  // 同一 Job 落了多行（DB 层重复，唯一索引 episode_videos_kind_job_uidx 防的就是它；
  // source_job_id 为 NULL 的重复行在上面的归属链里显示为 src=-，这里按 Job 再兜一道）
  const byJobGroups = new Map();
  for (const r of rows) {
    if (r.hidden || r.job_id == null) continue;
    const k = `${r.kind}/${r.job_id}`;
    if (!byJobGroups.has(k)) byJobGroups.set(k, []);
    byJobGroups.get(k).push(r);
  }
  for (const [k, list] of byJobGroups) {
    if (list.length <= 1) continue;
    flagged += 1;
    logger.info(`⚠ 同 Job 重复行 ${k} 共 ${list.length} 条：${list.map(desc).join(' | ')}`);
  }
  logger.info(`审计完成：${groups.size} 个项目/集组合，${flagged} 个可疑组（--audit 只读不改）`);
  await sequelize.close();
}

async function main() {
  if (audit) return auditMode();
  // 两轮共用：加载全部未隐藏字幕草稿行（含 source_job_id 为 NULL 的行）
  const rows = await db.EpisodeVideo.findAll({ where: { kind: 'subtitle', hidden: false } });
  if (!rows.length) {
    logger.info('没有 kind=subtitle 的未隐藏草稿行，无事可做');
    await sequelize.close();
    return;
  }

  // 通用分组处理：groupOf(row) 给出分组键；键为 null 跳过（不参与该轮）
  let toHide = 0;
  let failed = 0;
  let groupCount = 0;
  const runPass = async (label, groupOf) => {
    const groups = new Map();
    for (const r of rows) {
      if (r.hidden) continue; // 前一轮可能已隐藏
      const k = groupOf(r);
      if (k == null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => rank(b) - rank(a) || ts(b) - ts(a) || b.id - a.id);
    }
    const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1);
    for (const [key, list] of dupGroups) {
      const [keep, ...losers] = list;
      groupCount += 1;
      logger.info(`[${label}] ${key} 共 ${list.length} 条：保留 ${desc(keep)}`);
      for (const r of losers) {
        logger.info(`    隐藏 ${desc(r)}`);
        toHide += 1;
        r.hidden = true; // 先记内存标记：干跑下后续轮次也可见，计划不重复计行
        if (!apply) continue;
        try {
          if (cleanFiles) deleteUrlFiles([r.video_url, r.srt_url, r.ass_url]);
          await r.update({ hidden: 1 });
        } catch (e) {
          failed += 1;
          logger.warn(`    隐藏失败（跳过继续）: #${r.id} ${e.message}`);
        }
      }
    }
  };

  // ① 同一提取 Job 落了多行（source_job_id 为 NULL 的重复只有这轮能查到）
  await runPass('同 Job 重复组', (r) => (r.job_id == null ? null : `job_id=${r.job_id}`));
  // ② 不同提取任务落在同一源成片上
  await runPass('同源重复组', (r) => (r.source_job_id == null ? null : `source_job_id=${r.source_job_id}`));

  if (!groupCount) {
    logger.info(`共 ${rows.length} 条字幕草稿行，无重复组，无事可做`);
    await sequelize.close();
    return;
  }

  logger.info(
    `${groupCount} 个重复组，${toHide} 条待隐藏，已处理 ${apply ? toHide - failed : 0} 条` +
      `${failed ? `，失败 ${failed} 条` : ''}${apply ? '' : '（干跑，未写库；确认无误加 --apply 执行）'}`,
  );
  await sequelize.close();
}

main().catch((e) => {
  logger.error(`清理失败: ${e.message}`);
  process.exit(1);
});
