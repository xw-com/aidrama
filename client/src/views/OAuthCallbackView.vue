<script setup>
// OAuth2 授权码回调页：xworld 授权中心 302 回跳 ?code=..&state=..，
// 这里校验 state → 换令牌 → 拉用户信息 → 建立本系统会话，再跳回原目标页。
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { handleCallback } from '../api/oauth';
import { useAuthStore } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

const error = ref('');

async function run() {
  try {
    const { tokens, user, redirect } = await handleCallback(route.query);
    await auth.applyOauth({ tokens, user });
    router.replace(redirect || '/projects');
  } catch (e) {
    error.value = e?.code === 'state_mismatch'
      ? t('oauth.stateMismatch')
      : (e?.message || t('oauth.failed'));
  }
}
run();

function retry() {
  // 重新走一遍授权（回到登录页再发起，保证 state/verifier 重新生成）
  router.replace('/login');
}
</script>

<template>
  <div class="oauth-callback">
    <div class="card">
      <div class="spinner" v-if="!error"></div>
      <el-icon v-else class="icon-error"><CircleClose /></el-icon>
      <p class="text">{{ error || t('oauth.signingIn') }}</p>
      <el-button v-if="error" type="primary" class="btn-brand" @click="retry">{{ t('oauth.retry') }}</el-button>
    </div>
  </div>
</template>

<style scoped>
.oauth-callback {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ad-bg);
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 48px 56px;
  border-radius: 16px;
  background: var(--ad-card);
  box-shadow: var(--ad-shadow-md);
}
.spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid var(--ad-brand-soft);
  border-top-color: var(--ad-brand);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.icon-error {
  font-size: 36px;
  color: var(--ad-danger, #ef4444);
}
.text {
  margin: 0;
  color: var(--ad-text-soft);
  font-size: 14px;
}
</style>
