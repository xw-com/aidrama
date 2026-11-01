import db from '../db/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getConfig, resolveConfig } from './modelConfig.service.js';
import { estimateVideoCost, applyModelPromo } from './pricing.service.js';
import { consumeCredits, refundCredits, getCurrentBalance, findJobHold, refundJobHold } from './credits.service.js';
import { ceilCredits } from '../utils/credits.js';
import { generateVideo, eraseVideoSubtitles } from './video.service.js';
import { extractFirstFrame, extractLastFrame } from './ffmpeg.service.js';
import { toUrl, genFilePath, deleteUrlFiles } from '../utils/fileUtil.js';
import { composeVideoPrompt } from './ai/storyboard.service.js';

const { Job, StoryboardSegment, Episode, Project, Asset, AssetImage, EpisodeAsset, Voice, CreditTransaction } = db;
const Op = db.Sequelize.Op;

// 批量段级计费业务键：job 级键（job:<id>）无法区分具体段（同 job 多段共用），
// 段级键（job:<id>:seg:<segId>）供「孤儿预扣退款」按流水对账
const segChargeKey = (jobId, segId) => `job:${jobId}:seg:${segId}`;

// 段级批量计费走个人余额（与 withCredits 同口径，见 credits.service）。
const balanceOf = (userId) => getCurrentBalance(userId);

// 查该业务键是否已有指定类型的积分流水（consume/refund 幂等对账用）。
// 查询失败必须向上抛：吞成 false 会让「查 consume 恰好失败 + persistMeta 清账成功」
// 时孤儿预扣被永久吞掉（用户已扣的段积分凭空蒸发，违背本函数「杜绝凭空送积分」的对账初衷）。
async function hasCreditTx(userId, refId, type) {
  return (await CreditTransaction.count({ where: { user_id: userId, ref_id: refId, type } })) > 0;
}

/**
 * 批量任务中断段的孤儿预扣退款（按段级流水对账后退款）。
 * 记账（meta.charged）先于扣费（consumeCredits）落库以保证崩溃可恢复，故崩溃可能落在两者之间：
 *  - 流水里确有该段 consume 且尚无 refund → 真预扣未结算，退款；
 *  - 无 consume（崩溃在扣费前）→ 不退（未扣过费，退了就是凭空送积分）；
 *  - 已有 refund（上次恢复退款后又崩溃）→ 不重复退。
 * @returns 实际退款额
 */
async function refundOrphanSegmentCharge(userId, jobId, segId, amount, feature) {
  const key = segChargeKey(jobId, segId);
  let refunded = 0;
  if (await hasCreditTx(userId, key, 'consume') && !(await hasCreditTx(userId, key, 'refund'))) {
    await refundCredits(userId, amount, { feature, refId: key, remark: '中断段退款' });
    refunded = amount;
  }
  return refunded;
}

// 解析视频生成所用模型配置（用于计费）：指定 id > 默认视频模型 > null（走全局定价兜底）
export async function loadVideoCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'video');
  } catch { return null; }
}

// 批量解析引用资产绑定的声音样本：voiceId(Number) -> Voice（仅保留有 audio_url 的）。
// 视频生成按「角色→音频」对应提交参考音频，故每个绑定音色的资产都要解析（不再是只取首个）。
export async function resolveAssetVoices(assets) {
  const ids = [];
  for (const a of assets || []) {
    const voiceId = Number(a?.meta?.voiceId);
    if (voiceId && !ids.includes(voiceId)) ids.push(voiceId);
  }
  if (!ids.length) return new Map();
  try {
    const voices = await Voice.findAll({ where: { id: ids } });
    return new Map(voices.filter((v) => v.audio_url).map((v) => [v.id, v]));
  } catch {
    return new Map();
  }
}

/**
 * 跨镜首尾帧延续的「连续性」判定：本镜与上一镜是否属同一场戏（视觉上应保持连贯）。
 * - scene_no 均存在：同号即同场；
 * - 任一侧缺少 scene_no → 视为不连续（保守，不强接尾帧）。
 */
export function isContinuousWith(prev, cur) {
  if (!prev || !cur) return false;
  if (prev.scene_no != null && cur.scene_no != null) return prev.scene_no === cur.scene_no;
  return false;
}


/**
 * 解析某集对角色的服饰覆盖：返回 assetId -> { image_url, doubao_asset_id }（仅当该集指定了有图的服饰）。
 * 未覆盖的角色不在 map 中，调用方据此回退到角色默认（Asset.image_url）。
 */
export async function resolveEpisodeCostumeOverrides(episodeId, assetIds) {
  if (!episodeId || !assetIds?.length) return new Map();
  try {
    const rows = await EpisodeAsset.findAll({
      where: { episode_id: episodeId, asset_id: assetIds },
      include: [{ model: AssetImage, as: 'costume' }],
    });
    const map = new Map();
    for (const r of rows) {
      // 有图或填了豆包资产ID均视为有效覆盖（seedance 走 asset:// 可无本地图）
      if (r.costume_id && r.costume && (r.costume.image_url || r.costume.doubao_asset_id)) {
        map.set(r.asset_id, { image_url: r.costume.image_url || null, doubao_asset_id: r.costume.doubao_asset_id || null });
      }
    }
    return map;
  } catch { return new Map(); }
}

/**
 * 单段视频生成核心（解析资产/声音/上一镜尾帧 → generateVideo → 抽首帧为关键帧、尾帧备用 → 落库 done）。
 * 与原 storyboard.routes 的 /generate、/generate-video workFn 主体等价，供单段路由与批量串行复用。
 * 调用方需在调用前置 segment.status='generating'、在捕获异常时置 'failed'。
 * @param {number} userId
 * @param {object} segment 已加载的 StoryboardSegment 实例
 * @param {{modelConfigId, resolution, jobId?, feature?}} opts resolution 由调用方选定后传入；
 *   jobId/feature 透传给视频生成留档（video_generations.job_id/feature）；
 *   feature 仅为 'segment_video_batch'（批量按顺序）时启用跨镜尾帧延续作起始帧
 * @returns {Promise<string>} videoUrl
 */
export async function generateSegmentVideo(userId, segment, { modelConfigId, resolution, jobId = null, feature = 'segment_video' } = {}) {
  // 重新生成时被替换的旧视频/关键帧/尾帧文件（首次生成为空；成功落库后再删）
  const oldFiles = [segment.video_url, segment.keyframe_url, segment.last_frame_url].filter(Boolean);
  const episode = await Episode.findByPk(segment.episode_id);
  const project = episode ? await Project.findByPk(episode.project_id, { attributes: { exclude: ["raw_script"] } }) : null;

  // 解析引用资产（视频生成链接，保证角色一致性）
  const refIds = (segment.asset_refs || []).map((r) => r.id).filter(Boolean);
  const found = refIds.length ? await Asset.findAll({ where: { id: refIds } }) : [];
  const byId = new Map(found.map((a) => [a.id, a]));
  const refAssets = refIds.map((id) => byId.get(id)).filter(Boolean);
  // 按集服饰覆盖：该集为角色指定了某套服饰时，用该服饰图替换默认（未覆盖则沿用 Asset.image_url）
  const charIds = refAssets.filter((a) => a.kind === 'character').map((a) => a.id);
  const costumeOverride = await resolveEpisodeCostumeOverrides(segment.episode_id, charIds);
  // 角色声音样本：逐资产解析绑定音色（视频生成按「角色→音频」对应提交参考音频）
  const assetVoices = await resolveAssetVoices(refAssets);
  const refAssetDTOs = refAssets.map((a) => {
    const ov = a.kind === 'character' ? costumeOverride.get(a.id) : null;
    const voice = assetVoices.get(Number(a?.meta?.voiceId));
    return {
      name: a.name,
      kind: a.kind,
      image_url: ov?.image_url || a.image_url,
      // 命中换装覆盖时豆包资产ID 只取服饰自身的（可为空）：若回退角色默认 asset_id，
      // seedance 会走 asset:// 引用默认数字资产并跳过 image_url，导致换装图被忽略
      doubao_asset_id: ov ? (ov.doubao_asset_id || null) : a.doubao_asset_id,
      aliases: Array.isArray(a.aliases) ? a.aliases : [],
      // 该角色绑定音色的声音样本 + 音色名（供视频生成按角色对应提交参考音频）
      voice_url: voice?.audio_url || null,
      voice_name: voice?.name || null,
      // 视频资产的上传视频文件（供视频生成按 reference_video 提交，封面图(image_url)仅作首帧回退）
      video_url: a.kind === 'video' ? (a.meta?.videoUrl || null) : null,
    };
  });

  // 跨镜首尾帧延续仅在「批量按顺序生成」(segment_video_batch) 中启用：
  // 单独生成/重新生成、并发批量一律纯文生视频，不携带任何起始帧
  const inSerialBatch = feature === 'segment_video_batch';
  // 上一镜（按 idx 紧邻）：跨镜首尾帧延续的尾帧来源
  const prevSegment = inSerialBatch && episode ? await StoryboardSegment.findOne({
    where: { episode_id: episode.id, idx: { [Op.lt]: segment.idx } },
    order: [['idx', 'DESC']],
  }) : null;
  const continuityFrame = prevSegment?.last_frame_url && isContinuousWith(prevSegment, segment) ? prevSegment.last_frame_url : null;
  // 尾帧来源：'seedance'=provider 原样返回的原图 / 'ffmpeg'=本地抽帧兜底（两者均可作下一镜起始帧参考图，Seedance 与 MiniMax 语义一致）
  const continuitySource = continuityFrame ? prevSegment.last_frame_source || null : null;
  if (continuityFrame) logger.info(`[SEGMENT] 跨镜延续 seg=${segment.id} 采用上一镜尾帧(seg=${prevSegment.id})作首帧（来源 ${continuitySource || '未知/ffmpeg'}）`);

  // 视频（提交 video_prompt 到 content，同时链接引用资产图 / 角色声音样本 / 跨镜尾帧延续）
  // 起始帧仅来自串行批量中的跨镜尾帧延续（同场连续）；其余场景不携带任何起始帧
  const { videoUrl, outPath: videoOut, lastFrameUrl: providerLastFrame, lastFrameSource: providerLastFrameSource } = await generateVideo(userId, {
    prompt: composeVideoPrompt(segment),
    imagePath: continuityFrame,
    continuityFrame,
    continuitySource,
    duration: segment.duration || 5,
    aspect: project?.aspect_ratio,
    refAssets: refAssetDTOs,
    modelConfigId: modelConfigId || null,
    resolution: resolution || null,
    // 留档上下文（video_generations）：按 Job/项目/分集/分镜追溯本次生成
    jobId,
    projectId: project?.id || null,
    episodeId: segment.episode_id,
    segmentId: segment.id,
    feature,
  });

  // 关键帧：从生成视频抽取第一帧（尽力而为，失败不影响视频落库）
  let keyframeUrl = segment.keyframe_url || null;
  try {
    const { absPath: kfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
    await extractFirstFrame(videoOut, kfAbs);
    keyframeUrl = toUrl(kfAbs);
  } catch (e) {
    logger.warn(`[SEGMENT] 抽取关键帧首帧失败 seg=${segment.id}: ${e.message}`);
  }
  // 尾帧：优先 provider 随任务返回的尾帧图（Seedance return_last_frame，已原样落盘、不得修改）；
  // 未返回时 ffmpeg 抽取最后一帧兜底（如作为下一镜图生视频的首帧延续）。
  // last_frame_source 记录来源（'seedance'/'ffmpeg'），供下一镜生成判断能否作 Seedance 起始帧参考图
  let lastFrameUrl = providerLastFrame || null;
  let lastFrameSource = providerLastFrame ? (providerLastFrameSource || null) : null;
  if (!lastFrameUrl) {
    try {
      const { absPath: lfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
      await extractLastFrame(videoOut, lfAbs);
      lastFrameUrl = toUrl(lfAbs);
      lastFrameSource = 'ffmpeg';
    } catch (e) {
      logger.warn(`[SEGMENT] 抽取尾帧失败 seg=${segment.id}: ${e.message}`);
    }
  }
  // 换视频（新生成）重置审阅标记：新片须重新审阅
  await segment.update({ video_url: videoUrl, keyframe_url: keyframeUrl, last_frame_url: lastFrameUrl, last_frame_source: lastFrameSource, status: 'done', reviewed_at: null, reviewer_id: null });
  // 重新生成成功：清掉被替换的旧文件（新值仍在引用的除外，如关键帧抽取失败时沿用的旧关键帧）
  deleteUrlFiles(oldFiles, [videoUrl, keyframeUrl, lastFrameUrl].filter(Boolean));
  return videoUrl;
}

/** 重算并回写分集总时长（分镜增删/生成后调用） */
export async function refreshEpisodeDuration(episode) {
  const segs = await StoryboardSegment.findAll({ where: { episode_id: episode.id } });
  const total = segs.reduce((s, x) => s + (x.duration || 0), 0);
  await episode.update({ duration: total });
}

/**
 * 合并写入批量 Job 的 meta（每次重新读取最新 meta 再合并，避免覆盖并发写入的字段）。
 * @returns 写入后的完整 meta
 */
async function persistMeta(job, patch) {
  const fresh = await Job.findByPk(job.id, { attributes: ['meta'] });
  const meta = { ...(fresh?.meta || {}), ...patch };
  await Job.update({ meta }, { where: { id: job.id } });
  return meta;
}

/**
 * 批量串行视频生成的 workFn（路由提交与重启恢复共用）。
 * 设计要点：
 *  - 严格按 meta.segmentIds 顺序逐段生成（保证跨镜首尾帧延续可用）；
 *  - 「本批已完成段」跳过，不重生成、不重扣 → 重启续跑安全（路由层已「先删后生成」，新任务
 *    preDoneIds 恒空：done+video_url 即本批产物；preDoneIds 仅用于兼容旧任务续跑判定）；
 *  - 每段「先记账 meta.charged → 再 consumeCredits 预扣 → 生成 → 成功结算/失败退款 → 清账」，
 *    崩溃后 meta.charged 残留即为「孤儿预扣」，恢复时按段级流水（job:<id>:seg:<segId>）对账：
 *    确已扣未退才退款（崩溃在扣费前的不退，杜绝凭空送积分/重复退款）；
 *  - 某段失败/余额不足 → 置 'failed'、退款、跳过，继续下一段（不 rethrow）；
 *  - 循环顶部检测 job.status==='cancelled' 则停止后续段（取消后由 cancelJob 统一退款）。
 */
export async function batchVideoWorkFn(ctx) {
  const job = await Job.findByPk(ctx.jobId);
  if (!job) return null;
  const userId = job.user_id;
  const segmentIds = Array.isArray(job.meta?.segmentIds) ? job.meta.segmentIds : [];
  const { modelConfigId, resolution } = job.meta || {};
  const total = segmentIds.length;
  const completed = Array.isArray(job.meta?.completed) ? [...job.meta.completed] : [];
  const failed = Array.isArray(job.meta?.failed) ? [...job.meta.failed] : [];
  const charged = { ...(job.meta?.charged || {}) }; // { [segId]: estCharged } 仅记已预扣未结算段
  let settledCredits = Number(job.meta?.settledCredits) || 0;
  const cfg = await loadVideoCfg(userId, modelConfigId);
  // 提交时已有视频的段集合：缺失（旧任务）时视为「全部已有」，保持旧跳过语义
  const hasPreDone = Array.isArray(job.meta?.preDoneIds);
  const isPreDone = (segId) => (hasPreDone ? job.meta.preDoneIds.includes(segId) : true);

  for (let i = 0; i < segmentIds.length; i++) {
    // 取消检测：停止提交后续段（已预扣的当段由下方 finally 正常退款）
    const cur = await Job.findByPk(job.id, { attributes: ['status'] });
    if (cur?.status === 'cancelled') break;

    const segId = segmentIds[i];
    const seg = await StoryboardSegment.findByPk(segId);
    await persistMeta(job, { index: i + 1, currentSegmentId: segId, completed, failed, charged, settledCredits });
    if (!seg) { if (!failed.includes(segId)) failed.push(segId); await persistMeta(job, { failed }); continue; }

    // ① 本批已完成（崩溃前完成）→ 跳过，不重扣：
    //    - 提交前无视频（!isPreDone）且已有成片 = 本批生成完毕；
    //    - 提交前已有视频（preDoneIds，旧任务）且已在 completed = 本批重生成完毕；
    //    - 旧任务无 preDoneIds 字段 → 退回旧行为：done+video_url 一律跳过
    //    （新提交的批量在路由层已「先删后生成」，preDoneIds 恒为空，此判定只服务旧任务续跑）
    if (seg.status === 'done' && seg.video_url && (!hasPreDone || !isPreDone(segId) || completed.includes(segId))) {
      if (!completed.includes(segId)) completed.push(segId);
      await persistMeta(job, { completed });
      continue;
    }
    // ①.5 本批此前已失败过（崩溃前已 catch 并退款，记在 meta.failed）→ 续跑时不重试，
    //    保持「跳过失败段」语义，避免对一个已判定失败的段重复扣费重跑。
    //    （新批次的 failed 为空，故不会误伤此前其它来源失败的段——它们仍会被生成）
    if (failed.includes(segId)) continue;
    // ② 孤儿预扣（崩溃在该段预扣后、结算前）→ 按段级流水对账后退款再重跑（未扣过费/已退过款不退）
    if (charged[segId]) {
      await refundOrphanSegmentCharge(userId, job.id, segId, charged[segId], 'segment_video_batch');
      delete charged[segId];
      await persistMeta(job, { charged });
    }

    await ctx.reportProgress(Math.round((i / total) * 100), `串行生成 ${i + 1}/${total}：${seg.title || ''}`);

    // 段级估算与余额检查
    const est = applyModelPromo(cfg, (await estimateVideoCost(cfg, seg.duration || 5, resolution)).credits);
    const estCharged = ceilCredits(est || 0);
    if (await balanceOf(userId) < estCharged) {
      await seg.update({ status: 'failed' });
      if (!failed.includes(segId)) failed.push(segId);
      await persistMeta(job, { failed });
      logger.warn(`[BATCH] seg=${segId} 余额不足，跳过（job=${job.id}）`);
      continue;
    }

    // ③ 先记账再预扣（顺序保证崩溃可恢复；扣费/退款均挂段级键，恢复时按流水对账）
    charged[segId] = estCharged;
    await persistMeta(job, { charged });
    try {
      // 预扣也纳入 try：余额被同用户其它任务抽干（预检后击穿）或 DB 瞬断抛错时，
      // 按「失败段跳过」处理继续后续段，而不是让整批中断（函数头承诺的语义）
      await consumeCredits(userId, est, { feature: 'segment_video_batch', refId: segChargeKey(job.id, segId), remark: `批量视频:${seg.title || ''}` });
      await seg.update({ status: 'generating' });
      await generateSegmentVideo(userId, seg, { modelConfigId, resolution, jobId: job.id, feature: 'segment_video_batch' });
      if (!completed.includes(segId)) completed.push(segId);
      settledCredits += estCharged;
    } catch (e) {
      await seg.update({ status: 'failed' }).catch(() => {});
      // 幂等退款：预扣本身失败（无 consume 流水）时不会多退
      await refundOrphanSegmentCharge(userId, job.id, segId, estCharged, 'segment_video_batch').catch(() => {});
      if (!failed.includes(segId)) failed.push(segId);
      logger.warn(`[BATCH] seg=${segId} 失败，跳过继续（job=${job.id}）: ${e?.message || e}`);
    } finally {
      delete charged[segId]; // 该段已结算/退款，清账
      await persistMeta(job, { completed, failed, charged, settledCredits });
    }
  }

  // 回写分集时长（视频生成不影响时长，但段状态可能变化，保持与单段一致）
  try {
    const first = await StoryboardSegment.findByPk(segmentIds[0]);
    if (first) {
      const ep = await Episode.findByPk(first.episode_id);
      if (ep) await refreshEpisodeDuration(ep);
    }
  } catch { /* ignore */ }

  const balance = await balanceOf(userId);
  await ctx.reportProgress(100, `完成 ${completed.length}/${total}`);
  return { completed, failed, total, credits_used: settledCredits, balance };
}

// 批量「并发生成」的同时上限：对视频供应商更友好，避免一次性触发 N 路并发的限流。
export const BATCH_CONCURRENT_LIMIT = 4;

/**
 * 有界并发池：最多同时跑 limit 个 worker；完成一个补一个。
 * 既「不串行排队」，又不会一次性打爆供应商限流。
 */
async function runPool(items, limit, worker) {
  const executing = new Set();
  for (const item of items) {
    const p = worker(item);
    executing.add(p);
    // p.finally(...) 派生的新 promise 会以同一 reason 拒绝且无人接管——worker 一步拒绝
    // （如余额不足抛 InsufficientCreditsError）就是 unhandled rejection，node>=15 默认进程退出。
    // 先 .catch 再 .finally：清理动作照做，派生 promise 不再外泄拒绝。
    p.catch(() => {}).finally(() => executing.delete(p));
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

/**
 * 批量「并发」视频生成的 workFn（路由提交与重启恢复共用）。
 * 与 batchVideoWorkFn 对称，差别：用有界并发池(BATCH_CONCURRENT_LIMIT)同时跑多段，而非按顺序串行。
 * 代价：并发段之间无法做跨镜首尾帧衔接（上一镜尚未落库 last_frame_url），各段用自身关键帧/资产图独立生成。
 *
 * 计费/续跑/取消语义与串行一致：
 *  - 「本批已完成段」跳过不重扣（新任务路由先删后生成、preDoneIds 恒空：done+video_url 即本批
 *    产物；preDoneIds 仅用于兼容旧任务续跑判定）；本批已 failed 段不重试；
 *    孤儿预扣(charged)按段级流水对账后退款再重跑；
 *  - 每段 consume→生成→成功结算/失败退款；闭包状态(completed/failed/charged/settledCredits)
 *    通过 per-job 锁串行化读改写并落库，杜绝并发 append 丢更新；
 *  - 取消(置 cancelled)：池中未启动段在 processOne 顶部检测到即停，已在跑的自然完成结算。
 */
export async function batchVideoWorkFnConcurrent(ctx) {
  const job = await Job.findByPk(ctx.jobId);
  if (!job) return null;
  const userId = job.user_id;
  const segmentIds = Array.isArray(job.meta?.segmentIds) ? job.meta.segmentIds : [];
  const { modelConfigId, resolution } = job.meta || {};
  const total = segmentIds.length;
  const completed = Array.isArray(job.meta?.completed) ? [...job.meta.completed] : [];
  const failed = Array.isArray(job.meta?.failed) ? [...job.meta.failed] : [];
  const charged = { ...(job.meta?.charged || {}) };
  let settledCredits = Number(job.meta?.settledCredits) || 0;
  const cfg = await loadVideoCfg(userId, modelConfigId);
  // 提交时已有视频的段集合：缺失（旧任务）时视为「全部已有」，保持旧跳过语义
  const hasPreDone = Array.isArray(job.meta?.preDoneIds);
  const isPreDone = (segId) => (hasPreDone ? job.meta.preDoneIds.includes(segId) : true);

  // per-job 互斥：串行化对闭包状态的读改写 + meta 落库。
  // persistMeta 的 fresh-read-merge 不足以避免多 worker 并发 append 丢更新，故在此显式加锁。
  let lock = Promise.resolve();
  function updateMeta(mutator) {
    const next = lock.then(async () => {
      mutator();
      const done = completed.length + failed.length;
      await persistMeta(job, { completed, failed, charged, settledCredits, done });
      await ctx.reportProgress(Math.round((done / total) * 100), `并发生成 ${done}/${total}`);
    });
    lock = next.catch(() => {});
    return next;
  }

  async function processOne(segId) {
    // 取消检测：池中待跑段若已取消则直接跳过（在跑段自然完成结算）
    const cur = await Job.findByPk(job.id, { attributes: ['status'] });
    if (cur?.status === 'cancelled') return;

    const seg = await StoryboardSegment.findByPk(segId);
    if (!seg) { await updateMeta(() => { if (!failed.includes(segId)) failed.push(segId); }); return; }

    // 本批已完成（崩溃前完成）→ 跳过，不重扣（判定口径与串行一致：非 preDone 已有成片 /
    // preDone 且已在 completed / 旧任务无 preDoneIds 字段；新批量路由先删后生成，preDoneIds 恒空）
    if (seg.status === 'done' && seg.video_url && (!hasPreDone || !isPreDone(segId) || completed.includes(segId))) {
      await updateMeta(() => { if (!completed.includes(segId)) completed.push(segId); });
      return;
    }
    // 本批此前已失败 → 续跑不重试（保持「跳过失败段」语义）
    if (failed.includes(segId)) return;
    // 孤儿预扣（崩溃在预扣后/结算前）→ 按段级流水对账后退款再重跑（未扣过费/已退过款不退）
    if (charged[segId]) {
      await refundOrphanSegmentCharge(userId, job.id, segId, charged[segId], 'segment_video_batch_concurrent');
      await updateMeta(() => { delete charged[segId]; });
    }

    // 段级估算与余额检查
    const est = applyModelPromo(cfg, (await estimateVideoCost(cfg, seg.duration || 5, resolution)).credits);
    const estCharged = ceilCredits(est || 0);
    if (await balanceOf(userId) < estCharged) {
      await seg.update({ status: 'failed' });
      await updateMeta(() => { if (!failed.includes(segId)) failed.push(segId); });
      logger.warn(`[BATCH-CONCURRENT] seg=${segId} 余额不足，跳过（job=${job.id}）`);
      return;
    }

    // 先记账再预扣（顺序保证崩溃可恢复；扣费/退款均挂段级键，恢复时按流水对账）
    await updateMeta(() => { charged[segId] = estCharged; });
    let settledOrRefunded = false; // 预扣成功后：要么结算、要么已退款，二者其一才允许清 charged 账
    try {
      // 预扣也纳入 try：余额被同用户其它任务抽干（预检后击穿）或 DB 瞬断抛错时，
      // 按「失败段跳过」处理——worker 拒绝会沿 runPool 派生 promise 变 unhandled rejection 打挂进程
      await consumeCredits(userId, est, { feature: 'segment_video_batch_concurrent', refId: segChargeKey(job.id, segId), remark: `批量并发视频:${seg.title || ''}` });
      await seg.update({ status: 'generating' });
      await generateSegmentVideo(userId, seg, { modelConfigId, resolution, jobId: job.id, feature: 'segment_video_batch_concurrent' });
      await updateMeta(() => {
        if (!completed.includes(segId)) completed.push(segId);
        settledCredits += estCharged;
      });
      settledOrRefunded = true;
    } catch (e) {
      await seg.update({ status: 'failed' }).catch(() => {});
      // 幂等退款：预扣本身失败（无 consume 流水）时不会多退；对账查询失败则保留 charged 留待续跑重试
      try {
        await refundOrphanSegmentCharge(userId, job.id, segId, estCharged, 'segment_video_batch_concurrent');
        settledOrRefunded = true;
      } catch { /* 保留 charged 账目 */ }
      await updateMeta(() => { if (!failed.includes(segId)) failed.push(segId); }).catch(() => {});
      logger.warn(`[BATCH-CONCURRENT] seg=${segId} 失败，跳过继续（job=${job.id}）: ${e?.message || e}`);
    } finally {
      if (settledOrRefunded) await updateMeta(() => { delete charged[segId]; }); // 该段已结算/退款，清账
    }
  }

  await runPool(segmentIds, BATCH_CONCURRENT_LIMIT, processOne);

  // 回写分集时长（段状态可能变化，保持与单段/串行一致）
  try {
    const first = await StoryboardSegment.findByPk(segmentIds[0]);
    if (first) {
      const ep = await Episode.findByPk(first.episode_id);
      if (ep) await refreshEpisodeDuration(ep);
    }
  } catch { /* ignore */ }

  const balance = await balanceOf(userId);
  await ctx.reportProgress(100, `完成 ${completed.length}/${total}`);
  return { completed, failed, total, credits_used: settledCredits, balance };
}

// ---- 单段任务的重启恢复 workFn（job.service.resumeInterruptedJobs 提交）----
// 服务重启后原 workFn 蒸发，但其厂商任务仍在生成：video_generations record 由扫描线程
// 继续查询至终态（无超时）。恢复时刻意「不清理、不退款、不重新提交」——继续等终态并完成
// 与原 workFn 相同的收尾；只有等来失败终态才按预扣流水退款（与取消/清理同一口径）。

/** 读该 Job 原预扣额（withCredits 在重启前已扣）：成功时作为 credits_used 回填，不重复扣费 */
async function jobHoldAmount(userId, jobId) {
  const hold = await findJobHold(userId, jobId);
  return hold && hold.amount < 0 ? Math.abs(hold.amount) : 0;
}

/** 恢复失败收尾：按预扣流水全额退款 + 回写 meta（与超时取消/僵尸取消同一退款口径） */
async function refundResumedJob(job, reason) {
  const refund = await refundJobHold(job.user_id, job.id, job.meta?.feature, reason);
  if (refund) await job.update({ meta: { ...(job.meta || {}), refunded_credits: refund } });
  return refund;
}

/**
 * 单段视频类任务（segment_video / segment_generate）的重启恢复 workFn。
 * job.ref_id 即目标分镜；jobId 复用原任务 → generateVideo 内部会命中已有厂商 record，
 * 不重新提交、只等待终态 + 下载/抽帧/落库 done（收尾与路由 workFn 完全一致）。
 */
export async function segmentVideoResumeWorkFn(ctx) {
  const job = await Job.findByPk(ctx.jobId);
  if (!job) return null;
  const userId = job.user_id;
  const segment = await StoryboardSegment.findByPk(job.ref_id);
  if (!segment) {
    // 分镜已删除：无处收尾，按预扣流水退款后置失败（与恢复失败同口径，勿让预扣悬空）
    await refundResumedJob(job, '重启恢复退款（分镜已删除）');
    throw new Error('分镜已删除，无法恢复该任务的生成结果');
  }
  const holdAmount = await jobHoldAmount(userId, job.id);
  try {
    await ctx.reportProgress(50, '服务重启恢复：等待厂商生成结果…');
    // modelConfigId/resolution 从 meta 回传：meta 缺失（旧任务）时才落默认解析——
    // 不回传会在「重启踩中提交窗口」时换默认模型、降分辨率，与用户所选/所付不符
    await generateSegmentVideo(userId, segment, {
      modelConfigId: job.meta?.modelConfigId || null,
      resolution: job.meta?.resolution || null,
      jobId: job.id,
      feature: job.meta?.feature || job.type,
    });
  } catch (e) {
    await segment.update({ status: 'failed' });
    await refundResumedJob(job, '重启恢复失败退款');
    throw e;
  }
  const episode = await Episode.findByPk(segment.episode_id);
  if (episode) await refreshEpisodeDuration(episode);
  const fresh = await StoryboardSegment.findByPk(segment.id);
  return { segment: fresh, credits_used: holdAmount, balance: await balanceOf(userId) };
}

/**
 * 「去除字幕」任务（segment_erase_subtitle）的重启恢复 workFn。
 * job.ref_id 即目标分镜；jobId/segmentId 复用原任务 → eraseVideoSubtitles 内部会命中已有
 * 厂商 record，不重新提交（无需再规整原视频），等待终态后与路由 workFn 相同地收尾：
 * 重抽关键帧、尾帧 provider 原图优先/ffmpeg 兜底、落库 done、清被替换旧文件。
 */
export async function segmentEraseResumeWorkFn(ctx) {
  const job = await Job.findByPk(ctx.jobId);
  if (!job) return null;
  const userId = job.user_id;
  const segment = await StoryboardSegment.findByPk(job.ref_id);
  if (!segment) {
    // 分镜已删除：无处收尾，按预扣流水退款后置失败（与恢复失败同口径，勿让预扣悬空）
    await refundResumedJob(job, '重启恢复退款（分镜已删除）');
    throw new Error('分镜已删除，无法恢复该任务的擦除结果');
  }
  const holdAmount = await jobHoldAmount(userId, job.id);
  // 被替换的旧视频/关键帧/尾帧：段行仍持旧值（重启时未回写），成功落库新值后再清理
  const oldFiles = [segment.video_url, segment.keyframe_url, segment.last_frame_url].filter(Boolean);
  try {
    await ctx.reportProgress(50, '服务重启恢复：等待厂商擦除结果…');
    const { videoUrl: newUrl, outPath, lastFrameUrl: providerLastFrame, lastFrameSource: providerLastFrameSource } = await eraseVideoSubtitles(userId, {
      videoUrl: segment.video_url,
      duration: segment.duration || 5,
      modelConfigId: job.meta?.modelConfigId || null,
      resolution: job.meta?.resolution || null,
      aspect: job.meta?.aspect || null,
      jobId: job.id,
      segmentId: segment.id,
    });
    // 关键帧：重抽新视频首帧（尽力而为，失败不影响视频落库）
    let keyframeUrl = segment.keyframe_url || null;
    try {
      const { absPath: kfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
      await extractFirstFrame(outPath, kfAbs);
      keyframeUrl = toUrl(kfAbs);
    } catch (e) {
      logger.warn(`[ERASE→恢复] 抽取关键帧首帧失败 seg=${segment.id}: ${e?.message || e}`);
    }
    // 尾帧：优先 provider 返回的原图（原样保存、不得修改），未返回时 ffmpeg 抽帧兜底
    let lastFrameUrl = providerLastFrame || null;
    let lastFrameSource = providerLastFrame ? (providerLastFrameSource || null) : null;
    if (!lastFrameUrl) {
      try {
        const { absPath: lfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
        await extractLastFrame(outPath, lfAbs);
        lastFrameUrl = toUrl(lfAbs);
        lastFrameSource = 'ffmpeg';
      } catch (e) {
        logger.warn(`[ERASE→恢复] 抽取尾帧失败 seg=${segment.id}: ${e?.message || e}`);
      }
    }
    // 换视频（擦除重启恢复写回）重置审阅标记
    await segment.update({ video_url: newUrl, keyframe_url: keyframeUrl, last_frame_url: lastFrameUrl, last_frame_source: lastFrameSource, status: 'done', reviewed_at: null, reviewer_id: null });
    deleteUrlFiles(oldFiles, [newUrl, keyframeUrl, lastFrameUrl].filter(Boolean));
  } catch (e) {
    // 擦除失败：原视频未被替换仍可用，状态回 done 而非 failed（与原 workFn catch 同口径）
    await segment.update({ status: segment.video_url ? 'done' : 'failed' });
    await refundResumedJob(job, '重启恢复失败退款');
    throw e;
  }
  const episode = await Episode.findByPk(segment.episode_id);
  if (episode) await refreshEpisodeDuration(episode);
  const fresh = await StoryboardSegment.findByPk(segment.id);
  return { segment: fresh, credits_used: holdAmount, balance: await balanceOf(userId) };
}
