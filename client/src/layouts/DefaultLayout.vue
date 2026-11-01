<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useJobsStore } from '../stores/jobs';
import { useInvitationsStore } from '../stores/invitations';
import PointsBadge from '../components/PointsBadge.vue';
import InvitationBell from '../components/InvitationBell.vue';
// 布局上的重弹窗/浮窗拆成异步 chunk：不随布局首屏加载，首次打开时才拉取（体量小、延迟可忽略）
import { defineAsyncComponent } from 'vue';
const AssistantChat = defineAsyncComponent(() => import('../components/AssistantChat.vue'));
const GenConfirmDialog = defineAsyncComponent(() => import('../components/GenConfirmDialog.vue'));
import { primaryNav } from '../components/navConfig';
import { useI18n } from 'vue-i18n';
import { ElMessageBox } from 'element-plus';

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const jobs = useJobsStore();
const invitations = useInvitationsStore();

const activeCount = computed(() => jobs.activeCount);
// 顶栏主导航：我的项目 / 任务中心 / 积分中心
const navItems = primaryNav.filter((i) => i.name);
const activeName = computed(() => {
  if (route.path.startsWith('/projects/')) return 'projects';
  return route.name;
});
function goNav(item) {
  // 任务中心固定新开窗口：任务跑着时原页面上下文不丢，可切过去看进度再切回来
  if (item.name === 'tasks') {
    window.open(item.path, '_blank');
    return;
  }
  router.push(item.path);
}

// 手机端收拢形态：左侧 ☰ 打开导航抽屉
const mobileNavOpen = ref(false);
function openMobileNav() {
  mobileNavOpen.value = true;
}
function goNavAndClose(item) {
  goNav(item);
  mobileNavOpen.value = false;
}

const assistantVisible = ref(false);

// 会话相关的轮询（任务中心 / 邀请中心）：仅登录态启动；
// 展示中心免登录可浏览，游客拉这些接口会 401 触发全局拦截器弹回登录页
function startSessionPolling() {
  if (!auth.token) return;
  // 必须等首拉回包再起轮询：未 await 时 activeCount 恒为 0，ensurePolling 直接早退，
  // 轮询永不启动（重启恢复的在跑任务完成时无人感知，角标冻结）。store 的 fetchAll
  // 成功路径也内置了自愈拉起，这里显式链上是为首拉场景即时生效
  jobs.fetchAll().then(() => jobs.ensurePolling());
  // 团队共享：邀请中心 30s 轮询（与 jobs 生命周期一致）
  invitations.ensurePolling();
}
onMounted(startSessionPolling);
watch(() => auth.token, () => startSessionPolling()); // 游客→登录（同布局内换页不重挂载）时补启动
onUnmounted(() => {
  jobs.stopPolling();
  invitations.stopPolling();
});

// 游客态登录/注册入口：登录后原路返回当前页
function goLogin() {
  router.push({ name: 'login', query: { redirect: route.fullPath } });
}
// 注册走登录页注册模式（本地注册）
function goRegister() {
  router.push({ name: 'login', query: { redirect: route.fullPath, mode: 'register' } });
}

// 用户中心菜单：手机版（uniapp H5，当前窗口跳转）+ 创作台（新窗口）
function goMobile() {
  window.location.href = '/h5/';
}
function openStudio() {
  window.open('/studio', '_blank');
}

async function onLogout() {
  try {
    await ElMessageBox.confirm(t('auth.logoutConfirm'), t('common.tip'), { type: 'warning' });
  } catch {
    return; // 用户取消
  }
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="layout">
    <div class="shell-main">
      <!-- 顶栏：meta.hideTopbar 路由（如 /studio 创作台，自带 Ribbon 工作台壳）整条隐藏 -->
      <header v-if="!route.meta.hideTopbar" class="topbar">
        <div class="topbar-left">
          <!-- 手机端（≤768px）：左组收拢为单个 ☰ 菜单按钮 -->
          <button class="hamburger mobile-only" :title="t('ui.menu')" @click="openMobileNav">
            <el-icon><Expand /></el-icon>
          </button>
          <!-- 侧栏已随管理台独立而移除，首页图标放顶部最左 -->
          <button class="home-btn" :title="t('nav.projects')" @click="router.push('/projects')">
            <el-icon><HomeFilled /></el-icon>
          </button>
          <!-- 手机端（≤768px）：顶栏左组品牌文字（左对齐，跟在菜单/首页按钮后），点击返回首页，PC 端不显示 -->
          <button class="topbar-brand" :title="t('nav.projects')" @click="router.push('/projects')">星网 XW.COM</button>
          <nav class="topnav">
            <button
              v-for="item in navItems"
              :key="item.name"
              class="topnav-item"
              :class="{ active: activeName === item.name }"
              @click="goNav(item)"
            >
              <el-icon class="topnav-icon"><component :is="item.icon" /></el-icon>
              <span>{{ t(item.labelKey) }}</span>
              <span v-if="item.badge && activeCount > 0" class="topnav-count">{{ activeCount > 99 ? '99+' : activeCount }}</span>
            </button>
          </nav>
        </div>

        <div class="topbar-right">
          <!-- 游客态（展示中心免登录浏览）：积分/邀请/用户菜单不适用，给注册+登录入口 -->
          <template v-if="auth.isLoggedIn">
            <InvitationBell />
            <PointsBadge />
            <el-dropdown trigger="click">
              <div class="user">
                <el-avatar :size="30" class="avatar">{{ (auth.displayName || 'U').slice(0, 1).toUpperCase() }}</el-avatar>
                <span class="uname">{{ auth.displayName || t('auth.notLoggedIn') }}</span>
                <el-icon class="caret"><ArrowDown /></el-icon>
              </div>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="goMobile"><el-icon><Iphone /></el-icon> {{ t('nav.mobile') }}</el-dropdown-item>
                  <el-dropdown-item @click="openStudio"><el-icon><Film /></el-icon> {{ t('nav.studio') }}</el-dropdown-item>
                  <el-dropdown-item divided @click="router.push('/settings')"><el-icon><User /></el-icon> {{ t('nav.settings') }}</el-dropdown-item>
                  <el-dropdown-item divided @click="onLogout"><el-icon><SwitchButton /></el-icon> {{ t('auth.logout') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
          <template v-else>
            <el-button text @click="goRegister">{{ t('auth.register') }}</el-button>
            <el-button type="primary" round @click="goLogin">{{ t('auth.login') }}</el-button>
          </template>
        </div>
      </header>

      <main class="content">
        <!-- 电影感动效：淡入上浮切换（.page-* 见 theme.scss）；out-in 避免双页交叠 -->
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- 手机端 ☰ 抽屉：主导航 + 设置/退出 -->
    <el-drawer
      v-model="mobileNavOpen"
      direction="ltr"
      size="76%"
      :with-header="false"
      class="mnav-drawer"
    >
      <nav class="mnav">
        <button
          v-for="item in navItems"
          :key="item.name"
          class="mnav-item"
          :class="{ active: activeName === item.name }"
          @click="goNavAndClose(item)"
        >
          <el-icon class="mnav-icon"><component :is="item.icon" /></el-icon>
          <span>{{ t(item.labelKey) }}</span>
          <span v-if="item.badge && activeCount > 0" class="mnav-count">{{ activeCount > 99 ? '99+' : activeCount }}</span>
        </button>
        <div class="mnav-divider"></div>
        <!-- 游客态：设置/退出换成登录/注册（登录后原路返回） -->
        <template v-if="auth.isLoggedIn">
          <button class="mnav-item" @click="router.push('/settings'); mobileNavOpen = false">
            <el-icon class="mnav-icon"><Setting /></el-icon>
            <span>{{ t('nav.settings') }}</span>
          </button>
          <button class="mnav-item" @click="mobileNavOpen = false; onLogout()">
            <el-icon class="mnav-icon"><SwitchButton /></el-icon>
            <span>{{ t('auth.logout') }}</span>
          </button>
        </template>
        <template v-else>
          <button class="mnav-item" @click="mobileNavOpen = false; goLogin()">
            <el-icon class="mnav-icon"><User /></el-icon>
            <span>{{ t('auth.login') }}</span>
          </button>
          <button class="mnav-item" @click="mobileNavOpen = false; goRegister()">
            <el-icon class="mnav-icon"><EditPen /></el-icon>
            <span>{{ t('auth.register') }}</span>
          </button>
        </template>
      </nav>
    </el-drawer>

    <!-- 星网助理 AI 助手（「使用帮助」触发） -->
    <AssistantChat v-model:visible="assistantVisible" />

    <!-- 全局「生成确认」对话框（模型选择 + 价格确认） -->
    <GenConfirmDialog />
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
  background: var(--ad-bg-soft);
}
.shell-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

/* 顶栏 */
.topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  height: var(--ad-topbar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  gap: 16px;
  background: var(--ad-topbar-bg);
  border-bottom: 1px solid var(--ad-border);
  backdrop-filter: saturate(180%) blur(8px);
}
.topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* 顶栏主导航 */
.topnav { display: flex; align-items: center; gap: 4px; min-width: 0; }
.topnav-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: none;
  background: transparent;
  border-radius: var(--ad-radius-sm);
  color: var(--ad-text-soft);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}
.topnav-item:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
.topnav-item.active { background: var(--ad-sidebar-active); color: var(--ad-brand); }
.topnav-icon { font-size: 16px; }
.topnav-count {
  min-width: 16px; height: 16px; padding: 0 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; line-height: 1;
  color: var(--ad-brand-contrast); background: var(--ad-brand);
  border-radius: 8px;
}
.hamburger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--ad-border);
  background: var(--ad-bg-elevated);
  border-radius: var(--ad-radius-sm);
  color: var(--ad-text-soft);
  cursor: pointer;
  font-size: 18px;
  transition: background 0.15s, color 0.15s;
}
.hamburger:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
/* admin 顶栏 ☰ 全宽度常显（桌面端也可收/展侧栏），压过基础 display:none */
.hamburger.always { display: inline-flex; }
/* 手机端专用元素（☰）：仅 ≤768px 显示，!important 压过 .hamburger 的 ≤1023px 规则 */
.mobile-only { display: none !important; }
/* 非admin顶部最左的首页/品牌图标（侧栏隐藏后作为入口） */
.home-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px;
  border: none; background: var(--ad-brand-gradient);
  border-radius: var(--ad-radius-sm); color: var(--ad-brand-contrast);
  cursor: pointer; font-size: 20px;
  transition: filter 0.15s;
}
.home-btn:hover { opacity: 0.88; }

.topbar-right { display: flex; align-items: center; gap: 12px; }
/* 手机端品牌文字：左对齐跟在菜单/首页按钮后，仅 ≤768px 显示 */
.topbar-brand {
  display: none;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--ad-text);
  white-space: nowrap;
  background: none;
  border: none;
  padding: 4px 2px;
  margin: 0;
  cursor: pointer;
  font-family: inherit;
}
.topbar-brand:active { opacity: 0.7; }
.user {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 4px 10px 4px 4px;
  border-radius: var(--ad-radius-pill);
  background: var(--ad-bg-soft);
  border: 1px solid var(--ad-border);
  transition: background 0.15s;
}
.user:hover { background: var(--ad-bg-elevated); }
.avatar { background: var(--ad-brand-gradient); color: var(--ad-brand-contrast); font-weight: 700; }
.uname { font-size: 13px; font-weight: 600; color: var(--ad-text); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caret { color: var(--ad-text-soft); font-size: 12px; }

.content { flex: 1; min-height: 0; }

/* 响应式 */
@media (max-width: 1023px) {
  .hamburger { display: inline-flex; }
  .topbar { padding: 0 16px; gap: 10px; }
  .uname { display: none; }
}
@media (max-width: 640px) {
  .topbar { padding: 0 10px; gap: 6px; }
  .topbar-right { gap: 6px; flex-shrink: 0; }
  .topnav-item { padding: 6px 8px; font-size: 13px; }
  .topnav-icon { display: none; }
  .user { padding: 4px 6px 4px 4px; }
}
/* 手机：动态视口高度，规避地址栏导致的 100vh 底部溢出 */
@media (max-width: 768px) {
  @supports (height: 100dvh) { .layout { min-height: 100dvh; } }
  /* 顶栏收拢形态：左 ☰，隐藏桌面版的首页图标与文字导航（主题/语言设置在「设置」页） */
  .mobile-only { display: inline-flex !important; }
  .home-btn, .topnav { display: none; }
  .topbar-brand { display: inline-block; }
  .topbar-right { gap: 8px; margin-left: auto; }
  .topbar-left { flex: 1; min-width: 0; }
}
</style>

<!-- 手机端 ☰ 抽屉内容 teleport 到 body，scoped 样式够不到，需非 scoped 块 -->
<style>
.mnav-drawer .el-drawer__body { padding: 12px; }
.mnav { display: flex; flex-direction: column; gap: 4px; }
.mnav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border: none; background: transparent;
  border-radius: var(--ad-radius-sm);
  color: var(--ad-text-soft);
  font-size: 15px; font-weight: 600;
  cursor: pointer; text-align: left; width: 100%;
  transition: background 0.15s, color 0.15s;
}
.mnav-item:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
.mnav-item.active { background: var(--ad-sidebar-active); color: var(--ad-brand); }
.mnav-icon { font-size: 18px; }
.mnav-count {
  margin-left: auto;
  min-width: 18px; height: 18px; padding: 0 5px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; line-height: 1;
  color: var(--ad-brand-contrast); background: var(--ad-brand);
  border-radius: 9px;
}
.mnav-divider { height: 1px; margin: 8px 4px; background: var(--ad-border); }
</style>
