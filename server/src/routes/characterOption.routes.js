import { Router } from 'express';
import fs from 'fs';
import sharp from 'sharp';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired, adminAuthRequired } from '../middleware/auth.js';
import { loadOwnedProject } from '../utils/ownership.js';
import { estimateImageCost, assertBalance, attachTierPricing, applyModelPromo } from '../services/pricing.service.js';
import { withCredits, getCurrentBalance } from '../services/credits.service.js';
import { resolveConfig, getConfig } from '../services/modelConfig.service.js';
import { generateImage } from '../services/image.service.js';
import { createJob, submit } from '../services/job.service.js';
import { resolveStyleKey, getStyleName } from '../services/artSkills.service.js';
import { urlToPath, deleteUrlFiles } from '../utils/fileUtil.js';
import { logger } from '../utils/logger.js';
import db from '../db/index.js';
import {
  listCharacterOptionGroups,
  getCharacterOptionStats,
  scanMissingOptions,
  findGroup,
  findOption,
  resolveSelections,
  buildCustomCharacterPrompt,
  summarizeAppearance,
  defaultAssetName,
  buildOptionPreviewPrompt,
  optionImagePaths,
} from '../services/characterOptions.service.js';

const router = Router();
const { Asset } = db;

// 取当前用户图像模型配置（用于计费/生图）：指定 id > 默认图像模型 > null
async function loadImageCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'image');
  } catch {
    return null;
  }
}

// ============ 用户端 ============

// 选项注册表下发（角色自定义弹窗）：分组 + 选项 + 预览图 URL（未生成为 null，前端降级占位）
router.get('/character-options', authRequired, asyncHandler(async (req, res) => {
  return ok(res, { groups: listCharacterOptionGroups() });
}));

// 估算自定义角色生图消耗（与资产生图同口径：所选图像模型每张价）
router.get('/projects/:id/characters/custom/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedProject(req.user.id, req.params.id);
  const cfg = await loadImageCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateImageCost(cfg);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

// 自定义角色：按外貌选项创建 character 资产并生成 16:9 三视图设定图（异步任务，复用 asset_image 类型）
router.post('/projects/:id/characters/custom', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id, 'ai.generate');

  // 白名单校验 + 性别过滤：前端只传 key，prompt 由服务端注册表拼装（防注入）
  const { gender, picks } = resolveSelections(req.body.selections);
  if (!gender) throw badRequest('charOption.gender_required');
  const freeText = String(req.body.freeText || '').trim().slice(0, 500);
  const styleKey = resolveStyleKey(project.style);
  const prompt = buildCustomCharacterPrompt({ gender, picks }, freeText, getStyleName(styleKey));

  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadImageCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  // 建行即写入拼装好的 prompt：任务失败后用户可直接用卡片「重新生图」重试
  const name = String(req.body.name || '').trim().slice(0, 128) || await defaultAssetName(project.id);
  const asset = await Asset.create({
    project_id: project.id,
    kind: 'character',
    name,
    description: summarizeAppearance({ gender, picks }, freeText),
    prompt,
    status: 'queued',
    meta: { customAppearance: { selections: req.body.selections || {}, freeText } },
  });

  const job = await createJob(req.user.id, {
    type: 'asset_image', projectId: project.id, refId: asset.id,
    meta: { feature: 'asset_image', label: '自定义角色生图', projectName: project.name, targetName: asset.name, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'asset_image', jobId: job.id, refId: asset.id, remark: `自定义角色生图:${asset.name}` },
      async () => {
        await asset.update({ status: 'generating' });
        try {
          await ctx.reportProgress(30, '生成角色设定图…');
          const url = await generateImage(req.user.id, prompt, {
            ratio: project.aspect_ratio, modelConfigId,
            logCtx: { jobId: job.id, projectId: project.id, feature: 'char_custom', target: asset.name },
          });
          await asset.update({ image_url: url, status: 'done' });
          return { _actualCredits: est };
        } catch (e) {
          await asset.update({ status: 'failed' });
          throw e;
        }
      });
    await asset.reload();
    return { asset, credits_used: spent, balance };
  });
  return ok(res, { job, asset }, 'charOption.create_queued');
}));

// ============ Admin：选项示例图管理 ============

// 注册表 + 统计（admin 管理页）
router.get('/admin/character-options', adminAuthRequired, asyncHandler(async (req, res) => {
  return ok(res, { groups: listCharacterOptionGroups(), stats: getCharacterOptionStats() });
}));

// 单张生成估算
router.get('/admin/character-options/generate-image/estimate', adminAuthRequired, asyncHandler(async (req, res) => {
  const cfg = await loadImageCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateImageCost(cfg);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

/** 生成一个选项的示例图并落盘（4K 原图 + 854x480 缩略图）；单个与批量共用 */
async function generateOptionPreviewFile(userId, groupKey, option, modelConfigId) {
  const url = await generateImage(userId, buildOptionPreviewPrompt(groupKey, option), {
    modelConfigId, ratio: '16:9',
    logCtx: { feature: 'char_option_preview', target: `${groupKey}.${option.key}` },
  });
  const src = urlToPath(url);
  if (!src || !fs.existsSync(src)) throw new Error('生成图落盘失败');
  const { dir, largePath, thumbPath } = optionImagePaths(groupKey, option.key);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, largePath);
  // 缩略图 854×480 WebP（q80 人像约 50KB，比 PNG 小一个数量级），卡片列表页用
  await sharp(src).resize(854, 480, { fit: 'cover', position: 'centre' }).webp({ quality: 80 }).toFile(thumbPath);
  // 源图已拷贝进选项目录，删除 uploads 生成产物避免孤儿堆积
  deleteUrlFiles([url]);
}

// 单个选项示例图（重新）生成（异步任务）
router.post('/admin/character-options/:group/:key/generate-image', adminAuthRequired, asyncHandler(async (req, res) => {
  const group = findGroup(req.params.group);
  const option = group && findOption(req.params.group, req.params.key);
  if (!group || !option) throw badRequest('charOption.option_not_found');

  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadImageCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'char_option_image',
    meta: { feature: 'char_option_image', label: '角色选项示例图', targetName: option.zh, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est, { feature: 'char_option_image', jobId: job.id, remark: `角色选项示例图:${group.key}/${option.key}` },
      async () => {
        await ctx.reportProgress(30, `生成「${option.zh}」示例图…`);
        await generateOptionPreviewFile(req.user.id, group.key, option, modelConfigId);
        return { _actualCredits: est };
      });
    return { group: group.key, key: option.key, stats: getCharacterOptionStats(), credits_used: spent, balance };
  });
  return ok(res, { job }, 'charOption.image_queued');
}));

// 批量生成缺失示例图：估算（N=缺失数；总价 = N × 单张名义积分）
router.get('/admin/character-options/generate-missing/estimate', adminAuthRequired, asyncHandler(async (req, res) => {
  const missing = scanMissingOptions();
  if (!missing.length) throw badRequest('charOption.nothing_missing');
  const cfg = await loadImageCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const per = await estimateImageCost(cfg);
  const credits = per.credits * missing.length;
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, count: missing.length, source: per.source, pricing: per.pricing, ...tierPricing });
}));

// 批量生成缺失示例图（异步任务；每张独立计费，单张失败不中断批量）
router.post('/admin/character-options/generate-missing', adminAuthRequired, asyncHandler(async (req, res) => {
  const missing = scanMissingOptions();
  if (!missing.length) throw badRequest('charOption.nothing_missing');

  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadImageCfg(req.user.id, modelConfigId);
  const { credits: perNominal } = await estimateImageCost(cfg);
  const perEst = applyModelPromo(cfg, perNominal);
  const est = perEst * missing.length;
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'char_option_image_batch',
    meta: { feature: 'char_option_image', label: '角色选项示例图批量生成', estimate: est },
  });
  submit(job.id, async (ctx) => {
    // workFn 内重扫缺失（幂等：跳过中途已由单张任务补齐的项）
    const items = scanMissingOptions();
    const total = items.length || 1;
    let done = 0;
    let failed = 0;
    let spentTotal = 0;
    for (const { group, option } of items) {
      try {
        await ctx.reportProgress(5 + Math.round((90 * done) / total), `生成「${option.zh}」（${done + 1}/${items.length}）…`);
        const { spent } = await withCredits(req.user.id, perEst, { feature: 'char_option_image', jobId: job.id, remark: `角色选项示例图:${group.key}/${option.key}` },
          async () => {
            await generateOptionPreviewFile(req.user.id, group.key, option, modelConfigId);
            return { _actualCredits: perEst };
          });
        spentTotal += spent;
        done += 1;
      } catch (e) {
        failed += 1; // withCredits 已退还该张预扣，继续下一项
        logger.warn(`[CHAR_OPTION] ${group.key}/${option.key} 示例图生成失败: ${e.message}`);
      }
    }
    return { credits_used: spentTotal, done, failed, total: items.length, stats: getCharacterOptionStats(), balance: await getCurrentBalance(req.user.id) };
  });
  return ok(res, { job }, 'charOption.image_queued');
}));

export default router;
