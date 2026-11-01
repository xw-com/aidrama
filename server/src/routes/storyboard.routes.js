import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { loadOwnedEpisode, loadOwnedSegment } from '../utils/ownership.js';
import { deleteUrlFiles, genFilePath, toUrl } from '../utils/fileUtil.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { extractFirstFrame, extractLastFrame } from '../services/ffmpeg.service.js';
import { assertBalance, estimateVideoCost, estimateTextCost, attachTierPricing, applyModelPromo } from '../services/pricing.service.js';
import { withCredits } from '../services/credits.service.js';
import { getConfig, resolveConfig, assertResolutionAllowed } from '../services/modelConfig.service.js';
import { generateStoryboard, generateSegmentPrompt } from '../services/ai/storyboard.service.js';
import { auditSegments, planSegmentPatch } from '../services/storyboardAudit.service.js';
import { createJob, submit } from '../services/job.service.js';
import { generateSegmentVideo, refreshEpisodeDuration, loadVideoCfg, batchVideoWorkFn, batchVideoWorkFnConcurrent } from '../services/segmentVideo.service.js';
import { eraseVideoSubtitles } from '../services/video.service.js';

// 会员体系已下线：分辨率不再按档位封顶；未指定时按最高档 '4K'（与原钻石档 clamp 行为一致）
const DEFAULT_VIDEO_RESOLUTION = '4K';
const normalizeResolution = (resolution) => resolution || DEFAULT_VIDEO_RESOLUTION;

const router = Router();
const { StoryboardSegment, Asset, Job } = db;

// 分镜视频上传（用户上传本地视频替代/补位 AI 生成）：磁盘流式存储（200MB 大文件不再整读进内存）、200MB 上限
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.resolve(process.cwd(), config.uploadDir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extForVideoMime(file.mimetype)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});
// 视频 mimetype → 扩展名（落盘用）
function extForVideoMime(mime) {
  if (mime === 'video/mp4' || mime === 'video/x-m4v') return 'mp4';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/x-msvideo') return 'avi';
  if (mime === 'video/x-matroska') return 'mkv';
  return 'mp4';
}

// 解析文本生成所用模型配置（用于计费）：指定 id > 默认文本模型 > null（走全局定价兜底）
async function loadTextCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'text');
  } catch { return null; }
}

/**
 * 规范化「本镜资产」引用：仅保留属于本项目的资产，并以数据库权威的 kind/name 回填，
 * 避免前端传入跨项目 / 已失效的 id 或脏数据；保留客户端传入顺序。
 */
async function normalizeAssetRefs(raw, projectId) {
  const arr = Array.isArray(raw) ? raw : [];
  const ids = [];
  const seen = new Set();
  for (const r of arr) {
    const id = Number(r && r.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return [];
  const rows = await Asset.findAll({ where: { id: ids, project_id: projectId }, attributes: ['id', 'kind', 'name'] });
  const byId = new Map(rows.map((a) => [a.id, a]));
  return ids.map((id) => {
    const a = byId.get(id);
    return a ? { type: a.kind, id, name: a.name } : null;
  }).filter(Boolean);
}

// 片段列表
router.get('/episodes/:eid/segments', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid);
  const segments = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });
  return ok(res, segments);
}));

// 新增一个空白分镜（在 afterId 指定分镜之后插入；beforeId 指定分镜之前插入；省略/未命中则追加到末尾）
// 时长默认 4 秒，shot_no 按子镜号 N-N-N 命名（见 buildInsertShotNo）
router.post('/episodes/:eid/segments', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid, 'storyboard.edit');
  const afterId = req.body?.afterId != null ? Number(req.body.afterId) : null;
  const beforeId = req.body?.beforeId != null ? Number(req.body.beforeId) : null;
  const segs = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });

  // 插入位置（segs 中的下标）：beforeId 优先（插到该分镜之前，用于插到最前），其次 afterId，均未提供/未命中时追加到末尾
  let pos = segs.length;
  if (beforeId != null) {
    const i = segs.findIndex((s) => s.id === beforeId);
    if (i > -1) pos = i;
  } else if (afterId != null) {
    const i = segs.findIndex((s) => s.id === afterId);
    if (i > -1) pos = i + 1;
  }
  const prev = pos > 0 ? segs[pos - 1] : null;
  const next = pos < segs.length ? segs[pos] : null;
  const afterIdx = prev ? prev.idx : 0;

  // 插入点及之后的分镜 idx 后移 1 位，腾出新位（顺序更新，本表 idx 无唯一约束）
  for (let j = pos; j < segs.length; j++) {
    await segs[j].update({ idx: segs[j].idx + 1 });
  }

  const created = await StoryboardSegment.create({
    episode_id: episode.id,
    idx: afterIdx + 1,
    scene_no: prev?.scene_no ?? next?.scene_no ?? null,
    shot_no: buildInsertShotNo(prev, segs, next?.scene_no),
    title: '',
    prompt: '',
    duration: 4, // 默认时长 4 秒
    asset_refs: [],
    status: 'pending',
    selected: true,
  });
  await refreshEpisodeDuration(episode);
  const fresh = await StoryboardSegment.findByPk(created.id);
  return ok(res, fresh, 'storyboard.segment_added');
}));

// 估算分镜脚本消耗（按所选文本模型每次调用价计费）
router.get('/episodes/:eid/generate-storyboard/estimate', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid);
  const len = (episode.content || '').length;
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'storyboard_script', len);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { chars: len, credits, source, pricing, ...tierPricing });
}));

// 生成分镜脚本（拆出片段）（异步任务）
router.post('/episodes/:eid/generate-storyboard', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'ai.generate');
  if (!episode.content || !episode.content.trim()) throw badRequest('storyboard.episode_no_content');
  // 流程门禁：必须先为该集提取资产，才能生成分镜（已生成过分镜的集可重新生成）
  if (!['assets', 'storyboard', 'video', 'done'].includes(episode.status)) {
    throw badRequest('storyboard.extract_assets_first');
  }

  const len = episode.content.length;
  const modelConfigId = req.body.modelConfigId || null;
  const requirement = req.body.requirement || '';
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'storyboard_script', len);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'storyboard_script', projectId: project.id, episodeId: episode.id,
    meta: { feature: 'storyboard_script', label: '生成分镜脚本', projectName: project.name, episodeTitle: episode.title, targetName: episode.title, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'storyboard_script', jobId: job.id, refId: episode.id, remark: '分镜脚本生成' },
      async () => {
        const assets = await Asset.findAll({ where: { project_id: project.id } });
        await ctx.reportProgress(30, '调用大模型生成分镜…');
        const segments = await generateStoryboard(req.user.id, {
          episodeTitle: episode.title, episodeContent: episode.content,
          assets: assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, role_tag: a.role_tag, description: a.description, aliases: a.aliases })),
          style: project.style, narrativeType: project.narrative_type, requirement, modelConfigId,
        });
        await ctx.reportProgress(70, '解析结果');
        // 旧分镜的视频/关键帧/尾帧文件随行一并清理，避免孤儿文件
        const oldSegs = await StoryboardSegment.findAll({
          where: { episode_id: episode.id },
          attributes: ['video_url', 'keyframe_url', 'last_frame_url'],
        });
        deleteUrlFiles(oldSegs.flatMap((s) => [s.video_url, s.keyframe_url, s.last_frame_url]));
        await StoryboardSegment.destroy({ where: { episode_id: episode.id } });
        await ctx.reportProgress(85, '写入数据库');
        const rows = [];
        for (const s of segments) {
          rows.push(await StoryboardSegment.create({
            episode_id: episode.id, idx: s.idx,
            scene_no: s.scene_no, shot_no: s.shot_no, scene_script: s.scene_script,
            title: s.title,
            duration: s.duration,
            video_prompt: s.video_prompt, asset_refs: s.asset_refs, status: 'pending', selected: true,
          }));
        }
        await episode.update({ status: 'storyboard' });
        return { _actualCredits: est };
      });
    const segments = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });
    return { segments, credits_used: spent, balance };
  });
  return ok(res, { job }, 'storyboard.generate_queued');
}));

// 更新单个片段
router.put('/segments/:sid', authRequired, asyncHandler(async (req, res) => {
  const { segment, project } = await loadOwnedSegment(req.user.id, req.params.sid, 'storyboard.edit');
  const {
    title, duration, voice_config, asset_refs, selected, keyframe_url,
    scene_no, shot_no, scene_script, video_prompt,
    transition,
  } = req.body;
  // 时长参与按秒计费（estimateVideoCost），必须为正整数且封顶——负数/0 会把预估钳成 0 积分
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 60)) {
    throw badRequest('storyboard.duration_invalid');
  }
  // 本镜资产引用需校验归属并回填权威字段
  const nextAssetRefs = asset_refs !== undefined ? await normalizeAssetRefs(asset_refs, project.id) : undefined;
  await segment.update({
    ...(title !== undefined && { title }),
    ...(duration !== undefined && { duration }),
    ...(voice_config !== undefined && { voice_config }),
    ...(nextAssetRefs !== undefined && { asset_refs: nextAssetRefs }),
    ...(selected !== undefined && { selected }),
    ...(keyframe_url !== undefined && { keyframe_url }),
    ...(scene_no !== undefined && { scene_no }),
    ...(shot_no !== undefined && { shot_no }),
    ...(scene_script !== undefined && { scene_script }),
    ...(video_prompt !== undefined && { video_prompt }),
    ...(transition !== undefined && { transition: transition || null }),
  });
  return ok(res, segment, 'storyboard.segment_updated');
}));

// 移动分镜位置（与前/后分镜交换顺序）：direction = -1 向前 | 1 向后。
// 交换后按新顺序把 idx 归一化为 1..N（本表 idx 无唯一约束），顺带消除删除留下的空洞；
// 返回全集最新分镜列表供前端整体替换。
router.post('/segments/:sid/move', authRequired, asyncHandler(async (req, res) => {
  const { segment, episode } = await loadOwnedSegment(req.user.id, req.params.sid, 'storyboard.edit');
  const direction = Number(req.body?.direction) === -1 ? -1 : 1;

  // 批量生成进行中禁止移动：批量任务已按提交时顺序排定（串行还做跨镜尾帧衔接），中途换序会打乱生成/衔接顺序
  const activeBatch = await Job.count({
    where: {
      user_id: req.user.id,
      status: { [db.Sequelize.Op.in]: ['pending', 'running'] },
      type: { [db.Sequelize.Op.in]: ['segment_video_batch', 'segment_video_batch_concurrent'] },
      episode_id: episode.id,
    },
  });
  if (activeBatch > 0) throw badRequest('storyboard.move_conflict_batch');
  // 本镜正在生成视频：提交时已捕获参考输入，换序虽不破坏任务，但为避免与落库回写竞态，一并拒绝
  if (segment.status === 'generating') throw badRequest('storyboard.move_conflict_generating');

  const segs = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });
  const i = segs.findIndex((s) => s.id === segment.id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= segs.length) throw badRequest('storyboard.move_out_of_range');

  [segs[i], segs[j]] = [segs[j], segs[i]];
  for (let k = 0; k < segs.length; k++) {
    if (segs[k].idx !== k + 1) await segs[k].update({ idx: k + 1 });
  }
  const fresh = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });
  return ok(res, fresh, 'storyboard.segment_moved');
}));

// 删除单个分镜（idx 留下空位不影响 ORDER BY 排序，故不做重排）；连同已生成的视频/关键帧/尾帧文件一并删除
router.delete('/segments/:sid', authRequired, asyncHandler(async (req, res) => {
  const { segment, episode } = await loadOwnedSegment(req.user.id, req.params.sid, 'storyboard.edit');
  deleteUrlFiles([segment.video_url, segment.keyframe_url, segment.last_frame_url]);
  await segment.destroy();
  await refreshEpisodeDuration(episode);
  return ok(res, null, 'storyboard.segment_deleted');
}));

// 删除单个分镜已生成的视频：清掉 video/keyframe/last_frame 文件与字段，状态回「待生成」，
// 保留 video_prompt 等文本字段，便于直接重新生成。媒体删除不影响分集时长，无需 refreshEpisodeDuration。
router.delete('/segments/:sid/video', authRequired, asyncHandler(async (req, res) => {
  const { segment } = await loadOwnedSegment(req.user.id, req.params.sid, 'storyboard.edit');
  deleteUrlFiles([segment.video_url, segment.keyframe_url, segment.last_frame_url]);
  await segment.update({ video_url: null, keyframe_url: null, last_frame_url: null, last_frame_source: null, status: 'pending' });
  return ok(res, segment, 'storyboard.video_deleted');
}));

// 审阅/取消审阅分镜视频（reviewed 默认 true）：置 reviewed_at + 审阅人，取消则双清。
// 换视频（生成/上传/剪辑写回/擦字幕）由各写点重置审阅标记，新片须重新审阅。
router.post('/segments/:sid/review', authRequired, asyncHandler(async (req, res) => {
  const { segment } = await loadOwnedSegment(req.user.id, req.params.sid, 'storyboard.edit');
  const reviewed = req.body?.reviewed !== false;
  await segment.update(reviewed
    ? { reviewed_at: new Date(), reviewer_id: req.user.id }
    : { reviewed_at: null, reviewer_id: null });
  return ok(res, segment, reviewed ? 'storyboard.review_marked' : 'storyboard.review_unmarked');
}));

// 上传本地视频作为该分镜的视频（替代 AI 生成）：落盘到 uploads，抽首帧为关键帧（poster/时间轴缩略图），
// 清掉旧 video/keyframe/last_frame 文件，状态置 done。用户自带素材，不计费、不走异步任务。
router.post('/segments/:sid/upload-video', authRequired, videoUpload.single('file'), asyncHandler(async (req, res) => {
  try {
    const { segment } = await loadOwnedSegment(req.user.id, req.params.sid, 'storyboard.edit');
    if (!req.file) throw badRequest('storyboard.no_video_file');
    if (!req.file.mimetype || !req.file.mimetype.startsWith('video/')) throw badRequest('storyboard.video_only');
    const ext = extForVideoMime(req.file.mimetype);
    const { absPath } = genFilePath(config.uploadDir, ext, 'seg_upload');
    // 磁盘流式存储：multer 已落盘，改名到规范路径即可（不再把 200MB 整个读进内存）
    fs.renameSync(req.file.path, absPath);
    const videoUrl = toUrl(absPath);

    // 抽首帧为关键帧（视频预览 poster / 时间轴缩略图），尽力而为，失败不阻断上传
    let keyframeUrl = null;
    try {
      const { absPath: kfAbs } = genFilePath(config.uploadDir, 'webp', 'seg_upload');
      await extractFirstFrame(absPath, kfAbs);
      keyframeUrl = toUrl(kfAbs);
    } catch (e) {
      logger.warn(`[SEGMENT] 上传视频抽取首帧失败 seg=${segment.id}: ${e.message}`);
    }

    // 清理旧视频/关键帧/尾帧文件（均对应旧视频，新视频已另存，不会误删）
    deleteUrlFiles([segment.video_url, segment.keyframe_url, segment.last_frame_url]);

    // 上传视频无 provider 尾帧，last_frame_source 一并清空（不做 Seedance 起始帧参考）；换视频重置审阅标记
    await segment.update({ video_url: videoUrl, keyframe_url: keyframeUrl, last_frame_url: null, last_frame_source: null, status: 'done', reviewed_at: null, reviewer_id: null });
    return ok(res, segment, 'storyboard.video_uploaded');
  } catch (e) {
    // multer 落盘先于归属/类型校验：失败时清掉已落盘的文件，避免孤儿
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* 已改名或已删除 */ } }
    throw e;
  }
}));

// 批量选中/取消
router.put('/episodes/:eid/segments/select', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid, 'storyboard.edit');
  const { ids, selected } = req.body;
  if (Array.isArray(ids)) {
    await StoryboardSegment.update({ selected }, { where: { episode_id: episode.id, id: ids } });
  }
  const segments = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });
  return ok(res, segments);
}));

// 分镜审计（dry-run，只读，免费，同步）：报告缺失资产 + 时长建议
router.post('/episodes/:eid/segments/audit', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid);
  const [segments, assets] = await Promise.all([
    StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] }),
    Asset.findAll({ where: { project_id: project.id }, attributes: ['id', 'kind', 'name', 'image_url', 'aliases'] }),
  ]);
  const report = auditSegments(
    segments.map((s) => s.toJSON()),
    assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, image_url: a.image_url, aliases: a.aliases })),
  );
  return ok(res, report);
}));

// 分镜审计：应用修复（写 asset_refs / duration，免费，同步）
// fixAssets/fixDuration 默认 true；segmentIds 省略则作用于全集。已有视频的分镜也照常调整时长。
router.post('/episodes/:eid/segments/audit/apply', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'storyboard.edit');
  const fixAssets = req.body?.fixAssets !== false;     // 默认 true
  const fixDuration = req.body?.fixDuration !== false; // 默认 true
  const idFilter = Array.isArray(req.body?.segmentIds) ? new Set(req.body.segmentIds.map(Number)) : null;

  const [segments, assets] = await Promise.all([
    StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] }),
    Asset.findAll({ where: { project_id: project.id }, attributes: ['id', 'kind', 'name', 'image_url', 'aliases'] }),
  ]);
  const report = auditSegments(
    segments.map((s) => s.toJSON()),
    assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, image_url: a.image_url, aliases: a.aliases })),
  );

  let assetsApplied = 0;
  let durationApplied = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const item = report.items[i];
    if (idFilter && !idFilter.has(seg.id)) continue;
    const patch = planSegmentPatch(item, { fixAssets, fixDuration });

    if (patch.assetRefsToAdd?.length) {
      const existing = Array.isArray(seg.asset_refs) ? seg.asset_refs : [];
      const merged = [...existing, ...patch.assetRefsToAdd.map((m) => ({ type: m.type, id: m.id, name: m.name }))];
      const canonical = await normalizeAssetRefs(merged, project.id); // 去重 + 项目归属 + 权威字段
      if (canonical.length !== existing.length) {                     // 确有新增才落库
        await seg.update({ asset_refs: canonical });
        assetsApplied += canonical.length - existing.length;
      }
    }
    if (patch.duration !== undefined) {
      await seg.update({ duration: patch.duration });
      durationApplied += 1;
    }
  }

  await refreshEpisodeDuration(episode);
  const fresh = await StoryboardSegment.findAll({ where: { episode_id: episode.id }, order: [['idx', 'ASC']] });
  return ok(res, { segments: fresh, stats: { assetsApplied, durationApplied } }, 'storyboard.auditApplied');
}));

// 估算单个片段视频生成消耗（按所选视频模型 + 分辨率计费）
router.get('/segments/:sid/generate/estimate', authRequired, asyncHandler(async (req, res) => {
  const { segment } = await loadOwnedSegment(req.user.id, req.params.sid);
  const { modelConfigId, resolution } = req.query || {};
  const clampedRes = normalizeResolution(resolution);
  const cfg = await loadVideoCfg(req.user.id, modelConfigId ? Number(modelConfigId) : null);
  assertResolutionAllowed(cfg, clampedRes); // 分辨率须在模型配置的 resolutions 列表内
  const vid = await estimateVideoCost(cfg, segment.duration || 5, clampedRes);
  const tierPricing = await attachTierPricing(req.user, vid.credits, cfg);
  return ok(res, { credits: vid.credits, perSec: vid.perSec, source: vid.source, duration: segment.duration, resolution: clampedRes, ...tierPricing });
}));

/**
 * 生成单个片段：(可选TTS) → 视频 → 抽取首帧为关键帧、尾帧备用（异步任务）
 * 关键帧不再单独生成，而在视频生成成功后用 ffmpeg 抽取第一帧自动回填 keyframe_url；
 * 同时抽取最后一帧回填 last_frame_url 保存备用（如作为下一镜图生视频的首帧延续）。
 */
router.post('/segments/:sid/generate', authRequired, asyncHandler(async (req, res) => {
  const { segment, episode, project } = await loadOwnedSegment(req.user.id, req.params.sid, 'ai.generate');
  if (!segment.video_prompt) throw badRequest('storyboard.prompt_required_first');

  const { modelConfigId, resolution } = req.body || {};
  const clampedRes = normalizeResolution(resolution);
  const cfg = await loadVideoCfg(req.user.id, modelConfigId || null);
  assertResolutionAllowed(cfg, clampedRes); // 分辨率须在模型配置的 resolutions 列表内
  const est = applyModelPromo(cfg, (await estimateVideoCost(cfg, segment.duration || 5, clampedRes)).credits);
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'segment_generate', projectId: project.id, episodeId: episode.id, refId: segment.id,
    // modelConfigId/resolution 落 meta：重启恢复的 workFn 原样回传，否则重新提交会换默认模型、降分辨率
    meta: { feature: 'segment_generate', label: '片段生成', modelConfigId: modelConfigId || null, resolution: clampedRes, projectName: project.name, episodeIdx: episode.idx, episodeTitle: episode.title, shotNo: segment.shot_no || '', targetName: segment.title, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'segment_generate', jobId: job.id, refId: segment.id, remark: `片段生成:${segment.title}` },
      async () => {
        await segment.update({ status: 'generating' });
        try {
          await ctx.reportProgress(70, '生成视频…');
          // 视频 + 抽首帧为关键帧、尾帧备用 + 落库 done（资产/声音/跨镜首尾帧延续在 helper 内处理）
          await generateSegmentVideo(req.user.id, segment, { modelConfigId: modelConfigId || null, resolution: clampedRes, jobId: job.id, feature: 'segment_generate' });
          return { _actualCredits: est };
        } catch (e) {
          await segment.update({ status: 'failed' });
          throw e;
        }
      });
    await refreshEpisodeDuration(episode);
    const fresh = await StoryboardSegment.findByPk(segment.id);
    return { segment: fresh, credits_used: spent, balance };
  });
  return ok(res, { job }, 'storyboard.segment_generate_queued');
}));

// 仅重新生成视频（异步任务）
router.post('/segments/:sid/generate-video', authRequired, asyncHandler(async (req, res) => {
  const { segment, episode, project } = await loadOwnedSegment(req.user.id, req.params.sid, 'ai.generate');
  if (!segment.video_prompt) throw badRequest('storyboard.prompt_required_first');
  const { modelConfigId, resolution } = req.body || {};
  const clampedRes = normalizeResolution(resolution);
  const cfg = await loadVideoCfg(req.user.id, modelConfigId || null);
  assertResolutionAllowed(cfg, clampedRes); // 分辨率须在模型配置的 resolutions 列表内
  const vidEst = applyModelPromo(cfg, (await estimateVideoCost(cfg, segment.duration || 5, clampedRes)).credits);
  await assertBalance(req.user, vidEst);

  const job = await createJob(req.user.id, {
    type: 'segment_video', projectId: project.id, episodeId: episode.id, refId: segment.id,
    // 首次生成与重新生成共用此入口：按是否已有视频区分任务标题，避免任务中心误显「重生成视频」
    // modelConfigId/resolution 落 meta：重启恢复的 workFn 原样回传，否则重新提交会换默认模型、降分辨率
    meta: { feature: 'segment_video', label: segment.video_url ? '重生成视频' : '生成视频', modelConfigId: modelConfigId || null, resolution: clampedRes, projectName: project.name, episodeIdx: episode.idx, episodeTitle: episode.title, shotNo: segment.shot_no || '', targetName: segment.title, estimate: vidEst },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, vidEst, { feature: 'segment_video', jobId: job.id, refId: segment.id, remark: '片段视频' },
      async () => {
        await segment.update({ status: 'generating' });
        try {
          await ctx.reportProgress(40, '生成视频…');
          // 视频 + 抽首帧为关键帧、尾帧备用 + 落库 done（资产/声音/跨镜首尾帧延续在 helper 内处理）
          await generateSegmentVideo(req.user.id, segment, { modelConfigId: modelConfigId || null, resolution: clampedRes, jobId: job.id, feature: 'segment_video' });
          return { _actualCredits: vidEst };
        } catch (e) {
          await segment.update({ status: 'failed' });
          throw e;
        }
      });
    await refreshEpisodeDuration(episode);
    const fresh = await StoryboardSegment.findByPk(segment.id);
    return { segment: fresh, credits_used: spent, balance };
  });
  return ok(res, { job }, 'storyboard.video_generate_queued');
}));

/**
 * 去除分镜视频字幕（异步任务）：把本镜已生成的原视频作为唯一参考输入提交多模态视频模型
 * （Seedance 2.x / MiniMax 的 reference_video 通道），仅擦除画面中的字幕、其余保持不变；
 * 产物替换本镜视频，并重抽首帧为关键帧。尾帧优先用 provider 随任务返回的尾帧图
 * （Seedance return_last_frame，原样保存、不得修改），未返回时 ffmpeg 抽帧兜底。
 */
router.post('/segments/:sid/erase-subtitle', authRequired, asyncHandler(async (req, res) => {
  const { segment, episode, project } = await loadOwnedSegment(req.user.id, req.params.sid, 'ai.generate');
  if (!segment.video_url) throw badRequest('storyboard.video_required_first');
  // 厂商契约 duration 钳位 [4,15]：源视频超 15s 时产物会被静默截短并直接替换原片（尾部内容丢失）
  if ((Number(segment.duration) || 0) > 15) throw badRequest('storyboard.erase_too_long');

  const { modelConfigId, resolution } = req.body || {};
  const clampedRes = normalizeResolution(resolution);
  const cfg = await loadVideoCfg(req.user.id, modelConfigId || null);
  assertResolutionAllowed(cfg, clampedRes); // 分辨率须在模型配置的 resolutions 列表内
  const est = applyModelPromo(cfg, (await estimateVideoCost(cfg, segment.duration || 5, clampedRes)).credits);
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'segment_erase_subtitle', projectId: project.id, episodeId: episode.id, refId: segment.id,
    // modelConfigId/resolution/aspect 落 meta：重启恢复的 workFn 原样回传——
    // 缺 aspect 时擦字幕恢复会按 9:16 出竖版替换横版原片
    meta: { feature: 'segment_erase_subtitle', label: '去除字幕', modelConfigId: modelConfigId || null, resolution: clampedRes, aspect: project.aspect_ratio, projectName: project.name, episodeIdx: episode.idx, episodeTitle: episode.title, shotNo: segment.shot_no || '', targetName: segment.title, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'segment_erase_subtitle', jobId: job.id, refId: segment.id, remark: `去除字幕:${segment.title}` },
      async () => {
        await segment.update({ status: 'generating' });
        try {
          // 被替换的旧视频/关键帧/尾帧文件：成功落库新值后再清理（擦除以旧视频为源，提交轮询完成后源文件已无消费方）
          const oldFiles = [segment.video_url, segment.keyframe_url, segment.last_frame_url].filter(Boolean);
          await ctx.reportProgress(30, '擦除字幕…');
          const { videoUrl: newUrl, outPath, lastFrameUrl: providerLastFrame, lastFrameSource: providerLastFrameSource } = await eraseVideoSubtitles(req.user.id, {
            videoUrl: segment.video_url,
            duration: segment.duration || 5,
            aspect: project.aspect_ratio,
            modelConfigId: modelConfigId || null,
            resolution: clampedRes,
            // 留档上下文（video_generations）
            jobId: job.id,
            projectId: project.id,
            episodeId: episode.id,
            segmentId: segment.id,
          });
          await ctx.reportProgress(80, '回填关键帧…');
          // 关键帧：重抽新视频首帧（尽力而为，失败不影响视频落库）
          let keyframeUrl = segment.keyframe_url || null;
          try {
            const { absPath: kfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
            await extractFirstFrame(outPath, kfAbs);
            keyframeUrl = toUrl(kfAbs);
          } catch (e) {
            logger.warn(`[ERASE] 抽取关键帧首帧失败 seg=${segment.id}: ${e?.message || e}`);
          }
          // 尾帧：优先 provider 返回的原图（原样保存、不得修改），未返回时 ffmpeg 抽帧兜底；
          // last_frame_source 记录来源（'seedance'/'ffmpeg'），两者均可作下一镜跨镜延续的起始帧参考
          let lastFrameUrl = providerLastFrame || null;
          let lastFrameSource = providerLastFrame ? (providerLastFrameSource || null) : null;
          if (!lastFrameUrl) {
            try {
              const { absPath: lfAbs } = genFilePath(config.uploadDir, 'webp', 'seg');
              await extractLastFrame(outPath, lfAbs);
              lastFrameUrl = toUrl(lfAbs);
              lastFrameSource = 'ffmpeg';
            } catch (e) {
              logger.warn(`[ERASE] 抽取尾帧失败 seg=${segment.id}: ${e?.message || e}`);
            }
          }
          await segment.update({ video_url: newUrl, keyframe_url: keyframeUrl, last_frame_url: lastFrameUrl, last_frame_source: lastFrameSource, status: 'done', reviewed_at: null, reviewer_id: null });
          // 清掉被替换的旧文件（新值仍在引用的除外，如关键帧抽取失败时沿用的旧关键帧）
          deleteUrlFiles(oldFiles, [newUrl, keyframeUrl, lastFrameUrl].filter(Boolean));
          return { _actualCredits: est };
        } catch (e) {
          // 擦除失败：原视频未被替换仍可用，状态回 done 而非 failed（避免被批量生成按 failed 误判重跑）
          await segment.update({ status: segment.video_url ? 'done' : 'failed' });
          throw e;
        }
      });
    await refreshEpisodeDuration(episode);
    const fresh = await StoryboardSegment.findByPk(segment.id);
    return { segment: fresh, credits_used: spent, balance };
  });
  return ok(res, { job }, 'storyboard.erase_subtitle_queued');
}));

/**
 * 批量串行生成视频（异步任务）：后端持有分镜列表并按 idx 顺序逐段生成，
 * 保证跨镜首尾帧延续；关页面/服务重启均不中断（workFn 可按已落库段断点续跑）。
 * 某段失败/余额不足 → 置 failed 并跳过，继续下一段，最终汇总成功/失败。
 */
router.post('/episodes/:eid/segments/generate-video-batch', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'ai.generate');
  const { modelConfigId, resolution } = req.body || {};
  const rawIds = Array.isArray(req.body?.segmentIds) ? req.body.segmentIds.map(Number).filter(Number.isFinite) : [];
  if (!rawIds.length) throw badRequest('storyboard.no_segments_selected');

  // 校验：分镜须属于该集，且必须有视频提示词；已有视频的段先删旧视频再重生成（先删后生成，见下方删除逻辑）
  const segs = await StoryboardSegment.findAll({ where: { id: rawIds, episode_id: episode.id }, order: [['idx', 'ASC']] });
  if (!segs.length) throw badRequest('storyboard.no_segments_selected');
  const targets = segs;
  const noPrompt = targets.filter((s) => !s.video_prompt);
  if (noPrompt.length) throw badRequest('storyboard.missing_prompt_count', { count: noPrompt.length });
  const targetIds = targets.map((s) => s.id);

  // 去重：任一目标已有单段视频生成任务在进行 → 拒绝，避免与单段入口双跑。
  // 不限定 user_id：团队共享项目里其他成员的单段任务同样会与本批双跑同一段
  const activeSingle = await Job.count({
    where: {
      status: { [db.Sequelize.Op.in]: ['pending', 'running'] },
      type: { [db.Sequelize.Op.in]: ['segment_generate', 'segment_video'] },
      ref_id: { [db.Sequelize.Op.in]: targetIds },
    },
  });
  if (activeSingle > 0) throw badRequest('storyboard.batch_conflict_active_single');

  // 批量维度全局互斥（不限 user_id）：createJob 去重键含 user_id，跨用户双批量查不到，
  // 会交叉删除/回写同一组分镜（先删后生成互相清掉对方刚出的片）。该集任意批量在跑即拒绝
  const activeBatch = await Job.count({
    where: {
      status: { [db.Sequelize.Op.in]: ['pending', 'running'] },
      episode_id: episode.id,
      type: { [db.Sequelize.Op.in]: ['segment_video_batch', 'segment_video_batch_concurrent'] },
    },
  });
  if (activeBatch > 0) throw badRequest('storyboard.batch_conflict_active_batch');

  const clampedRes = normalizeResolution(resolution);
  const cfg = await loadVideoCfg(req.user.id, modelConfigId || null);
  assertResolutionAllowed(cfg, clampedRes); // 分辨率须在模型配置的 resolutions 列表内
  let totalEst = 0;
  for (const s of targets) totalEst += applyModelPromo(cfg, (await estimateVideoCost(cfg, s.duration || 5, clampedRes)).credits);
  await assertBalance(req.user, totalEst);

  // 「先删后生成」：选中段已有视频的先删除（文件+字段，状态回待生成）再整批重出，
  // 「全部生成」即整批重新生成、不残留旧视频（放在余额校验之后：余额不足时不破坏现状）
  for (const s of targets) {
    if (!s.video_url && !s.keyframe_url && !s.last_frame_url) continue;
    deleteUrlFiles([s.video_url, s.keyframe_url, s.last_frame_url]);
    await s.update({ video_url: null, keyframe_url: null, last_frame_url: null, last_frame_source: null, status: 'pending' });
  }
  // 视频已清空，无「提交前已完成」段；字段保留供 workFn 兼容重启续跑的旧任务
  const preDoneIds = targets.filter((s) => s.video_url).map((s) => s.id);

  const job = await createJob(req.user.id, {
    type: 'segment_video_batch', projectId: project.id, episodeId: episode.id,
    meta: {
      feature: 'segment_video_batch', label: `批量生成视频（${targetIds.length}段）`,
      projectName: project.name, episodeTitle: episode.title,
      segmentIds: targetIds, total: targetIds.length,
      modelConfigId: modelConfigId || null, resolution: clampedRes,
      estimate: totalEst,
      charged: {}, completed: [], failed: [], settledCredits: 0, index: 0, preDoneIds,
    },
  });
  submit(job.id, batchVideoWorkFn);
  return ok(res, { job }, 'storyboard.batch_generate_queued');
}));

/**
 * 批量「并发」生成视频（异步任务）：与串行批量同样持有分镜列表，但用有界并发池
 * (BATCH_CONCURRENT_LIMIT=4) 同时生成多段，而非按 idx 顺序逐段。
 * - 不串行排队，速度快；并发段之间不做跨镜首尾帧衔接（各段用自身关键帧/资产图独立生成）；
 * - 某段失败/余额不足 → 置 failed 并跳过、退款，其余段继续，最终汇总成功/失败；
 * - 关页面/服务重启均不中断（workFn 按 DB 段状态断点续跑）。
 */
router.post('/episodes/:eid/segments/generate-video-batch-concurrent', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'ai.generate');
  const { modelConfigId, resolution } = req.body || {};
  const rawIds = Array.isArray(req.body?.segmentIds) ? req.body.segmentIds.map(Number).filter(Number.isFinite) : [];
  if (!rawIds.length) throw badRequest('storyboard.no_segments_selected');

  // 校验：分镜须属于该集，且必须有视频提示词；已有视频的段先删旧视频再重生成（先删后生成，见下方删除逻辑）
  const segs = await StoryboardSegment.findAll({ where: { id: rawIds, episode_id: episode.id }, order: [['idx', 'ASC']] });
  if (!segs.length) throw badRequest('storyboard.no_segments_selected');
  const targets = segs;
  const noPrompt = targets.filter((s) => !s.video_prompt);
  if (noPrompt.length) throw badRequest('storyboard.missing_prompt_count', { count: noPrompt.length });
  const targetIds = targets.map((s) => s.id);

  // 去重：任一目标已有单段视频生成任务在进行 → 拒绝，避免与单段入口双跑。
  // 不限定 user_id：团队共享项目里其他成员的单段任务同样会与本批双跑同一段
  const activeSingle = await Job.count({
    where: {
      status: { [db.Sequelize.Op.in]: ['pending', 'running'] },
      type: { [db.Sequelize.Op.in]: ['segment_generate', 'segment_video'] },
      ref_id: { [db.Sequelize.Op.in]: targetIds },
    },
  });
  if (activeSingle > 0) throw badRequest('storyboard.batch_conflict_active_single');

  // 批量维度全局互斥（不限 user_id）：该集任意批量（串行/并发，含其他成员发起）在跑即拒绝，
  // 避免两批同时操作同集分镜/状态/时长
  const activeBatch = await Job.count({
    where: {
      status: { [db.Sequelize.Op.in]: ['pending', 'running'] },
      episode_id: episode.id,
      type: { [db.Sequelize.Op.in]: ['segment_video_batch', 'segment_video_batch_concurrent'] },
    },
  });
  if (activeBatch > 0) throw badRequest('storyboard.batch_conflict_active_batch');

  const clampedRes = normalizeResolution(resolution);
  const cfg = await loadVideoCfg(req.user.id, modelConfigId || null);
  assertResolutionAllowed(cfg, clampedRes); // 分辨率须在模型配置的 resolutions 列表内
  let totalEst = 0;
  for (const s of targets) totalEst += applyModelPromo(cfg, (await estimateVideoCost(cfg, s.duration || 5, clampedRes)).credits);
  await assertBalance(req.user, totalEst);

  // 「先删后生成」：选中段已有视频的先删除（文件+字段，状态回待生成）再整批重出，
  // 「全部生成」即整批重新生成、不残留旧视频（放在余额校验之后：余额不足时不破坏现状）
  for (const s of targets) {
    if (!s.video_url && !s.keyframe_url && !s.last_frame_url) continue;
    deleteUrlFiles([s.video_url, s.keyframe_url, s.last_frame_url]);
    await s.update({ video_url: null, keyframe_url: null, last_frame_url: null, last_frame_source: null, status: 'pending' });
  }
  // 视频已清空，无「提交前已完成」段；字段保留供 workFn 兼容重启续跑的旧任务
  const preDoneIds = targets.filter((s) => s.video_url).map((s) => s.id);

  const job = await createJob(req.user.id, {
    type: 'segment_video_batch_concurrent', projectId: project.id, episodeId: episode.id,
    meta: {
      feature: 'segment_video_batch_concurrent', label: `批量生成视频（并发·${targetIds.length}段）`,
      projectName: project.name, episodeTitle: episode.title,
      segmentIds: targetIds, total: targetIds.length,
      modelConfigId: modelConfigId || null, resolution: clampedRes,
      estimate: totalEst,
      charged: {}, completed: [], failed: [], settledCredits: 0, done: 0, preDoneIds,
    },
  });
  submit(job.id, batchVideoWorkFnConcurrent);
  return ok(res, { job }, 'storyboard.concurrent_generate_queued');
}));

// 估算分镜提示词生成消耗（按所选文本模型每次调用价计费）
router.get('/segments/:sid/generate-prompt/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedSegment(req.user.id, req.params.sid);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'segment_prompt', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

// 生成分镜提示词（异步任务，写入 video_prompt）
router.post('/segments/:sid/generate-prompt', authRequired, asyncHandler(async (req, res) => {
  const { segment, episode, project } = await loadOwnedSegment(req.user.id, req.params.sid, 'ai.generate');
  const modelConfigId = req.body.modelConfigId || null;
  const requirement = req.body.requirement || '';
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'segment_prompt', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'segment_prompt', projectId: project.id, episodeId: episode.id, refId: segment.id,
    meta: { feature: 'segment_prompt', label: '生成提示词', projectName: project.name, episodeIdx: episode.idx, episodeTitle: episode.title, shotNo: segment.shot_no || '', targetName: segment.title, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'segment_prompt', jobId: job.id, refId: segment.id, remark: `提示词生成:${segment.title}` },
      async () => {
        await ctx.reportProgress(30, '调用大模型生成提示词…');
        // 按 asset_refs 顺序解析关联资产，供视频生成引用并生成参考图映射
        const refIds = (segment.asset_refs || []).map((r) => r.id).filter(Boolean);
        const found = refIds.length ? await Asset.findAll({ where: { id: refIds } }) : [];
        const idMap = new Map(found.map((a) => [a.id, a]));
        const ordered = refIds.map((id) => idMap.get(id)).filter(Boolean);
        const videoPrompt = await generateSegmentPrompt(req.user.id, {
          segment, assets: ordered, style: project.style, narrativeType: project.narrative_type,
          directorRequirements: episode.director_requirements, requirement, modelConfigId,
        });
        await ctx.reportProgress(80, '写入提示词');
        await segment.update({ video_prompt: videoPrompt });
        return { _actualCredits: est };
      });
    const fresh = await StoryboardSegment.findByPk(segment.id);
    return { segment: fresh, credits_used: spent, balance };
  });
  return ok(res, { job }, 'storyboard.prompt_generate_queued');
}));

/**
 * 构造插入分镜的 shot_no（子镜号 N-N-N）：
 * 取前一分镜 shot_no 的「场景-镜头」两位作基线，追加递增子号；
 * 子号 = 已存在同名前缀数量 + 1，保证唯一。前一无合法编号时回退到「场景号-idx」。
 * 例：前镜 "1-2" → "1-2-1"；再插一次 → "1-2-2"。
 */
function buildInsertShotNo(prev, allSegs, fallbackSceneNo = null) {
  let base = null;
  if (prev && prev.shot_no) {
    const parts = String(prev.shot_no).split('-').map((p) => p.trim()).filter((p) => /^\d+$/.test(p));
    if (parts.length >= 2) base = `${parts[0]}-${parts[1]}`;
  }
  if (!base) {
    // 插到最前时 prev 为空：场景号回退用后继分镜的场景号（再回退 1），子镜号用 0（如 1-0-1，排在 1-1 之前）
    const sn = prev?.scene_no ?? fallbackSceneNo ?? 1;
    const n = prev?.idx ?? 0;
    base = `${sn}-${n}`;
  }
  const prefix = `${base}-`;
  const used = allSegs.filter((s) => String(s.shot_no || '').startsWith(prefix)).length;
  return `${base}-${used + 1}`;
}

export default router;
