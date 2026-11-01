<script setup>
/**
 * 忘记密码：直连 xworld 账号中心验证码重置（client ForgotPasswordView 移植，移动端单列）。
 * 手机号/邮箱双通道 + 60s 发码倒计时；短信/邮箱验证码本身即人机屏障，不再叠加图片点选验证码。
 * 重置成功不自动登录，回登录页用新密码重新登录。
 */
import { reactive, ref, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { toast, toastError } from '../../utils/ui';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import { useKeyboardAvoid } from '../../composables/useKeyboardAvoid';
import MIcon from '../../components/m-icon/m-icon.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();
// 键盘避让：输入时按键盘高度上移整页，焦点编辑框底部（含间距）保持在键盘上方
const kb = useKeyboardAvoid();

const form = reactive({ accountType: 'phone', phone: '', email: '', code: '', password: '', confirm: '' });
const sending = ref(false);
const busy = ref(false);
const countdown = ref(0);

let timer = null;
onUnmounted(() => { if (timer) clearInterval(timer); });

function startCountdown() {
  countdown.value = 60;
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) { clearInterval(timer); timer = null; }
  }, 1000);
}

// 手机号客户端宽校验（大陆号段强校验在服务端，422 message 会透出；未注册 404 亦透传）
const PHONE_RE = /^\d{6,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 当前通道字段名与值（phone 优先，同服务端语义）
function channel() {
  return form.accountType === 'phone'
    ? { key: 'phone', value: form.phone.trim() }
    : { key: 'email', value: form.email.trim() };
}

function onSendCode() {
  if (countdown.value > 0 || sending.value) return;
  const { value } = channel();
  if (!value) { toast(t(form.accountType === 'phone' ? 'validation.phoneRequired' : 'validation.emailRequired')); return; }
  doSendCode();
}

async function doSendCode() {
  const { key, value } = channel();
  sending.value = true;
  try {
    await auth.sendCode({ [key]: value, type: 'reset_password' });
    toast(t('register.codeSent'));
    startCountdown();
  } catch (e) {
    toastError(e); // 直连 xworld 路径不经 http 拦截层，需就地提示（404 未注册 / 429 限频等）
  } finally {
    sending.value = false;
  }
}

function onSubmit() {
  if (busy.value) return;
  const { key, value } = channel();
  if (!value) { toast(t(form.accountType === 'phone' ? 'validation.phoneRequired' : 'validation.emailRequired')); return; }
  if (form.accountType === 'phone' && !PHONE_RE.test(value)) { toast(t('validation.phoneInvalid')); return; }
  if (form.accountType === 'email' && !EMAIL_RE.test(value)) { toast(t('validation.emailInvalid')); return; }
  if (!form.code) { toast(t('validation.codeRequired')); return; }
  if (!form.password) { toast(t('validation.passwordRequired')); return; }
  if (form.password.length < 6) { toast(t('validation.passwordLen')); return; }
  if (!form.confirm) { toast(t('validation.confirmRequired')); return; }
  if (form.confirm !== form.password) { toast(t('validation.passwordMismatch')); return; }
  doSubmit();
}

async function doSubmit() {
  const { key, value } = channel();
  busy.value = true;
  try {
    await auth.resetPassword({ [key]: value, code: form.code.trim(), password: form.password });
    toast(t('forgot.success'));
    // 鸿蒙端：reLaunch 不绘制（生命周期跑、屏幕不翻页），用 redirectTo
    uni.redirectTo({ url: '/pages/login/index' });
  } catch (e) {
    toastError(e); // 直连 xworld 路径不经 http 拦截层，需就地提示（400 验证码错误 / 404 未注册等）
  } finally {
    busy.value = false;
  }
}

function goLogin() {
  // 鸿蒙端：reLaunch 不绘制（生命周期跑、屏幕不翻页），用 redirectTo
  uni.redirectTo({ url: '/pages/login/index' });
}
</script>

<template>
  <view class="au-page" :class="theme.rootCls" :style="kb.style.value">
    <view class="au-glow" />

    <view class="au-top" @tap="goLogin">
      <m-icon name="left" :size="18" :sw="2" />
      <text class="au-back">{{ t('forgot.back') }}</text>
    </view>

    <text class="au-title">{{ t('forgot.title') }}</text>
    <text class="au-sub">{{ t('forgot.sub') }}</text>

    <!-- 重置通道切换 -->
    <view class="au-seg">
      <view class="mbtn sm" :class="form.accountType === 'phone' ? '' : 'ghost'" @tap="form.accountType = 'phone'">
        <text>{{ t('register.byPhone') }}</text>
      </view>
      <view class="mbtn sm" :class="form.accountType === 'email' ? '' : 'ghost'" @tap="form.accountType = 'email'">
        <text>{{ t('register.byEmail') }}</text>
      </view>
    </view>

    <view class="ad-field">
      <view class="ad-field-label">{{ t(form.accountType === 'phone' ? 'field.phone' : 'field.email') }}</view>
      <input
        v-if="form.accountType === 'phone'"
        v-model="form.phone" class="ad-input" type="number"
        :placeholder="t('register.phPhone')" placeholder-class="au-ph" :maxlength="15" @focus="kb.focus(0)"
      >
      <input
        v-else
        v-model="form.email" class="ad-input"
        :placeholder="t('register.phEmail')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(0)"
      >
    </view>

    <view class="ad-field">
      <view class="ad-field-label">{{ t('field.code') }}</view>
      <view class="au-coderow">
        <input v-model="form.code" class="ad-input au-code" :placeholder="t('register.phCode')" placeholder-class="au-ph" :maxlength="8" @focus="kb.focus(1)">
        <view class="mbtn soft sm au-send" :class="{ dis: countdown > 0 || sending }" @tap="onSendCode">
          <text>{{ countdown > 0 ? t('register.resend', { n: countdown }) : t('register.sendCode') }}</text>
        </view>
      </view>
    </view>

    <view class="ad-field">
      <view class="ad-field-label">{{ t('field.newPassword') }}</view>
      <input v-model="form.password" class="ad-input" type="password" :password="true" :placeholder="t('forgot.phPassword')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(2)">
    </view>

    <view class="ad-field">
      <view class="ad-field-label">{{ t('field.confirmPassword') }}</view>
      <input v-model="form.confirm" class="ad-input" type="password" :password="true" :placeholder="t('register.phConfirm')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(3)" @confirm="onSubmit">
    </view>

    <view class="mbtn au-submit" :class="{ dis: busy }" @tap="onSubmit">
      <text>{{ t('forgot.submit') }}</text>
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
  transition: transform 0.22s ease-out;
}
.au-glow { position: absolute; width: 280px; height: 280px; top: -110px; right: -90px; border-radius: 50%; filter: blur(70px); pointer-events: none; background: rgba(224, 182, 78, 0.13); }
.au-ph { color: var(--ad-text-mut); }

.au-top { position: relative; display: flex; align-items: center; gap: 7px; margin-bottom: 26px; }
.au-back { font-size: 14px; color: var(--ad-text); }
.au-title { position: relative; font-family: var(--ad-serif); font-size: 26px; font-weight: 800; color: var(--ad-text); margin-bottom: 6px; }
.au-sub { position: relative; font-size: 13px; color: var(--ad-text-soft); margin-bottom: 22px; }

.au-seg { position: relative; display: flex; gap: 10px; margin-bottom: 16px; }
.au-seg .mbtn { flex: 1; }

.au-coderow { display: flex; gap: 10px; }
.au-code { flex: 1; }
.au-send { flex-shrink: 0; min-width: 108px; }
.au-send.dis { opacity: 0.45; }

.au-submit { height: 48px; border-radius: 13px; font-size: 15px; margin-top: 8px; }
</style>
