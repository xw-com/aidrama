<script setup>
/**
 * 我的（Tab 4）：urow 用户条 + bcard 积分卡 + mgroup 入口列表（proposal 1:1）。
 * 未登录时展示登录引导。
 */
import { computed, onMounted } from 'vue';
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../../stores/auth';
import { useJobsStore } from '../../stores/jobs';
import { useInvitationsStore } from '../../stores/invitations';
import { useThemeStore } from '../../stores/theme';
import { formatCredits } from '../../utils/format';
import { statusBarHeight } from '../../utils/system';
import { confirm } from '../../utils/ui';
import { requireLogin } from '../../api';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdTabbar from '../../components/ad-tabbar/ad-tabbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

const { t } = useI18n();
const auth = useAuthStore();
const jobs = useJobsStore();
const invitations = useInvitationsStore();
const theme = useThemeStore();

const avatarChar = computed(() => (auth.displayName || '访')[0]);
const uid = computed(() => {
  const u = auth.user;
  if (!u) return '';
  return 'UID ' + String(u.id ?? '').padStart(6, '0');
});

const rows = computed(() => [
  { key: 'scripts', icon: 'clap', label: t('mobile.mine.scripts'), badge: null, url: '/pages/create/writer' },
  { key: 'market', icon: 'case', label: t('nav.market'), badge: null, url: '/pages/market/index' },
  { key: 'credits', icon: 'coin', label: t('nav.credits'), badge: null, url: '/pages/credits/index' },
  { key: 'invitations', icon: 'invite', label: t('mobile.mine.invitations'), badge: invitations.pendingCount ? { cls: 'gold', text: t('mobile.mine.pending', { n: invitations.pendingCount }) } : null, url: '/pages/invitations/index' },
  { key: 'models', icon: 'layers', label: t('settings.privateModels.title'), badge: null, url: '/pages/settings/private-models' },
  { key: 'tutorial', icon: 'help', label: t('tutorial.title'), badge: null, url: '/pages/tutorial/index', free: true },
  // 协议页免登录可读（合规要求游客可访问；页内可互切 terms/privacy 页签）
  { key: 'agreement', icon: 'doc', label: t('mobile.mine.agreement'), badge: null, url: '/pages/agreement/index?type=terms', free: true },
  { key: 'settings', icon: 'set', label: t('nav.settings'), badge: null, url: '/pages/settings/index' },
]);

function go(row) {
  if (!row.free && !auth.isLoggedIn) { requireLogin(row.url); return; }
  uni.navigateTo({ url: row.url });
}

function goLogin() {
  uni.navigateTo({ url: '/pages/login/index' });
}
function goRecharge() {
  if (!auth.isLoggedIn) { requireLogin('/pages/credits/index'); return; }
  uni.navigateTo({ url: '/pages/credits/index' });
}

async function logout() {
  const ok = await confirm(t('auth.logoutConfirm'), t('auth.logout'));
  if (!ok) return;
  invitations.stopPolling();
  jobs.stopPolling();
  auth.logout(); // H5 整页跳 /oauth/logout；小程序/App reLaunch 登录页
}

onMounted(() => {
  if (!auth.isLoggedIn) return;
  jobs.fetchAll();
  invitations.ensurePolling();
  auth.refreshCredits();
});
onShow(() => {
  if (!auth.isLoggedIn) return;
  jobs.fetchAll();
});
// 下拉刷新：同步任务列表 + 积分（企业上下文同时刷池余额）
onPullDownRefresh(async () => {
  if (!auth.isLoggedIn) { uni.stopPullDownRefresh(); return; }
  try {
    jobs.fetchAll();
    await auth.refreshCredits();
  } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page with-tabbar" :class="theme.rootCls">
    <view class="ptop" :style="{ paddingTop: statusBarHeight() + 6 + 'px' }">
      <view class="ptitle">{{ t('mobile.mine.title') }}</view>
    </view>

    <!-- 用户条 -->
    <view class="urow">
      <template v-if="auth.isLoggedIn">
        <view class="avatar uava"><view class="glow" /><text class="uzi">{{ avatarChar }}</text></view>
        <view class="uinfo">
          <text class="uname">{{ auth.displayName }}</text>
          <text class="uid">{{ uid }}</text>
        </view>
        <view style="flex: 1" />
        <view class="iconbtn" @tap="go(rows.find((r) => r.key === 'settings'))"><m-icon name="set" :size="18" /></view>
      </template>
      <template v-else>
        <view class="avatar uava"><view class="glow" /><text class="uzi">访</text></view>
        <view class="uinfo">
          <text class="uname">{{ t('mobile.mine.guest') }}</text>
          <text class="uid">{{ t('mobile.mine.guestTip') }}</text>
        </view>
        <view style="flex: 1" />
        <view class="mbtn sm" @tap="goLogin">{{ t('login.action') }}</view>
      </template>
    </view>

    <!-- 积分卡 -->
    <view class="bcard" @tap="goRecharge">
      <view class="lb">{{ t('mobile.mine.balanceLabel') }}</view>
      <view class="bnum">{{ formatCredits(auth.credits ?? 0) }}<text class="bu">{{ t('mobile.mine.creditsUnit') }}</text></view>
      <view class="brow">
        <text class="mbtn dark sm">{{ t('credits.recharge') }}</text>
      </view>
    </view>

    <!-- 入口列表 -->
    <view class="mgroup">
      <view v-for="row in rows" :key="row.key" class="mrow" @tap="go(row)">
        <view class="mi"><m-icon :name="row.icon" :size="19" /></view>
        <text class="mrow-label">{{ row.label }}</text>
        <text v-if="row.badge" class="chip sm" :class="row.badge.cls">{{ row.badge.text }}</text>
        <view class="arr"><m-icon name="right" :size="14" /></view>
      </view>
    </view>

    <view v-if="auth.isLoggedIn" class="mgroup">
      <view class="mrow danger" @tap="logout">
        <view class="mi"><m-icon name="left" :size="18" /></view>
        <text class="mrow-label danger">{{ t('auth.logout') }}</text>
      </view>
    </view>

    <view class="pfootnote">XWorld · {{ t('mobile.mine.footnote') }}</view>

    <AdTabbar current="mine" />
  <AdDialog />
  </view>
</template>

<style scoped>
.uinfo { margin-left: 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.uname { font-size: 16px; font-weight: 800; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uid { font-size: 11px; color: var(--ad-text-mut); }
.uava { width: 52px; height: 52px; }
.uzi { position: absolute; left: 0; right: 0; top: 0; bottom: 0; text-align: center; line-height: 52px; font-size: 24px; color: var(--ad-text); font-family: var(--ad-font-serif); font-weight: 900; }
.bnum .bu { font-size: 10px; letter-spacing: 0.18em; color: #8a8a98; margin-left: 8px; }
.brow { display: flex; align-items: center; }
.mrow-label { flex: 1; font-size: 14px; font-weight: 600; color: var(--ad-text); }
.mrow-label.danger { color: var(--ad-danger); }
.mrow.danger .mi { background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.25); color: var(--ad-danger); }
.pfootnote { padding: 26px 0 10px; text-align: center; font-size: 10px; letter-spacing: 0.14em; color: var(--ad-text-mut); text-transform: uppercase; }
</style>
