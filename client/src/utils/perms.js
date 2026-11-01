// 团队共享权限：与 server/src/utils/access.js 的 PERM_KEYS 保持一致
export const PERM_KEYS = [
  'script.edit',
  'asset.edit',
  'storyboard.edit',
  'ai.generate',
  'video.manage',
  'project.settings',
];

// 权限组展示文案的 i18n key（权限 key 含点，不能直接作嵌套键，故映射为 camelCase 叶子键）
export const PERM_LABEL_KEYS = {
  'script.edit': 'team.perms.scriptEdit',
  'asset.edit': 'team.perms.assetEdit',
  'storyboard.edit': 'team.perms.storyboardEdit',
  'ai.generate': 'team.perms.aiGenerate',
  'video.manage': 'team.perms.videoManage',
  'project.settings': 'team.perms.projectSettings',
};

// 是否项目创建者（owner 隐式拥有全部权限）
export function isOwner(project) {
  return project?.my_role === 'owner';
}

// 是否拥有某权限（owner 全有；成员按 owner 勾选的分组判定）
export function can(project, perm) {
  if (!project) return false;
  if (project.my_role === 'owner') return true;
  return Array.isArray(project.my_permissions) && project.my_permissions.includes(perm);
}
