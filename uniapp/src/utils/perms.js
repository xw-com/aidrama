/** 项目协作权限（从 client/utils/perms.js 原样移植，仅 i18n key 不变） */

export const PERM_KEYS = [
  'script.edit',
  'asset.edit',
  'storyboard.edit',
  'ai.generate',
  'video.manage',
  'project.settings',
];

export const PERM_LABEL_KEYS = {
  'script.edit': 'team.perms.scriptEdit',
  'asset.edit': 'team.perms.assetEdit',
  'storyboard.edit': 'team.perms.storyboardEdit',
  'ai.generate': 'team.perms.aiGenerate',
  'video.manage': 'team.perms.videoManage',
  'project.settings': 'team.perms.projectSettings',
};

export function isOwner(project) {
  return !!project && project.my_role === 'owner';
}

export function can(project, perm) {
  if (!project) return false;
  if (isOwner(project)) return true;
  return Array.isArray(project.my_permissions) && project.my_permissions.includes(perm);
}
