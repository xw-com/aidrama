import { createApp } from './app.js';
import { sequelize } from './db/index.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { setFfmpegPath } from './services/ffmpeg.service.js';
import { runSeed } from './seeders/seed.js';
import { resumeInterruptedJobs, rebuildModelConcurrency } from './services/job.service.js';
import { stopTaskReporter } from './services/maintenance.service.js';
import { startVideoGenScanner, stopVideoGenScanner } from './services/videoGenScanner.service.js';
import { ensureColumns, dropColumns, dropTableIfExists, ensureIndex, dropIndexIfExists, ensureEnumValues, ensureDecimalColumns, widenTextColumns, backfillShowcaseStatus, backfillAdminModelsToShared, backfillEpisodeVideos, backfillSubtitleDraftsFromBackup, backfillVideoGenerationSubmitUrls, STORYBOARD_NEW_COLUMNS, STORYBOARD_DROPPED_COLUMNS, EPISODE_NEW_COLUMNS, PROJECT_NEW_COLUMNS, PROJECT_SHARE_COLUMNS, PROJECT_SHARE_TTL_COLUMNS, PROJECT_SETTINGS_COLUMNS, MODEL_CONFIG_NEW_COLUMNS, MODEL_CONFIG_PROMO_COLUMNS, MODEL_CONFIG_MAX_SIZE_COLUMNS, MODEL_CONFIG_INPUT_LIMIT_COLUMNS, VENDOR_MODELS_COLUMNS, USER_XWORLD_COLUMNS, RECHARGE_NEW_COLUMNS, ASSET_NEW_COLUMNS, ASSET_ALIASES_COLUMNS, ASSET_THUMB_COLUMNS, ASSET_IMAGE_THUMB_COLUMNS, PROJECT_COVER_THUMB_COLUMNS, SEGMENT_TRANSITION_COLUMNS, SEGMENT_LAST_FRAME_SOURCE_COLUMNS, SEGMENT_REVIEW_COLUMNS, SCRIPT_NEW_COLUMNS, VOICE_CATALOG_COLUMNS, VOICE_DROPPED_COLUMNS, SHOWCASE_EPISODE_COLUMNS, SHOWCASE_REVIEW_COLUMNS, USER_REFERRAL_COLUMNS, USER_STATUS_COLUMNS, EPISODE_VIDEO_SUBTITLE_COLUMNS, EPISODE_VIDEO_COVER_COLUMNS, EPISODE_VIDEO_REVIEW_COLUMNS, VIDEO_GENERATION_SUBMIT_URL_COLUMNS } from './db/ensureColumns.js';
import { startThumbScanner, stopThumbScanner } from './services/thumbnail.service.js';

async function main() {
  if (config.ffmpegPath) setFfmpegPath(config.ffmpegPath);

  await sequelize.authenticate();
  logger.info(`数据库已连接：dialect=${config.db.dialect}`);

  // 建表（仅创建缺失的表，不会修改/清空已有表）
  // 说明：SQLite 下 sync({alter:true}) 会重建表导致数据丢失，故采用安全模式。
  // 若修改了模型结构，请删除 data/*.db 重新初始化，或对 MySQL 使用迁移。
  await sequelize.sync();
  logger.info('数据表已同步');
  // 积分一位小数化（步进 0.1）：整型积分列升级为 DOUBLE（幂等，仅未迁移列执行）
  await ensureDecimalColumns(sequelize, 'users', ['credits']);
  await ensureDecimalColumns(sequelize, 'credit_transactions', ['amount', 'balance_after']);
  await ensureDecimalColumns(sequelize, 'jobs', ['credits_used']);
  await ensureDecimalColumns(sequelize, 'recharge_orders', ['credits']);
  await ensureDecimalColumns(sequelize, 'pricings', ['credits_per_unit']);
  await ensureDecimalColumns(sequelize, 'referrals', ['reward_credits']);
  await ensureDecimalColumns(sequelize, 'task_orders', ['price_per_second', 'total_price']);
  // 幂等补列：sync() 不改已有表，这里为旧库补齐模型中新增的列（不丢数据）
  await ensureColumns(sequelize, 'storyboard_segments', STORYBOARD_NEW_COLUMNS);
  await ensureColumns(sequelize, 'storyboard_segments', SEGMENT_TRANSITION_COLUMNS);
  await ensureColumns(sequelize, 'storyboard_segments', SEGMENT_LAST_FRAME_SOURCE_COLUMNS);
  // 分镜视频审阅标记列（旧库补列；存量行 NULL = 未审，行为不变）
  await ensureColumns(sequelize, 'storyboard_segments', SEGMENT_REVIEW_COLUMNS);
  // 移除已废弃的旧分镜字段（景别/构图/运镜/光影/场景/站位/音效），保持库结构与模型一致
  await dropColumns(sequelize, 'storyboard_segments', STORYBOARD_DROPPED_COLUMNS);
  await ensureColumns(sequelize, 'episodes', EPISODE_NEW_COLUMNS);
  await ensureColumns(sequelize, 'projects', PROJECT_NEW_COLUMNS);
  // 分享令牌列（旧库补列）+ 唯一索引（补列之后建；不放在模型 indexes 里，避免 sync() 在补列前建索引导致启动失败）
  await ensureColumns(sequelize, 'projects', PROJECT_SHARE_COLUMNS);
  // 分享令牌签发时间（链接 24 小时有效；存量行 NULL = 旧永久链接，公开页按已过期拒绝）
  await ensureColumns(sequelize, 'projects', PROJECT_SHARE_TTL_COLUMNS);
  await ensureIndex(sequelize, 'projects', 'projects_share_token_uidx', ['share_token'], { unique: true });
  // 项目级全局设置（首个子项：字幕烧录样式字体/字号/底距；存量行 NULL = 走公式默认，行为不变）
  await ensureColumns(sequelize, 'projects', PROJECT_SETTINGS_COLUMNS);
  await ensureColumns(sequelize, 'model_configs', MODEL_CONFIG_NEW_COLUMNS);
  await ensureColumns(sequelize, 'model_configs', MODEL_CONFIG_PROMO_COLUMNS);
  // 最大支持尺寸列（仅 image 生效；ensureColumns 裸加列无默认值，存量行 NULL 由 normalizeMaxSize 回退 2K）
  await ensureColumns(sequelize, 'model_configs', MODEL_CONFIG_MAX_SIZE_COLUMNS);
  await ensureColumns(sequelize, 'model_configs', MODEL_CONFIG_INPUT_LIMIT_COLUMNS);
  // 共享模型归属归 NULL：admin 后台添加的模型统一 user_id=NULL（原记 admin 账号名下），
  // admin 账号名下从此只有私有模型，可在前台走 /my 添加自带 Key 的模型
  await backfillAdminModelsToShared(sequelize);
  // 厂商模型清单列（admin 维护，用户私有模型配置页下拉用）
  await ensureColumns(sequelize, 'model_vendors', VENDOR_MODELS_COLUMNS);
  await ensureColumns(sequelize, 'users', USER_XWORLD_COLUMNS);
  // users.external_id 唯一索引：列级 unique: true 只在 createTable 时落成约束，旧库经
  // ensureColumns 裸加列永远没有该索引——「并发首登撞唯一索引→查回既有用户」的防重复
  // 建号兜底失效（同 external_id 可建出两个账号、双发赠送积分）。先查存量重复，
  // 有脏数据则告警跳过（addIndex 会因重复值失败阻断启动），人工清理后下次启动补建。
  {
    const [dupRows] = await sequelize.query(
      "SELECT external_id, COUNT(*) AS n FROM users WHERE external_id IS NOT NULL GROUP BY external_id HAVING n > 1 LIMIT 3"
    );
    if (dupRows.length) {
      logger.warn('users.external_id 存在重复值，跳过唯一索引创建（请先清理重复账号）:', JSON.stringify(dupRows));
    } else {
      await ensureIndex(sequelize, 'users', 'users_external_id_uidx', ['external_id'], { unique: true });
    }
  }
  // 模型类型 ENUM 扩 'asr'（成片加字幕的语音识别模型）；幂等，仅缺失时 MODIFY
  await ensureEnumValues(sequelize, 'model_configs', 'type', ['text', 'image', 'video', 'tts', 'asr']);
  await ensureColumns(sequelize, 'recharge_orders', RECHARGE_NEW_COLUMNS);
  await ensureColumns(sequelize, 'assets', ASSET_NEW_COLUMNS);
  await ensureColumns(sequelize, 'assets', ASSET_ALIASES_COLUMNS);
  // 列表卡片缩略图列（webp 短边 480；存量由 thumbnail 扫描线程补齐）
  await ensureColumns(sequelize, 'assets', ASSET_THUMB_COLUMNS);
  await ensureColumns(sequelize, 'asset_images', ASSET_IMAGE_THUMB_COLUMNS);
  await ensureColumns(sequelize, 'projects', PROJECT_COVER_THUMB_COLUMNS);
  // 资产类型 ENUM 扩 'video'（资产库管理用户上传的视频素材）；幂等，仅缺失时 MODIFY
  await ensureEnumValues(sequelize, 'assets', 'kind', ['character', 'scene', 'prop', 'material', 'video']);
  await ensureColumns(sequelize, 'scripts', SCRIPT_NEW_COLUMNS);
  await ensureColumns(sequelize, 'voices', VOICE_CATALOG_COLUMNS);
  // 移除 voices 已废弃字段（音色库全局共享化），保持库结构与模型一致
  await dropColumns(sequelize, 'voices', VOICE_DROPPED_COLUMNS);
  // 长文本列升级（剧本导入曾报 ER_DATA_TOO_LONG errno 1406）：raw_script 直升 LONGTEXT(4GB)——
  // 上传上限 20MB 的 GBK 文本按 utf8mb4 入库会膨胀（中文 2 字节→3 字节），MEDIUMTEXT(16MB) 仍可能不够
  await widenTextColumns(sequelize, 'projects', { raw_script: null }, 'long');
  await widenTextColumns(sequelize, 'episodes', { content: null, summary: null, director_requirements: null });
  await widenTextColumns(sequelize, 'scripts', { content: null, outline: null }); // MySQL TEXT 列不允许 DB 级默认值，defaultValue 只留在模型应用层
  await widenTextColumns(sequelize, 'storyboard_segments', { scene_script: null, video_prompt: null });
  // 幂等补索引：jobs 列表查询 WHERE user_id=? ORDER BY created_at DESC 缺复合索引时走 filesort，
  // 整行（含 result/meta 大 JSON）打包进 sort buffer 会触发 ER_OUT_OF_SORTMEMORY
  await ensureIndex(sequelize, 'jobs', 'jobs_user_created_idx', ['user_id', 'created_at']);
  // 删冗余单列索引 jobs_user_id（jobs_user_created_idx 最左前缀已完全覆盖）：它与 jobs_status
  // 的 index_merge intersect 是生产 ER_OUT_OF_SORTMEMORY 的根因——两索引求交后顺序信息丢失，
  // 优化器再对含大 JSON 的整行 filesort（EXPLAIN 已实锤 Using intersect(jobs_user_id,jobs_status)）。
  // 留一腿交并凑不起来；须放在上面复合索引确保存在之后执行。模型里已不再声明该单列索引。
  await dropIndexIfExists(sequelize, 'jobs', 'jobs_user_id');
  // 团队项目共享：成员表 (project_id, user_id) 唯一索引——一人一项目只一行成员记录，接受邀请并发时兜底
  await ensureIndex(sequelize, 'project_members', 'project_members_project_user_uidx', ['project_id', 'user_id'], { unique: true });
  // 展示中心：发布时勾选的分集快照列（旧库补列，null=全部可播分集）
  await ensureColumns(sequelize, 'showcase_items', SHOWCASE_EPISODE_COLUMNS);
  // 展示中心发布审核：状态/驳回原因/审核时间与审核人（存量行置 approved，已公开内容不受影响）
  await ensureColumns(sequelize, 'showcase_items', SHOWCASE_REVIEW_COLUMNS);
  await backfillShowcaseStatus(sequelize);
  // 展示中心：一项目只一条展示记录（并发一键发布兜底）
  await ensureIndex(sequelize, 'showcase_items', 'showcase_items_project_uidx', ['project_id'], { unique: true });
  // 接单中心：列表/筛选常用维度补索引；积分流水 type ENUM 扩 'settle'（订单验收结算给接单方）
  await ensureIndex(sequelize, 'task_orders', 'task_orders_status_created_idx', ['status', 'created_at']);
  await ensureIndex(sequelize, 'task_orders', 'task_orders_publisher_idx', ['publisher_id']);
  await ensureIndex(sequelize, 'task_orders', 'task_orders_worker_idx', ['worker_id']);
  await ensureIndex(sequelize, 'order_events', 'order_events_order_idx', ['order_id']);
  // 高频列表查询补索引（sync 不会给已存在的表补模型索引）：工作台各列表几乎都按
  // project_id / episode_id 过滤；成片选版按 (project_id, status, type)；展示列表按流量倒序
  await ensureIndex(sequelize, 'episodes', 'episodes_project_idx', ['project_id']);
  await ensureIndex(sequelize, 'storyboard_segments', 'segments_episode_idx', ['episode_id']);
  await ensureIndex(sequelize, 'assets', 'assets_project_idx', ['project_id']);
  await ensureIndex(sequelize, 'projects', 'projects_user_idx', ['user_id']);
  await ensureIndex(sequelize, 'jobs', 'jobs_project_status_type_idx', ['project_id', 'status', 'type']);
  await ensureIndex(sequelize, 'showcase_items', 'showcase_view_created_idx', ['view_count', 'created_at']);
  await ensureEnumValues(sequelize, 'credit_transactions', 'type', ['recharge', 'consume', 'refund', 'settle', 'adjust']);
  // 视频生成查询明细表已废弃：轮询不再逐次落明细，只更新 video_generations 本身（状态/结果/更新时间）
  await dropTableIfExists(sequelize, 'video_generation_queries');
  // 留档提交完整端点列（旧库补列）：base_url + 厂商提交路径，admin 详情展示；存量行 NULL
  await ensureColumns(sequelize, 'video_generations', VIDEO_GENERATION_SUBMIT_URL_COLUMNS);
  // 存量留档回填 submit_url：按 vendor+base_url 快照反推完整端点（幂等，只补 NULL 且 base_url 非空的行）
  try {
    const n = await backfillVideoGenerationSubmitUrls(sequelize);
    if (n) logger.info(`留档 submit_url 存量回填完成：${n} 条`);
  } catch (e) {
    logger.warn('留档 submit_url 存量回填失败（可忽略，下次启动重试）:', e.message);
  }
  // 邀请有礼：用户邀请码列 + 唯一索引（懒生成时预检+重试，索引兜底并发撞码）；
  // referrals 表 invitee 唯一（一人一生只能被绑定一次，防刷核心）、referrer 列表索引
  await ensureColumns(sequelize, 'users', USER_REFERRAL_COLUMNS);
  await ensureColumns(sequelize, 'users', USER_STATUS_COLUMNS);
  await ensureIndex(sequelize, 'users', 'users_referral_code_uidx', ['referral_code'], { unique: true });
  await ensureIndex(sequelize, 'referrals', 'referrals_invitee_uidx', ['invitee_id'], { unique: true });
  await ensureIndex(sequelize, 'referrals', 'referrals_referrer_idx', ['referrer_id']);
  await ensureIndex(sequelize, 'referrals', 'referrals_ip_idx', ['invitee_ip']);
  // admin 用户管理：登录日志按用户/时间查询（login_logs 表由 sync 建表）
  await ensureIndex(sequelize, 'login_logs', 'login_logs_user_created_idx', ['user_id', 'created_at']);
  await ensureIndex(sequelize, 'login_logs', 'login_logs_created_idx', ['created_at']);
  // 成片落档：列表/选版按项目、按分集查询（episode_videos 表由 sync 建表）
  await ensureIndex(sequelize, 'episode_videos', 'episode_videos_project_idx', ['project_id']);
  await ensureIndex(sequelize, 'episode_videos', 'episode_videos_episode_idx', ['episode_id']);
  // 字幕草稿状态落档（旧库补列，须在成片回填之前）：字幕编辑数据源从提取 Job 迁到成片行，Job 清理后字幕仍可编辑
  await ensureColumns(sequelize, 'episode_videos', EPISODE_VIDEO_SUBTITLE_COLUMNS);
  // 成片封面列（旧库补列，须在成片回填之前）：封面 480P webp，存量行由缩略图扫描线程补齐
  await ensureColumns(sequelize, 'episode_videos', EPISODE_VIDEO_COVER_COLUMNS);
  // 成片审阅标记列（旧库补列，须在成片回填之前；存量行 NULL = 未审，行为不变）
  await ensureColumns(sequelize, 'episode_videos', EPISODE_VIDEO_REVIEW_COLUMNS);
  // 存量成功 Job 的成片记录回填：成片查询与 jobs 表解耦（Job 清理/删除不影响成片历史）
  try {
    const n = await backfillEpisodeVideos();
    if (n) logger.info(`成片落档回填完成：新增 ${n} 条`);
  } catch (e) {
    logger.warn('成片落档回填失败（可忽略，下次启动重试）:', e.message);
  }
  // 字幕草稿灾备回填：jobs 被清后从同库备份表（如 jobs_copy1，可用 JOBS_BACKUP_TABLE 指定）找回
  // 字幕草稿写回 episode_videos；无备份表自动跳过，幂等可重复执行
  try {
    const r = await backfillSubtitleDraftsFromBackup(sequelize);
    if (r) logger.info(`字幕草稿回填完成（备份表 ${r.table}）：新建 ${r.created} 条、补齐 ${r.patched} 条`);
  } catch (e) {
    logger.warn('字幕草稿回填失败（可忽略，下次启动重试）:', e.message);
  }
  // 成片行唯一性 DB 兜底：一条 Job 只落一行成片记录（提取/合成/剪辑三处落档同口径）。
  // 各落档点虽已 findOrCreate/预检防重，但「查→插」非原子，多进程部署/并发下仍可双插
  // （表现为同一张字幕草稿卡出现两次）；唯一索引让并发第二插直接撞约束，
  // Sequelize findOrCreate 撞唯一索引会自动重查回既有行，普通 create 有 .catch 不阻断任务。
  // 软隐藏行同样占用唯一索引：先把「同 (kind, job_id) 多余的已隐藏行」物理去除
  // （每组保留一条：优先未隐藏行，否则最小 id；只删已隐藏的行，不碰任何可见数据），
  // 再查存量重复；仍有未隐藏重复（live 脏数据）则告警跳过（addIndex 会因重复值失败阻断启动）
  // ——跑 scripts/cleanupDuplicateSubtitleDrafts.js --apply 清理后下次启动自动补建。
  {
    const [purged] = await sequelize.query(
      'DELETE FROM episode_videos WHERE hidden = 1 AND id NOT IN (' +
      'SELECT keep FROM (SELECT CASE WHEN SUM(hidden = 0) > 0 THEN MIN(CASE WHEN hidden = 0 THEN id END) ELSE MIN(id) END AS keep ' +
      'FROM episode_videos GROUP BY kind, job_id) t)',
    ).catch(() => [null]);
    if (purged?.affectedRows) logger.info(`成片行唯一性整理：物理去除多余的已隐藏重复行 ${purged.affectedRows} 条`);
    const [dupRows] = await sequelize.query(
      'SELECT kind, job_id, COUNT(*) AS n FROM episode_videos WHERE job_id IS NOT NULL GROUP BY kind, job_id HAVING n > 1 LIMIT 3',
    ).catch(() => [null]);
    if (dupRows?.length) {
      logger.warn('episode_videos (kind, job_id) 存在未隐藏重复值，跳过唯一索引创建（请先跑 scripts/cleanupDuplicateSubtitleDrafts.js --apply）:', JSON.stringify(dupRows));
    } else {
      await ensureIndex(sequelize, 'episode_videos', 'episode_videos_kind_job_uidx', ['kind', 'job_id'], { unique: true });
    }
  }

  // 初始化种子数据（幂等）
  try {
    await runSeed();
    logger.info('种子数据初始化完成');
  } catch (e) {
    logger.warn('种子数据初始化失败（可忽略）:', e.message);
  }

  // 载入美术风格内存缓存（DB 驱动；表未建/为空时回退 ART_STYLES 常量）
  try {
    const { reloadArtStyles } = await import('./services/artSkills.service.js');
    await reloadArtStyles();
    logger.info('美术风格缓存已载入');
  } catch (e) {
    logger.warn('美术风格缓存载入失败（可忽略）:', e.message);
  }

  // 恢复服务重启前未完成的任务：批量视频断点续跑；单段厂商任务型不清理、继续查询任务状态；
  // 其余无厂商任务可续的按「服务重启中断」清理退款
  // 先按 DB running 行重建模型级全局并发计数（重启前在厂商侧仍跑的任务继续占名额），
  // 再恢复入队——恢复的同一 jobId 再次 track 时靠 Set 去重，不会双计
  try {
    await rebuildModelConcurrency();
  } catch (e) {
    logger.warn('模型并发计数重建失败（可忽略，按空计数运行）:', e.message);
  }
  try {
    const r = await resumeInterruptedJobs();
    if (r.batch || r.resumed || r.cleaned) {
      logger.info(`启动恢复：批量续跑 ${r.batch} 个、厂商任务继续等待 ${r.resumed} 个、清理无任务可续 ${r.cleaned} 个`);
    }
  } catch (e) {
    logger.warn('启动恢复中断任务失败（可忽略）:', e.message);
  }

  // 视频生成留档扫描线程：独立周期任务，持续查询 video_generations 中 pending record 的
  // 厂商终态（无超时，查到成功/失败为止；重启前遗留的 record 也会继续查完留档）
  startVideoGenScanner();

  // 缩略图补齐扫描线程：给存量资产图/服饰图/项目封面生成 webp 缩略图（列表页省 95%+ 图片流量）
  startThumbScanner();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`星网 XW.COM 服务端已启动: http://localhost:${config.port}  (env=${config.env})`);
    logger.info(`默认 DB_DIALECT=${config.db.dialect}，前端来源=${config.clientOrigin.join(',')}`);
  });

  // 会员体系已下线：不再启动会员定时任务（月度扣费 / 过期降级）。

  const shutdown = (sig) => {
    logger.info(`${sig} received, closing server...`);
    stopTaskReporter(); // 停掉维护期任务播报定时器
    stopVideoGenScanner(); // 停掉视频生成留档扫描线程（pending record 落库，重启后续查）
    stopThumbScanner(); // 停掉缩略图补齐扫描线程
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 进程级兜底：任何一处漏接的 rejection 不再默认杀进程（node>=15 默认 throw 退出）。
  // unhandledRejection 记日志继续跑；uncaughtException 记日志后退出——重启链路
  // （resumeInterruptedJobs）会把在途任务恢复/清理，比带着未知状态硬撑更安全。
  process.on('unhandledRejection', (reason) => {
    logger.error('[PROCESS] unhandledRejection:', reason?.stack || reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('[PROCESS] uncaughtException:', err?.stack || err);
    setTimeout(() => process.exit(1), 100).unref();
  });
}

main().catch((err) => {
  logger.error('启动失败:', err);
  process.exit(1);
});
