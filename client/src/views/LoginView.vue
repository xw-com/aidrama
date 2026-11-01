<script setup>
// 登录/注册页（本地账号体系）：用户名/邮箱/手机号 + 密码登录；注册需过点选文字验证码。
// 注册成功即登录；忘记密码无自助通道（自部署无短信/邮件服务），提示联系站点管理员。
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import CaptchaDialog from '../components/CaptchaDialog.vue';
import ThemeSwitch from '../components/ThemeSwitch.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import SiteFooterBar from '../components/SiteFooterBar.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();
// logo 徽标字符：取品牌名首字（各语言下均为「星」）
const brandMark = computed(() => t('brand.name').charAt(0) || '星');

// 模式：login 登录 / register 注册（顶栏「注册」入口经 ?mode=register 直达）
const mode = ref(route.query.mode === 'register' ? 'register' : 'login');
function switchMode(m) {
  mode.value = m;
  form.password = '';
  if (m === 'login') form.confirm = '';
}

const form = reactive({
  identity: '',
  username: '',
  email: '',
  password: '',
  confirm: '',
});
const showPassword = ref(false);
const busy = ref(false);
const captchaVisible = ref(false);

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

function requireAgreed() {
  if (agreed.value) return true;
  ElMessage.warning(t('login.agreeRequired'));
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ===== 登录：identity + 密码，直接提交 =====
async function onLogin() {
  if (busy.value) return;
  if (!form.identity.trim()) { ElMessage.warning(t('validation.identityRequired')); return; }
  if (!form.password) { ElMessage.warning(t('validation.passwordRequired')); return; }
  if (!requireAgreed()) return;
  busy.value = true;
  try {
    await auth.login({ identity: form.identity.trim(), password: form.password });
    ElMessage.success(t('login.success'));
    router.push(String(route.query.redirect || '/projects'));
  } catch (e) {
    // _silent 请求：拦截器不弹窗，这里自行提示（message 已是服务端本地化文案）
    ElMessage.error(e?.message || t('errors.requestFailed'));
  } finally {
    busy.value = false;
  }
}

// ===== 注册：先过点选验证码，通过后携带 ticket 提交（成功即登录）=====
function onRegisterClick() {
  if (busy.value) return;
  if (!form.username.trim()) { ElMessage.warning(t('login.usernameRequired')); return; }
  if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) { ElMessage.warning(t('validation.emailInvalid')); return; }
  if (!form.password) { ElMessage.warning(t('validation.passwordRequired')); return; }
  if (form.password.length < 6) { ElMessage.warning(t('validation.passwordLen')); return; }
  if (!form.confirm) { ElMessage.warning(t('validation.confirmRequired')); return; }
  if (form.confirm !== form.password) { ElMessage.warning(t('validation.passwordMismatch')); return; }
  if (!requireAgreed()) return;
  captchaVisible.value = true;
}

async function doRegister(captchaTicket) {
  busy.value = true;
  try {
    await auth.register({
      username: form.username.trim(),
      password: form.password,
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      captcha_ticket: captchaTicket,
    });
    ElMessage.success(t('login.success'));
    router.push(String(route.query.redirect || '/projects'));
  } catch (e) {
    ElMessage.error(e?.message || t('errors.requestFailed'));
    captchaVisible.value = false; // ticket 一次性消费，失败后重开换新题
  } finally {
    busy.value = false;
  }
}

// 忘记密码：自部署实例无短信/邮件通道，密码重置由管理员在「用户管理」完成
function onForgot() {
  ElMessageBox.alert(t('login.forgotHint'), t('login.forgot'), { confirmButtonText: t('common.confirm') }).catch(() => {});
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
          <el-segmented v-model="mode" :options="[{ label: t('auth.login'), value: 'login' }, { label: t('auth.register'), value: 'register' }]" @change="switchMode" />
          <div class="auth-switches">
            <LocaleSwitch />
            <ThemeSwitch />
          </div>
        </div>

        <!-- 登录表单 -->
        <template v-if="mode === 'login'">
          <p class="auth-sub">{{ t('login.sub') }}</p>
          <el-input
            v-model="form.identity"
            size="large"
            :placeholder="t('login.phIdentity')"
            :prefix-icon="'User'"
            autocomplete="username"
            @keyup.enter="onLogin"
          />
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            show-password
            :placeholder="t('login.phPassword')"
            :prefix-icon="'Lock'"
            autocomplete="current-password"
            class="field-gap"
            @keyup.enter="onLogin"
          />
          <div class="row-between">
            <el-checkbox v-model="agreed" class="agree" @change="onAgreeChange">
              <span>{{ t('login.agreeLead') }}</span>
              <router-link to="/terms" @click.stop>{{ t('login.agreeTerms') }}</router-link>
            </el-checkbox>
            <a href="javascript:void(0)" class="forgot" @click="onForgot">{{ t('login.forgot') }}</a>
          </div>
          <el-button type="primary" size="large" class="submit btn-brand" :loading="busy" @click="onLogin">
            <el-icon class="btn-icon"><User /></el-icon>
            {{ t('login.signIn') }}
          </el-button>
          <div class="auth-foot">
            {{ t('login.noAccount') }}<a href="javascript:void(0)" @click="switchMode('register')">{{ t('login.register') }}</a>
          </div>
        </template>

        <!-- 注册表单：提交前先过点选验证码 -->
        <template v-else>
          <p class="auth-sub">{{ t('login.registerSub') }}</p>
          <el-input
            v-model="form.username"
            size="large"
            :placeholder="t('login.usernamePh')"
            :prefix-icon="'User'"
            autocomplete="username"
          >
            <template #append><span class="append-hint">{{ t('login.usernameRule') }}</span></template>
          </el-input>
          <el-input
            v-model="form.email"
            size="large"
            :placeholder="t('login.emailPh')"
            :prefix-icon="'Message'"
            autocomplete="email"
            class="field-gap"
          />
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            show-password
            :placeholder="t('login.phPassword')"
            :prefix-icon="'Lock'"
            autocomplete="new-password"
            class="field-gap"
          />
          <el-input
            v-model="form.confirm"
            size="large"
            type="password"
            show-password
            :placeholder="t('login.phConfirm')"
            :prefix-icon="'Lock'"
            autocomplete="new-password"
            class="field-gap"
            @keyup.enter="onRegisterClick"
          />
          <el-checkbox v-model="agreed" class="agree" @change="onAgreeChange">
            <span>{{ t('login.agreeLead') }}</span>
            <router-link to="/terms" @click.stop>{{ t('login.agreeTerms') }}</router-link>
            <span>{{ t('login.agreeAnd') }}</span>
            <router-link to="/privacy" @click.stop>{{ t('login.agreePrivacy') }}</router-link>
          </el-checkbox>
          <el-button type="primary" size="large" class="submit btn-brand" :loading="busy" @click="onRegisterClick">
            <el-icon class="btn-icon"><Plus /></el-icon>
            {{ t('login.signUp') }}
          </el-button>
          <div class="auth-foot">
            {{ t('login.hasAccount') }}<a href="javascript:void(0)" @click="switchMode('login')">{{ t('auth.login') }}</a>
          </div>
        </template>
      </div>
      <SiteFooterBar class="auth-footer" />
    </div>

    <!-- 点选文字验证码：注册提交前的人机校验，通过后携带 ticket 注册 -->
    <CaptchaDialog v-model="captchaVisible" @success="doRegister" />
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
.auth-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.auth-switches { display: flex; align-items: center; gap: 8px; }
.auth-sub { color: var(--ad-text-soft); margin: 0 0 18px; }
.field-gap { margin-top: 14px; }
.append-hint { font-size: 12px; opacity: 0.75; white-space: nowrap; }
/* 协议 + 忘记密码行 */
.row-between { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-top: 12px; }
.forgot { font-size: 12px; color: var(--ad-text-muted); text-decoration: none; flex-shrink: 0; line-height: 1.6; }
.forgot:hover { color: var(--ad-brand); }
/* 视觉规格交给全局 .btn-brand（金渐变礼宾键），这里只管布局尺寸 */
.submit {
  width: 100%;
  height: 46px;
  font-size: 15px;
  margin-top: 16px;
}
.btn-icon { margin-right: 6px; }
/* 登录前协议勾选行：小字弱化，链接描金 */
.agree {
  display: flex;
  align-items: flex-start;
  font-size: 12px;
  line-height: 1.6;
  margin-top: 0;
}
.agree :deep(.el-checkbox__label) {
  display: inline;
  color: var(--ad-text-soft);
  line-height: 1.6;
  white-space: normal;
}
.agree a { color: var(--ad-brand); font-weight: 600; text-decoration: none; }
.agree a:hover { text-decoration: underline; }
.auth-foot { text-align: center; margin-top: 20px; color: var(--ad-text-soft); font-size: 14px; }
.auth-foot a { color: var(--ad-accent); text-decoration: none; font-weight: 600; }
.auth-foot a:hover { text-decoration: underline; }

@media (max-width: 900px) {
  .auth { grid-template-columns: 1fr; }
  .auth-left { display: none; }
}
</style>
