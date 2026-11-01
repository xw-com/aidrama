import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { guest: true } },
  // 法务文档页：公开免登录（页脚/登录页协议勾选的链接入口；独立全屏版式，不挂 DefaultLayout）
  { path: '/terms', name: 'terms', component: () => import('../views/TermsView.vue'), meta: { auth: false, titleKey: 'route.terms' } },
  { path: '/privacy', name: 'privacy', component: () => import('../views/PrivacyView.vue'), meta: { auth: false, titleKey: 'route.privacy' } },
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    meta: { auth: true },
    children: [
      // 首页默认进入展示中心（站点门面，免登录可浏览）
      { path: '', redirect: '/showcase' },
      { path: 'projects', name: 'projects', component: () => import('../views/ProjectsView.vue'), meta: { titleKey: 'route.projects' } },
      // 创作台（小白模式总控台）：Ribbon 工作台，剧本→资产→分镜→成片全程不切页
      { path: 'studio', name: 'studio', component: () => import('../views/studio/StudioView.vue'), meta: { titleKey: 'route.studio', hideTopbar: true } },
      {
        path: 'projects/:id',
        name: 'workspace',
        component: () => import('../views/workspace/WorkspaceView.vue'),
        meta: { titleKey: 'route.workspace', immersive: true },
      },
      {
        path: 'projects/:id/episodes/:eid',
        name: 'storyboard',
        component: () => import('../views/workspace/StoryboardEditor.vue'),
        meta: { titleKey: 'route.storyboard', immersive: true },
      },
      // 管理后台已独立为 admin 入口（/admin，独立登录与令牌），前台不再挂管理路由
      { path: 'script-writer', name: 'script-writer', component: () => import('../views/ScriptWriterView.vue'), meta: { titleKey: 'route.scriptWriter' } },
      // 展示中心免登录：auth:false 覆盖父级 meta.auth（浏览/观看公开；「我发布的」等用户操作前端引导登录）
      { path: 'showcase', name: 'showcase', component: () => import('../views/ShowcaseView.vue'), meta: { auth: false, titleKey: 'route.showcase' } },
      { path: 'showcase/:id', name: 'showcaseDetail', component: () => import('../views/ShowcaseDetailView.vue'), meta: { auth: false, titleKey: 'route.showcase' } },
      { path: 'market', name: 'market', component: () => import('../views/MarketView.vue'), meta: { titleKey: 'route.market' } },
      { path: 'market/:id', name: 'marketDetail', component: () => import('../views/MarketDetailView.vue'), meta: { titleKey: 'route.market' } },
      { path: 'credits', name: 'credits', component: () => import('../views/CreditsView.vue'), meta: { titleKey: 'route.credits' } },      { path: 'tasks', name: 'tasks', component: () => import('../views/TasksView.vue'), meta: { titleKey: 'route.tasks' } },
      { path: 'invitations', name: 'invitations', component: () => import('../views/InvitationsView.vue'), meta: { titleKey: 'route.invitations' } },
      { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { titleKey: 'route.settings' } },
    ],
  },
  // 在线视频剪辑（独立全屏窗口，无 DefaultLayout：window.open 具名窗口打开）
  {
    path: '/editor/video/:jobId',
    name: 'videoEditor',
    component: () => import('../views/VideoEditorView.vue'),
    meta: { auth: true, titleKey: 'route.videoEditor' },
  },
  // 免登录剧集分享播放页（无 auth/guest meta：守卫直接放行，深链由 nginx try_files 兜底）
  { path: '/share/:token', name: 'sharePlay', component: () => import('../views/SharePlayView.vue'), meta: { titleKey: 'route.sharePlay' } },
  { path: '/:pathMatch(.*)*', redirect: '/showcase' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 页面切换回到顶部（浏览器前进/后退保留原位置）
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return { top: 0 };
  },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  // 管理台「一键登录用户前端」：login_token 为管理台刚代签的前台令牌，立即落地为会话并
  // 从地址栏剥离（replace，不留带令牌的历史记录），随后按原目标页继续（/ 即进展示中心首页）
  if (to.query.login_token) {
    await auth.applyAdminIssuedToken(String(to.query.login_token));
    const query = { ...to.query };
    delete query.login_token;
    return { path: to.path, query, replace: true };
  }
  // 档案补拉：公开页（auth 显式为 false，如展示中心）也拉，保证登录用户在公开页显示登录态
  // （管理员在展示中心也能看到下架按钮）；公开页走静默模式——携带失效令牌的游客拉取失败
  // 不弹「登录过期」/跳登录页，仅静默清会话退回普通游客，浏览公开内容不受打扰
  if (auth.token && !auth.user) {
    await auth.fetchMe({ silent: to.meta.auth === false });
  }
  if (to.meta.auth && !auth.token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guest && auth.token) {
    return { name: 'projects' };
  }
  return true;
});

export default router;
