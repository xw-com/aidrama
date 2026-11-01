import db from "../db/index.js";
import { notFound, forbidden } from "./response.js";
import { resolveProjectAccess } from "./access.js";

const { Project, Episode, Asset, StoryboardSegment } = db;

// 团队项目共享改造：四个 loadOwned* 加第三参 perm（可省略）。
// - perm 省略 = 只要有访问权（owner 或任意成员，即读操作）
// - perm 传入 = 写操作，owner 恒放行，成员需在 permissions 里持有该权限组
// 另提供 loadOwnerProject：严格 owner（删除项目 / 一键分享 / 成员管理）

// withRawScript：默认不下发 raw_script 大字段（列表/详情瘦身）；剧本拆分等需读全文的场景显式开启
export async function loadOwnedProject(userId, projectId, perm = null, { withRawScript = false } = {}) {
  const project = await Project.findByPk(projectId, withRawScript ? undefined : { attributes: { exclude: ["raw_script"] } });
  if (!project) throw notFound("项目不存在");
  const access = await resolveProjectAccess(userId, project);
  if (!access) throw forbidden("无权访问该项目");
  if (perm && access.role !== "owner" && !access.permissions.includes(perm)) throw forbidden("member.no_permission");
  return project;
}

// 严格 owner：不做成员放行（不可委托的高危操作）
export async function loadOwnerProject(userId, projectId) {
  const project = await Project.findByPk(projectId, { attributes: { exclude: ["raw_script"] } });
  if (!project) throw notFound("项目不存在");
  if (project.user_id !== userId) throw forbidden("member.owner_required");
  return project;
}

//raw_script
export async function loadOwnedEpisode(userId, episodeId, perm = null) {
  const episode = await Episode.findByPk(episodeId);
  if (!episode) throw notFound("分集不存在");
  const project = await Project.findByPk(episode.project_id, { attributes: { exclude: ["raw_script"] } });
  if (!project) throw forbidden("无权访问该分集");
  const access = await resolveProjectAccess(userId, project);
  if (!access) throw forbidden("无权访问该分集");
  if (perm && access.role !== "owner" && !access.permissions.includes(perm)) throw forbidden("member.no_permission");
  return { episode, project };
}

export async function loadOwnedSegment(userId, segmentId, perm = null) {
  const segment = await StoryboardSegment.findByPk(segmentId);
  if (!segment) throw notFound("片段不存在");
  const episode = await Episode.findByPk(segment.episode_id);
  if (!episode) throw notFound("分集不存在");
  const project = await Project.findByPk(episode.project_id, { attributes: { exclude: ["raw_script"] } });
  if (!project) throw forbidden("无权访问该片段");
  const access = await resolveProjectAccess(userId, project);
  if (!access) throw forbidden("无权访问该片段");
  if (perm && access.role !== "owner" && !access.permissions.includes(perm)) throw forbidden("member.no_permission");
  return { segment, episode, project };
}

export async function loadOwnedAsset(userId, assetId, perm = null) {
  const asset = await Asset.findByPk(assetId);
  if (!asset) throw notFound("资产不存在");
  const project = await Project.findByPk(asset.project_id, { attributes: { exclude: ["raw_script"] } });
  if (!project) throw forbidden("无权访问该资产");
  const access = await resolveProjectAccess(userId, project);
  if (!access) throw forbidden("无权访问该资产");
  if (perm && access.role !== "owner" && !access.permissions.includes(perm)) throw forbidden("member.no_permission");
  return { asset, project };
}
