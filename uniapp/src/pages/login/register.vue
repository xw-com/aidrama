<script setup>
/**
 * 注册页：直连 xworld 账号中心验证码注册（client RegisterView 移植，移动端单列）。
 * 手机号/邮箱双通道 + 60s 发码倒计时；短信/邮箱验证码本身即人机屏障，不再叠加图片点选验证码。
 * 注册成功即登录（服务端直接签发令牌），沿用 ?redirect 原路返回。
 */
import { reactive, ref, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad } from '@dcloudio/uni-app';
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

let redirectPath = '';
const form = reactive({ accountType: 'phone', phone: '', email: '', code: '', password: '', confirm: '' });
const sending = ref(false);
const busy = ref(false);
const countdown = ref(0);
// 协议勾选：未勾选阻止注册提交
const agreed = ref(false);

function goAgreement(type) {
  uni.navigateTo({ url: `/pages/agreement/index?type=${type}` });
}

let timer = null;
onUnmounted(() => { if (timer) clearInterval(timer); });

function startCountdown() {
  countdown.value = 60;
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) { clearInterval(timer); timer = null; }
  }, 1000);
}

// 手机号客户端宽校验（^1[3-9]\d{9}$ 大陆号段强校验在服务端，422 message 会透出）
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
    await auth.sendCode({ [key]: value, type: 'register' });
    toast(t('register.codeSent'), 'success');
    startCountdown();
  } catch (e) {
    toastError(e); // 直连 xworld 路径不经 http 拦截层，需就地提示（409 已注册 / 429 限频等）
  } finally {
    sending.value = false;
  }
}

function onSubmit() {
  if (busy.value) return;
  if (!agreed.value) { toast(t('agreement.agreeRequired'), 'error'); return; }
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
    await auth.register({ [key]: value, code: form.code.trim(), password: form.password });
    toast(t('register.success'));
    // 鸿蒙端：reLaunch 不绘制，用 redirectTo
    uni.redirectTo({ url: redirectPath || '/pages/projects/index' });
  } catch (e) {
    toastError(e); // 直连 xworld 路径不经 http 拦截层，需就地提示（409 已注册 / 422 校验失败 / 验证码错误等）
  } finally {
    busy.value = false;
  }
}

function goLogin() {
  const qs = redirectPath ? `?redirect=${encodeURIComponent(redirectPath)}` : '';
  // 鸿蒙端：reLaunch 不绘制（生命周期跑、屏幕不翻页），用 redirectTo
  uni.redirectTo({ url: `/pages/login/index${qs}` });
}

onLoad((q) => {
  redirectPath = (q && q.redirect) ? decodeURIComponent(q.redirect) : '';
});
</script>

<template>
  <view class="au-page" :class="theme.rootCls" :style="kb.style.value">
    <view class="au-glow" />

    <view class="au-top" @tap="goLogin">
      <m-icon name="left" :size="18" :sw="2" />
      <text class="au-back">{{ t('forgot.back') }}</text>
    </view>

    <text class="au-title">{{ t('register.title') }}</text>
    <text class="au-sub">{{ t('register.sub') }}</text>

    <!-- 注册通道切换 -->
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
      <view class="ad-field-label">{{ t('field.password') }}</view>
      <input v-model="form.password" class="ad-input" type="password" :password="true" :placeholder="t('register.phPassword')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(2)">
    </view>

    <view class="ad-field">
      <view class="ad-field-label">{{ t('field.confirmPassword') }}</view>
      <input v-model="form.confirm" class="ad-input" type="password" :password="true" :placeholder="t('register.phConfirm')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(3)" @confirm="onSubmit">
    </view>

    <!-- 协议勾选：未勾选阻止提交（链接可跳协议页全文） -->
    <view class="au-agree" @tap="agreed = !agreed">
      <view class="au-check" :class="{ on: agreed }">
        <m-icon v-if="agreed" name="check" :size="11" :sw="3.2" />
      </view>
      <view class="au-agree-text">
        <text>{{ t('agreement.agreePrefix') }}</text>
        <text class="au-alink" @tap.stop="goAgreement('terms')">{{ t('agreement.termsTitle') }}</text>
        <text>{{ t('agreement.agreeAnd') }}</text>
        <text class="au-alink" @tap.stop="goAgreement('privacy')">{{ t('agreement.privacyTitle') }}</text>
      </view>
    </view>

    <view class="mbtn au-submit" :class="{ dis: busy }" @tap="onSubmit">
      <text>{{ t('register.signUp') }}</text>
    </view>

    <view class="au-foot">
      <text>{{ t('register.haveAccount') }}</text>
      <text class="au-link" @tap="goLogin">{{ t('auth.login') }}</text>
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

/* 协议勾选行 */
.au-agree { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; }
.au-check {
  width: 17px; height: 17px; border-radius: 5px; flex-shrink: 0; margin-top: 1px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--ad-line); background: var(--ad-inset, #0d0d14); color: #0a0a0f;
}
.au-check.on {
  background: linear-gradient(135deg, #f2d489, #e0b64e);
  border-color: transparent;
}
.au-agree-text { font-size: 12px; line-height: 1.6; color: var(--ad-text-mut); display: flex; flex-wrap: wrap; align-items: baseline; }
.au-alink { color: var(--ad-brand); }

.au-foot { display: flex; justify-content: center; gap: 6px; margin-top: 18px; font-size: 13px; color: var(--ad-text-soft); }
.au-link { color: var(--ad-brand); font-weight: 700; }
</style>
