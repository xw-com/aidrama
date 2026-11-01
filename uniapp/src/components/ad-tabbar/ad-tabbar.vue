<script setup>
/**
 * 底部五槽 TabBar + 中央快门键（proposal「底部 TabBar」1:1）。
 * 不用原生 tabBar（中央凸起键需自绘）；Tab 切换 uni.redirectTo 保持单实例。
 * 中央键内嵌创作面板（ad-create-sheet）。
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useJobsStore } from '../../stores/jobs';
import { useAuthStore } from '../../stores/auth';
import { requireLogin } from '../../api';
import MIcon from '../m-icon/m-icon.vue';
import AdCreateSheet from '../ad-create-sheet/ad-create-sheet.vue';

const props = defineProps({
  current: { type: String, default: '' }, // showcase | projects | tasks | mine
});
const { t } = useI18n();
const jobs = useJobsStore(); // App.vue 全局轮询，运行中角标各 Tab 页都准
const auth = useAuthStore();
const createSheet = ref(null);
// 角标自愈：Tab 间是 redirectTo 换页（本组件随页重挂载），挂载即补拉一次（fetchAll 单飞、
// 无活跃任务时 ensurePolling 空转）。兜住「任务在别的设备/登录前创建，本机从未轮询到」
// 时角标滞后；未登录（showcase 游客态）不拉，避免 401 触发全局 bailSession 弹回登录页。
if (auth.isLoggedIn) jobs.fetchAll().then(() => jobs.ensurePolling());

const tabs = computed(() => [
  { key: 'showcase', icon: 'home', label: t('mobile.tab.showcase'), url: '/pages/showcase/index' },
  { key: 'projects', icon: 'clap', label: t('mobile.tab.projects'), url: '/pages/projects/index' },
  { key: 'tasks', icon: 'tasks', label: t('nav.tasks'), url: '/pages/tasks/index' },
  { key: 'mine', icon: 'user', label: t('mobile.tab.mine'), url: '/pages/mine/index' },
]);

function go(tab) {
  if (props.current === tab.key) return;
  // 需登录 Tab（showcase/mine 游客可浏览）：与中央创作键同款 requireLogin 确认框，
  // 点「去登录」才跳（登录后 redirect 回本 Tab）；模态框同时挡掉连点堆叠导航。
  // 别让游客进页后再由 onMounted 跳——redirectTo 转场未落定时调 reLaunch，
  // 鸿蒙路由会把后者永久排队（Waiting to navigate），整个导航卡死。
  if ((tab.key === 'projects' || tab.key === 'tasks') && !auth.isLoggedIn) {
    requireLogin(tab.url);
    return;
  }
  uni.redirectTo({ url: tab.url });
}
</script>

<template>
  <view class="tb">
    <view class="tb-tab" :class="{ active: current === 'showcase' }" @tap="go(tabs[0])">
      <m-icon name="home" :size="23" />
      <text class="tb-label">{{ tabs[0].label }}</text>
    </view>
    <view class="tb-tab" :class="{ active: current === 'projects' }" @tap="go(tabs[1])">
      <m-icon name="clap" :size="23" />
      <text class="tb-label">{{ tabs[1].label }}</text>
    </view>
    <view class="tb-c">
      <view class="tb-shut" @tap="createSheet.open()">
        <m-icon name="plus" :size="24" color="#1a1205" :sw="2.2" />
      </view>
    </view>
    <view class="tb-tab" :class="{ active: current === 'tasks' }" @tap="go(tabs[2])">
      <view class="tb-icowrap">
        <m-icon name="tasks" :size="23" />
        <text v-if="jobs.activeCount" class="tb-badge">{{ jobs.activeCount > 99 ? '99+' : jobs.activeCount }}</text>
      </view>
      <text class="tb-label">{{ tabs[2].label }}</text>
    </view>
    <view class="tb-tab" :class="{ active: current === 'mine' }" @tap="go(tabs[3])">
      <m-icon name="user" :size="23" />
      <text class="tb-label">{{ tabs[3].label }}</text>
    </view>
  </view>
  <!-- 须留在 .tb 之外：.tb 的 backdrop-filter 会成为 fixed 后代的包含块，
       内嵌时 ad-mask 的 inset:0 只盖住 TabBar 一条，点页面空白关不掉面板 -->
  <AdCreateSheet ref="createSheet" />
</template>

<style scoped>
.tb {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 650;
  display: flex;
  align-items: flex-end;
  padding: 8px 14px;
  padding-bottom: calc(10px + env(safe-area-inset-bottom));
  background: var(--ad-tabbar-bg);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  border-top: 1px solid var(--ad-line);
}
.tb-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0 2px;
  color: var(--ad-text-mut);
}
.tb-label {
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.05em;
}
.tb-tab.active { color: var(--ad-brand); }
.tb-icowrap { position: relative; width: 23px; height: 23px; }
.tb-badge {
  position: absolute;
  top: -7px;
  right: -12px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--ad-accent);
  color: #06231f;
  font-size: 9px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  box-sizing: border-box;
}
.tb-c { flex: 1; display: flex; justify-content: center; }
.tb-shut {
  width: 55px;
  height: 55px;
  margin-top: -30px;
  border-radius: 50%;
  background: linear-gradient(135deg, #f2d489 0%, #e0b64e 45%, #b3871f 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 10px 26px rgba(224, 182, 78, 0.34),
    0 0 0 6px rgba(224, 182, 78, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
  transition: transform 0.16s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.tb-shut:active { transform: scale(0.9); }
</style>
