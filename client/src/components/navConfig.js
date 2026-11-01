// 前台顶栏导航配置，供 DefaultLayout 与移动端抽屉共用。
// name 对应路由 name，用于高亮匹配；path 用于跳转；labelKey 为 i18n 文案键。
// 管理后台导航已随管理台独立入口迁移至 src/admin/navConfig.js。
export const primaryNav = [
  // 创作台（小白总控台）暂不进导航，直接访问 /studio（路由仍注册）
  // { name: 'studio', labelKey: 'nav.studio', icon: 'MagicStick', path: '/studio' },
  { name: 'script-writer', labelKey: 'nav.scriptWriter', icon: 'EditPen', path: '/script-writer' },
  { name: 'projects', labelKey: 'nav.projects', icon: 'Files', path: '/projects', badge: true },
  { name: 'tasks', labelKey: 'nav.tasks', icon: 'Tickets', path: '/tasks', badge: true },
  { name: 'showcase', labelKey: 'nav.showcase', icon: 'Film', path: '/showcase' },
  { name: 'market', labelKey: 'nav.market', icon: 'Sell', path: '/market' },
  { name: 'credits', labelKey: 'nav.credits', icon: 'Wallet', path: '/credits' },
];
