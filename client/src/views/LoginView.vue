<script setup>
// 登录页：改为第三方登录 —— 点击后 302 跳 xworld 统一账号中心（OAuth2 授权码 + PKCE），
// 账号密码/注册/找回密码均由授权中心托管页面处理，本站不接触用户凭据。
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import { startLogin } from '../api/oauth';
import ThemeSwitch from '../components/ThemeSwitch.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import SiteFooterBar from '../components/SiteFooterBar.vue';

const route = useRoute();
const auth = useAuthStore();
const { t } = useI18n();
// logo 徽标字符：取品牌名首字（各语言下均为「星」）
const brandMark = computed(() => t('brand.name').charAt(0) || '星');

// 协议勾选：勾选状态记 localStorage，勾过一次后续登录免再勾
const AGREE_KEY = 'aidrama-legal-agreed';
const agreed = ref(false);
try { agreed.value = localStorage.getItem(AGREE_KEY) === '1'; } catch { /* 隐私模式等场景忽略 */ }

function onAgreeChange(v) {
  try {
    if (v) localStorage.setItem(AGREE_KEY, '1');
    else localStorage.removeItem(AGREE_KEY);
  } catch { /* ignore */ }
}

// 跳授权中心：未勾选协议先提示并阻止；带上路由守卫记录的原目标页（登录成功后回跳）
function onLogin() {
  if (!agreed.value) {
    ElMessage.warning(t('login.agreeRequired'));
    return;
  }
  startLogin(route.query.redirect);
}
// 注册直接新开 xworld 官网注册页
function onRegister() {
  window.open('https://www.example.com/register', '_blank');
}
</script>

<template>
  <div class="auth">
    <div class="auth-left">
      <div class="hero">
        <div class="hero-brand">
          <div class="brand-mark brand-mark-hero">{{ brandMark }}</div>
          <span>{{ t('brand.name') }}</span>
        </div>
        <h1>{{ t('login.heroTitle1') }}<br />{{ t('login.heroTitle2') }}</h1>
        <p>{{ t('login.heroDesc') }}</p>
        <ul class="features">
          <li><el-icon><Check /></el-icon> {{ t('login.feat1') }}</li>
          <li><el-icon><Check /></el-icon> {{ t('login.feat2') }}</li>
          <li><el-icon><Check /></el-icon> {{ t('login.feat3') }}</li>
        </ul>
      </div>
    </div>
    <div class="auth-right">
      <div class="auth-card">
        <div class="brand-hero">
          <div class="brand-mark">{{ brandMark }}</div>
          <div class="brand-text">
            <div class="brand-name">{{ t('brand.name') }}</div>
            <div class="brand-tag">{{ t('brand.tagline') }}</div>
          </div>
        </div>
        <div class="auth-top">
          <span class="auth-title">{{ t('login.welcome') }}</span>
          <div class="auth-switches">
            <LocaleSwitch />
            <ThemeSwitch />
          </div>
        </div>
        <p class="auth-sub">{{ t('login.sub') }}</p>
        <el-button type="primary" size="large" class="submit btn-brand" @click="onLogin">
          <el-icon class="btn-icon"><User /></el-icon>
          {{ t('login.oauthButton') }}
        </el-button>
        <!-- 登录前协议勾选：未勾选点击登录只提示不跳转；勾选状态记 localStorage -->
        <el-checkbox v-model="agreed" class="agree" @change="onAgreeChange">
          <span>{{ t('login.agreeLead') }}</span>
          <router-link to="/terms" @click.stop>{{ t('login.agreeTerms') }}</router-link>
          <span>{{ t('login.agreeAnd') }}</span>
          <router-link to="/privacy" @click.stop>{{ t('login.agreePrivacy') }}</router-link>
        </el-checkbox>
        <p class="oauth-hint">{{ t('login.oauthHint') }}</p>
        <div class="auth-foot">
          {{ t('login.noAccount') }}<a href="javascript:void(0)" @click="onRegister">{{ t('login.register') }}</a>
        </div>
      </div>
      <SiteFooterBar class="auth-footer" />
    </div>
  </div>
</template>

<style scoped>
.auth {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  background: var(--ad-bg);
}
.auth-left {
  /* 影棚侧幕：暖黑底 + 金晕聚光（沿用侧栏胶片暗盒配色） */
  background:
    radial-gradient(720px 480px at 82% -8%, var(--ad-brand-soft), transparent 62%),
    radial-gradient(560px 420px at -6% 110%, var(--ad-brand-soft-2), transparent 58%),
    linear-gradient(160deg, #14110c 0%, #1d1912 55%, #26201a 100%);
  color: var(--ad-sidebar-text-strong);
  display: flex;
  align-items: center;
  padding: 64px;
  position: relative;
  overflow: hidden;
}
.auth-left::before {
  content: '';
  position: absolute;
  top: -120px;
  right: -120px;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.10);
}
.auth-left::after {
  content: '';
  position: absolute;
  bottom: -80px;
  left: -80px;
  width: 240px;
  height: 240px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
}
.hero { max-width: 460px; position: relative; z-index: 1; }
.hero-brand { display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 800; margin-bottom: 36px; opacity: 0.95; font-family: var(--ad-font-display); }
.brand-mark-hero { width: 44px; height: 44px; font-size: 24px; box-shadow: var(--ad-shadow-md); }
.hero h1 { font-family: var(--ad-font-display); font-size: 40px; line-height: 1.25; margin: 0 0 16px; font-weight: 800; }
.hero p { font-size: 16px; opacity: 0.8; margin: 0 0 32px; }
.features { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }
.features li { display: flex; align-items: center; gap: 10px; opacity: 0.92; }
.features .el-icon { color: var(--ad-success); }
.auth-right {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.auth-card { width: 100%; max-width: 380px; }
/* 页脚协议链接条：与卡片同宽，垫在登录卡片下方 */
.auth-footer { width: 100%; max-width: 380px; }
/* 品牌logo 组合：渐变徽标「星」+ 品牌名 + tagline */
.brand-hero { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
.brand-mark {
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  font-weight: 800;
  color: var(--ad-brand-contrast);
  background: var(--ad-brand-gradient);
  box-shadow: var(--ad-shadow-md);
  letter-spacing: 0;
}
.brand-text { min-width: 0; }
.brand-name { font-family: var(--ad-font-display); font-size: 24px; font-weight: 800; color: var(--ad-text); letter-spacing: 0.2px; line-height: 1.2; }
.brand-tag { font-size: 12px; font-weight: 600; color: var(--ad-text-muted); margin-top: 3px; letter-spacing: 0.5px; }
.auth-top { display: flex; align-items: center; justify-content: space-between; }
.auth-switches { display: flex; align-items: center; gap: 8px; }
.auth-title { font-family: var(--ad-font-display); font-size: 24px; font-weight: 800; color: var(--ad-text); }
.auth-sub { color: var(--ad-text-soft); margin: 6px 0 28px; }
/* 视觉规格交给全局 .btn-brand（金渐变礼宾键），这里只管布局尺寸 */
.submit {
  width: 100%;
  height: 46px;
  font-size: 15px;
}
.btn-icon { margin-right: 6px; }
/* 登录前协议勾选行：小字弱化，链接描金 */
.agree {
  display: flex;
  align-items: flex-start;
  width: 100%;
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.6;
}
.agree :deep(.el-checkbox__label) {
  display: inline;
  color: var(--ad-text-soft);
  line-height: 1.6;
  white-space: normal;
}
.agree a { color: var(--ad-brand); font-weight: 600; text-decoration: none; }
.agree a:hover { text-decoration: underline; }
.oauth-hint { text-align: center; color: var(--ad-text-muted); font-size: 12px; margin: 14px 0 0; }
.auth-foot { text-align: center; margin-top: 20px; color: var(--ad-text-soft); font-size: 14px; }
.auth-foot a { color: var(--ad-accent); text-decoration: none; font-weight: 600; }
.auth-foot a:hover { text-decoration: underline; }

@media (max-width: 900px) {
  .auth { grid-template-columns: 1fr; }
  .auth-left { display: none; }
}
</style>
