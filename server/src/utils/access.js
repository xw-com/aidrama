// 团队项目共享：项目访问权限解析（owner ∪ member）
import db from '../db/index.js';

const { ProjectMember } = db;

// 六组可分配权限（由项目路由归类而来）；owner 隐式全有，不存库
export const PERM_KEYS = ['script.edit', 'asset.edit', 'storyboard.edit', 'ai.generate', 'video.manage', 'project.settings'];

// 权限数组合法性：数组且逐项 ∈ PERM_KEYS
export function isValidPermissions(perms) {
  return Array.isArray(perms) && perms.every((p) => PERM_KEYS.includes(p));
}

// 解析用户对某项目的访问身份：
// owner 短路（零额外查询）；否则按成员表点查。返回 { role, permissions } 或 null（无访问权）
export async function resolveProjectAccess(userId, project) {
  if (project.user_id === userId) return { role: 'owner', permissions: PERM_KEYS };
  const membership = await ProjectMember.findOne({
    where: { project_id: project.id, user_id: userId },
    attributes: ['permissions'],
  });
  if (!membership) return null;
  return { role: 'member', permissions: Array.isArray(membership.permissions) ? membership.permissions : [] };
}
