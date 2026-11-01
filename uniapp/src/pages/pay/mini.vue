<script setup>
/**
 * 小程序支付壳页（自 miniclient weapp pages/pay/pay 移植）：
 * wx.login 取 code → POST /recharge/wechat/miniapp/prepay {no,t,code} → uni.requestPayment 拉起。
 * 支付结果由充值页弹层轮询订单状态确认；本页只负责拉起与重试。
 * 文案键族 pay.mini.*（本页为小程序专属壳页，pages.json 标题保留中文即可）。
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad } from '@dcloudio/uni-app';
import { useThemeStore } from '../../stores/theme';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层（支付壳页即回拉起的充值页），不越级回祖父
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();
const state = ref('loading'); // loading | paying | ok | cancel | fail
const msg = ref('');
let orderNo = '';
let payToken = '';
let payParams = null;

// 服务端错误码 → 本地化文案键（未收录的码透传服务端 message）
const ERR_KEY = {
  'recharge.pay_token_invalid': 'pay.mini.errTokenInvalid',
  'recharge.wechat_not_enabled': 'pay.mini.errWechatNotEnabled',
  'recharge.payment_failed': 'pay.mini.errPaymentFailed',
  'common.not_found': 'pay.mini.errNotFound',
};

function request(url, data) {
  return new Promise((resolve, reject) => {
    uni.request({
      url,
      method: 'POST',
      data,
      timeout: 15000,
      success: (res) => resolve(res.data || {}),
      fail: (e) => reject(new Error(e?.errMsg || 'network error')),
    });
  });
}

async function start() {
  state.value = 'loading';
  msg.value = '';
  try {
    const [loginErr, loginRes] = await new Promise((resolve) => {
      uni.login({
        provider: 'weixin',
        success: (r) => resolve([null, r]),
        fail: (e) => resolve([e, null]),
      });
    });
    if (loginErr) {
      state.value = 'fail';
      msg.value = t('pay.mini.loginFailed');
      return;
    }
    await prepay(loginRes.code || '');
  } catch (e) {
    state.value = 'fail';
    msg.value = e?.message || t('pay.mini.networkError');
  }
}

async function prepay(code) {
  state.value = 'loading';
  try {
    // 与 miniclient 壳页同一端点（PUBLIC_BASE_URL 部署地址）
    const base = (import.meta.env.VITE_SERVER_ORIGIN || '').replace(/\/$/, '');
    const body = await request(base + '/api/recharge/wechat/miniapp/prepay', { no: orderNo, t: payToken, code });
    const d = body.data || {};
    if (d.already_paid) { state.value = 'ok'; return; }
    if (body.code === 0 && d.pay_params) {
      payParams = d.pay_params; // prepay_id 2 小时内可重复拉起，取消后原地重试
      pullUp();
      return;
    }
    state.value = 'fail';
    msg.value = (body.message && ERR_KEY[body.message] && t(ERR_KEY[body.message])) || body.message || t('pay.mini.orderFailed');
  } catch (e) {
    state.value = 'fail';
    msg.value = t('pay.mini.networkError');
  }
}

function pullUp() {
  state.value = 'paying';
  const p = payParams;
  uni.requestPayment({
    provider: 'wxpay',
    timeStamp: p.timeStamp,
    nonceStr: p.nonceStr,
    package: p.package,
    signType: p.signType || 'RSA',
    paySign: p.paySign,
    success: () => { state.value = 'ok'; },
    fail: (e) => {
      const m = (e && e.errMsg) || '';
      if (m.indexOf('cancel') >= 0) state.value = 'cancel';
      else { state.value = 'fail'; msg.value = t('pay.mini.pullFailed'); }
    },
  });
}

// 重试：已有拉起参数直接再拉起（免重复 code2Session）；否则重走全流程
function retry() {
  if (payParams) pullUp();
  else start();
}
function back() {
  uni.navigateBack({ delta: 1 });
}

onLoad((q) => {
  orderNo = (q && q.no) || '';
  payToken = (q && q.t) || '';
  if (!orderNo || !payToken) {
    state.value = 'fail';
    msg.value = t('pay.mini.missingParams');
    return;
  }
  start();
});
</script>

<template>
  <view class="paymini" :class="theme.rootCls">
    <view class="paymini-card">
      <view v-if="state === 'loading'" class="paymini-state">
        <view class="paymini-spin" />
        <text>{{ t('pay.mini.preparing') }}</text>
      </view>
      <view v-else-if="state === 'paying'" class="paymini-state">
        <text class="paymini-emoji">💳</text>
        <text>{{ t('pay.mini.pulling') }}</text>
      </view>
      <view v-else-if="state === 'ok'" class="paymini-state">
        <text class="paymini-emoji">✅</text>
        <text class="paymini-strong">{{ t('pay.mini.success') }}</text>
        <text class="paymini-sub">{{ t('pay.mini.successSub') }}</text>
        <view class="mbtn sm paymini-btn" @tap="back">{{ t('pay.mini.back') }}</view>
      </view>
      <view v-else-if="state === 'cancel'" class="paymini-state">
        <text class="paymini-emoji">↩️</text>
        <text>{{ t('pay.mini.canceled') }}</text>
        <view class="paymini-acts">
          <view class="mbtn sm" @tap="retry">{{ t('pay.mini.retry') }}</view>
          <view class="mbtn ghost sm" @tap="back">{{ t('common.back') }}</view>
        </view>
      </view>
      <view v-else class="paymini-state">
        <text class="paymini-emoji">⚠️</text>
        <text class="paymini-strong">{{ t('pay.mini.failed') }}</text>
        <text class="paymini-sub">{{ msg }}</text>
        <view class="paymini-acts">
          <view class="mbtn sm" @tap="retry">{{ t('pay.mini.retryShort') }}</view>
          <view class="mbtn ghost sm" @tap="back">{{ t('common.back') }}</view>
        </view>
      </view>
    </view>
    <AdDialog />
  </view>
</template>

<style>
.paymini { min-height: 100vh; background: var(--ad-ink); display: flex; align-items: center; justify-content: center; padding: 24px; }
.paymini-card {
  width: min(340px, 90vw); border-radius: 20px; padding: 28px 22px;
  background: var(--ad-panel); border: 1px solid var(--ad-line);
}
.paymini-state { display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--ad-text); font-size: 14px; text-align: center; }
.paymini-spin {
  width: 30px; height: 30px; border-radius: 50%;
  border: 3px solid rgba(224, 182, 78, 0.2); border-top-color: var(--ad-brand);
  animation: paymini-rotate 0.8s linear infinite;
}
@keyframes paymini-rotate { to { transform: rotate(360deg); } }
.paymini-emoji { font-size: 34px; }
.paymini-strong { font-size: 17px; font-weight: 800; color: var(--ad-text); }
.paymini-sub { font-size: 12px; color: var(--ad-text-mut); }
.paymini-acts { display: flex; gap: 10px; margin-top: 8px; }
.paymini-btn { margin-top: 8px; min-width: 140px; }
</style>
