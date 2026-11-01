<script setup>
// 管理后台专属登录页：账号（手机号/用户名/邮箱）+ 密码 + 点选文字验证码 → admt_ 管理令牌。
// 与前台登录相互独立（令牌分开存储，同一浏览器可同时登录两端）；管理员账号即 User.role='admin' 的既有账号，
// 首次启动会自动创建初始管理员（见 server/src/seeders/seed.js）。
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { useAdminAuthStore } from '../stores/auth';
import CaptchaDialog from '../../components/CaptchaDialog.vue';
import LocaleSwitch from '../../components/LocaleSwitch.vue';
import ThemeSwitch from '../../components/ThemeSwitch.vue';

const route = useRoute();
const router = useRouter();
const auth = useAdminAuthStore();
const { t } = useI18n();
const brandMark = computed(() => t('brand.name').charAt(0) || '星');

const form = reactive({ phone: '', password: '' });
const showPassword = ref(false);
const submitting = ref(false);
const captchaVisible = ref(false);

async function submit(captchaTicket) {
  if (!form.phone.trim() || !form.password || submitting.value) return;
  submitting.value = true;
  try {
    await auth.login({
      phone: form.phone.trim(),
      password: form.password,
      captcha_ticket: captchaTicket,
    });
    ElMessage.success(t('admin.login.success'));
    // 登录后回到守卫记录的原目标页（无则进首个管理页）
    router.push(String(route.query.redirect || '/models'));
  } catch (e) {
    // _silent 请求：拦截器不弹窗，这里自行提示（message 已是本地化文案）
    ElMessage.error(e?.message || t('errors.requestFailed'));
  } finally {
    submitting.value = false;
  }
}

// 登录按钮：先过人机验证，通过后携带 ticket 提交
function onLoginClick() {
  if (!form.phone.trim() || !form.password) {
    ElMessage.warning(t('admin.auth.missing_fields'));
    return;
  }
  captchaVisible.value = true;
}
</script>

<template>
  <div class="admin-login">
    <div class="al-top">
      <LocaleSwitch />
      <ThemeSwitch />
    </div>
    <div class="al-card">
      <div class="brand-hero">
        <div class="brand-mark">{{ brandMark }}</div>
        <div class="brand-text">
          <div class="brand-name">{{ t('admin.title') }}</div>
          <div class="brand-tag">XW.COM</div>
        </div>
      </div>
      <p class="al-sub">{{ t('admin.login.sub') }}</p>

      <el-input
        v-model="form.phone"
        size="large"
        :placeholder="t('admin.login.identityPh')"
        :prefix-icon="'Iphone'"
        autocomplete="tel"
        @keyup.enter="onLoginClick"
      />
      <el-input
        v-model="form.password"
        size="large"
        type="password"
        show-password
        :placeholder="t('admin.login.passwordPh')"
        :prefix-icon="'Lock'"
        autocomplete="current-password"
        class="al-field"
        @keyup.enter="onLoginClick"
      />

      <el-button type="primary" size="large" class="submit btn-brand" :loading="submitting" @click="onLoginClick">
        <el-icon class="btn-icon"><Key /></el-icon>
        {{ submitting ? t('admin.login.submitting') : t('admin.login.submit') }}
      </el-button>
      <p class="al-hint">{{ t('admin.login.hint') }}</p>
    </div>

    <!-- 点选文字验证码：通过后携带 ticket 提交登录 -->
    <CaptchaDialog v-model="captchaVisible" @success="submit" />
  </div>
</template>

<style scoped>
.admin-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(720px 480px at 82% -8%, var(--ad-brand-soft), transparent 62%),
    radial-gradient(560px 420px at -6% 110%, var(--ad-brand-soft-2), transparent 58%),
    var(--ad-bg);
  position: relative;
  padding: 24px;
}
.al-top {
  position: absolute;
  top: 20px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.al-card {
  width: 100%;
  max-width: 380px;
  background: var(--ad-bg-elevated);
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius-lg, 16px);
  padding: 36px 32px;
  box-shadow: var(--ad-shadow-lg);
}
.brand-hero { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
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
}
.brand-text { min-width: 0; }
.brand-name { font-family: var(--ad-font-display); font-size: 22px; font-weight: 800; color: var(--ad-text); letter-spacing: 0.2px; line-height: 1.2; }
.brand-tag { font-size: 12px; font-weight: 600; color: var(--ad-text-muted); margin-top: 3px; letter-spacing: 0.5px; }
.al-sub { color: var(--ad-text-soft); margin: 0 0 24px; font-size: 14px; }
.al-field { margin-top: 14px; }
.submit { width: 100%; height: 46px; font-size: 15px; margin-top: 24px; }
.btn-icon { margin-right: 6px; }
.al-hint { text-align: center; color: var(--ad-text-muted); font-size: 12px; margin: 14px 0 0; }
@media (max-width: 640px) {
  .al-card { padding: 28px 22px; }
}
</style>
