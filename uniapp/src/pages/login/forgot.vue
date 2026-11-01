<script setup>
/**
 * 忘记密码（移动端单列）：本地账号体系下自部署实例无短信/邮件通道，不提供自助重置。
 * 引导联系站点管理员（管理后台「用户管理」→ 重置密码），页面只提供说明与返回登录入口。
 */
import { useI18n } from 'vue-i18n';
import { useThemeStore } from '../../stores/theme';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();

function goLogin() {
  // 鸿蒙端：reLaunch 不绘制（生命周期跑、屏幕不翻页），用 redirectTo
  uni.redirectTo({ url: '/pages/login/index' });
}
</script>

<template>
  <view class="au-page" :class="theme.rootCls">
    <view class="au-glow" />

    <view class="au-top" @tap="goLogin">
      <m-icon name="left" :size="18" :sw="2" />
      <text class="au-back">{{ t('forgot.back') }}</text>
    </view>

    <text class="au-title">{{ t('forgot.title') }}</text>
    <text class="au-sub">{{ t('forgot.sub') }}</text>

    <view class="au-tip">
      <view class="au-tip-icon"><m-icon name="help" :size="20" :sw="2" /></view>
      <text class="au-tip-text">{{ t('forgot.heroDesc') }}</text>
    </view>

    <view class="mbtn au-submit" @tap="goLogin">
      <text>{{ t('forgot.back') }}</text>
    </view>
    <AdToast />
    <AdDialog />
  </view>
</template>

<style scoped>
.au-page {
  min-height: 100vh; background: var(--ad-ink); position: relative; overflow: hidden;
  display: flex; flex-direction: column;
  /* 先给无 env() 的老内核一版兜底，支持的内核用下面带安全区的覆盖 */
  padding: 20px 26px 40px;
  padding: calc(20px + env(safe-area-inset-top)) 26px calc(40px + env(safe-area-inset-bottom));
}
.au-glow { position: absolute; width: 280px; height: 280px; top: -110px; right: -90px; border-radius: 50%; filter: blur(70px); pointer-events: none; background: rgba(224, 182, 78, 0.13); }

.au-top { position: relative; display: flex; align-items: center; gap: 7px; margin-bottom: 26px; }
.au-back { font-size: 14px; color: var(--ad-text); }
.au-title { position: relative; font-family: var(--ad-serif); font-size: 26px; font-weight: 800; color: var(--ad-text); margin-bottom: 6px; }
.au-sub { position: relative; font-size: 13px; color: var(--ad-text-soft); margin-bottom: 22px; }

/* 联系管理员提示卡 */
.au-tip {
  position: relative;
  display: flex; align-items: flex-start; gap: 12px;
  padding: 16px; border-radius: 14px;
  background: var(--ad-inset, #0d0d14); border: 1px solid var(--ad-line);
}
.au-tip-icon {
  width: 38px; height: 38px; border-radius: 11px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--ad-brand); background: rgba(224, 182, 78, 0.12);
}
.au-tip-text { font-size: 13px; line-height: 1.7; color: var(--ad-text-soft); }

.au-submit { height: 48px; border-radius: 13px; font-size: 15px; margin-top: 24px; }
</style>
