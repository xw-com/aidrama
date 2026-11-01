<script setup>
import { computed, ref, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessageBox } from 'element-plus';
import { useAdminAuthStore } from './stores/auth';
import { useJobsStore } from '../stores/jobs';
import { useThemeStore } from '../stores/theme';
import { adminNav } from './navConfig';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import ThemeSwitch from '../components/ThemeSwitch.vue';
// 全局「生成确认」对话框：美术风格/角色选项示例图生成流程依赖（useCostAction 打开）
const GenConfirmDialog = defineAsyncComponent(() => import('../components/GenConfirmDialog.vue'));

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAdminAuthStore();
const jobs = useJobsStore();
const theme = useThemeStore();

// 沉浸式收起：跟前台一致存档到 theme store（键 aidrama-sidebar-collapsed 两端共用，无碍）
const effectiveCollapsed = computed(() => theme.sidebarCollapsed);
const mobileOpen = ref(false);
const mobileMq = window.matchMedia('(max-width: 1023px)');
function onMenu() {
  // 窄屏开抽屉；桌面端直接展开/收起侧栏
  if (mobileMq.matches) mobileOpen.value = true;
  else theme.toggleSidebar();
}
function closeMobile() {
  mobileOpen.value = false;
}
function go(item) {
  router.push(item.path);
  closeMobile();
}

// 生成任务轮询（美术风格/角色选项示例图生成在管理台发起，完成回调依赖本轮询）：
// 仅登录态启动，与前台 DefaultLayout 同款守卫——首拉回包后再起轮询
function startSessionPolling() {
  if (!auth.token) return;
  jobs.fetchAll().then(() => jobs.ensurePolling());
}
onMounted(startSessionPolling);
watch(() => auth.token, () => startSessionPolling());
onUnmounted(() => {
  jobs.stopPolling();
});

async function onLogout() {
  try {
    await ElMessageBox.confirm(t('auth.logoutConfirm'), t('common.tip'), { type: 'warning' });
  } catch {
    return; // 用户取消
  }
  auth.logout();
}
function goFront() {
  // 返回前台（新开标签，不打断管理端会话）
  window.open('/', '_blank');
}
</script>

<template>
  <div class="al-layout" :class="{ 'sidebar-collapsed': effectiveCollapsed }">
    <!-- 移动端遮罩 -->
    <div v-if="mobileOpen" class="al-mask" @click="closeMobile"></div>

    <aside class="al-sidebar" :class="{ 'mobile-open': mobileOpen }">
      <div class="al-brand">
        <span class="al-logo">🎬</span>
        <div class="al-brand-text">
          <span class="al-brand-name">{{ t('admin.title') }}</span>
          <span class="al-brand-sub">XW.COM</span>
        </div>
      </div>

      <nav class="al-nav">
        <button
          v-for="item in adminNav"
          :key="item.name"
          class="al-item"
          :class="{ active: route.name === item.name }"
          :title="effectiveCollapsed ? t(item.labelKey) : ''"
          @click="go(item)"
        >
          <span class="al-active-bar"></span>
          <el-icon class="al-icon"><component :is="item.icon" /></el-icon>
          <span class="al-label">{{ t(item.labelKey) }}</span>
        </button>
      </nav>

      <div class="al-spacer"></div>
      <div class="al-footer">
        <button class="al-collapse" :title="t('nav.collapse')" @click="theme.toggleSidebar()">
          <el-icon><Fold /></el-icon>
          <span>{{ t('nav.collapse') }}</span>
        </button>
      </div>
    </aside>

    <div class="al-main">
      <header class="al-topbar">
        <div class="al-topbar-left">
          <button class="al-hamburger" :title="t('ui.menu')" @click="onMenu">
            <el-icon><Expand /></el-icon>
          </button>
          <span class="al-page-title">{{ route.meta?.titleKey ? t(route.meta.titleKey) : t('admin.title') }}</span>
        </div>
        <div class="al-topbar-right">
          <LocaleSwitch />
          <ThemeSwitch />
          <el-dropdown trigger="click">
            <div class="al-user">
              <el-avatar :size="30" class="avatar">{{ (auth.displayName || 'A').slice(0, 1).toUpperCase() }}</el-avatar>
              <span class="uname">{{ auth.displayName || t('auth.notLoggedIn') }}</span>
              <el-icon class="caret"><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="goFront"><el-icon><Monitor /></el-icon> {{ t('admin.backToSite') }}</el-dropdown-item>
                <el-dropdown-item divided @click="onLogout"><el-icon><SwitchButton /></el-icon> {{ t('auth.logout') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="al-content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- 全局「生成确认」对话框（模型选择 + 价格确认） -->
    <GenConfirmDialog />
  </div>
</template>

<style scoped>
.al-layout {
  display: flex;
  min-height: 100vh;
  background: var(--ad-bg-soft);
}
.al-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

/* 侧栏：沿用前台侧栏的影棚黑视觉（theme.scss 令牌） */
.al-sidebar {
  width: var(--ad-sidebar-w);
  flex: 0 0 var(--ad-sidebar-w);
  background: linear-gradient(180deg, var(--ad-sidebar-bg) 0%, var(--ad-sidebar-bg-2) 100%);
  display: flex;
  flex-direction: column;
  color: var(--ad-sidebar-text);
  border-right: 1px solid var(--ad-sidebar-border);
  position: sticky;
  top: 0;
  height: 100vh;
  @supports (height: 100dvh) { & { height: 100dvh; } }
  transition: width 0.2s ease, flex-basis 0.2s ease;
  z-index: 120;
  overflow: hidden;
}
.al-layout.sidebar-collapsed .al-sidebar {
  width: var(--ad-sidebar-w-collapsed);
  flex-basis: var(--ad-sidebar-w-collapsed);
}
.al-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 18px 16px;
  height: var(--ad-topbar-h);
  box-sizing: border-box;
}
.al-layout.sidebar-collapsed .al-brand { justify-content: center; padding: 18px 0; }
.al-logo { font-size: 24px; flex: 0 0 auto; filter: drop-shadow(0 2px 6px rgba(224, 182, 78, 0.35)); }
.al-brand-text { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.al-brand-name { font-size: 16px; font-weight: 800; color: var(--ad-sidebar-text-strong); letter-spacing: 0.3px; white-space: nowrap; }
.al-brand-sub { font-size: 11px; color: var(--ad-sidebar-text-muted); margin-top: 2px; }

.al-nav { display: flex; flex-direction: column; gap: 2px; padding: 6px 12px; overflow-y: auto; }
.al-layout.sidebar-collapsed .al-nav { padding: 6px 8px; }
.al-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  border-radius: var(--ad-radius-sm);
  cursor: pointer;
  color: var(--ad-sidebar-text);
  font-size: 14px;
  font-weight: 600;
  transition: background 0.15s, color 0.15s;
  text-align: left;
  white-space: nowrap;
}
.al-layout.sidebar-collapsed .al-item { justify-content: center; padding: 10px 0; }
.al-item:hover { background: var(--ad-sidebar-hover); color: var(--ad-sidebar-text-strong); }
.al-item.active { background: var(--ad-sidebar-active); color: var(--ad-sidebar-text-strong); }
.al-icon { font-size: 18px; flex: 0 0 auto; }
.al-label { overflow: hidden; text-overflow: ellipsis; }
.al-active-bar {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%) scaleY(0);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--ad-sidebar-active-bar);
  transition: transform 0.18s ease;
}
.al-item.active .al-active-bar { transform: translateY(-50%) scaleY(1); }

.al-spacer { flex: 1; }
.al-footer { display: flex; flex-direction: column; padding: 6px 12px 14px; border-top: 1px solid var(--ad-sidebar-border); }
.al-collapse {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--ad-sidebar-text-muted);
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--ad-radius-sm);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.al-collapse:hover { background: var(--ad-sidebar-hover); color: var(--ad-sidebar-text-strong); }
.al-layout.sidebar-collapsed .al-collapse { justify-content: center; padding: 8px 0; }
.al-layout.sidebar-collapsed .al-collapse span { display: none; }

/* 顶栏 */
.al-topbar {
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
.al-topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.al-hamburger {
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
.al-hamburger:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
.al-page-title {
  font-family: var(--ad-font-display);
  font-size: 16px;
  font-weight: 800;
  color: var(--ad-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.al-topbar-right { display: flex; align-items: center; gap: 12px; }
.al-user {
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
.al-user:hover { background: var(--ad-bg-elevated); }
.avatar { background: var(--ad-brand-gradient); color: var(--ad-brand-contrast); font-weight: 700; }
.uname { font-size: 13px; font-weight: 600; color: var(--ad-text); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caret { color: var(--ad-text-soft); font-size: 12px; }

.al-content { flex: 1; min-height: 0; }

/* 遮罩 + 响应式：<1024px 侧栏变抽屉 */
.al-mask { display: none; }
@media (max-width: 1023px) {
  .al-hamburger { display: inline-flex; }
  .al-topbar { padding: 0 16px; }
  .uname { display: none; }
  .al-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    transform: translateX(-100%);
    box-shadow: var(--ad-shadow-lg);
    width: min(var(--ad-sidebar-w), 84vw);
    flex-basis: min(var(--ad-sidebar-w), 84vw);
    max-width: 84vw;
  }
  .al-sidebar.mobile-open { transform: translateX(0); }
  .al-mask {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 15, 0.55);
    backdrop-filter: blur(2px);
    z-index: 110;
  }
}
@media (max-width: 768px) {
  @supports (height: 100dvh) { .al-layout { min-height: 100dvh; } }
  .al-topbar { padding: 0 10px; gap: 8px; }
  .al-topbar-right { gap: 6px; }
}
</style>

<!-- 遮罩 teleport？非 teleport（同组件树内 fixed），scoped 可达；无需非 scoped 块 -->
