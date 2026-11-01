import { Router } from "express";
import multer from "multer";
import fs from "fs";
import crypto from "crypto";
import db, { charLenSql } from "../db/index.js";
import { asyncHandler, ok, badRequest, notFound, forbidden } from "../utils/index.js";
import { authRequired } from "../middleware/auth.js";
import { loadOwnedProject, loadOwnerProject } from "../utils/ownership.js";
import { resolveProjectAccess, PERM_KEYS } from "../utils/access.js";
import { genFilePath, toUrl, deleteUrlFiles } from "../utils/fileUtil.js";
import { deleteEpisodeArtifacts } from "../services/job.service.js";
import { normalizeSubtitleStyle } from "../services/subtitle.service.js";
import { makeThumbUrl } from "../services/thumbnail.service.js";
import { selectCoverMaterials, listCoverCandidates, startCoverJob } from "../services/cover.service.js";
import { getConfig, resolveConfig } from "../services/modelConfig.service.js";
import { estimateImageCost, attachTierPricing, applyModelPromo } from "../services/pricing.service.js";
import { config } from "../config/index.js";

const router = Router();
const { Project } = db;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 分集卡片级聚合（项目全量、与页码无关，一次 GROUP BY 一查避免逐项 N+1）：
// 资产数（总数/按类型/按分集归属）、每集累计积分（实结-退款）、每集状态分布（引导横幅判「一集都未进分镜」）。
// 项目详情与分集分页列表两个路由共用
async function episodeAggregates(projectId) {
  // 资产计数（总数 + 按类型）：工作台首页/分集列表只需要个数，
  // 不必再拉全量资产列表（含 prompt/description/meta 大字段）
  const assetKindRows = await db.Asset.findAll({
    where: { project_id: projectId },
    attributes: ["kind", [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "cnt"]],
    group: ["kind"],
    raw: true,
  });
  const asset_counts = {};
  let asset_count = 0;
  for (const row of assetKindRows) {
    asset_counts[row.kind] = Number(row.cnt);
    asset_count += Number(row.cnt);
  }
  // 分集卡片要展示每集的角色/场景数（episode_id 归属；未归属单集的资产不计数）
  const assetEpRows = await db.Asset.findAll({
    where: { project_id: projectId, episode_id: { [db.Sequelize.Op.ne]: null } },
    attributes: ["episode_id", "kind", [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "cnt"]],
    group: ["episode_id", "kind"],
    raw: true,
  });
  const asset_counts_by_episode = {};
  for (const row of assetEpRows) {
    const m = asset_counts_by_episode[row.episode_id] || (asset_counts_by_episode[row.episode_id] = {});
    m[row.kind] = Number(row.cnt);
  }
  // 分集卡片要展示每集累计成本（积分）：按任务实结积分聚合，扣除已退款部分（meta.refunded_credits；
  // JSON_EXTRACT 在 MySQL/SQLite(≥3.38) 通用，meta 为 NULL 时取 0）
  const costEpRows = await db.Job.findAll({
    where: { project_id: projectId },
    attributes: [
      "episode_id",
      [db.Sequelize.literal("SUM(credits_used - COALESCE(JSON_EXTRACT(meta, '$.refunded_credits'), 0))"), "spent"],
    ],
    group: ["episode_id"],
    raw: true,
  });
  const credits_by_episode = {};
  for (const row of costEpRows) {
    if (row.episode_id == null) continue; // 未归属单集的任务不计入任何分集
    credits_by_episode[row.episode_id] = Math.round(Number(row.spent || 0) * 10) / 10; // 一位小数，同积分口径
  }
  // 状态分布：客户端据此判「还没有任何一集进入分镜」等整剧级提示（分页后客户端只见当页）
  const statusRows = await db.Episode.findAll({
    where: { project_id: projectId },
    attributes: ["status", [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "cnt"]],
    group: ["status"],
    raw: true,
  });
  const status_counts = {};
  for (const row of statusRows) status_counts[row.status] = Number(row.cnt);
  return { asset_count, asset_counts, asset_counts_by_episode, credits_by_episode, status_counts };
}

// 列表（团队共享：我创建的 ∪ 我加入的，成员项目附 owner 信息与我的权限）
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const owned = await Project.findAll({
      where: { user_id: req.user.id },
      attributes: { exclude: ["raw_script"] },
    });
    const memberships = await db.ProjectMember.findAll({
      where: { user_id: req.user.id },
      attributes: ["project_id", "permissions"],
    });
    const memberIds = memberships.map((m) => m.project_id);
    const joined = memberIds.length
      ? await Project.findAll({
          where: { id: { [db.Sequelize.Op.in]: memberIds } },
          attributes: { exclude: ["raw_script"] },
        })
      : [];
    const permOf = new Map(memberships.map((m) => [m.project_id, m.permissions]));

    // 成员项目的 owner 展示名（批量一次查，避免逐项 N+1）
    const ownerIds = [...new Set(joined.map((p) => p.user_id))];
    const owners = ownerIds.length
      ? await db.User.findAll({ where: { id: { [db.Sequelize.Op.in]: ownerIds } }, attributes: ["id", "nickname", "email", "phone", "username"] })
      : [];
    const ownerName = (u) => u?.nickname || u?.email || u?.phone || u?.username || "";

    const rows = [
      ...owned.map((p) => ({ p, my_role: "owner", my_permissions: PERM_KEYS })),
      ...joined.map((p) => ({ p, my_role: "member", my_permissions: permOf.get(p.id) || [] })),
    ].sort((a, b) => new Date(b.p.updated_at) - new Date(a.p.updated_at));

    // 附带分集统计（一次聚合查询，避免逐项 N+1 count）
    const allIds = rows.map((r) => r.p.id);
    const counts = allIds.length
      ? await db.Episode.findAll({
          where: { project_id: { [db.Sequelize.Op.in]: allIds } },
          attributes: ["project_id", [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "cnt"]],
          group: ["project_id"],
          raw: true,
        })
      : [];
    const countOf = new Map(counts.map((c) => [c.project_id, Number(c.cnt)]));

    const out = [];
    for (const { p, my_role, my_permissions } of rows) {
      const episodes = countOf.get(p.id) || 0;
      const owner = owners.find((u) => u.id === p.user_id);
      out.push({
        ...p.toJSON(),
        episode_count: episodes,
        my_role,
        my_permissions,
        // 共享给我的项目：标记 + 创建者展示名
        ...(my_role === "member" && { shared: true, owner_name: ownerName(owner) }),
      });
    }
    return ok(res, out);
  })
);

// 详情
// 不返回 MEDIUMTEXT 大字段（raw_script / episode.content / summary / director_requirements）全文，
// 仅以轻量计算字段替代：project.has_script（是否已导入剧本）、episode.content_length（分集正文字数）。
// 客户端需要某集完整大文本时，按分集单条查询 GET /episodes/:eid 拉取，省网络、提体验。
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await Project.findByPk(req.params.id, {
      attributes: {
        exclude: ["raw_script"],
        include: [[db.Sequelize.literal(`(raw_script IS NOT NULL AND ${charLenSql("TRIM(raw_script)")} > 0)`), "has_script"]],
      },
    });
    if (!project) throw notFound("项目不存在");
    const access = await resolveProjectAccess(req.user.id, project);
    if (!access) throw forbidden("无权访问该项目");
    const episodes = await db.Episode.findAll({
      where: { project_id: project.id },
      order: [["idx", "ASC"]],
      attributes: {
        exclude: ["content", "summary", "director_requirements"],
        include: [[db.Sequelize.literal(charLenSql("content")), "content_length"]],
      },
    });
    const aggregates = await episodeAggregates(project.id);
    return ok(res, { ...project.toJSON(), episodes, ...aggregates, my_role: access.role, my_permissions: access.permissions });
  })
);

// 分集列表（后端分页）：分集视频页每页只拉一页（默认 15 条，?page/?size 调节），不再整包下发全部分集。
// ?find=<episodeId> 直接返回该集所在页（任务页深链「查看结果」/分集跳转定位；集不存在或他项目时回落第一页）。
// ?size= 拉全量（批量下载、发布展示中心勾选等整包场景，上限 1000）。
// 行口径同详情接口：不下发 content/summary/director_requirements 大字段，仅附 content_length。
// 附全项目级聚合与轻量 project 信息（uniapp 独立页不再额外拉项目详情即可供权限/画幅使用）。
router.get(
  "/:id/episodes",
  authRequired,
  asyncHandler(async (req, res) => {
    // 轻量 project 附 has_script（口径同详情接口）：剧本大纲页只走本接口，不再整包拉项目详情
    const project = await Project.findByPk(req.params.id, {
      attributes: [
        "id", "user_id", "name", "aspect_ratio",
        [db.Sequelize.literal(`(raw_script IS NOT NULL AND ${charLenSql("TRIM(raw_script)")} > 0)`), "has_script"],
      ],
    });
    if (!project) throw notFound("项目不存在");
    const access = await resolveProjectAccess(req.user.id, project);
    if (!access) throw forbidden("无权访问该项目");

    const size = Math.min(Math.max(Number(req.query.size) || 15, 1), 1000);
    let page = Math.max(Number(req.query.page) || 1, 1);
    if (req.query.find) {
      // idx 建集/删集时服务端保持连续（1..N），且列表按 idx 升序分页 → 页码 = ceil(idx/size)
      const found = await db.Episode.findOne({
        where: { id: Number(req.query.find), project_id: project.id },
        attributes: ["idx"],
      });
      if (found) page = Math.ceil(found.idx / size);
    }

    // count/findAll 分开查：findAndCountAll 的 count 子查询会带上 attributes.include 的字面量列，各库方言下易碎
    const where = { project_id: project.id };
    const total = await db.Episode.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / size));
    page = Math.min(page, totalPages); // 越界页（删集后页数收缩/深链旧页码）收敛到最后一页
    const rows = await db.Episode.findAll({
      where,
      order: [["idx", "ASC"]],
      offset: (page - 1) * size,
      limit: size,
      attributes: {
        exclude: ["content", "summary", "director_requirements"],
        include: [[db.Sequelize.literal(charLenSql("content")), "content_length"]],
      },
    });
    const aggregates = await episodeAggregates(project.id);
    return ok(res, {
      rows,
      total,
      page,
      size,
      total_pages: totalPages,
      ...aggregates,
      project: { id: project.id, name: project.name, aspect_ratio: project.aspect_ratio, has_script: !!project.get("has_script") },
      my_role: access.role,
      my_permissions: access.permissions,
    });
  })
);

// 创建
router.post(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, style, narrative_type, aspect_ratio, raw_script, cover, producer, copyright } = req.body;
    if (!name) throw badRequest("project.name_required");
    const project = await Project.create({
      user_id: req.user.id,
      name,
      style: style || "古偶唯美柔光",
      ...(narrative_type !== undefined && { narrative_type }),
      aspect_ratio: aspect_ratio || "9:16",
      raw_script: raw_script || "",
      ...(cover !== undefined && { cover }),
      ...(producer !== undefined && { producer }),
      ...(copyright !== undefined && { copyright }),
    });
    return ok(res, project, "project.created");
  })
);

// 更新
router.put(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnedProject(req.user.id, req.params.id, "project.settings");
    const { name, style, narrative_type, aspect_ratio, raw_script, status, cover, producer, copyright, settings } = req.body;

    // settings 白名单：只认 { subtitle }（项目字幕烧录样式），其余键一律拒绝；subtitle 归一化（null=恢复默认）
    let subtitle = undefined; // undefined=本次不更新 settings
    if (settings !== undefined) {
      if (settings === null || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).some((k) => k !== "subtitle"))
        throw badRequest("project.settings_invalid");
      try {
        subtitle = normalizeSubtitleStyle(settings.subtitle);
      } catch {
        throw badRequest("project.settings_invalid");
      }
    }

    const updates = {
      ...(name !== undefined && { name }),
      ...(style !== undefined && { style }),
      ...(narrative_type !== undefined && { narrative_type }),
      ...(aspect_ratio !== undefined && { aspect_ratio }),
      ...(raw_script !== undefined && { raw_script }),
      ...(status !== undefined && { status }),
      ...(cover !== undefined && { cover }),
      ...(producer !== undefined && { producer }),
      ...(copyright !== undefined && { copyright }),
    };
    // 换图写点同步重算缩略图：cover 变化（含清空）时 cover_thumb 一并刷新，否则列表卡片永久 stale
    if (cover !== undefined && cover !== (project.cover || "")) {
      const coverThumb = cover ? await makeThumbUrl(cover) : "";
      updates.cover_thumb = coverThumb || "";
    }
    if (subtitle !== undefined) {
      // JSON 列整值替换：基于旧值浅合并出新对象再赋值（原地改嵌套不会标脏）；null=删除子树恢复默认
      const next = { ...(project.settings || {}) };
      if (subtitle === null) delete next.subtitle;
      else next.subtitle = subtitle;
      updates.settings = next;
    }
    await project.update(updates);
    return ok(res, project, "project.updated");
  })
);

// 一键分享：确保项目有未过期的 share_token（幂等；已过期则换发新令牌，旧令牌随之作废）
// 链接有效期 Project.SHARE_TTL_MS = 24 小时，公开播放页按同一常量校验
// 门禁：没有任何成片（video_url 非空）的分集不可分享；合成版已删但仍有剪辑版成片任务时同样可分享（与生成版同权）
router.post(
  "/:id/share",
  authRequired,
  asyncHandler(async (req, res) => {
    // 一键分享是对外曝光开关，仅 owner 可操作
    const project = await loadOwnerProject(req.user.id, req.params.id);
    let playable = await db.Episode.count({
      where: {
        project_id: project.id,
        [db.Sequelize.Op.and]: [{ video_url: { [db.Sequelize.Op.ne]: null } }, { video_url: { [db.Sequelize.Op.ne]: "" } }],
      },
    });
    if (!playable) {
      // 兜底与分享播放页同口径：分集当前成片被删（video_url 已清空）但仍有可播的合成/剪辑成片记录
      // （episode_videos 成片落档，与 jobs 表解耦）
      playable = (await db.EpisodeVideo.count({
        where: {
          project_id: project.id,
          episode_id: { [db.Sequelize.Op.ne]: null },
          hidden: false,
          kind: { [db.Sequelize.Op.in]: ['compose', 'edit'] },
        },
      }))
        ? 1
        : 0;
    }
    if (!playable) throw badRequest("share.no_episodes");

    const issuedAt = project.share_issued_at ? new Date(project.share_issued_at) : null;
    const valid = project.share_token && issuedAt && issuedAt.getTime() + Project.SHARE_TTL_MS > Date.now();
    let token = project.share_token;
    let effectiveIssued = issuedAt;
    if (!valid) {
      // 首次分享或已过期：换发新令牌（旧令牌随之作废，被收藏的旧链接一律 410），有效期从现在起算
      // base64url(16B)=22 字符，URL 安全；findOne 预检 + 捕获唯一约束冲突重试（旧库无唯一索引，正确性不押在 DB 约束上）
      token = "";
      for (let i = 0; i < 5 && !token; i++) {
        const candidate = crypto.randomBytes(16).toString("base64url");
        const exists = await Project.findOne({ where: { share_token: candidate }, attributes: ["id"] });
        if (exists) continue;
        try {
          token = candidate;
          await project.update({ share_token: token });
        } catch (e) {
          if (e?.name !== "SequelizeUniqueConstraintError") throw e; // 撞库 → 换 token 重试
          token = "";
        }
      }
      effectiveIssued = new Date();
      await project.update({ share_issued_at: effectiveIssued });
    }
    return ok(
      res,
      {
        token,
        expires_at: new Date(effectiveIssued.getTime() + Project.SHARE_TTL_MS),
      },
      "share.ready"
    );
  })
);

// 上传项目封面（覆盖时清掉旧封面文件）
router.post(
  "/:id/cover",
  authRequired,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const project = await loadOwnedProject(req.user.id, req.params.id, "project.settings");
    if (!req.file) throw badRequest("project.cover_file_missing");
    const { absPath } = genFilePath(config.uploadDir, "png", "cover");
    const oldCover = project.cover;
    const oldCoverThumb = project.cover_thumb;
    fs.writeFileSync(absPath, req.file.buffer);
    // 即时生成卡片缩略图（用户上传封面不压缩，原图可能数 MB；AI 封面本身 720×1080 也一并归一）
    const coverThumb = await makeThumbUrl(toUrl(absPath));
    await project.update({ cover: toUrl(absPath), ...(coverThumb && { cover_thumb: coverThumb }) });
    deleteUrlFiles([oldCover, oldCoverThumb]);
    return ok(res, project, "project.cover_uploaded");
  })
);

// —— AI 生成封面（编辑项目弹窗入口；素材=用户挑选的角色/场景/道具（默认出镜最多的一个）+ 补充描述 + 前三集概要）——

// 素材预检：确认弹窗前调用，返回三类候选（有图资产，按出镜次数降序，首项即默认勾选）；
// 缺分镜/资产图片/剧本概要时直接提示失败
router.get(
  "/:id/cover/ai/materials",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnedProject(req.user.id, req.params.id, "project.settings");
    const candidates = await listCoverCandidates(project);
    return ok(res, candidates);
  })
);

// 估算生成封面消耗
router.get(
  "/:id/cover/ai/estimate",
  authRequired,
  asyncHandler(async (req, res) => {
    const cfg = req.query.modelConfigId
      ? await getConfig(req.user.id, Number(req.query.modelConfigId))
      : await resolveConfig(req.user.id, "image");
    const img = await estimateImageCost(cfg);
    const tierPricing = await attachTierPricing(req.user, img.credits, cfg);
    return ok(res, { credits: img.credits, pricing: img.pricing, source: img.source, ...tierPricing });
  })
);

// 生成封面（异步 Job；完成后写回 project.cover 并清旧封面文件）
// body 可带用户挑选素材：character_ids/scene_ids/prop_ids（各为资产 id 数组）+ description（一句补充描述，≤200 字）；
// 不带 ids 走默认（每类出镜最多的一个）
router.post(
  "/:id/cover/ai",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnedProject(req.user.id, req.params.id, "project.settings");
    const body = req.body || {};
    const readIds = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isFinite))] : null);
    const hasPicks = ["character_ids", "scene_ids", "prop_ids"].some((k) => Array.isArray(body[k]));
    const picks = hasPicks
      ? {
          characterIds: readIds(body.character_ids),
          sceneIds: readIds(body.scene_ids),
          propIds: readIds(body.prop_ids),
          description: String(body.description || "").trim().slice(0, 200),
        }
      : null;
    await selectCoverMaterials(project, picks); // 提交前校验素材齐备且所选有效（任务内会重新校验）
    const job = await startCoverJob(req.user, project, body.modelConfigId || null, picks);
    return ok(res, { job }, "project.cover_ai_queued");
  })
);

// 删除：先收集项目下全部媒体 URL 并删文件（封面、各集成片、各分镜视频/关键帧/尾帧、资产主图/参考图、服饰图），再删库
router.delete(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    // 删除项目级联清空全部数据，不可委托，仅 owner
    const project = await loadOwnerProject(req.user.id, req.params.id);
    const episodes = await db.Episode.findAll({ where: { project_id: project.id }, attributes: ["id", "video_url"] });
    const segments = await db.StoryboardSegment.findAll({
      where: { episode_id: { [db.Sequelize.Op.in]: episodes.map((e) => e.id) } },
      attributes: ["video_url", "keyframe_url", "last_frame_url"],
    });
    const assets = await db.Asset.findAll({ where: { project_id: project.id }, attributes: ["id", "image_url", "thumb_url", "meta"] });
    const costumes = await db.AssetImage.findAll({
      where: { asset_id: { [db.Sequelize.Op.in]: assets.map((a) => a.id) } },
      attributes: ["image_url"],
    });
    deleteUrlFiles([
      project.cover,
      ...episodes.map((e) => e.video_url),
      ...segments.flatMap((s) => [s.video_url, s.keyframe_url, s.last_frame_url]),
      ...assets.flatMap((a) => [a.image_url, a.thumb_url, `${a.image_url}.thumb.webp`, a.meta?.referenceImage, a.meta?.videoUrl]),
      ...costumes.flatMap((c) => [c.image_url, `${c.image_url}.thumb.webp`]),
    ]);
    await deleteEpisodeArtifacts(episodes.map((e) => e.id)); // 历史 Job 产物：多次合成成片 + 字幕版 mp4/srt/ass
    // 子表显式先删（不依赖 DB 外键级联——历史库/索引不全时级联可能缺失，会留孤儿行）：
    // 集-角色服饰配置(EpisodeAsset)、分镜、分集，再删资产服饰图(AssetImage)、资产
    await db.EpisodeAsset.destroy({ where: { episode_id: { [db.Sequelize.Op.in]: episodes.map((e) => e.id) } } });
    await db.StoryboardSegment.destroy({ where: { episode_id: { [db.Sequelize.Op.in]: episodes.map((e) => e.id) } } });
    await db.Episode.destroy({ where: { project_id: project.id } });
    await db.AssetImage.destroy({ where: { asset_id: { [db.Sequelize.Op.in]: assets.map((a) => a.id) } } });
    await db.Asset.destroy({ where: { project_id: project.id } });
    // 团队共享：一并清理成员关系与历史邀请，避免孤儿行
    await db.ProjectMember.destroy({ where: { project_id: project.id } });
    await db.ProjectInvitation.destroy({ where: { project_id: project.id } });
    await project.destroy();
    return ok(res, null, "project.deleted");
  })
);

export default router;
