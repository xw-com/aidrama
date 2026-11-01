<script setup>
/**
 * 登录页（移动端单列）：本地账号密码登录（用户名/邮箱/手机号任一）。
 * 提交前过点选验证码（ticket 随登录请求透传，服务端「提供才校验」）；
 * 原目标页经 ?redirect 带入（登录成功后回跳）。
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad } from '@dcloudio/uni-app';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { toast, toastError } from '../../utils/ui';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import { platformProviders, resolveProviders, tapProvider } from '../../utils/oauthLogin';
import { useKeyboardAvoid } from '../../composables/useKeyboardAvoid';
import MIcon from '../../components/m-icon/m-icon.vue';
import CaptchaDialog from '../../components/captcha-dialog/captcha-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();
// 键盘避让：输入时按键盘高度上移表单卡片，焦点编辑框底部（含间距）保持在键盘上方
const kb = useKeyboardAvoid();

const brandMark = t('brand.name').charAt(0) || '星';
let redirectPath = '';

const form = ref({ identity: '', password: '' });
const busy = ref(false);
const captchaOpen = ref(false);
// 协议勾选：未勾选阻止一切登录提交（含第三方一键登录）
const agreed = ref(false);

function goAgreement(type) {
  uni.navigateTo({ url: `/pages/agreement/index?type=${type}` });
}

// 按平台给出的一键登录候选（iOS=Apple；Android=Google；微信/华为暂未就绪，各端均不展示）
const providers = ref(platformProviders());
// 再按设备实际可用性过滤：未配置 OAuth 模块 / 本机缺微信客户端的方式不显示
resolveProviders().then((list) => { providers.value = list; });

function onSubmit() {
  if (busy.value) return;
  if (!agreed.value) { toast(t('agreement.agreeRequired'), 'error'); return; }
  if (!form.value.identity.trim()) { toast(t('validation.identityRequired'), 'error'); return; }
  if (!form.value.password) { toast(t('validation.passwordRequired'), 'error'); return; }
  // 先过点选验证码，通过后再登录（captcha-dialog 打开即自动取题）
  captchaOpen.value = true;
}

async function doLogin(ticket) {
  busy.value = true;
  try {
    await auth.login({ identity: form.value.identity.trim(), password: form.value.password, captcha_ticket: ticket });
    toast(t('login.success'));
    // 鸿蒙端：reLaunch 不绘制，用 redirectTo（栈内残留游客页，返回时由各页未登录态兜底）
    uni.redirectTo({ url: redirectPath || '/pages/projects/index' });
  } catch (e) {
    toastError(e); // _silent 请求不经 http 拦截层弹窗，需就地提示（401 凭证错误 / 429 限频等）
  } finally {
    busy.value = false;
  }
}

function goForgot() {
  const qs = redirectPath ? `?redirect=${encodeURIComponent(redirectPath)}` : '';
  uni.navigateTo({ url: `/pages/login/forgot${qs}` });
}

// 第三方一键登录：取上游凭证 → 服务端 /auth/oauth/:provider 换取 → 落会话
async function onProvider(key) {
  if (busy.value) return;
  if (!agreed.value) { toast(t('agreement.agreeRequired'), 'error'); return; }
  busy.value = true;
  const ok = await tapProvider(auth, key, t('login.oauthUnavailable'));
  busy.value = false;
  if (ok) {
    toast(t('login.success'));
    // 鸿蒙端：reLaunch 不绘制，用 redirectTo
    uni.redirectTo({ url: redirectPath || '/pages/projects/index' });
  }
}

function goRegister() {
  const qs = redirectPath ? `?redirect=${encodeURIComponent(redirectPath)}` : '';
  uni.navigateTo({ url: `/pages/login/register${qs}` });
}

onLoad((q) => {
  redirectPath = (q && q.redirect) ? decodeURIComponent(q.redirect) : '';
});
</script>

<template>
  <view class="lg-page" :class="theme.rootCls">
    <!-- 影棚聚光背景（鸿蒙端暂缓：装饰性 CSS blur(70px) 光斑未在鸿蒙验证过，功能无影响，后续视效统一时再上） -->
    <!-- #ifndef APP-HARMONY -->
    <view class="lg-glow a" />
    <view class="lg-glow b" />
    <!-- #endif -->

    <view class="lg-hero">
      <view class="lg-markrow">
        <view class="lg-mark">{{ brandMark }}</view>
        <text class="lg-brand">{{ t('brand.name') }}</text>
      </view>
      <text class="lg-title">{{ t('login.heroTitle1') }}</text>
      <text class="lg-title">{{ t('login.heroTitle2') }}</text>
      <text class="lg-desc">{{ t('login.heroDesc') }}</text>

      <view class="lg-feats">
        <view class="lg-feat"><m-icon name="check" :size="15" :sw="2.2" /><text>{{ t('login.feat1') }}</text></view>
        <view class="lg-feat"><m-icon name="check" :size="15" :sw="2.2" /><text>{{ t('login.feat2') }}</text></view>
        <view class="lg-feat"><m-icon name="check" :size="15" :sw="2.2" /><text>{{ t('login.feat3') }}</text></view>
      </view>
    </view>

    <view class="lg-card" :style="kb.style.value">
      <text class="lg-welcome">{{ t('login.welcome') }}</text>
      <text class="lg-sub">{{ t('login.sub') }}</text>

      <view class="ad-field">
        <input v-model="form.identity" class="ad-input" :placeholder="t('login.phIdentity')" placeholder-class="lg-ph" :maxlength="64" @focus="kb.focus(0)" @confirm="onSubmit">
      </view>
      <view class="ad-field">
        <input v-model="form.password" class="ad-input" type="password" :password="true" :placeholder="t('login.phPassword')" placeholder-class="lg-ph" :maxlength="64" @focus="kb.focus(1)" @confirm="onSubmit">
      </view>

      <!-- 协议勾选：未勾选阻止提交（链接可跳协议页全文） -->
      <view class="lg-agree" @tap="agreed = !agreed">
        <view class="lg-check" :class="{ on: agreed }">
          <m-icon v-if="agreed" name="check" :size="11" :sw="3.2" />
        </view>
        <view class="lg-agree-text">
          <text>{{ t('agreement.agreePrefix') }}</text>
          <text class="lg-alink" @tap.stop="goAgreement('terms')">{{ t('agreement.termsTitle') }}</text>
          <text>{{ t('agreement.agreeAnd') }}</text>
          <text class="lg-alink" @tap.stop="goAgreement('privacy')">{{ t('agreement.privacyTitle') }}</text>
        </view>
      </view>

      <view class="mbtn lg-btn" :class="{ dis: busy }" @tap="onSubmit">
        <text>{{ t('login.signIn') }}</text>
      </view>

      <view class="lg-row">
        <text class="lg-link" @tap="goForgot">{{ t('login.forgot') }}</text>
        <view class="lg-row-right">
          <text>{{ t('login.noAccount') }}</text>
          <text class="lg-reg" @tap="goRegister">{{ t('login.register') }}</text>
        </view>
      </view>

      <!-- 平台一键登录：按条件编译只显示当前平台可用的方式 -->
      <template v-if="providers.length">
        <view class="lg-odiv"><text>{{ t('login.oauthDivider') }}</text></view>
        <view
          v-for="p in providers"
          :key="p.key"
          class="mbtn ghost lg-obtn"
          :class="{ dis: busy }"
          @tap="onProvider(p.key)"
        >
          <text>{{ t(p.labelKey) }}</text>
          <AdDialog />
        </view>
      </template>
    </view>

    <!-- 点选验证码：通过后携带 ticket 登录（v-if 挂载即弹，配合组件内 immediate watch 取题；
         仅打开时挂载，不进首渲染路径） -->
    <captcha-dialog v-if="captchaOpen" v-model="captchaOpen" @success="doLogin" />
    <AdToast />
  </view>
</template>

<style scoped>
.lg-page {
  min-height: 100vh; background: var(--ad-ink); position: relative; overflow: hidden;
  display: flex; flex-direction: column; justify-content: center;
  /* 先给无 env() 的老内核一版兜底，支持的内核用下面带安全区的覆盖 */
  padding: 48px 26px 40px;
  padding: 48px 26px calc(40px + env(safe-area-inset-bottom));
}
.lg-glow { position: absolute; border-radius: 50%; filter: blur(70px); pointer-events: none; }
.lg-glow.a { width: 300px; height: 300px; top: -110px; right: -90px; background: rgba(224, 182, 78, 0.16); }
.lg-glow.b { width: 260px; height: 260px; bottom: -100px; left: -90px; background: rgba(224, 182, 78, 0.10); }

.lg-hero { position: relative; display: flex; flex-direction: column; gap: 12px; margin-bottom: 40px; }
.lg-markrow { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.lg-mark {
  width: 46px; height: 46px; border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 800; color: #0a0a0f;
  background: linear-gradient(135deg, #f2d489, #e0b64e 45%, #b3871f);
}
.lg-brand { font-family: var(--ad-serif); font-size: 21px; font-weight: 800; color: var(--ad-text); }
.lg-title { font-family: var(--ad-serif); font-size: 30px; line-height: 1.3; font-weight: 800; color: var(--ad-text); }
.lg-desc { font-size: 14px; line-height: 1.7; color: var(--ad-text-soft); margin-top: 2px; }
.lg-feats { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.lg-feat { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--ad-text-soft); }

.lg-card { position: relative; display: flex; flex-direction: column; gap: 10px; transition: transform 0.22s ease-out; }
.lg-welcome { font-family: var(--ad-serif); font-size: 22px; font-weight: 800; color: var(--ad-text); }
.lg-sub { font-size: 13px; color: var(--ad-text-soft); margin-bottom: 8px; }
.lg-ph { color: var(--ad-text-mut); }
.lg-btn {
  height: 48px; border-radius: 13px; display: flex; align-items: center; justify-content: center; gap: 8px;
  font-size: 15px; font-weight: 700; margin-top: 6px;
}

/* 协议勾选行 */
.lg-agree { display: flex; align-items: flex-start; gap: 8px; margin-top: 4px; }
.lg-check {
  width: 17px; height: 17px; border-radius: 5px; flex-shrink: 0; margin-top: 1px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--ad-line); background: var(--ad-inset, #0d0d14); color: #0a0a0f;
}
.lg-check.on {
  background: linear-gradient(135deg, #f2d489, #e0b64e);
  border-color: transparent;
}
.lg-agree-text { font-size: 12px; line-height: 1.6; color: var(--ad-text-mut); display: flex; flex-wrap: wrap; align-items: baseline; }
.lg-alink { color: var(--ad-brand); }
.lg-row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; font-size: 13px; color: var(--ad-text-soft); }
.lg-row-right { display: flex; gap: 6px; }
.lg-link { color: var(--ad-text-soft); }
.lg-reg { color: var(--ad-brand); font-weight: 700; }

/* 平台一键登录 */
.lg-odiv {
  display: flex; align-items: center; gap: 12px;
  margin-top: 18px; font-size: 12px; color: var(--ad-text-mut);
}
.lg-odiv::before, .lg-odiv::after { content: ''; flex: 1; height: 1px; background: var(--ad-line); }
.lg-obtn { height: 46px; border-radius: 13px; margin-top: 10px; display: flex; align-items: center; justify-content: center; }
</style>
