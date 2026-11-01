import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { pinyin } from "pinyin-pro";
import { ok, badRequest } from "../utils/index.js";
import { asyncHandler } from "../utils/index.js";
import { authRequired, authOptional, adminAuthRequired } from "../middleware/auth.js";
import { urlToPath, deleteUrlFiles } from "../utils/fileUtil.js";
import db from "../db/index.js";
import {
  listArtStyles,
  resolveStyleKey,
  listNarrativeTypes,
  resolveNarrativeKey,
  DEFAULT_STYLE_KEY,
  PROMPT_FILES,
  getStyleCategory,
  reloadArtStyles,
  invalidatePromptCache,
  loadRawPrompt,
} from "../services/artSkills.service.js";
import sharp from "sharp";
import { generateImage } from "../services/image.service.js";
import { resolveConfig, getConfig } from "../services/modelConfig.service.js";
import { estimateImageCost, assertBalance, attachTierPricing, applyModelPromo } from "../services/pricing.service.js";
import { withCredits } from "../services/credits.service.js";
import { createJob, submit } from "../services/job.service.js";

const router = Router();
const { ArtStyle } = db;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SKILLS_ROOT = () => path.resolve(process.cwd(), "skills");
const ART_ROOT = () => path.join(SKILLS_ROOT(), "art_skills");
const VALID_CATEGORIES = ["realistic", "anime"];

// ============ 用户端只读（保持原样） ============

// 风格列表（风格类型 / 名称 / 缩略图 / 关联提示词文件名）。
// authOptional：展示中心（免登录）筛选项依赖此接口
router.get(
  "/art-styles",
  authOptional,
  asyncHandler(async (req, res) => {
    return ok(res, listArtStyles());
  })
);

// 校验/归一化某个风格值 → 返回合法 key（兼容旧值，未命中回退默认）
router.get(
  "/art-styles/resolve",
  authRequired,
  asyncHandler(async (req, res) => {
    const key = resolveStyleKey(req.query.style);
    return ok(res, { key });
  })
);

// 叙事类型列表（类型 key / 名称）。authOptional：展示中心（免登录）筛选项依赖此接口
router.get(
  "/narrative-types",
  authOptional,
  asyncHandler(async (req, res) => {
    return ok(res, listNarrativeTypes());
  })
);

// 校验/归一化某个叙事类型值 → 返回合法 key（兼容旧值，未命中回退默认）
router.get(
  "/narrative-types/resolve",
  authRequired,
  asyncHandler(async (req, res) => {
    const key = resolveNarrativeKey(req.query.narrative_type);
    return ok(res, { key });
  })
);

// ============ Admin 管理（adminAuthRequired，仅 admt_ 管理令牌） ============

/** 由风格名生成 key：中文→拼音、小写、非字母数字→_、折叠、按大类加前缀 */
function deriveKeyFromName(name, category) {
  const py = pinyin(String(name || ""), { toneType: "none", type: "array" }).join("");
  let slug = py
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = "style";
  const prefix = category === "realistic" ? "realpeople_" : "2D_";
  if (!slug.startsWith(prefix.replace(/_$/, ""))) slug = `${prefix}${slug}`;
  return slug;
}

/** 取当前用户图像模型配置（指定 id > 默认图像模型 > null） */
async function loadImageCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, "image");
  } catch {
    return null;
  }
}

/** 构造风格示例图提示词：风格名 + prefix.md 头部 + 代表性画面描述 */
function buildStyleImagePrompt(styleKey, styleName) {
  const prefixBody = loadRawPrompt(styleKey, "prefix") || "";
  const head = prefixBody.slice(0, 600);
  const sys = head ? `${head}\n\n` : "";

  const PREVIEW_COMPOSITION_PROMPT = [
    "画面为单幅风格展示图：整体为符合该风格的场景背景（环境/空间/氛围与风格世界观一致），画面中至少加入一位"+(Math.random() < 0.5 ? '男' : '女')+"性人物（半身构图，腰部以上），人物与背景自然融合、光影统一。",
    "人物面容清晰、气质鲜明，构图重心稳定，画面具备该风格最具辨识度的质感与色彩特征。",
    "忽略任何多视图/三视图/设定图排版要求，仅生成这一幅半身构图。图像比例：16:9。",
    "主题背景+人物即可，画面中不要出现多余的文字、logo、边框、UI元素。",
  ].join("\n");

  return {
    system: sys,
    prompt: `请根据风格名 "${styleName}" 生成一幅符合该风格的示例图。\n${PREVIEW_COMPOSITION_PROMPT}`,
  };
}

/**
 * 起 art_style_image Job：调图像模型生成 4K 示例图，落盘 images/1.webp + preview.webp，
 * 完成后 image_version+1 并 reloadArtStyles。供「重新生成示例图」复用。
 * @param user req.user 实例（assertBalance 需 .reload()）
 */
async function startStyleImageJob(user, styleRow, modelConfigId, label) {
  const userId = user.id;
  const cfg = modelConfigId ? await getConfig(userId, modelConfigId) : await resolveConfig(userId, "image");
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(user, est);

  const { system, prompt } = buildStyleImagePrompt(styleRow.key, styleRow.name);
  const job = await createJob(userId, {
    type: "art_style_image",
    meta: { feature: "art_style_image", label: label || "风格示例图", targetName: styleRow.name, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(
      userId,
      est,
      { feature: "art_style_image", jobId: job.id, remark: `风格示例图:${styleRow.key}` },
      async () => {
        await ctx.reportProgress(30, "调用大模型生成 4K 示例图…");
        const url = await generateImage(userId, prompt, {
          modelConfigId, ratio: '16:9', system,
          logCtx: { jobId: job.id, feature: 'art_style_image', target: styleRow.key },
        });
        const src = urlToPath(url);
        if (!src || !fs.existsSync(src)) throw new Error("生成图落盘失败");
        const imgDir = path.join(ART_ROOT(), styleRow.key, "images");
        fs.mkdirSync(imgDir, { recursive: true });
        // 大图 4K 转 WebP 落盘（比 PNG 小一个数量级，admin 大图预览秒开）
        await sharp(src).webp({ quality: 85 }).toFile(path.join(imgDir, "1.webp"));
        // preview.webp 缩为 480p 16:9 缩略图，节省列表页流量
        await sharp(src).resize(854, 480, { fit: "cover", position: "centre" }).webp({ quality: 80 }).toFile(path.join(imgDir, "preview.webp"));
        // 源图已转码进风格目录（1.webp/preview.webp），uploads 里的生成产物删除避免堆积孤儿
        deleteUrlFiles([url]);
        await styleRow.update({ image_version: (styleRow.image_version || 1) + 1 });
        await reloadArtStyles();
        return { _actualCredits: est };
      }
    );
    return { styleKey: styleRow.key, credits_used: spent, balance };
  });
  return job;
}

// Admin 列表（含 disabled / sort_order / image_version）
router.get(
  "/admin/art-styles",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const rows = await ArtStyle.findAll({
      order: [
        ["sort_order", "ASC"],
        ["id", "ASC"],
      ],
    });
    return ok(res, rows);
  })
);

// 新建风格
router.post(
  "/admin/art-styles",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const { name, category, key: keyIn, clone_from } = req.body || {};
    if (!name || !String(name).trim()) throw badRequest("artstyle.name_required");
    const cat = VALID_CATEGORIES.includes(category) ? category : "anime";

    // 1) 确定 key（优先显式传入，否则由名称生成）；保证唯一
    let key = keyIn ? String(keyIn).trim() : deriveKeyFromName(name, cat);
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw badRequest("artstyle.key_invalid");
    let finalKey = key;
    let n = 2;
    while (await ArtStyle.findOne({ where: { key: finalKey } })) finalKey = `${key}_${n++}`;

    // 2) 建目录 + 脚手架 .md（从 clone_from 克隆，缺省 DEFAULT_STYLE_KEY；源缺失则写最小 stub）
    const destDir = path.join(ART_ROOT(), finalKey);
    if (fs.existsSync(destDir)) throw badRequest("artstyle.dir_exists");
    const srcKey = clone_from || DEFAULT_STYLE_KEY;
    const srcDir = path.join(ART_ROOT(), srcKey);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, destDir, { recursive: true });
      // 清掉克隆带过来的图片（新风格用 AI 生成自己的示例图）
      const clonedImg = path.join(destDir, "images");
      if (fs.existsSync(clonedImg)) fs.rmSync(clonedImg, { recursive: true, force: true });
      fs.mkdirSync(path.join(destDir, "images"), { recursive: true });
    } else {
      scaffoldMinimalStyle(destDir, name);
    }

    // 3) 插行（示例图生成走独立的 /:id/generate-image，经「模型+价格」确认页，遵循生成确认约定）
    const maxOrder = (await ArtStyle.max("sort_order")) || 0;
    const row = await ArtStyle.create({
      key: finalKey,
      name: String(name).trim(),
      category: cat,
      thumbnail: `art_skills/${finalKey}/images/preview.webp`,
      sort_order: maxOrder + 1,
      enabled: true,
      image_version: 1,
    });
    await reloadArtStyles();

    return ok(res, { style: row }, "artstyle.created");
  })
);

// 修改风格（name / category / enabled / sort_order；key 不可改）
router.put(
  "/admin/art-styles/:id",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const row = await ArtStyle.findByPk(req.params.id);
    if (!row) throw badRequest("common.not_found");
    const { name, category, enabled, sort_order } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).trim() || row.name;
    if (category !== undefined && VALID_CATEGORIES.includes(category)) patch.category = category;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (sort_order !== undefined) patch.sort_order = Number(sort_order) || 0;
    await row.update(patch);
    await reloadArtStyles();
    return ok(res, row, "artstyle.updated");
  })
);

// 删除风格（拒绝删默认风格）
router.delete(
  "/admin/art-styles/:id",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const row = await ArtStyle.findByPk(req.params.id);
    if (!row) throw badRequest("common.not_found");
    if (row.key === DEFAULT_STYLE_KEY) throw badRequest("artstyle.cannot_delete_default");
    await row.destroy();
    const dir = path.join(ART_ROOT(), row.key);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    await reloadArtStyles();
    return ok(res, null, "artstyle.deleted");
  })
);

// 调整顺序：body { ids: [id,...] } 按序重排 sort_order
router.post(
  "/admin/art-styles/reorder",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) throw badRequest("artstyle.no_ids");
    for (let i = 0; i < ids.length; i++) {
      await ArtStyle.update({ sort_order: i }, { where: { id: ids[i] } });
    }
    await reloadArtStyles();
    return ok(res, null, "artstyle.reordered");
  })
);

// 读取某提示词原始正文（含 frontmatter）
router.get(
  "/admin/art-styles/:id/prompts/:logical",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const row = await ArtStyle.findByPk(req.params.id);
    if (!row) throw badRequest("common.not_found");
    const rel = PROMPT_FILES[req.params.logical];
    if (!rel) throw badRequest("artstyle.prompt_not_found");
    const abs = path.join(ART_ROOT(), row.key, rel);
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      /* 文件缺失返回空串 */
    }
    return ok(res, { logical: req.params.logical, file: rel, content });
  })
);

// 保存某提示词正文（写回磁盘 + 清缓存）
router.put(
  "/admin/art-styles/:id/prompts/:logical",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const row = await ArtStyle.findByPk(req.params.id);
    if (!row) throw badRequest("common.not_found");
    const rel = PROMPT_FILES[req.params.logical];
    if (!rel) throw badRequest("artstyle.prompt_not_found");
    const abs = path.join(ART_ROOT(), row.key, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(req.body?.content ?? ""), "utf8");
    invalidatePromptCache(row.key);
    return ok(res, null, "artstyle.prompt_saved");
  })
);

// 上传替换图片（?type=preview|large）
router.post(
  "/admin/art-styles/:id/images",
  adminAuthRequired,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const row = await ArtStyle.findByPk(req.params.id);
    if (!row) throw badRequest("common.not_found");
    if (!req.file) throw badRequest("artstyle.no_file");
    const type = req.query.type === "large" ? "1.webp" : "preview.webp";
    const imgDir = path.join(ART_ROOT(), row.key, "images");
    fs.mkdirSync(imgDir, { recursive: true });
    // 上传源多为 PNG/JPEG，落盘统一转码 WebP（缩略图归一 854×480），保证扩展名与字节一致
    const pipeline = req.query.type === "large"
      ? sharp(req.file.buffer).webp({ quality: 85 })
      : sharp(req.file.buffer).resize(854, 480, { fit: "cover", position: "centre" }).webp({ quality: 80 });
    await pipeline.toFile(path.join(imgDir, type));
    await row.update({ image_version: (row.image_version || 1) + 1 });
    await reloadArtStyles();
    return ok(res, { image_version: row.image_version }, "artstyle.image_uploaded");
  })
);

// 估算生成示例图消耗
router.get(
  "/admin/art-styles/generate-image/estimate",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const cfg = await loadImageCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
    const img = await estimateImageCost(cfg);
    const tierPricing = await attachTierPricing(req.user, img.credits, cfg);
    return ok(res, { credits: img.credits, pricing: img.pricing, source: img.source, ...tierPricing });
  })
);

// 重新生成示例图（独立于新建）
router.post(
  "/admin/art-styles/:id/generate-image",
  adminAuthRequired,
  asyncHandler(async (req, res) => {
    const row = await ArtStyle.findByPk(req.params.id);
    if (!row) throw badRequest("common.not_found");
    const modelConfigId = req.body?.modelConfigId || null;
    const job = await startStyleImageJob(req.user, row, modelConfigId, "风格示例图重新生成");
    return ok(res, { job }, "artstyle.image_queued");
  })
);

/** 源目录缺失时写最小 .md stub（README + prefix + 8 个 prompt 文件），admin 之后在线编辑 */
function scaffoldMinimalStyle(destDir, name) {
  fs.mkdirSync(path.join(destDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "art_prompt"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "driector_skills"), { recursive: true });
  const stub = (title) => `# ${title}\n\n待补充。\n`;
  fs.writeFileSync(path.join(destDir, "README.md"), stub(name), "utf8");
  fs.writeFileSync(path.join(destDir, "prefix.md"), stub(`${name} · 全局美学基础`), "utf8");
  for (const [logical, rel] of Object.entries(PROMPT_FILES)) {
    const abs = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, stub(`${name} · ${logical}`), "utf8");
  }
}

export default router;
