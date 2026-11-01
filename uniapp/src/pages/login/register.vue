<script setup>
/**
 * 注册页（移动端单列）：本地账号注册——用户名 + 密码（邮箱选填）。
 * 提交前过点选验证码（服务端强制校验 ticket，手机/短信通道已随 xworld 解耦下线）；
 * 注册成功即登录（服务端直接签发 axt_ 令牌），沿用 ?redirect 原路返回。
 */
import { reactive, ref } from 'vue';
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
import CaptchaDialog from '../../components/captcha-dialog/captcha-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();
// 键盘避让：输入时按键盘高度上移整页，焦点编辑框底部（含间距）保持在键盘上方
const kb = useKeyboardAvoid();

let redirectPath = '';
const form = reactive({ username: '', email: '', password: '', confirm: '' });
const busy = ref(false);
const captchaOpen = ref(false);
// 协议勾选：未勾选阻止注册提交
const agreed = ref(false);

function goAgreement(type) {
  uni.navigateTo({ url: `/pages/agreement/index?type=${type}` });
}

// 用户名规则与服务端一致（2-64 位字母/数字/_.-；占位即重申，重名等 422 message 会透出）
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,64}$/;
// 邮箱客户端宽校验（格式强校验在服务端，422 message 会透出）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 校验通过 → 弹点选验证码；通过后携带 ticket 提交（doRegister）
function onSubmit() {
  if (busy.value) return;
  if (!agreed.value) { toast(t('agreement.agreeRequired'), 'error'); return; }
  if (!form.username.trim()) { toast(t('validation.usernameRequired'), 'error'); return; }
  if (!USERNAME_RE.test(form.username.trim())) { toast(t('validation.usernameInvalid'), 'error'); return; }
  if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) { toast(t('validation.emailInvalid'), 'error'); return; }
  if (!form.password) { toast(t('validation.passwordRequired'), 'error'); return; }
  if (form.password.length < 6) { toast(t('validation.passwordLen'), 'error'); return; }
  if (!form.confirm) { toast(t('validation.confirmRequired'), 'error'); return; }
  if (form.confirm !== form.password) { toast(t('validation.passwordMismatch'), 'error'); return; }
  // captcha-dialog 打开即自动取题
  captchaOpen.value = true;
}

async function doRegister(ticket) {
  busy.value = true;
  try {
    await auth.register({
      username: form.username.trim(),
      password: form.password,
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      captcha_ticket: ticket,
    });
    toast(t('register.success'));
    // 鸿蒙端：reLaunch 不绘制，用 redirectTo
    uni.redirectTo({ url: redirectPath || '/pages/projects/index' });
  } catch (e) {
    toastError(e); // _silent 请求不经 http 拦截层弹窗，需就地提示（409 已注册 / 422 校验失败 / 验证码过期等）
    captchaOpen.value = false; // ticket 一次性消费，失败后重开换新题
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

    <view class="ad-field">
      <view class="ad-field-label">{{ t('field.username') }}</view>
      <input v-model="form.username" class="ad-input" :placeholder="t('register.phUsername')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(0)" @confirm="onSubmit">
    </view>

    <view class="ad-field">
      <view class="ad-field-label">{{ t('field.email') }}（{{ t('register.emailOptional') }}）</view>
      <input v-model="form.email" class="ad-input" :placeholder="t('register.phEmail')" placeholder-class="au-ph" :maxlength="64" @focus="kb.focus(1)">
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

    <!-- 点选验证码：注册提交前的人机校验，通过后携带 ticket 注册（v-if 挂载即弹，
         仅打开时挂载，不进首渲染路径） -->
    <captcha-dialog v-if="captchaOpen" v-model="captchaOpen" @success="doRegister" />
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
