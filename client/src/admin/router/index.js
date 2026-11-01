import { createRouter, createWebHistory } from 'vue-router';
import { useAdminAuthStore } from '../stores/auth';

// 管理后台路由：base /admin/（独立入口 admin.html，与前台 router 完全独立）。
// 管理视图沿用 client/src/views 下的既有组件（原样复用，免改相对导入）。
const routes = [
  { path: '/login', name: 'admin-login', component: () => import('../views/AdminLoginView.vue'), meta: { guest: true } },
  {
    path: '/',
    component: () => import('../AdminLayout.vue'),
    meta: { auth: true },
    children: [
      // 应用内路径不带 /admin 前缀（base 已由 createWebHistory('/admin/') 承担；
      // redirect 写成 '/admin/models' 会落 catch-all 自指 redirect 死循环 → 爆栈黑屏）
      { path: '', redirect: '/models' },
      { path: 'models', name: 'models', component: () => import('../../views/ModelConfigView.vue'), meta: { titleKey: 'route.models' } },
      { path: 'art-styles', name: 'art-styles', component: () => import('../../views/ArtStyleAdminView.vue'), meta: { titleKey: 'route.artStyles' } },
      { path: 'char-options', name: 'char-options', component: () => import('../../views/CharacterOptionAdminView.vue'), meta: { titleKey: 'route.charOptions' } },
      { path: 'vendors', name: 'vendors', component: () => import('../../views/ModelVendorView.vue'), meta: { titleKey: 'route.vendors' } },
      { path: 'voices', name: 'voices', component: () => import('../../views/VoiceLibraryView.vue'), meta: { titleKey: 'route.voices' } },
      { path: 'maintenance', name: 'maintenance', component: () => import('../../views/MaintenanceView.vue'), meta: { titleKey: 'route.maintenance' } },
      { path: 'payments', name: 'payments', component: () => import('../../views/PaymentAdminView.vue'), meta: { titleKey: 'route.payments' } },
      { path: 'pricing', name: 'pricing', component: () => import('../../views/PricingAdminView.vue'), meta: { titleKey: 'route.pricing' } },
      { path: 'users', name: 'users', component: () => import('../../views/UserAdminView.vue'), meta: { titleKey: 'route.users' } },
      { path: 'job-admin', name: 'job-admin', component: () => import('../../views/JobAdminView.vue'), meta: { titleKey: 'route.jobAdmin' } },
      { path: 'video-gen-admin', name: 'video-gen-admin', component: () => import('../../views/VideoGenAdminView.vue'), meta: { titleKey: 'route.videoGenAdmin' } },
      { path: 'showcase-admin', name: 'showcase-admin', component: () => import('../../views/ShowcaseAdminView.vue'), meta: { titleKey: 'route.showcaseAdmin' } },
      { path: 'logs', name: 'logs', component: () => import('../../views/LogAdminView.vue'), meta: { titleKey: 'route.logs' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/models' },
];

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return { top: 0 };
  },
});

router.beforeEach(async (to) => {
  const auth = useAdminAuthStore();
  // 档案补拉：刷新后恢复登录态（令牌有效但内存 user 为空）
  if (auth.token && !auth.user) await auth.fetchMe();
  if (to.meta.auth && !auth.token) {
    return { name: 'admin-login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guest && auth.token) {
    return { path: '/models' };
  }
  return true;
});

export default router;
