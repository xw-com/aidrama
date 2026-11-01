import { Router } from 'express';
import fs from 'fs';
import db from '../db/index.js';
import { config } from '../config/index.js';
import { asyncHandler, ok, badRequest, notFound, forbidden } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { loadOwnedEpisode, loadOwnedProject } from '../utils/ownership.js';
import { resolveProjectAccess } from '../utils/access.js';
import { estimateCost, assertBalance, attachTierPricing, estimateSubtitleCost, estimateTextCost, applyModelPromo } from '../services/pricing.service.js';
import { withCredits } from '../services/credits.service.js';
import { concatVideosWithTransitions, probeMedia, extractAudio, burnSubtitles, assembleEdit, canvasFor, extractFirstFrame, extractLastFrame, extractFilmCover } from '../services/ffmpeg.service.js';
import { refreshEpisodeDuration } from '../services/segmentVideo.service.js';
import { transcribe } from '../services/asr.service.js';
import { normalizeSegments, segmentizeSegments, splitSegmentsByPunctuation, segmentsToSrt, segmentsToAss, subtitleLineCapacity } from '../services/subtitle.service.js';
import { resolveConfig, getConfig } from '../services/modelConfig.service.js';
import { correctSubtitleText, mergeCorrections } from '../services/ai/subtitleCorrect.service.js';
import { toUrl, genFilePath, urlToPath, deleteUrlFiles } from '../utils/fileUtil.js';
import { createJob, submit } from '../services/job.service.js';
import { labelVideo } from '../services/aigcLabel.service.js';
import { logger } from '../utils/logger.js';

const router = Router();
const { StoryboardSegment } = db;

/**
 * 加载 Job 并校验访问权（团队共享）：本人的产物恒放行（Job 永挂操作者）；
 * 他人的产物须该 Job 所属项目可访问——perm 省略 = 读（任意成员），perm 传入 = 写（成员需持有该权限）。
 * 无 project_id 的他人 Job 一律拒绝。找不到抛 404，无权抛 403。
 */
async function loadAccessibleJob(userId, jobId, perm = null) {
  const job = await db.Job.findByPk(jobId);
  if (!job) throw notFound('common.not_found');
  if (job.user_id !== userId) {
    if (!job.project_id) throw forbidden('common.forbidden');
    const project = await db.Project.findByPk(job.project_id, { attributes: { exclude: ["raw_script"] } });
    if (!project) throw forbidden('common.forbidden');
    const access = await resolveProjectAccess(userId, project);
    if (!access) throw forbidden('common.forbidden');
    if (perm && access.role !== 'owner' && !access.permissions.includes(perm)) throw forbidden('member.no_permission');
  }
  return job;
}

/**
 * 成片行访问权（团队共享，口径同 loadAccessibleJob）：本人发起的恒放行；他人的成片须其所属项目
 * 可访问——perm 省略 = 读（任意成员），perm 传入 = 写（成员需持有该权限）。项目缺失/无权抛 403。
 */
async function assertFilmAccess(userId, film, perm = null) {
  if (film.user_id !== userId) {
    const project = await db.Project.findByPk(film.project_id, { attributes: { exclude: ['raw_script'] } });
    if (!project) throw forbidden('common.forbidden');
    const access = await resolveProjectAccess(userId, project);
    if (!access) throw forbidden('common.forbidden');
    if (perm && access.role !== 'owner' && !access.permissions.includes(perm)) throw forbidden('member.no_permission');
  }
}

/**
 * 源成片视频 URL（按源 Job id 回溯）：优先成片落档行（compose/edit），兜底源 Job 产物；
 * 两处都无（Job 已清且行缺失）返回 null——调用方按「源视频缺失」处理。
 */
async function sourceFilmUrlOf(sourceJobId) {
  if (!sourceJobId) return null;
  const film = await db.EpisodeVideo.findOne({
    where: { job_id: sourceJobId, hidden: false, kind: { [db.Sequelize.Op.in]: ['compose', 'edit'] } },
    order: [['created_at', 'DESC']],
  });
  if (film?.video_url) return film.video_url;
  const srcJob = await db.Job.findByPk(sourceJobId).catch(() => null);
  return srcJob ? jobVideoOf(srcJob).url : null;
}

/**
 * 已校正标志自愈：行上未打标（false/null）时，回溯该草稿名下最近一次成功的校正任务补标落行。
 * 标志本体随草稿行落档（与 jobs 表解耦），jobs 只是打标前老草稿的历史来源——补一次就够，
 * 打标后不再查询；jobs 已清且无备份时查不到，维持行上现状（不阻塞编辑）。
 */
async function backfillCorrectedFlag(film) {
  if (film.corrected) return film;
  const hist = await db.Job.findOne({
    where: { type: 'subtitle_correct', ref_id: film.job_id, status: 'succeeded' },
    order: [['created_at', 'DESC']],
  }).catch(() => null);
  if (!hist) return film;
  await film.update({ corrected: true, corrected_count: film.corrected_count ?? (Number(hist.result?.subtitle?.changed_count) || 0) });
  return film;
}

/**
 * 把提取 Job 名下的字幕草稿（result.subtitle）水合成/补齐成片行：段落、源成片 URL、尺寸、
 * 已校正标记（草稿自带 or 回溯最近一次成功校正任务）。幂等：行已存在时只补缺失字段。
 * 调用前提：访问权已由上游校验（水合只发生在 Job 访问权通过之后）。
 */
async function hydrateSubtitleFilm(job, sub) {
  let corrected = sub.corrected === true;
  let correctedCount = Number.isFinite(sub.corrected_count) ? sub.corrected_count : null;
  if (!corrected) {
    // 老草稿（打标前已校正过）回溯该草稿名下最近一次成功的校正任务
    const hist = await db.Job.findOne({
      where: { type: 'subtitle_correct', ref_id: job.id, status: 'succeeded' },
      order: [['created_at', 'DESC']],
    }).catch(() => null);
    if (hist) {
      corrected = true;
      correctedCount = correctedCount ?? (Number(hist.result?.subtitle?.changed_count) || 0);
    }
  }
  const sourceVideoUrl = sub.source_video_url || (await sourceFilmUrlOf(sub.source_job_id ?? job.ref_id)) || null;
  const [film] = await db.EpisodeVideo.findOrCreate({
    where: { kind: 'subtitle', job_id: job.id },
    defaults: {
      project_id: job.project_id, episode_id: job.episode_id, user_id: job.user_id,
      kind: 'subtitle', job_id: job.id, source_job_id: sub.source_job_id ?? job.ref_id ?? null,
      video_url: sub.video_url || null, srt_url: sub.srt_url || null, ass_url: sub.ass_url || null,
      duration: sub.duration || 0,
      segments_count: sub.segments_count || (Array.isArray(sub.segments) ? sub.segments.length : 0),
      segments: Array.isArray(sub.segments) ? sub.segments : [],
      source_video_url: sourceVideoUrl,
      width: Math.round(sub.width) || 0, height: Math.round(sub.height) || 0,
      corrected, corrected_count: correctedCount,
    },
  });
  // 早期落档行只存外壳（srt/时长）：补齐缺失的段落/源 URL/尺寸/校正标记
  const patch = {};
  if ((!Array.isArray(film.segments) || !film.segments.length) && Array.isArray(sub.segments) && sub.segments.length) patch.segments = sub.segments;
  if (!film.source_video_url && sourceVideoUrl) patch.source_video_url = sourceVideoUrl;
  if (!(Number(film.width) > 0) && Number(sub.width) > 0) patch.width = Math.round(sub.width);
  if (!(Number(film.height) > 0) && Number(sub.height) > 0) patch.height = Math.round(sub.height);
  // 已校正标志只增不回退：行上 false/null 都允许按历史补标（打标前老草稿、旧回填写死的 false）
  if (!film.corrected && corrected) { patch.corrected = corrected; patch.corrected_count = correctedCount; }
  if (Object.keys(patch).length) await film.update(patch);
  return film;
}

/**
 * 加载字幕草稿行（episode_videos, kind='subtitle'）并校验访问权（perm 语义同 loadAccessibleJob）：
 * 段落/源成片/尺寸/校正标记全在行上，字幕编辑与 jobs 表解耦（Job 清理后草稿仍可编辑、可重烧）。
 * 行缺失或行上无段落（早期落档只存外壳）时，从提取 Job 水合补齐一次；Job 已清则维持行上存量。
 */
async function loadSubtitleFilm(userId, jobId, perm = null) {
  let film = await db.EpisodeVideo.findOne({ where: { kind: 'subtitle', job_id: jobId } });
  if (!film) {
    const job = await loadAccessibleJob(userId, jobId, perm);
    const sub = job.type === 'video_subtitle' ? job.result?.subtitle : null;
    if (job.type !== 'video_subtitle' || job.status !== 'succeeded' || !sub) throw badRequest('video.subtitle_not_ready');
    return hydrateSubtitleFilm(job, sub);
  }
  await assertFilmAccess(userId, film, perm);
  if (!Array.isArray(film.segments) || !film.segments.length) {
    const job = await db.Job.findByPk(jobId).catch(() => null);
    const sub = job?.type === 'video_subtitle' && job.status === 'succeeded' ? job.result?.subtitle : null;
    if (sub) film = await hydrateSubtitleFilm(job, sub);
  }
  // 已校正标志自愈：老草稿未打标时按校正历史补一次（见 backfillCorrectedFlag），此后随行走
  if (!film.corrected) film = await backfillCorrectedFlag(film);
  return film;
}

/**
 * 成片类 Job 的视频产物：合成版挂 result.episode、剪辑版挂 result.edit（时长同理）。
 * 字幕版产物在提取 Job 名下（result.subtitle），不在此列。
 */
function jobVideoOf(job) {
  if (!job) return { url: null, duration: 0 };
  if (job.type === 'video_synthesis') return { url: job.result?.episode?.video_url || null, duration: job.result?.episode?.duration || 0 };
  if (job.type === 'video_edit') return { url: job.result?.edit?.video_url || null, duration: job.result?.edit?.duration || 0 };
  return { url: null, duration: 0 };
}

/**
 * 加载「加字幕」的源成片：合成版与剪辑版同权（与成片列表同口径，分镜源剪辑的产物已写回
 * 分镜、不算成片），须有视频且文件仍在本地。
 * 优先成片落档行（与 jobs 表解耦，Job 清理后入口不受影响），行缺失回溯源 Job；
 * 访问权：行按 assertFilmAccess、Job 按 loadAccessibleJob（perm 语义不变）。
 * 返回 { film?|job?, projectId, episodeId, url, path, duration }；不满足条件抛对应错误。
 */
async function loadSubtitleSource(userId, jobId, perm = null) {
  const film = await db.EpisodeVideo.findOne({
    where: { job_id: jobId, hidden: false, kind: { [db.Sequelize.Op.in]: ['compose', 'edit'] }, video_url: { [db.Sequelize.Op.ne]: null } },
    order: [['created_at', 'DESC']],
  });
  if (film) {
    await assertFilmAccess(userId, film, perm);
    const p = urlToPath(film.video_url);
    if (!p || !fs.existsSync(p)) throw badRequest('video.source_video_missing');
    return { film, projectId: film.project_id, episodeId: film.episode_id, url: film.video_url, path: p, duration: film.duration || 0 };
  }
  const job = await loadAccessibleJob(userId, jobId, perm);
  const isFilm = job.type === 'video_synthesis' || (job.type === 'video_edit' && job.meta?.editSource !== 'segment');
  if (!isFilm || job.status !== 'succeeded') throw badRequest('video.subtitle_source_invalid');
  const url = jobVideoOf(job).url;
  const p = url ? urlToPath(url) : null;
  if (!p || !fs.existsSync(p)) throw badRequest('video.source_video_missing');
  return { job, projectId: job.project_id, episodeId: job.episode_id, url, path: p, duration: jobVideoOf(job).duration || 0 };
}

// —— 单视频在线剪辑（掐头去尾 / 分割 / 删段 / 调序 → 导出新成片）——
const EDIT_MAX_SEGMENTS = 100;   // 剪辑段数量上限
const EDIT_MIN_SEG_SEC = 0.2;    // 最短段长（25fps 下 5 帧，与前端 MIN_SEG_MS=200 一致）
const EDIT_CLAMP_EPS_SEC = 0.05; // 浮点容差：越界 ≤50ms 静默收敛，超出报错（源时长对不上时不做静默大改）
const EDIT_RESOLUTIONS = {       // 导出档位：计费系数（editor_export 每分钟价 × 系数）+ 输出画布短边
  '480p': { factor: 1, shortEdge: 480 },   // casing 与 COMPOSE_RESOLUTIONS / 管理端 VIDEO_RESOLUTION_PRESETS 一致（'2K'/'4K' 大写 K）
  '720p': { factor: 1, shortEdge: 720 },
  '768p': { factor: 1, shortEdge: 768 },
  '1080p': { factor: 2, shortEdge: 1080 },
  '2K': { factor: 4, shortEdge: 1440 },
  '4K': { factor: 8, shortEdge: 2160 },
};
const COMPOSE_RESOLUTIONS = {    // 合成分辨率档位：计费系数（video_synthesis 每集基准价 × 系数）+ 成片画布短边
  '480p': { factor: 1, shortEdge: 480 },   // casing 与管理端 VIDEO_RESOLUTION_PRESETS 一致（'2K'/'4K' 大写 K）
  '720p': { factor: 1, shortEdge: 720 },
  '768p': { factor: 1, shortEdge: 768 },
  '1080p': { factor: 1, shortEdge: 1080 }, // 默认档 = 现行为：旧调用不传 resolution 完全等价
  '2K': { factor: 2, shortEdge: 1440 },
  '4K': { factor: 4, shortEdge: 2160 },
};
const COMPOSE_DEFAULT_RESOLUTION = '1080p';

/**
 * 加载「剪辑」的源：ref 为数字（成片任务/落档行）或 `seg-<id>`（分镜视频——批量生成无独立 Job，视频只挂分镜行）。
 * 数字 ref 优先成片落档行（合成/字幕版/剪辑导出成片，剪辑版可再剪；与 jobs 表解耦，Job 清理后入口
 * 不受影响），行缺失回溯源 Job，须有视频且文件仍在本地。
 * 访问权口径同 loadSubtitleSource（本人恒放行；他人产物读=项目成员、写=video.manage）。
 * 返回 { kind:'film'|'job', ... , projectId, episodeId, srcJobId, srcType, url, path }——
 * srcJobId/srcType 统一两条分支的「上游任务 id / 任务类型」（落档行取 job_id 与 kind 映射）。
 */
async function loadEditSource(userId, ref, perm = null) {
  if (/^seg-\d+$/.test(String(ref))) return loadSegmentEditSource(userId, Number(String(ref).slice(4)), perm);
  const film = await db.EpisodeVideo.findOne({
    where: { job_id: ref, hidden: false, video_url: { [db.Sequelize.Op.ne]: null } },
    order: [['created_at', 'DESC']],
  });
  if (film) {
    await assertFilmAccess(userId, film, perm);
    const p = urlToPath(film.video_url);
    if (!p || !fs.existsSync(p)) throw badRequest('video.source_video_missing');
    const srcType = film.kind === 'compose' ? 'video_synthesis' : film.kind === 'subtitle' ? 'video_subtitle' : 'video_edit';
    return { kind: 'film', film, projectId: film.project_id, episodeId: film.episode_id, srcJobId: film.job_id, srcType, url: film.video_url, path: p };
  }
  const job = await loadAccessibleJob(userId, ref, perm);
  if (!['video_synthesis', 'video_subtitle', 'video_edit'].includes(job.type) || job.status !== 'succeeded') {
    throw badRequest('video.edit_source_invalid');
  }
  const url = job.type === 'video_synthesis'
    ? job.result?.episode?.video_url
    : job.type === 'video_subtitle' ? job.result?.subtitle?.video_url : job.result?.edit?.video_url;
  const p = url ? urlToPath(url) : null;
  if (!p || !fs.existsSync(p)) throw badRequest('video.source_video_missing');
  return { kind: 'job', job, projectId: job.project_id, episodeId: job.episode_id, srcJobId: job.id, srcType: job.type, url, path: p };
}

/**
 * 分镜视频源：须已生成（video_url 落盘）。分镜无 user_id，访问权走所属项目
 * （项目成员可读；perm=video.manage 时成员须持有该权限，owner 恒通过）——与成片口径对齐。
 * 返回 { kind:'segment', segment, episode, project, url, path }。
 */
async function loadSegmentEditSource(userId, segmentId, perm = null) {
  const segment = await StoryboardSegment.findByPk(segmentId);
  if (!segment) throw notFound('common.not_found');
  const episode = segment.episode_id ? await db.Episode.findByPk(segment.episode_id) : null;
  const project = episode?.project_id ? await db.Project.findByPk(episode.project_id, { attributes: { exclude: ["raw_script"] } }) : null;
  if (!episode || !project) throw forbidden('common.forbidden');
  const access = await resolveProjectAccess(userId, project);
  if (!access) throw forbidden('common.forbidden');
  if (perm && access.role !== 'owner' && !access.permissions.includes(perm)) throw forbidden('member.no_permission');
  if (!segment.video_url) throw badRequest('video.edit_source_invalid');
  const p = urlToPath(segment.video_url);
  if (!p || !fs.existsSync(p)) throw badRequest('video.source_video_missing');
  return { kind: 'segment', segment, episode, project, url: segment.video_url, path: p };
}

/**
 * 校验并归一化前端提交的剪辑段（源时间轴毫秒；段间允许重叠，保持用户提交顺序——调序是功能）。
 * 返回 { segments: [{ss,t}]（秒）, totalSec }；不合法直接抛 i18n 错误键。
 */
function normalizeEditSegments(raw, srcDurationSec) {
  const durMs = Math.max(0, (Number(srcDurationSec) || 0) * 1000);
  if (!Array.isArray(raw) || !raw.length) throw badRequest('video.edit_no_segments');
  if (raw.length > EDIT_MAX_SEGMENTS) throw badRequest('video.edit_too_many_segments', { max: EDIT_MAX_SEGMENTS });
  const epsMs = EDIT_CLAMP_EPS_SEC * 1000;
  const out = [];
  raw.forEach((s, idx) => {
    const a = Number(s?.startMs);
    const b = Number(s?.endMs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw badRequest('video.edit_segment_invalid', { idx: idx + 1 });
    const startMs = Math.min(Math.max(a, 0), durMs);
    const endMs = Math.min(Math.max(b, 0), durMs);
    if (Math.abs(startMs - a) > epsMs || Math.abs(endMs - b) > epsMs) {
      throw badRequest('video.edit_segment_out_of_range', { idx: idx + 1 });
    }
    if (endMs - startMs < EDIT_MIN_SEG_SEC * 1000) throw badRequest('video.edit_segment_too_short', { idx: idx + 1, min: EDIT_MIN_SEG_SEC });
    out.push({ ss: startMs / 1000, t: (endMs - startMs) / 1000 });
  });
  const totalSec = out.reduce((n, s) => n + s.t, 0);
  return { segments: out, totalSec };
}

function editResolution(raw) {
  const r = EDIT_RESOLUTIONS[raw];
  if (!r) throw badRequest('video.edit_resolution_invalid');
  return r;
}

// 合成分辨率白名单校验：缺省回退默认档（旧调用等价），非法值抛 i18n 错误键。
// 返回 { key, factor, shortEdge } —— key 供 meta/列表角标，factor 供计费，shortEdge 供合成画布。
function composeResolution(raw) {
  const key = raw || COMPOSE_DEFAULT_RESOLUTION;
  const cfg = COMPOSE_RESOLUTIONS[key];
  if (!cfg) throw badRequest('video.compose_resolution_invalid');
  return { key, ...cfg };
}

// 剪辑导出计费：输出时长先按分钟向上取整（不足 1 分钟按 1 分钟），再乘分辨率系数。
// estimateCost 的 unit=60 秒，传入「分钟×系数×60 秒」恰好得到 units=分钟×系数。
function editEstimateCredits(seconds, factor) {
  const minutes = Math.max(1, Math.ceil((Number(seconds) || 0) / 60));
  return estimateCost('editor_export', minutes * factor * 60);
}

// 合成消耗估算（按所选分辨率档位计系数）
router.get('/episodes/:eid/compose/estimate', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid);
  const resCfg = composeResolution(req.query.resolution);
  const { credits, pricing } = await estimateCost('video_synthesis', resCfg.factor);
  const tierPricing = await attachTierPricing(req.user, credits);
  const segs = await StoryboardSegment.findAll({ where: { episode_id: episode.id, selected: true, video_url: { [db.Sequelize.Op.ne]: null } } });
  return ok(res, { credits, pricing, ready_segments: segs.length, resolution: resCfg.key, ...tierPricing });
}));

// 合成全集（异步任务）
router.post('/episodes/:eid/compose', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'video.manage');
  const segments = await StoryboardSegment.findAll({
    where: { episode_id: episode.id, selected: true },
    order: [['idx', 'ASC']],
  });
  const ready = segments.filter((s) => s.video_url);
  if (!ready.length) throw badRequest('video.no_composable_segments');

  // 白名单校验 + 按档位系数计价（不信任前端价格；非法值在计费/建任务之前抛出，无副作用）
  const resCfg = composeResolution(req.body?.resolution);
  const { credits: est } = await estimateCost('video_synthesis', resCfg.factor);
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'video_synthesis', projectId: project.id, episodeId: episode.id,
    meta: { feature: 'video_synthesis', label: '合成全集', projectName: project.name, episodeTitle: episode.title, targetName: episode.title, estimate: est, resolution: resCfg.key },
  });
  submit(job.id, async (ctx) => {
    let filmUrl = null;
    let coverUrl = null;
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'video_synthesis', jobId: job.id, refId: episode.id, remark: '合成全集' },
      async () => {
        await ctx.reportProgress(20, '校验片段…');
        // 把每个片段视频下载/解析为本地路径
        const localPaths = [];
        for (const s of ready) {
          const p = urlToPath(s.video_url);
          if (!p || !fs.existsSync(p)) {
            // 远程视频需先下载（这里简化：要求本地文件）
            throw badRequest('video.segment_video_missing', { idx: s.idx });
          }
          localPaths.push(p);
        }
        await ctx.reportProgress(70, '拼接视频（仅手动设置的转场）…');
        const { absPath } = genFilePath(config.outputDir, 'mp4', 'episode');
        // 传分镜元数据，供 resolveTransition 选择转场：仅使用用户手动设置的 transition，未设置时一律硬切（不再自动添加转场）
        const segMeta = ready.map((s) => ({ transition: s.transition }));
        // 画布跟项目画幅走：横版项目合成 1920x1080 横版成片（片段亦按此画幅生成），不再硬塞竖版画布；
        // 短边 = 用户所选分辨率档位（默认 1080 = 现行为）
        await concatVideosWithTransitions(localPaths, absPath, segMeta, project.aspect_ratio, resCfg.shortEdge);
        // 合规（AI 显式标识）：合成成片属 AI 生成内容，须加显式「AI生成」角标（《人工智能生成合成内容标识办法》）。
        // 在整条转场/concat 完成后的成品文件上做后处理（labelVideo 内部先出临时文件再同目录原位替换），
        // 不介入既有 ffmpeg 合成流程；episode_videos.video_url 指向的文件即带标识。
        // 失败时 labelVideo 内部降级返回原文件（仅告警不阻断合成）。字幕版/剪辑版均由本成片再加工，
        // 角标已烧入像素随之保留，无需重复打标。
        filmUrl = toUrl(await labelVideo(absPath, absPath));
        // 成片封面：抽成品第一帧出 480P webp（长宽按项目画幅）；失败不阻断合成（落档行为空，扫描线程/重合成兜底）
        try {
          coverUrl = toUrl(await extractFilmCover(absPath, project.aspect_ratio));
        } catch (e) { logger.warn('成片封面生成失败（跳过）:', e.message); }
        await episode.update({ video_url: filmUrl, status: 'done' });
        await project.update({ status: 'video' });
        return { _actualCredits: est };
      });
    const fresh = await db.Episode.findByPk(episode.id);
    // 成片落档（episode_videos）：成片查询与 jobs 表解耦，Job 清理/删除不影响成片历史
    if (filmUrl) {
      await db.EpisodeVideo.create({
        project_id: project.id, episode_id: episode.id, user_id: req.user.id, kind: 'compose',
        video_url: filmUrl, cover_url: coverUrl, duration: fresh?.duration || 0, resolution: resCfg.key, job_id: job.id,
      }).catch((e) => logger.warn('成片落档失败:', e.message));
    }
    return { episode: fresh, resolution: resCfg.key, credits_used: spent, balance };
  });
  return ok(res, { job }, 'video.compose_job_submitted');
}));

// 获取视频信息
router.get('/episodes/:eid/video', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid);
  return ok(res, { video_url: episode.video_url, status: episode.status, duration: episode.duration });
}));

// 成片加字幕消耗估算（按成片实际时长 × ASR 模型价/全局定价）
router.get('/videos/:jobId/subtitle/estimate', authRequired, asyncHandler(async (req, res) => {
  const { path: srcPath, duration: srcDuration } = await loadSubtitleSource(req.user.id, req.params.jobId);
  const cfg = req.query.modelConfigId ? await getConfig(req.user.id, req.query.modelConfigId) : await resolveConfig(req.user.id, 'asr');
  const probe = await probeMedia(srcPath).catch(() => null);
  const duration = Math.ceil(probe?.duration || srcDuration || 0);
  const { credits, source, pricing } = await estimateSubtitleCost(cfg, duration);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, duration, minutes: Math.max(1, Math.ceil(duration / 60)), ...tierPricing });
}));

// 成片提取字幕（异步任务，两段式第一步）：提取音频 → ASR 识别台词（带时间戳）→ 生成 SRT 草稿。
// 不烧录——用户在前端字幕编辑器里校对/修改后，走 POST /videos/:jobId/subtitle/burn 单独合并。
// 同源提交互斥：下方查重守卫（dupFilm/dupJob）与 createJob 不在同一事务，两个并发提交
// （双击确认/双端/团队成员同刻提交）可双双穿过守卫。进程内按源成片 Job 串行化整个提交段；
// 多进程部署再由 createJob 的「同目标在途任务」预检兜底。
const subtitleSubmitLocks = new Map();
function withSubtitleLock(key, fn) {
  const prev = subtitleSubmitLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  subtitleSubmitLocks.set(key, next);
  const done = () => { if (subtitleSubmitLocks.get(key) === next) subtitleSubmitLocks.delete(key); };
  next.then(done, done);
  return next;
}

router.post('/videos/:jobId/subtitle', authRequired, asyncHandler(async (req, res) => withSubtitleLock(`sub:${Number(req.params.jobId)}`, async () => {
  const modelConfigId = req.body?.modelConfigId || null;
  const srcJobId = Number(req.params.jobId);
  const { projectId, episodeId, url: srcUrl, path: srcPath, duration: srcDuration } = await loadSubtitleSource(req.user.id, req.params.jobId, 'video.manage');
  // 幂等防重：同一成片已有草稿行、或提取任务仍在途时拒绝重复提交。此前防重只靠前端禁用 CC 入口，
  // 多端/多标签、任务完成到成片列表刷新的间隙下会漏，同一成片会落两张相同草稿。
  // 草稿已删（hidden=true）或历史任务失败/取消不拦，允许重新提取。
  const [dupFilm, dupJob] = await Promise.all([
    db.EpisodeVideo.findOne({ where: { kind: 'subtitle', source_job_id: srcJobId, hidden: false }, attributes: ['id'] }),
    db.Job.findOne({ where: { type: 'video_subtitle', ref_id: srcJobId, status: { [db.Sequelize.Op.in]: ['pending', 'running'] } }, attributes: ['id'] }),
  ]);
  if (dupFilm || dupJob) throw badRequest('video.subtitle_exists');
  const cfg = modelConfigId ? await getConfig(req.user.id, modelConfigId) : await resolveConfig(req.user.id, 'asr');

  const probe = await probeMedia(srcPath).catch(() => null);
  const duration = Math.ceil(probe?.duration || srcDuration || 0);
  const { credits: nominal } = await estimateSubtitleCost(cfg, duration);
  const est = applyModelPromo(cfg, nominal);
  await assertBalance(req.user, est);

  const [project, episode] = await Promise.all([
    projectId ? db.Project.findByPk(projectId, { attributes: { exclude: ["raw_script"] } }) : null,
    episodeId ? db.Episode.findByPk(episodeId) : null,
  ]);

  const job = await createJob(req.user.id, {
    type: 'video_subtitle', projectId, episodeId, refId: srcJobId,
    meta: {
      feature: 'video_subtitle', label: '提取字幕', stage: 'extract', projectName: project?.name || '', episodeTitle: episode?.title || '', targetName: episode?.title || '',
      estimate: est, sourceJobId: srcJobId, modelConfigId,
    },
  });
  submit(job.id, async (ctx) => {
    const { result, spent, balance } = await withCredits(req.user.id, est, { feature: 'video_subtitle', jobId: job.id, refId: srcJobId, remark: '成片加字幕' },
      async () => {
        // 排队期间源文件可能被删（如用户删除了该成片），执行前再校验一次
        if (!fs.existsSync(srcPath)) throw badRequest('video.source_video_missing');

        await ctx.reportProgress(10, '提取音频…');
        // 音频放 outputDir（/files 静态可访问）：火山标准版要求传公网 URL，服务端要能被回调拉取
        const { absPath: audioPath } = genFilePath(config.outputDir, 'mp3', 'asr_audio');
        try {
          await extractAudio(srcPath, audioPath);

          await ctx.reportProgress(40, '语音识别台词…');
          const asr = await transcribe(req.user.id, audioPath, { modelConfigId });

          await ctx.reportProgress(75, '生成字幕草稿…');
          const info = await probeMedia(srcPath);
          // 分段策略：先按标点断句（一句一行，须在去标点之前），再按「一行 ≤ 屏宽可容纳汉字数」二次断句
          const lineCap = subtitleLineCapacity({ width: info?.width, height: info?.height }, project?.settings?.subtitle);
          const segments = segmentizeSegments(normalizeSegments(splitSegmentsByPunctuation(asr.segments), info.duration || asr.duration || 0), lineCap);
          if (!segments.length) throw badRequest('video.asr_no_segments');

          const { absPath: srtPath } = genFilePath(config.outputDir, 'srt', 'episode_sub');
          fs.writeFileSync(srtPath, segmentsToSrt(segments, lineCap), 'utf8');

          return {
            _actualCredits: est,
            srt_url: toUrl(srtPath),
            segments,
            segments_count: segments.length,
            source_job_id: srcJobId,
            source_video_url: srcUrl,
            duration: info.duration || asr.duration || 0,
            width: Math.round(info?.width) || 0,
            height: Math.round(info?.height) || 0,
          };
        } finally {
          try { fs.unlinkSync(audioPath); } catch { /* 临时文件清理失败不阻断 */ }
        }
      });
    // 成片落档：字幕草稿行（video_url 为空、仅 srt；烧录后回填），job_id=提取 Job、source_job_id=源成片 Job。
    // 草稿状态（段落/源成片 URL/尺寸）一并落行：字幕编辑与 jobs 表解耦，Job 清理后仍可编辑/重烧。
    // findOrCreate 防重入：同一提取 Job 在重启恢复/并发下也只落一行
    await db.EpisodeVideo.findOrCreate({
      where: { kind: 'subtitle', job_id: job.id },
      defaults: {
        project_id: projectId, episode_id: episodeId, user_id: req.user.id, kind: 'subtitle',
        srt_url: result.srt_url || null, duration: result.duration || 0, segments_count: result.segments_count || 0,
        segments: result.segments || [], source_video_url: srcUrl || null,
        width: result.width || 0, height: result.height || 0, corrected: false,
        job_id: job.id, source_job_id: srcJobId,
      },
    }).catch((e) => logger.warn('成片落档失败:', e.message));
    return { subtitle: result, credits_used: spent, balance };
  });
  return ok(res, { job }, 'video.subtitle_job_submitted');
})));

// 字幕编辑器取段落（两段式）：草稿段落存成片行（与 jobs 表解耦），返回段落 + 视频时长 + 是否已智能校正
router.get('/videos/:jobId/subtitle/segments', authRequired, asyncHandler(async (req, res) => {
  const film = await loadSubtitleFilm(req.user.id, req.params.jobId);
  if (!Array.isArray(film.segments) || !film.segments.length) throw badRequest('video.subtitle_not_ready');
  return ok(res, {
    segments: film.segments,
    duration: film.duration || 0,
    srt_url: film.srt_url || null,
    corrected: film.corrected === true,
    corrected_count: film.corrected_count ?? null,
  });
}));

// 保存字幕段落（两段式编辑器）：校对结果回写成片行（与 jobs 表解耦），并同步重新生成 SRT 草稿文件；
// 统一按「一行 ≤ 屏宽可容纳汉字数、超长拆成等长」标准重新分段（断点落词界，时长按字数比例分配），返回分段结果供编辑器刷新。
router.put('/videos/:jobId/subtitle/segments', authRequired, asyncHandler(async (req, res) => {
  const film = await loadSubtitleFilm(req.user.id, req.params.jobId, 'video.manage');
  if (!Array.isArray(film.segments) || !film.segments.length) throw badRequest('video.subtitle_not_ready');

  const raw = Array.isArray(req.body?.segments) ? req.body.segments : [];
  const project = film.project_id ? await db.Project.findByPk(film.project_id, { attributes: { exclude: ["raw_script"] } }) : null;
  const lineCap = await subtitleLineCapacityFor(film, project?.settings?.subtitle);
  const segments = segmentizeSegments(normalizeSegments(raw, film.duration || 0), lineCap).sort((a, b) => a.start - b.start);
  if (!segments.length) throw badRequest('video.asr_no_segments');

  // 同步 SRT 草稿：能定位原文件就原地覆盖（下载链接不变），失败则另存新文件并更新链接
  let srtUrl = film.srt_url || null;
  let written = false;
  const oldPath = srtUrl ? urlToPath(srtUrl) : null;
  if (oldPath) { try { fs.writeFileSync(oldPath, segmentsToSrt(segments, lineCap), 'utf8'); written = true; } catch { /* 原路径不可写，走另存 */ } }
  if (!written) {
    const { absPath } = genFilePath(config.outputDir, 'srt', 'episode_sub');
    fs.writeFileSync(absPath, segmentsToSrt(segments, lineCap), 'utf8');
    srtUrl = toUrl(absPath);
  }

  await film.update({ segments, segments_count: segments.length, srt_url: srtUrl });
  return ok(res, { segments, segments_count: segments.length, srt_url: srtUrl }, 'video.subtitle_saved');
}));

// —— 智能校正字幕（两段式编辑器内的 AI 能力，异步任务计费）——

// 解析校正所用文本模型配置（用于计费）：指定 id > 默认文本模型 > null（走全局定价兜底）
async function loadTextCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'text');
  } catch { return null; }
}

// 字幕一行可容纳的汉字当量：优先用草稿行存档的视频尺寸（提取/水合时写入），
// 缺失时回探源成片文件（行上 source_video_url → 源成片落档行 → 源 Job 逐级回溯）；
// 拿不到尺寸时回退产品标准（一行 ≤15 汉字）。style 传项目字幕设置。
async function subtitleLineCapacityFor(film, style) {
  let width = Number(film?.width) || 0;
  let height = Number(film?.height) || 0;
  if (!(width > 0 && height > 0)) {
    const url = film?.source_video_url || await sourceFilmUrlOf(film?.source_job_id);
    const p = url ? urlToPath(url) : null;
    const probe = p && fs.existsSync(p) ? await probeMedia(p).catch(() => null) : null;
    width = Math.round(probe?.width) || 0;
    height = Math.round(probe?.height) || 0;
  }
  return subtitleLineCapacity({ width, height }, style);
}

// 智能校正消耗估算：按所选文本模型原标准（模型每次调用价 > 全局 subtitle_correct 定价）
router.get('/videos/:jobId/subtitle/correct/estimate', authRequired, asyncHandler(async (req, res) => {
  const film = await loadSubtitleFilm(req.user.id, req.params.jobId);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'subtitle_correct', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, segments_count: (Array.isArray(film.segments) ? film.segments : []).length, ...tierPricing });
}));

// 智能校正字幕（异步任务）：把「本集剧本 + 当前字幕草稿」交给文本大模型逐条修正 ASR 听写错误
// （只小改、读音/字数相近、时间码不动），结果写回草稿并重生成 SRT。按所选模型标准计费。
router.post('/videos/:jobId/subtitle/correct', authRequired, asyncHandler(async (req, res) => {
  const modelConfigId = req.body?.modelConfigId || null;
  const film = await loadSubtitleFilm(req.user.id, req.params.jobId, 'video.manage');
  if (!Array.isArray(film.segments) || !film.segments.length) throw badRequest('video.subtitle_not_ready');

  // 校正底稿：编辑器提交的当前段落（含未保存的校对），缺省用草稿原稿
  const rawSegs = Array.isArray(req.body?.segments) && req.body.segments.length ? req.body.segments : film.segments;
  const baseSegments = normalizeSegments(rawSegs, film.duration || 0);
  if (!baseSegments.length) throw badRequest('video.asr_no_segments');

  // 本集剧本：校正的对照标准（草稿行上有分集归属）
  const episode = film.episode_id ? await db.Episode.findByPk(film.episode_id) : null;
  const scriptText = String(episode?.content || '').trim();
  if (!scriptText) throw badRequest('video.subtitle_no_script');

  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'subtitle_correct', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const project = film.project_id ? await db.Project.findByPk(film.project_id, { attributes: { exclude: ["raw_script"] } }) : null;
  const correctJob = await createJob(req.user.id, {
    type: 'subtitle_correct', projectId: film.project_id, episodeId: film.episode_id, refId: film.job_id,
    meta: {
      feature: 'subtitle_correct', label: '智能校正字幕', projectName: project?.name || '', episodeTitle: episode?.title || '',
      targetName: episode?.title || '', estimate: est, sourceJobId: film.job_id, modelConfigId,
    },
  });
  submit(correctJob.id, async (ctx) => {
    const { result, spent, balance } = await withCredits(req.user.id, est, { feature: 'subtitle_correct', jobId: correctJob.id, refId: film.job_id, remark: '智能校正字幕' },
      async () => {
        await ctx.reportProgress(20, 'AI 校正台词…');
        const corrections = await correctSubtitleText(req.user.id, { script: scriptText, segments: baseSegments, modelConfigId });
        const { merged, changed } = mergeCorrections(baseSegments, corrections);

        // 写回前终态护栏：LLM 调用期间任务可能已被超时取消（运行中的调用无法中止，本孤儿回调
        // 会继续跑完）——取消即放弃写回，草稿（段落/SRT/已校正标记）保持原样，「已智能校正」
        // 只随真正成功的任务亮起。抛错由 withCredits/runOne 的取消终态对称处理（不再退款、不覆盖状态）。
        const st = await db.Job.findByPk(correctJob.id, { attributes: ['status'] });
        if (!st || st.status !== 'running') throw badRequest('任务已取消，字幕草稿保持原样');

        await ctx.reportProgress(80, '写回字幕草稿…');
        // 与保存接口同一行宽标准重分段并回写草稿 + SRT
        const lineCap = await subtitleLineCapacityFor(film, project?.settings?.subtitle);
        const segments = segmentizeSegments(merged, lineCap).sort((a, b) => a.start - b.start);
        if (!segments.length) throw badRequest('video.asr_no_segments');
        let srtUrl = film.srt_url || null;
        let written = false;
        const oldPath = srtUrl ? urlToPath(srtUrl) : null;
        if (oldPath) { try { fs.writeFileSync(oldPath, segmentsToSrt(segments, lineCap), 'utf8'); written = true; } catch { /* 原路径不可写，走另存 */ } }
        if (!written) {
          const { absPath } = genFilePath(config.outputDir, 'srt', 'episode_sub');
          fs.writeFileSync(absPath, segmentsToSrt(segments, lineCap), 'utf8');
          srtUrl = toUrl(absPath);
        }
        // 回写成片行（与 jobs 表解耦）：段落/SRT/已校正标记（手动编辑保存不清除，只增改不回退）
        await film.update({ segments, segments_count: segments.length, srt_url: srtUrl, corrected: true, corrected_count: changed });

        return {
          _actualCredits: est,
          srt_url: srtUrl,
          segments,
          segments_count: segments.length,
          changed_count: changed,
          total_count: baseSegments.length,
          source_job_id: film.source_job_id || film.job_id || null,
          duration: film.duration || 0,
        };
      });
    return { subtitle: result, credits_used: spent, balance };
  });
  return ok(res, { job: correctJob }, 'video.subtitle_correct_submitted');
}));

// 合并字幕到视频（两段式第二步，异步任务，纯本地 ffmpeg 不计费）：
// 用编辑器提交的段落（缺省用提取时的原稿）生成 ASS → 烧录硬字幕 → 产物回写字幕草稿成片行。
router.post('/videos/:jobId/subtitle/burn', authRequired, asyncHandler(async (req, res) => {
  const film = await loadSubtitleFilm(req.user.id, req.params.jobId, 'video.manage');
  if (!Array.isArray(film.segments) || !film.segments.length) throw badRequest('video.subtitle_not_ready');

  // 源视频按草稿行回溯：行上源成片 URL → 源成片落档行 → 源 Job（与 jobs 表解耦，Job 清理后仍可重烧）：
  // 合成版/剪辑版都认——剪辑版的字幕草稿重烧不再退回未剪辑的原片时间线
  const srcJobId = film.source_job_id || film.job_id;
  const srcUrl = film.source_video_url || await sourceFilmUrlOf(film.source_job_id);
  const srcPath = srcUrl ? urlToPath(srcUrl) : null;
  if (!srcPath || !fs.existsSync(srcPath)) throw badRequest('video.source_video_missing');

  // 编辑器提交的段落；缺省回退提取原稿。统一按「一行 ≤ 屏宽可容纳汉字数、超长拆成等长」标准分段
  const rawSegs = Array.isArray(req.body?.segments) && req.body.segments.length ? req.body.segments : film.segments;
  const probe = await probeMedia(srcPath).catch(() => null);
  const duration = probe?.duration || film.duration || 0;

  const [project, episode] = await Promise.all([
    film.project_id ? db.Project.findByPk(film.project_id, { attributes: { exclude: ["raw_script"] } }) : null,
    film.episode_id ? db.Episode.findByPk(film.episode_id) : null,
  ]);

  // 行宽按视频真实宽度 + 项目字号动态算（横屏约为竖屏两倍），超宽行由 libass 自动折行兜底
  const lineCap = subtitleLineCapacity({ width: probe?.width || film.width, height: probe?.height || film.height }, project?.settings?.subtitle);
  let segments = segmentizeSegments(normalizeSegments(rawSegs, duration), lineCap);
  segments = segments.sort((a, b) => a.start - b.start);
  if (!segments.length) throw badRequest('video.asr_no_segments');

  const job = await createJob(req.user.id, {
    type: 'video_subtitle', projectId: film.project_id, episodeId: film.episode_id, refId: srcJobId,
    meta: {
      feature: 'video_subtitle', label: '合并字幕', stage: 'burn', hidden: true,
      projectName: project?.name || '', episodeTitle: episode?.title || '', targetName: episode?.title || '', sourceJobId: srcJobId,
    },
  });
  submit(job.id, async (ctx) => {
    await ctx.reportProgress(20, '生成字幕样式…');
    const { absPath: srtPath } = genFilePath(config.outputDir, 'srt', 'episode_sub');
    const { absPath: assPath } = genFilePath(config.outputDir, 'ass', 'episode_sub');
    fs.writeFileSync(srtPath, segmentsToSrt(segments, lineCap), 'utf8');
    fs.writeFileSync(assPath, segmentsToAss(segments, { width: probe?.width, height: probe?.height }, project?.settings?.subtitle), 'utf8');

    // 覆盖合并：清掉上一版字幕版产物（视频/srt/ass/封面，缺失不阻断；新生成的 srt 保留）
    for (const old of [film.video_url, film.srt_url, film.ass_url, film.cover_url]) {
      const p = urlToPath(old);
      if (p && p !== srtPath) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 忽略 */ } }
    }

    await ctx.reportProgress(50, '烧录字幕…');
    const { absPath: outPath } = genFilePath(config.outputDir, 'mp4', 'episode_sub');
    await burnSubtitles(srcPath, assPath, outPath);

    // 字幕版封面：抽烧录产物第一帧（0s 处通常无字幕，画面同源片；项目画幅跟 film 所属项目走）
    let coverUrl = null;
    try {
      coverUrl = toUrl(await extractFilmCover(outPath, project?.aspect_ratio || '9:16'));
    } catch (e) { logger.warn('字幕版封面生成失败（跳过）:', e.message); }

    // 产物回写成片行（与 jobs 表解耦）：字幕版视频/新 SRT/ASS 与最新段落一并落行
    await film.update({
      video_url: toUrl(outPath), srt_url: toUrl(srtPath), ass_url: toUrl(assPath),
      cover_url: coverUrl,
      segments, segments_count: segments.length, duration,
    }).catch((e) => logger.warn('字幕版产物回写失败:', e.message));

    return {
      subtitle: { video_url: toUrl(outPath), srt_url: toUrl(srtPath), ass_url: toUrl(assPath), segments_count: segments.length, source_job_id: srcJobId, duration },
      credits_used: 0,
    };
  });
  return ok(res, { job }, 'video.subtitle_job_submitted');
}));

// —— 单视频在线剪辑（掐头去尾 / 分割 / 删段 / 调序 → 计费导出新成片）——

// 剪辑器源信息：probe 时长/宽高 + 项目画幅 + 是否可导出（成员无 video.manage 时编辑器进只读态）。
// ref 为 `seg-<id>` 时源为分镜视频（导出写回替换该分镜，write_back=true 供前端提示）
router.get('/videos/:jobId/edit', authRequired, asyncHandler(async (req, res) => {
  const src = await loadEditSource(req.user.id, req.params.jobId);
  let canEdit = true;
  try { await loadEditSource(req.user.id, req.params.jobId, 'video.manage'); } catch { canEdit = false; }
  let project = null; let episode = null;
  let base = { kind: 'edit' };
  if (src.kind === 'segment') {
    project = src.project; episode = src.episode;
    base = { job_id: null, kind: 'segment', segment_id: src.segment.id, segment_title: src.segment.title || '', write_back: true };
  } else {
    [project, episode] = await Promise.all([
      src.projectId ? db.Project.findByPk(src.projectId, { attributes: { exclude: ["raw_script"] } }) : null,
      src.episodeId ? db.Episode.findByPk(src.episodeId) : null,
    ]);
    base = {
      job_id: src.srcJobId,
      kind: src.srcType === 'video_synthesis' ? 'compose' : src.srcType === 'video_subtitle' ? 'subtitle' : 'edit',
    };
  }
  const probe = await probeMedia(src.path).catch(() => null);
  return ok(res, {
    ...base,
    video_url: src.url,
    duration: probe?.duration || 0,
    width: probe?.width || 0,
    height: probe?.height || 0,
    has_audio: !!probe?.hasAudio,
    aspect_ratio: project?.aspect_ratio || '9:16',
    project_id: project?.id || null,
    project_name: project?.name || '',
    episode_id: episode?.id || null,
    episode_idx: episode?.idx || null,
    episode_title: episode?.title || '',
    can_edit: canEdit,
  });
}));

// 剪辑导出估算：输出总时长(秒) × 分辨率系数 → editor_export 每分钟价（GET，同字幕估算先例）
router.get('/videos/:jobId/edit/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadEditSource(req.user.id, req.params.jobId); // 只验权，不重复 probe
  const resCfg = editResolution(req.query.resolution);
  const seconds = Math.max(0, Number(req.query.seconds) || 0);
  const { credits, pricing } = await editEstimateCredits(seconds, resCfg.factor);
  const tierPricing = await attachTierPricing(req.user, credits);
  return ok(res, {
    credits, pricing, source: 'global', resolution: req.query.resolution,
    factor: resCfg.factor, seconds, minutes: Math.max(1, Math.ceil(seconds / 60)), ...tierPricing,
  });
}));

// 导出剪辑成片（异步任务，计费：editor_export × 分钟 × 分辨率系数；失败/取消自动退款，与合成同范式）
router.post('/videos/:jobId/edit', authRequired, asyncHandler(async (req, res) => {
  const src = await loadEditSource(req.user.id, req.params.jobId, 'video.manage');
  const srcPath = src.path;
  const resCfg = editResolution(req.body?.resolution);

  const probe = await probeMedia(srcPath);
  const { segments, totalSec } = normalizeEditSegments(req.body?.segments, probe.duration || probe.videoDuration || 0);

  const { credits: est } = await editEstimateCredits(totalSec, resCfg.factor);
  await assertBalance(req.user, est);

  // 分镜源：写回替换该分镜视频（meta.editSource 供成片列表排除 + 前端挂回在途任务时区分同号 jobId）
  const isSeg = src.kind === 'segment';
  const srcJobId = isSeg ? null : src.srcJobId;
  const srcType = isSeg ? null : src.srcType;
  const project = isSeg ? src.project : (src.projectId ? await db.Project.findByPk(src.projectId, { attributes: { exclude: ["raw_script"] } }) : null);
  const episode = isSeg ? src.episode : (src.episodeId ? await db.Episode.findByPk(src.episodeId) : null);
  const srcRefId = isSeg ? src.segment.id : srcJobId;
  const job = await createJob(req.user.id, {
    type: 'video_edit', projectId: project?.id || null, episodeId: episode?.id || null, refId: srcRefId,
    meta: {
      feature: 'editor_export', label: isSeg ? '剪辑分镜视频' : '剪辑导出', editSource: isSeg ? 'segment' : 'job',
      projectName: project?.name || '', episodeIdx: episode?.idx || null, episodeTitle: episode?.title || '',
      shotNo: isSeg ? (src.segment.shot_no || '') : '',
      targetName: isSeg ? (src.segment.title || '') : (episode?.title || ''),
      estimate: est, sourceJobId: srcJobId, sourceSegmentId: isSeg ? src.segment.id : null,
      resolution: req.body.resolution, segments,
    },
  });
  submit(job.id, async (ctx) => {
    const { result, spent, balance } = await withCredits(req.user.id, est,
      { feature: 'editor_export', jobId: job.id, refId: srcRefId, remark: isSeg ? `剪辑分镜:${src.segment.title || ''}` : '剪辑导出' },
      async () => {
        // 排队期间源文件可能被删（如用户删除了该成片/重新生成了分镜视频），执行前再校验一次
        if (!fs.existsSync(srcPath)) throw badRequest('video.source_video_missing');
        if (isSeg) {
          const cur = await StoryboardSegment.findByPk(src.segment.id);
          if (!cur || cur.video_url !== src.url) throw badRequest('video.edit_source_changed');
        }

        await ctx.reportProgress(15, '校验剪辑段…');
        const canvas = canvasFor(project?.aspect_ratio || '9:16', resCfg.shortEdge);

        await ctx.reportProgress(30, '渲染剪辑成片…');
        const { absPath } = genFilePath(config.outputDir, 'mp4', 'episode_edit');
        await assembleEdit(srcPath, segments, absPath, canvas);

        // 音画漂移防线：输出时长与「Σ段长按 25fps 帧网格取整」比对，超 1 帧余量即失败退款
        await ctx.reportProgress(85, '校验输出…');
        const out = await probeMedia(absPath);
        const expectSec = segments.reduce((n, s) => n + Math.floor(s.t * 25) / 25, 0);
        if (Math.abs((out.duration || 0) - expectSec) > 0.06) throw badRequest('video.edit_output_mismatch');

        // 分镜源：写回替换该分镜视频——重抽首帧(关键帧)/尾帧(跨镜延续)、时长改为真实输出、清理被替换旧文件
        let freshSegment = null;
        if (isSeg) {
          await ctx.reportProgress(92, '回写分镜…');
          let keyframeUrl = null; let lastFrameUrl = null;
          try {
            const { absPath: kfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
            await extractFirstFrame(absPath, kfAbs);
            keyframeUrl = toUrl(kfAbs);
          } catch { /* 首帧失败不影响视频落库 */ }
          try {
            const { absPath: lfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
            await extractLastFrame(absPath, lfAbs);
            lastFrameUrl = toUrl(lfAbs);
          } catch { /* 尾帧失败不影响视频落库 */ }
          deleteUrlFiles(
            [src.segment.video_url, src.segment.keyframe_url, src.segment.last_frame_url],
            [toUrl(absPath), keyframeUrl, lastFrameUrl],
          );
          await src.segment.update({
            video_url: toUrl(absPath), keyframe_url: keyframeUrl, last_frame_url: lastFrameUrl,
            last_frame_source: lastFrameUrl ? 'ffmpeg' : null, duration: out.duration || 0, status: 'done',
            reviewed_at: null, reviewer_id: null, // 剪辑写回换了视频，审阅标记重置（新片须重新审阅）
          });
          await refreshEpisodeDuration(episode);
          freshSegment = await StoryboardSegment.findByPk(src.segment.id);
        }

        // 成片落档：剪辑导出成片（分镜源已写回分镜，不算成片不落档）；成片查询与 jobs 表解耦
        if (!isSeg) {
          // 剪辑版封面：抽导出成品第一帧（剪辑后时间线与源片不同，须重新抽取；画幅跟项目走）
          let coverUrl = null;
          try {
            coverUrl = toUrl(await extractFilmCover(absPath, project?.aspect_ratio || '9:16'));
          } catch (e) { logger.warn('剪辑版封面生成失败（跳过）:', e.message); }
          await db.EpisodeVideo.create({
            project_id: project?.id || null, episode_id: episode?.id || null, user_id: req.user.id, kind: 'edit',
            video_url: toUrl(absPath), cover_url: coverUrl, duration: out.duration || 0, resolution: req.body.resolution,
            segments_count: segments.length, job_id: job.id, source_job_id: srcJobId,
          }).catch((e) => logger.warn('成片落档失败:', e.message));
        }

        // 实际扣费按真实输出时长重估（帧对齐后 ≤ 请求时长，withCredits 只退差额不补收）
        const actual = await editEstimateCredits(out.duration || 0, resCfg.factor);
        return {
          _actualCredits: actual.credits,
          edit: {
            video_url: toUrl(absPath),
            duration: out.duration || 0,
            segments,
            segments_count: segments.length,
            resolution: req.body.resolution,
            source_job_id: srcJobId,
            source_kind: isSeg ? 'segment' : srcType,
            segment_id: isSeg ? src.segment.id : null,
          },
          ...(freshSegment ? { segment: freshSegment } : {}),
        };
      });
    return { edit: result.edit, ...(result.segment ? { segment: result.segment } : {}), credits_used: spent, balance };
  });
  return ok(res, { job }, 'video.edit_job_submitted');
}));

// 项目下所有分集的成片历史（episode_videos 成片落档，支持多次合成）
// 成片查询与 jobs 表解耦：Job 记录清理/删除后成片历史仍可查；job_id/source_job_id 仅作任务上下文回溯
// kind: 'compose' = 合成成片；'subtitle' = 由某条成片生成的字幕版；'edit' = 剪辑导出的剪辑版（source_job_id 指向源）
// 团队共享：不再按 user_id 过滤，项目全员可见全部成片（含其他成员合成的）
router.get('/projects/:pid/videos', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.pid);
  // 两段式取数免大 JSON 行 filesort（同 job.service 口径）：成片行含视频/字幕草稿等大字段，
  // 本机优化器会对整行排序触发 ER_OUT_OF_SORTMEMORY——先只取 id 列按 created_at 倒序
  // （排序元组极小），再按 id IN 走 PK 点查整行，JS 内恢复倒序（同秒并列按 id 新者在前）
  const filmIdRows = await db.EpisodeVideo.findAll({
    where: { project_id: project.id, hidden: false },
    attributes: ['id'], order: [['created_at', 'DESC']],
  });
  const filmIds = filmIdRows.map((r) => r.id);
  const films = filmIds.length
    ? (await db.EpisodeVideo.findAll({ where: { id: { [db.Sequelize.Op.in]: filmIds } } }))
        .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || (b.id - a.id))
    : [];
  const videos = films
    .map((v) => ({
      id: v.id,
      job_id: v.job_id ?? null,
      episode_id: v.episode_id,
      kind: v.kind,
      video_url: v.video_url || null,
      cover_url: v.cover_url || null,
      srt_url: v.srt_url || null,
      segments_count: v.segments_count || 0,
      duration: v.duration || 0,
      resolution: v.resolution || null,
      created_at: v.created_at,
      source_job_id: v.source_job_id ?? null,
      reviewed_at: v.reviewed_at ?? null,
    }))
    // 成片/剪辑版必须有视频；字幕行放宽到有 srt 即可（两段式：提取出的草稿未合并时无 video_url）
    .filter((v) => v.video_url || (v.kind === 'subtitle' && v.srt_url));
  return ok(res, videos);
}));

/**
 * 加载成片记录并校验访问权（团队共享，口径同 loadAccessibleJob）：
 * 本人发起的恒放行；他人的成片须其所属项目可访问且持有 video.manage（删除属写操作）。
 * 找不到抛 404，无权抛 403。
 */
async function loadAccessibleVideo(userId, videoId, perm = 'video.manage') {
  const film = await db.EpisodeVideo.findByPk(videoId);
  if (!film) throw notFound('common.not_found');
  await assertFilmAccess(userId, film, perm);
  return film;
}

// 删除单条成片/字幕版/剪辑版（按成片记录 id）：删产物文件 + 软隐藏成片记录（行保留供追溯）；
// 仅合成成片可能挂在该集当前成片上（清空并回退状态）；字幕版/剪辑版从不写 episode.video_url，无需回退
router.delete('/videos/:videoId', authRequired, asyncHandler(async (req, res) => {
  const film = await loadAccessibleVideo(req.user.id, req.params.videoId);
  const isSubtitle = film.kind === 'subtitle';
  // 1) 删物理文件（字幕版连 srt/ass 一起删；封面一并删；缺失不阻断）
  deleteUrlFiles([film.video_url, film.cover_url, isSubtitle ? film.srt_url : null, isSubtitle ? film.ass_url : null]);
  // 2) 软隐藏成片记录
  await film.update({ hidden: true });
  // 3) 仅合成成片：若正是该集当前成片，清空 video_url；原 status=done 回退到 storyboard（分镜仍在，可重新合成）
  if (film.kind === 'compose' && film.episode_id && film.video_url) {
    const ep = await db.Episode.findByPk(film.episode_id);
    if (ep && ep.video_url === film.video_url) {
      const patch = { video_url: null };
      if (ep.status === 'done') patch.status = 'storyboard';
      await ep.update(patch);
    }
  }
  return ok(res, null, 'video.video_deleted');
}));

// 审阅/取消审阅成片（reviewed 默认 true）：置 reviewed_at + 审阅人，取消则双清。
// 每条成片记录（合成/字幕版/剪辑版）独立审阅；新合成/导出的成片从头审。
router.post('/videos/:videoId/review', authRequired, asyncHandler(async (req, res) => {
  const film = await loadAccessibleVideo(req.user.id, req.params.videoId);
  const reviewed = req.body?.reviewed !== false;
  await film.update(reviewed
    ? { reviewed_at: new Date(), reviewer_id: req.user.id }
    : { reviewed_at: null, reviewer_id: null });
  return ok(res, {
    id: film.id,
    job_id: film.job_id ?? null,
    kind: film.kind,
    reviewed_at: film.reviewed_at ?? null,
  }, reviewed ? 'video.review_marked' : 'video.review_unmarked');
}));

export default router;
