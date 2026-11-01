import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { loadOwnedProject, loadOwnedAsset, loadOwnedEpisode } from '../utils/ownership.js';
import { estimateTextCost, assertBalance, estimateImageCost, attachTierPricing, applyModelPromo } from '../services/pricing.service.js';
import { withCredits } from '../services/credits.service.js';
import { resolveConfig, getConfig } from '../services/modelConfig.service.js';
import { extractAssets } from '../services/ai/extract.service.js';
import { generateAssetPrompt, CHARACTER_PROMPT_SUFFIX, isSingleHumanCharacter } from '../services/ai/assetPrompt.service.js';
import { resolveStyleKey, getStyleName } from '../services/artSkills.service.js';
import { generateImage, generateImageToImage, supportsReferenceImages } from '../services/image.service.js';
import { makeThumbUrl } from '../services/thumbnail.service.js';
import { createJob, submit } from '../services/job.service.js';
import { genFilePath, toUrl, deleteUrlFiles } from '../utils/fileUtil.js';
import { extractFirstFrame, extractFrameAt, probeMedia } from '../services/ffmpeg.service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

const router = Router();
const { Asset, AssetImage, EpisodeAsset } = db;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// 视频素材上传（用户上传本地视频）：磁盘流式存储（200MB 大文件不再整读进内存）、200MB 上限
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

// 服饰「换装」生图的系统指令：锁定原构图与人物面部，仅按用户要求替换服饰
const COSTUME_SWAP_SYSTEM = '你是一个换装专家，保留人物面部特征不变，按要求生成新的人物结构图像，替换服饰。请严格遵守要求，不要改变人物面部、发型、姿势和构图。';

// 参考图 mimetype → 扩展名（落盘后由 encodeReferenceImage 据扩展名判断 base64 的 mime）
function extForMime(mime) {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

// 视频 mimetype → 扩展名（落盘用，与分镜上传视频一致）
function extForVideoMime(mime) {
  if (mime === 'video/mp4' || mime === 'video/x-m4v') return 'mp4';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/x-msvideo') return 'avi';
  if (mime === 'video/x-matroska') return 'mkv';
  return 'mp4';
}

// 取当前用户文本模型配置（用于计费）：指定 id > 默认文本模型 > null（走全局定价兜底）
async function loadTextCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'text');
  } catch { return null; }
}

// 取当前用户图像模型配置（用于计费）：指定 id > 默认图像模型 > null；未配置返回 null
async function loadImageCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'image');
  } catch { return null; }
}

// 写入提取的资产：资产库（本项目）中已存在（按 kind + name）的略过，返回新增数量
// 作用域为整个项目资产库（非单集），故跨集同名同类型资产不会重复创建
async function persistExtractedAssets(projectId, data, episodeId = null) {
  const existing = await Asset.findAll({ where: { project_id: projectId }, attributes: ['kind', 'name', 'aliases'] });
  const seen = new Set(existing.map((a) => `${a.kind}::${String(a.name || '').trim()}`));
  // 已有别名也纳入去重：提取出的名字命中任一已有别名则视为同一资产，避免别名造成重复
  for (const a of existing) {
    for (const alias of Array.isArray(a.aliases) ? a.aliases : []) {
      const al = String(alias || '').trim();
      if (al) seen.add(`${a.kind}::${al}`);
    }
  }
  let added = 0;
  const addKind = async (kind, list) => {
    for (const it of list) {
      const name = String(it.name || '').trim();
      if (!name) continue;
      const key = `${kind}::${name}`;
      if (seen.has(key)) continue; // 资产库已存在同名同类型，略过
      seen.add(key);
      // 角色的「单人人形」判定（大模型在提取时逐角色给出）落 meta，供换装生图等后续流程免二次判定
      const meta = kind === 'character' && typeof it.single_human === 'boolean' ? { singleHuman: it.single_human } : null;
      await Asset.create({ project_id: projectId, episode_id: episodeId, kind, name, description: it.description || '', prompt: it.prompt || '', role_tag: it.role_tag || '', status: 'queued', ...(meta ? { meta } : {}) });
      added += 1;
    }
  };
  await addKind('character', data.characters);
  await addKind('scene', data.scenes);
  await addKind('prop', data.props);
  return added;
}

// 列表（按类型）；角色附带服饰数量 costume_count
router.get('/projects/:id/assets', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id);
  const where = { project_id: project.id };
  if (req.query.type) where.kind = req.query.type;
  const assets = await Asset.findAll({
    where, order: [['kind', 'ASC'], ['id', 'ASC']],
    include: [{ model: AssetImage, as: 'images', attributes: ['id'], required: false }],
  });
  const rows = assets.map((a) => { const o = a.toJSON(); o.costume_count = (o.images || []).length; delete o.images; return o; });
  return ok(res, rows);
}));

// 估算提取消耗（按所选文本模型每次调用价计费）
router.get('/projects/:id/extract/estimate', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id);
  const epCount = await db.Episode.count({ where: { project_id: project.id } });
  const qty = Math.max(1, epCount);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'asset_extract', qty);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { episodes: epCount, credits, source, pricing, ...tierPricing });
}));

// AI 提取资产（角色/场景/道具）（异步任务）
router.post('/projects/:id/extract', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id, 'ai.generate');
  const episodes = await db.Episode.findAll({ where: { project_id: project.id }, order: [['idx', 'ASC']] });
  if (!episodes.length) throw badRequest('asset.script_split_required');

  const qty = episodes.length;
  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'asset_extract', qty);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'asset_extract', projectId: project.id,
    meta: { feature: 'asset_extract', label: '资产提取', projectName: project.name, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_extract', jobId: job.id, refId: project.id, remark: '资产提取' },
      async () => {
        // 逐集调用提取（计费口径即「每集一次」）：合并全集成单次调用会被 extractAssets 内部
        // 的单次输入截断（约 1 万字）砍掉后面各集的内容，长剧只提取出前几集的资产
        let added = 0;
        for (let i = 0; i < episodes.length; i++) {
          const e = episodes[i];
          await ctx.reportProgress(30 + Math.round((i / episodes.length) * 55), `提取第 ${e.idx} 集「${e.title}」资产…`);
          const text = `${e.title}\n${e.content || ''}`;
          const data = await extractAssets(req.user.id, text, project.style, { modelConfigId });
          added += await persistExtractedAssets(project.id, data, e.id);
          // 标记本集已完成资产提取（只升不降：不覆盖 storyboard 及之后的更高阶段状态）
          if (['draft', 'outline'].includes(e.status)) await e.update({ status: 'assets' });
        }
        await project.update({ status: 'assets' });
        await ctx.reportProgress(90, '写入数据库');
        await ctx.reportProgress(100, `完成，新增 ${added} 项`);
        return { _actualCredits: est, added };
      });
    const assets = await Asset.findAll({ where: { project_id: project.id }, order: [['kind', 'ASC'], ['id', 'ASC']] });
    return { assets, credits_used: spent, balance };
  });
  return ok(res, { job }, 'asset.extract_queued');
}));

// 估算单集资产提取消耗（按所选文本模型每次调用价计费）
router.get('/projects/:id/episodes/:eid/extract/estimate', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid);
  if (String(project.id) !== String(req.params.id)) throw badRequest('asset.episode_not_in_project');
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'asset_extract', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing, episodeIdx: episode.idx, episodeTitle: episode.title });
}));

// AI 提取单集资产：仅处理该集剧本，已存在（按 kind+name）的略过，否则新增（异步任务）
router.post('/projects/:id/episodes/:eid/extract', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'ai.generate');
  if (String(project.id) !== String(req.params.id)) throw badRequest('asset.episode_not_in_project');
  if (!episode.content || !episode.content.trim()) throw badRequest('asset.episode_content_empty');

  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'asset_extract', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'asset_extract', projectId: project.id, refId: episode.id,
    meta: { feature: 'asset_extract', label: `资产提取·第${episode.idx}集`, projectName: project.name, targetName: episode.title, estimate: est, episodeId: episode.id },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_extract', jobId: job.id, refId: project.id, remark: `资产提取·第${episode.idx}集` },
      async () => {
        await ctx.reportProgress(30, '调用大模型提取资产…');
        const text = `${episode.title}\n${episode.content || ''}`;
        const data = await extractAssets(req.user.id, text, project.style, { modelConfigId });
        await ctx.reportProgress(70, '解析结果并去重');
        // 去重：资产库（本项目）已存在（按 kind + name）的略过，其余新增；episode_id 仅作溯源记录
        const added = await persistExtractedAssets(project.id, data, episode.id);
        await project.update({ status: 'assets' });
        // 标记本集已完成资产提取（只升不降：不覆盖 storyboard 及之后的更高阶段状态）
        if (['draft', 'outline'].includes(episode.status)) {
          await episode.update({ status: 'assets' });
        }
        await ctx.reportProgress(100, `完成，新增 ${added} 项`);
        return { _actualCredits: est, added };
      });
    const assets = await Asset.findAll({ where: { project_id: project.id }, order: [['kind', 'ASC'], ['id', 'ASC']] });
    return { assets, credits_used: spent, balance };
  });
  return ok(res, { job }, 'asset.extract_queued');
}));

// 估算单个资产生图消耗（按所选图像模型每张价计费）
router.get('/assets/:aid/generate-image/estimate', authRequired, asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid);
  const cfg = await loadImageCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const img = await estimateImageCost(cfg);
  const tierPricing = await attachTierPricing(req.user, img.credits, cfg);
  // 回传当前所选模型是否支持参考图：前端据此在"已设参考图但模型不支持"时给出警告（避免静默退回纯文生图）
  return ok(res, { credits: img.credits, pricing: img.pricing, source: img.source, name: asset.name, supportsReferenceImages: supportsReferenceImages(cfg), ...tierPricing });
}));

// 生成资产图（异步任务）；视频资产的封面由视频首帧生成，不支持 AI 生图
router.post('/assets/:aid/generate-image', authRequired, asyncHandler(async (req, res) => {
  const { asset, project } = await loadOwnedAsset(req.user.id, req.params.aid, 'ai.generate');
  if (asset.kind === 'video') throw badRequest('asset.video_image_locked');
  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadImageCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'asset_image', projectId: project.id, refId: asset.id,
    meta: { feature: 'asset_image', label: '资产生图', projectName: project.name, targetName: asset.name, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_image', jobId: job.id, refId: asset.id, remark: `资产生图:${asset.name}` },
      async () => {
        await asset.update({ status: 'generating' });
        try {
          await ctx.reportProgress(30, '调用大模型生成图片…');
          // 参考图（图生图）：仅在资产设置了参考图且所选模型支持时启用
          const ref = asset.meta?.referenceImage;
          const hasRef = !!(ref && supportsReferenceImages(cfg));
          const referenceImages = hasRef ? [ref] : undefined;
          // 角色带参考图：文字里面部特征让位于参考图（避免 prompt 中表情/视角硬规定压制参考图导致"不像"）。
          // basePrompt（不含该增强）写回资产，避免动态指令污染入库的 prompt。
          const basePrompt = buildAssetPrompt(asset, project.style);
          const prompt = buildAssetPrompt(asset, project.style, { hasRef });
          const oldUrl = asset.image_url;
          const url = await generateImage(req.user.id, prompt, {
            ratio: '16:9', modelConfigId, referenceImages, // 资产类固定 16:9
            logCtx: { jobId: job.id, projectId: project.id, feature: 'asset_image', target: asset.name },
          });
          const thumbUrl = await makeThumbUrl(url);
          await asset.update({ image_url: url, status: 'done', prompt: basePrompt, thumb_url: thumbUrl || null });
          // 重新生成替换旧主图：旧图若仍被某套服饰引用（默认服饰与主图同文件）则保留，否则删除（与上传主图路由同口径）
          const keep = oldUrl && (await AssetImage.count({ where: { asset_id: asset.id, image_url: oldUrl } })) > 0 ? [oldUrl, `${oldUrl}.thumb.webp`] : [];
          deleteUrlFiles([oldUrl, `${oldUrl}.thumb.webp`], keep);
          return { _actualCredits: est };
        } catch (e) {
          await asset.update({ status: 'failed' });
          throw e;
        }
      });
    await asset.reload();
    return { asset, credits_used: spent, balance };
  });
  return ok(res, { job }, 'asset.image_queued');
}));

// 估算资产提示词润色消耗（按所选文本模型每次调用价计费）
router.get('/assets/:aid/generate-prompt/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedAsset(req.user.id, req.params.aid);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'asset_prompt', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

// AI 润色资产提示词（异步任务，写入 prompt）
router.post('/assets/:aid/generate-prompt', authRequired, asyncHandler(async (req, res) => {
  const { asset, project } = await loadOwnedAsset(req.user.id, req.params.aid, 'ai.generate');
  const modelConfigId = req.body.modelConfigId || null;
  const requirement = req.body.requirement || '';
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'asset_prompt', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'asset_prompt', projectId: project.id, refId: asset.id,
    meta: { feature: 'asset_prompt', label: 'AI润色资产提示词', projectName: project.name, targetName: asset.name, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_prompt', jobId: job.id, refId: asset.id, remark: `AI润色资产提示词:${asset.name}` },
      async () => {
        await ctx.reportProgress(30, '调用大模型润色提示词…');
        const prompt = await generateAssetPrompt(req.user.id, { asset, style: project.style, modelConfigId, requirement });
        await ctx.reportProgress(80, '写入提示词');
        await asset.update({ prompt });
        return { _actualCredits: est };
      });
    await asset.reload();
    return { asset, credits_used: spent, balance };
  });
  return ok(res, { job }, 'asset.prompt_queued');
}));

// 更新资产（名称/描述/提示词/手动指定图片/参考图链接/角色声音）
router.put('/assets/:aid', authRequired, asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid, 'asset.edit');
  const { name, aliases, description, prompt, image_url, role_tag, doubao_asset_id, reference_image, voice_id, voice_settings } = req.body;
  // meta 合并：reference_image / voice_id / voice_settings 可能同时提交，需合并为同一 meta 对象
  let metaPatch = null;
  if (reference_image !== undefined || voice_id !== undefined || voice_settings !== undefined) {
    metaPatch = { ...(asset.meta || {}) };
    if (reference_image !== undefined) metaPatch.referenceImage = reference_image || null;
    if (voice_id !== undefined) metaPatch.voiceId = voice_id || null;
    // 声音参数：语速/音量/语调/情感（来自角色「声音设置」弹窗）
    if (voice_settings !== undefined) {
      if (voice_settings && typeof voice_settings === 'object') {
        const s = voice_settings;
        metaPatch.voiceSettings = {
          speed: Number.isFinite(+s.speed) ? +s.speed : 1,
          volume: Number.isFinite(+s.volume) ? +s.volume : 5,
          pitch: Number.isFinite(+s.pitch) ? +s.pitch : 1,
          emotion: typeof s.emotion === 'string' ? s.emotion : '',
        };
      } else {
        metaPatch.voiceSettings = null;
      }
    }
  }
  await asset.update({
    ...(name !== undefined && { name }),
    ...(aliases !== undefined && { aliases: Array.isArray(aliases) ? aliases.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 50) : null }),
    ...(description !== undefined && { description }),
    ...(prompt !== undefined && { prompt }),
    // 手动换图同步重算缩略图（失败置 null 交扫描线程重试，避免残留旧图的 thumb）
    ...(image_url !== undefined && { image_url, status: 'done', thumb_url: image_url ? (await makeThumbUrl(image_url)) || null : null }),
    ...(role_tag !== undefined && { role_tag }),
    ...(doubao_asset_id !== undefined && { doubao_asset_id }),
    ...(metaPatch && { meta: metaPatch }),
  });
  return ok(res, asset, 'asset.updated');
}));

// 上传资产参考图（图生图蓝本）：落盘并写入 meta.referenceImage
router.post('/assets/:aid/reference-image', authRequired, upload.single('file'), asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid, 'asset.edit');
  if (!req.file) throw badRequest('asset.no_reference_file');
  if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) throw badRequest('asset.reference_image_only');
  const ext = extForMime(req.file.mimetype);
  const { absPath } = genFilePath(config.uploadDir, ext, 'refimg');
  const oldRef = asset.meta?.referenceImage || null;
  fs.writeFileSync(absPath, req.file.buffer);
  await asset.update({ meta: { ...(asset.meta || {}), referenceImage: toUrl(absPath) } });
  deleteUrlFiles([oldRef]); // 清掉被替换的旧参考图
  return ok(res, asset, 'asset.reference_image_uploaded');
}));

// 上传资产主图：落盘并写入 image_url，状态置为 done（与 PUT 指定 image_url 语义一致）；视频资产封面由视频首帧自动生成
router.post('/assets/:aid/image', authRequired, upload.single('file'), asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid, 'asset.edit');
  if (asset.kind === 'video') throw badRequest('asset.video_image_locked');
  if (!req.file) throw badRequest('asset.no_image_file');
  if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) throw badRequest('asset.image_only');
  const ext = extForMime(req.file.mimetype);
  const { absPath } = genFilePath(config.uploadDir, ext, 'asset');
  const oldUrl = asset.image_url;
  fs.writeFileSync(absPath, req.file.buffer);
  // 即时生成列表卡片缩略图（存量与遗漏由 thumbnail 扫描线程兜底）
  const thumbUrl = await makeThumbUrl(toUrl(absPath));
  await asset.update({ image_url: toUrl(absPath), status: 'done', ...(thumbUrl && { thumb_url: thumbUrl }) });
  // 旧主图若仍被某套服饰引用（默认服饰与主图同文件）则保留
  const keep = (await AssetImage.count({ where: { asset_id: asset.id, image_url: oldUrl } })) > 0 ? [oldUrl] : [];
  deleteUrlFiles([oldUrl, `${oldUrl}.thumb.webp`], keep);
  return ok(res, asset, 'asset.image_uploaded');
}));

// 上传视频素材（仅 video 类型资产）：落盘写入 meta.videoUrl，抽首帧为封面（image_url），
// probeMedia 取时长/宽高入 meta；状态置 done。用户自带素材，不计费、不走异步任务。
router.post('/assets/:aid/video', authRequired, videoUpload.single('file'), asyncHandler(async (req, res) => {
  try {
    const { asset } = await loadOwnedAsset(req.user.id, req.params.aid, 'asset.edit');
    if (asset.kind !== 'video') throw badRequest('asset.video_kind_required');
    if (!req.file) throw badRequest('asset.no_video_file');
    if (!req.file.mimetype || !req.file.mimetype.startsWith('video/')) throw badRequest('asset.video_only');
    const ext = extForVideoMime(req.file.mimetype);
    const { absPath } = genFilePath(config.uploadDir, ext, 'assetvideo');
    const oldVideoUrl = asset.meta?.videoUrl || null;
    const oldCoverUrl = asset.image_url;
    // 磁盘流式存储：multer 已落盘，改名到规范路径即可（不再把 200MB 整个读进内存）
    fs.renameSync(req.file.path, absPath);
    const videoUrl = toUrl(absPath);

    // 抽首帧为封面（卡片缩略/分镜选择器/参考图管线均消费 image_url），尽力而为，失败不阻断上传
    let coverUrl = null;
    try {
      const { absPath: coverAbs } = genFilePath(config.uploadDir, 'webp', 'assetvideo');
      await extractFirstFrame(absPath, coverAbs);
      coverUrl = toUrl(coverAbs);
    } catch (e) {
      logger.warn(`[ASSET] 视频素材抽取首帧失败 asset=${asset.id}: ${e.message}`);
    }
    // 封面即时生成列表卡片缩略图（webp 封面属 SOURCE_EXT 支持范围；失败置 null 交扫描线程重试）
    const coverThumbUrl = coverUrl ? await makeThumbUrl(coverUrl) : null;

    // 时长/分辨率（尽力而为，失败不阻断；probeMedia 以 0 兜底，统一归一为 null）
    let duration = null;
    let width = null;
    let height = null;
    try {
      const info = await probeMedia(absPath);
      duration = info.videoDuration || info.duration || null;
      width = info.width || null;
      height = info.height || null;
    } catch (e) {
      logger.warn(`[ASSET] 视频素材探测元信息失败 asset=${asset.id}: ${e.message}`);
    }

    await asset.update({
      image_url: coverUrl,
      thumb_url: coverThumbUrl || null, // 重传视频必须重算缩略图：旧值非 NULL 时扫描线程永不再兜底，会一直显示上个视频的封面
      status: 'done',
      meta: { ...(asset.meta || {}), videoUrl, duration, width, height },
    });

    // 清理被替换的旧视频与旧封面及其缩略图（均属旧视频产物，不会误删）
    deleteUrlFiles([oldVideoUrl, oldCoverUrl, `${oldCoverUrl}.thumb.webp`]);
    return ok(res, asset, 'asset.video_uploaded');
  } catch (e) {
    // multer 落盘先于归属/类型校验：失败时清掉已落盘的文件，避免孤儿
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* 已改名或已删除 */ } }
    throw e;
  }
}));

// 视频转图片关键帧：上传视频 + 名称 + 个数，同步按个数均匀抽 N 帧生成 material 图片素材（命名 名称#1..N）。
// 视频用完即删、不留档（不为视频建 Asset 行，meta 不落任何视频信息）。用户自带素材，不计费、不走异步任务。
router.post('/projects/:id/assets/keyframes', authRequired, videoUpload.single('file'), asyncHandler(async (req, res) => {
  const videoPath = req.file?.path || null; // multer 落盘的临时视频（成功/失败最终都删）
  const created = [];                       // 本次请求已建的 Asset 行（失败回滚）
  const frameUrls = [];                     // 已落盘的帧图 URL（失败回滚，连同缩略图）
  try {
    const project = await loadOwnedProject(req.user.id, req.params.id, 'asset.edit');
    if (!req.file) throw badRequest('asset.no_video_file');
    if (!req.file.mimetype || !req.file.mimetype.startsWith('video/')) throw badRequest('asset.video_only');

    // 名称：必填；去空白；剥掉用户输入尾部的 #数字（避免「名称#1#1」）；基名截到 124 保证拼上 #N 后仍 ≤128（模型 STRING(128)）
    let name = String(req.body?.name || '').trim().replace(/#\d+\s*$/, '').trim();
    if (!name) throw badRequest('asset.keyframes.name_required');
    name = name.slice(0, 124);

    // 个数：1-50 整数
    const count = Number(req.body?.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw badRequest('asset.keyframes.count_invalid');

    // 均匀取帧基准时长：优先流级 videoDuration，回退容器 duration；取不到视为坏视频
    let dur = 0;
    try {
      const info = await probeMedia(videoPath);
      dur = info.videoDuration || info.duration || 0;
    } catch (e) {
      logger.warn(`[ASSET] 视频转关键帧探测失败 project=${project.id}: ${e.message}`);
    }
    if (!(dur > 0)) throw badRequest('asset.keyframes.probe_failed');

    for (let i = 0; i < count; i++) {
      const t = dur * (i + 0.5) / count; // 段中心取帧：严格落在 (0, dur) 内，避开 0/EOF 边界帧
      const { absPath } = genFilePath(config.uploadDir, 'webp', 'keyframe');
      try {
        await extractFrameAt(videoPath, t, absPath);
      } catch (e) {
        logger.warn(`[ASSET] 视频转关键帧抽帧失败 project=${project.id} t=${t.toFixed(3)}: ${e.message}`);
        throw badRequest('asset.keyframes.extract_failed');
      }
      const imageUrl = toUrl(absPath);
      frameUrls.push(imageUrl);
      // 即时生成列表卡片缩略图（幂等；失败置 null 交扫描线程兜底）
      const thumbUrl = await makeThumbUrl(imageUrl);
      created.push(await Asset.create({
        project_id: project.id,
                kind: 'material',
        name: `${name}#${i + 1}`,
        image_url: imageUrl,
        thumb_url: thumbUrl || null,
        status: 'done',
      }));
    }

    // 与列表行同构（list 端点会附 costume_count；material 恒 0，补齐形状便于前端直接并入列表）
    const rows = created.map((a) => { const o = a.toJSON(); o.costume_count = 0; return o; });
    return ok(res, rows, 'asset.keyframes.created', { count: created.length });
  } catch (e) {
    // 回滚：销毁本次已建的资产行 + 删帧图与其缩略图（deleteUrlFiles 不抛错）
    for (const a of created) { try { await a.destroy(); } catch { /* ignore */ } }
    deleteUrlFiles([...frameUrls, ...frameUrls.map((u) => `${u}.thumb.webp`)]);
    throw e;
  } finally {
    // 视频用完即删（不留档）：成功、失败、归属校验失败一律清理
    if (videoPath) { try { fs.unlinkSync(videoPath); } catch { /* 已删除 */ } }
  }
}));

// 新建空白资产
router.post('/projects/:id/assets', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id, 'asset.edit');
  const { kind, name, description, prompt } = req.body;
  if (!kind || !['character', 'scene', 'prop', 'material', 'video'].includes(kind)) throw badRequest('asset.invalid_kind');
  const asset = await Asset.create({ project_id: project.id, kind, name: name || '新资产', description: description || '', prompt: prompt || '', status: 'queued' });
  return ok(res, asset, 'asset.created');
}));

// 删除资产：连同磁盘文件一并清理（主图/封面及其缩略图、参考图、视频素材、全部服饰图；主图与默认服饰同文件时由工具去重）
router.delete('/assets/:aid', authRequired, asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid, 'asset.edit');
  const costumes = await AssetImage.findAll({ where: { asset_id: asset.id }, attributes: ['image_url', 'thumb_url'] });
  deleteUrlFiles([
    asset.image_url, asset.thumb_url,
    `${asset.image_url}.thumb.webp`, // 扫描线程生成的缩略图按「原图URL+.thumb.webp」推导，未必已写进 thumb_url
    asset.meta?.referenceImage, asset.meta?.videoUrl,
    ...costumes.flatMap((c) => [c.image_url, c.thumb_url, `${c.image_url}.thumb.webp`]),
  ]);
  await asset.destroy();
  return ok(res, null, 'asset.deleted');
}));

// ===== 服饰（AssetImage）：一套服饰 = 一张图，一个角色可有多套 =====

// 取得某角色的指定服饰（须属于该资产），不存在抛错；perm 透传给资产装载器（成员写权限校验）
async function loadOwnedCostume(userId, aid, cid, perm = null) {
  const { asset } = await loadOwnedAsset(userId, aid, perm);
  const costume = await AssetImage.findOne({ where: { id: cid, asset_id: asset.id } });
  if (!costume) throw badRequest('asset.costume.not_found');
  return { asset, costume };
}

// 列出某角色的全部服饰
router.get('/assets/:aid/costumes', authRequired, asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid);
  const list = await AssetImage.findAll({ where: { asset_id: asset.id }, order: [['is_default', 'DESC'], ['sort', 'ASC'], ['id', 'ASC']] });
  return ok(res, list);
}));

// 新建空白服饰
router.post('/assets/:aid/costumes', authRequired, asyncHandler(async (req, res) => {
  const { asset } = await loadOwnedAsset(req.user.id, req.params.aid, 'asset.edit');
  const name = String(req.body?.name || '').trim().slice(0, 64);
  const costume = await AssetImage.create({ asset_id: asset.id, name });
  return ok(res, costume, 'asset.costume.created');
}));

// 上传服饰图片（落盘并写入 costume.image_url；若为默认服饰则同步回写 Asset.image_url）
router.post('/assets/:aid/costumes/:cid/image', authRequired, upload.single('file'), asyncHandler(async (req, res) => {
  const { asset, costume } = await loadOwnedCostume(req.user.id, req.params.aid, req.params.cid, 'asset.edit');
  if (!req.file) throw badRequest('asset.no_image_file');
  if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) throw badRequest('asset.image_only');
  const ext = extForMime(req.file.mimetype);
  const { absPath } = genFilePath(config.uploadDir, ext, 'costume');
  const oldUrl = costume.image_url;
  fs.writeFileSync(absPath, req.file.buffer);
  // 即时生成列表卡片缩略图；默认服饰同步回写资产主图时缩略图一并同步（失败置 null，勿沿用旧图 thumb 造成串图）
  const thumbUrl = await makeThumbUrl(toUrl(absPath));
  await costume.update({ image_url: toUrl(absPath), thumb_url: thumbUrl || null });
  if (costume.is_default) await asset.update({ image_url: costume.image_url, thumb_url: thumbUrl || null });
  // 旧服饰图若正是资产当前主图（历史同步遗留）则保留，否则删除（连同缩略图）
  deleteUrlFiles([oldUrl, `${oldUrl}.thumb.webp`], [asset.image_url, `${asset.image_url}.thumb.webp`]);
  return ok(res, costume, 'asset.costume.image_uploaded');
}));

// 估算服饰生图消耗（复用图像模型定价）
router.get('/assets/:aid/costumes/:cid/generate-image/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedCostume(req.user.id, req.params.aid, req.params.cid);
  const cfg = await loadImageCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateImageCost(cfg);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, supportsReferenceImages: supportsReferenceImages(cfg), ...tierPricing });
}));

// 服饰 AI 生图（异步任务；复用角色参考图保持面部一致，服饰提示词来自该套服饰）
router.post('/assets/:aid/costumes/:cid/generate-image', authRequired, asyncHandler(async (req, res) => {
  const { asset, project, costume } = await (async () => {
    const r = await loadOwnedAsset(req.user.id, req.params.aid, 'ai.generate');
    const c = await AssetImage.findOne({ where: { id: req.params.cid, asset_id: r.asset.id } });
    if (!c) throw badRequest('asset.costume.not_found');
    return { ...r, costume: c };
  })();
  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadImageCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'asset_image', projectId: project.id, refId: asset.id,
    meta: { feature: 'asset_image', label: '服饰生图', projectName: project.name, targetName: `${asset.name}·${costume.name || '服饰'}`, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_image', jobId: job.id, refId: asset.id, remark: `服饰生图:${asset.name}` },
      async () => {
        await ctx.reportProgress(30, '调用大模型生成服饰图…');
        // 角色服饰沿用该角色的参考图（保持面部一致），服饰样式由服饰提示词决定
        const ref = asset.meta?.referenceImage;
        const hasRef = !!(ref && supportsReferenceImages(cfg));
        const referenceImages = hasRef ? [ref] : undefined;
        const basePrompt = String(costume.prompt || asset.prompt || asset.description || asset.name).trim();
        const prompt = facePriorityPrompt(basePrompt, asset.kind, { hasRef });
        const oldUrl = costume.image_url;
        const url = await generateImage(req.user.id, prompt, {
          ratio: '16:9', modelConfigId, referenceImages, // 资产类固定 16:9
          logCtx: { jobId: job.id, projectId: project.id, feature: 'asset_image', target: `${asset.name}·${costume.name || '服饰'}` },
        });
        const thumbUrl = await makeThumbUrl(url)
        await costume.update({ image_url: url, prompt: basePrompt, thumb_url: thumbUrl || null });
        if (costume.is_default) await asset.update({ image_url: url, thumb_url: thumbUrl || null });
        // 旧服饰图清理：若正是资产当前主图（历史同步遗留）则保留，否则删除（与上传服饰图路由同口径）
        deleteUrlFiles([oldUrl, `${oldUrl}.thumb.webp`], [asset.image_url, `${asset.image_url}.thumb.webp`]);
        return { _actualCredits: est };
      });
    await costume.reload();
    return { costume, credits_used: spent, balance };
  });
  return ok(res, { job }, 'asset.costume.image_queued');
}));

// 服饰「换装」生图（异步任务）：以用户在确认框填写的「本次要求」作为唯一提示词，
// 仅默认附加该角色原始图片(asset.image_url)为参考；并注入换装 system 指令(锁定原构图与面部、仅替换服饰)。
// 与 generate-image 的区别：提示词来源=用户要求(非 asset.prompt)、参考图=角色原图(非 meta.referenceImage)、附 system 指令。
router.post('/assets/:aid/costumes/:cid/generate-image-by-requirement', authRequired, asyncHandler(async (req, res) => {
  const { asset, project, costume } = await (async () => {
    const r = await loadOwnedAsset(req.user.id, req.params.aid, 'ai.generate');
    const c = await AssetImage.findOne({ where: { id: req.params.cid, asset_id: r.asset.id } });
    if (!c) throw badRequest('asset.costume.not_found');
    return { ...r, costume: c };
  })();
  const requirement = String(req.body.requirement || '').trim();
  if (!requirement) throw badRequest('asset.costume.requirement_required');
  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadImageCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'asset_image', projectId: project.id, refId: asset.id,
    meta: { feature: 'asset_image', label: '服饰换装生图', projectName: project.name, targetName: `${asset.name}·${costume.name || '服饰'}`, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_image', jobId: job.id, refId: asset.id, remark: `服饰换装生图:${asset.name}` },
      async () => {
        await ctx.reportProgress(30, '调用大模型换装生图…');
        // 走 Seedream 图生图(image 字段)：以角色原图(asset.image_url)为底图，COSTUME_SWAP_SYSTEM 指令锁定原构图与面部。
        // 在用户「本次要求」前注入：项目风格名称 + 角色设定图规格（仅单人人形角色，群像/动物不注入）。
        const styleKey = resolveStyleKey(project.style);
        const styleAnchor = `【风格】${getStyleName(styleKey)}`;
        const characterSpec = isSingleHumanCharacter(asset) ? CHARACTER_PROMPT_SUFFIX : '';
        const prompt = [styleAnchor, characterSpec, requirement].filter(Boolean).join('\n\n');
        const oldCostumeUrl = costume.image_url;
        const oldAssetUrl = asset.image_url; // 默认服饰同步替换时旧主图一并作废
        const url = await generateImageToImage(req.user.id, prompt, {
          ratio: '1:1', // 换装图固定方画幅（服务端默认即 1:1，此处显式声明）
          modelConfigId,
          image: asset.image_url,
          system: COSTUME_SWAP_SYSTEM,
          logCtx: { jobId: job.id, projectId: project.id, feature: 'costume_swap', target: `${asset.name}·${costume.name || '服饰'}` },
        });
        const thumbUrl = await makeThumbUrl(url);
        await costume.update({ image_url: url, prompt: requirement, thumb_url: thumbUrl || null });
        if (costume.is_default) await asset.update({ image_url: url, thumb_url: thumbUrl || null });
        // 清掉被替换的旧服饰图/旧主图及其缩略图：仍被引用的保留（非默认时 asset.image_url 即底图，仍在用）
        deleteUrlFiles(
          [oldCostumeUrl, oldAssetUrl, `${oldCostumeUrl}.thumb.webp`, `${oldAssetUrl}.thumb.webp`],
          [url, `${url}.thumb.webp`, asset.image_url, `${asset.image_url}.thumb.webp`],
        );
        return { _actualCredits: est };
      });
    await costume.reload();
    return { costume, credits_used: spent, balance };
  });
  return ok(res, { job }, 'asset.costume.image_queued');
}));

// 更新服饰（名称/提示词/doubao_asset_id）
router.put('/assets/:aid/costumes/:cid', authRequired, asyncHandler(async (req, res) => {
  const { costume } = await loadOwnedCostume(req.user.id, req.params.aid, req.params.cid, 'asset.edit');
  const { name, prompt, doubao_asset_id } = req.body;
  await costume.update({
    ...(name !== undefined && { name: String(name).slice(0, 64) }),
    ...(prompt !== undefined && { prompt }),
    ...(doubao_asset_id !== undefined && { doubao_asset_id }),
  });
  return ok(res, costume, 'asset.costume.updated');
}));

// 设为默认服饰（本资产内互斥；并把 image_url 镜像回 Asset，保证未配置集级覆盖时视频链路一致）
router.post('/assets/:aid/costumes/:cid/set-default', authRequired, asyncHandler(async (req, res) => {
  const { asset, costume } = await loadOwnedCostume(req.user.id, req.params.aid, req.params.cid, 'asset.edit');
  await db.sequelize.transaction(async (t) => {
    await AssetImage.update({ is_default: false }, { where: { asset_id: asset.id }, transaction: t });
    await costume.update({ is_default: true }, { transaction: t });
  });
  // 主图镜像同步缩略图：优先沿用该服饰已生成的 thumb（同一原图），缺失时现算（幂等）
  if (costume.image_url) await asset.update({ image_url: costume.image_url, thumb_url: costume.thumb_url || (await makeThumbUrl(costume.image_url)) || null });
  return ok(res, costume, 'asset.costume.default_set');
}));

// 删除服饰（删的是默认则重选一个默认并回写 Asset）
router.delete('/assets/:aid/costumes/:cid', authRequired, asyncHandler(async (req, res) => {
  const { asset, costume } = await loadOwnedCostume(req.user.id, req.params.aid, req.params.cid, 'asset.edit');
  const wasDefault = costume.is_default;
  await costume.destroy();
  // 删除该服饰后，引用它的集级配置（EpisodeAsset）一并清除 → 相关剧集自动回退默认服饰
  await EpisodeAsset.destroy({ where: { costume_id: costume.id } });
  if (wasDefault) {
    const next = await AssetImage.findOne({ where: { asset_id: asset.id }, order: [['sort', 'ASC'], ['id', 'ASC']] });
    if (next) {
      await next.update({ is_default: true });
      if (next.image_url) await asset.update({ image_url: next.image_url, thumb_url: next.thumb_url || (await makeThumbUrl(next.image_url)) || null });
    }
  }
  // 删服饰图文件：若删的是默认服饰且无下一套可顶替，asset.image_url 仍指向该文件，保留不删
  deleteUrlFiles([costume.image_url], [asset.image_url]);
  return ok(res, null, 'asset.costume.deleted');
}));

// ===== 按集角色服饰配置（EpisodeAsset）：剧集可指定角色用哪套服饰，未配置即默认 =====

// 查询某集的角色服饰配置：本项目全部角色 + 各自服饰 + 当前集覆盖的 costume_id
router.get('/episodes/:eid/costume-config', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid);
  const characters = await Asset.findAll({ where: { project_id: project.id, kind: 'character' }, order: [['id', 'ASC']] });
  const overrides = await EpisodeAsset.findAll({ where: { episode_id: episode.id } });
  const overrideMap = new Map(overrides.map((o) => [o.asset_id, o.costume_id]));
  const list = await Promise.all(characters.map(async (a) => {
    const costumes = await AssetImage.findAll({
      where: { asset_id: a.id }, order: [['is_default', 'DESC'], ['sort', 'ASC'], ['id', 'ASC']],
      attributes: ['id', 'name', 'image_url', 'is_default', 'doubao_asset_id'],
    });
    return { asset_id: a.id, name: a.name, image_url: a.image_url, costume_id: overrideMap.get(a.id) ?? null, costumes };
  }));
  return ok(res, list);
}));

// 保存某集角色服饰配置（前端全量提交；仅持久化显式选了某套服饰的项，其余视为默认）
router.put('/episodes/:eid/costume-config', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'asset.edit');
  const configs = Array.isArray(req.body?.configs) ? req.body.configs : [];
  const validCharIds = new Set((await Asset.findAll({ where: { project_id: project.id, kind: 'character' }, attributes: ['id'] })).map((a) => a.id));
  const rows = [];
  for (const c of configs) {
    const assetId = Number(c?.asset_id);
    const costumeId = c?.costume_id ? Number(c.costume_id) : null;
    if (!Number.isFinite(assetId) || !validCharIds.has(assetId)) continue;
    if (!costumeId) continue; // 未指定服饰 = 默认，无需建行
    const owns = await AssetImage.findOne({ where: { id: costumeId, asset_id: assetId }, attributes: ['id'] });
    if (!owns) continue;
    rows.push({ episode_id: episode.id, asset_id: assetId, costume_id: costumeId });
  }
  await db.sequelize.transaction(async (t) => {
    await EpisodeAsset.destroy({ where: { episode_id: episode.id }, transaction: t });
    if (rows.length) await EpisodeAsset.bulkCreate(rows, { transaction: t });
  });
  return ok(res, null, 'asset.costumeConfig.saved');
}));

// 构造生图 prompt：默认取资产提示词（兜底描述/名称）。
// 角色带参考图时追加"面部遵循参考图"优先级指令，让 prompt 中对表情/视角的硬规定让位于参考图
// （与 storyboard 视频线"保持角色面部特征与参考图一致"的写法一致）。
function facePriorityPrompt(base, kind, { hasRef = false } = {}) {
  if (hasRef && kind === 'character') {
    return `${base}\n\n面部五官、脸型、发型、表情、肤色严格遵循参考图，与前文不一致时以参考图为准。`;
  }
  return base;
}
function buildAssetPrompt(asset, style, { hasRef = false } = {}) {
  return facePriorityPrompt(asset.prompt || asset.description || asset.name, asset.kind, { hasRef });
}

export default router;
