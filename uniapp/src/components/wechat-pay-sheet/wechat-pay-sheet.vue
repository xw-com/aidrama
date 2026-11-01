<script setup>
/**
 * 微信支付弹层（自 client WechatPayDialog + miniclient WechatPaySheet 合并移植）：
 *  - qr     ：H5 非微信浏览器，code_url/pay_url 画二维码 + 轮询订单（qrcode 动态加载，仅 H5 打包）
 *  - jsapi  ：H5 微信内，页面自行 bridgePay；本弹层只展示状态 + 轮询
 *  - miniapp：小程序，弹层展示「去支付/重试」，跳 pages/pay/mini 壳页拉起，回来自动轮询
 * 轮询 rechargeApi.order 到 paid → emit('paid')。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
// 深引纯 JS 核心（core/qrcode.js 无 fs/pngjs 依赖）：主入口 lib/index.js 是 Node 版（require fs），
// 鸿蒙 App 构建不走 package.json 的 browser 字段映射，只能用深引保证各端一致；顺带减小小程序主包体积。
// TextEncoder 兜底须先于 qrcode 引入（qrcode byte-data 依赖；鸿蒙 JSVM 无此全局）
import '../../utils/text-encoder-polyfill.js';
// 静态引入：动态 import 在 App 端 iife 构建不支持分包
import QRCode from 'qrcode/lib/core/qrcode.js';
import { rechargeApi } from '../../api';
import { toast } from '../../utils/ui';
import { bridgePay } from '../../utils/wxpay';
import AdSheet from '../ad-sheet/ad-sheet.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'qr' }, // qr | jsapi | miniapp
  codeUrl: { type: String, default: '' },
  payParams: { type: Object, default: null }, // JSAPI 拉起参数（create 返回的 pay_params）
  orderId: { type: [Number, String], default: null },
  credits: { type: Number, default: 0 }, // 套餐基础积分
  yuan: { type: [Number, String], default: 0 }, // 套餐价格（¥）
  bonus: { type: Number, default: 0 }, // 赠送积分
  miniNo: { type: String, default: '' },   // 小程序壳支付页参数（order_no）
  miniToken: { type: String, default: '' }, // 小程序壳支付页参数（pay_token）
});
const emit = defineEmits(['update:show', 'paid']);

const { t } = useI18n();
// 二维码模块矩阵（每行一个 01 串）：QRCode.create 纯 JS 出点阵，各端通用 ——
// 之前用 toDataURL 画 canvas 仅 H5 可用，App/小程序端二维码永远停在「加载中」
const qrRows = ref([]);
const qrError = ref(false); // 点阵生成失败（如旧包 qrcode 入口解析到 Node 版）：给重试入口而非永久「加载中」
const qrErrMsg = ref(''); // 具体报错（App 端看不到 console，直接展示在重试下方定位）
const status = ref('pending'); // pending | paid
const countdown = ref(300);
let timer = null;
let cdTimer = null;

const isCashierLink = computed(() => /^https?:\/\//i.test(props.codeUrl));

// JSAPI（微信内 H5）：进场即 WeixinJSBridge 拉起；取消/失败可在弹层原地重试（prepay_id 2 小时内有效）
async function pullUpJsapi() {
  if (!props.payParams) return;
  await bridgePay(props.payParams);
  // 结果不在此收口：到账由订单轮询确认；取消/失败给用户「重新拉起」入口
}

async function renderQr() {
  if (!props.codeUrl) return;
  qrError.value = false;
  try {
    const qr = QRCode.create(props.codeUrl, { errorCorrectionLevel: 'M' });
    const { size, data } = qr.modules;
    const rows = [];
    for (let r = 0; r < size; r++) {
      // 行数据用字符数组：v-for 直接遍历字符串在部分 App 端运行时不支持，数组各端一致
      const row = new Array(size);
      for (let c = 0; c < size; c++) row[c] = data[r * size + c] ? '1' : '0';
      rows.push(row);
    }
    qrRows.value = rows;
  } catch (e) {
    console.error('[wechat-pay-sheet] QRCode.create failed:', e);
    qrErrMsg.value = (e && (e.message || String(e))) || 'unknown';
    qrRows.value = [];
    qrError.value = true;
  }
}

function startPolling() {
  stopPolling();
  timer = setInterval(async () => {
    if (!props.orderId) return;
    try {
      const o = await rechargeApi.order(props.orderId);
      if (o && o.status === 'paid') {
        status.value = 'paid';
        toast(t('pay.successDefault'), 'success');
        stopPolling();
        setTimeout(() => { emit('update:show', false); emit('paid'); }, 900);
      }
    } catch (e) { /* 轮询失败忽略，下次重试 */ }
  }, 2000);
  cdTimer = setInterval(() => { if (countdown.value > 0) countdown.value -= 1; }, 1000);
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
}

function close() {
  stopPolling();
  emit('update:show', false);
}

// 小程序：跳壳支付页（pages/pay/mini 拉起 wx.requestPayment；失败可在壳页原地重试），
// 支付结果由本弹层轮询确认（web-view/壳页与逻辑层无实时回传通道）
function jumpMiniPay() {
  if (!props.miniNo || !props.miniToken) {
    toast(t('pay.tokenMissing'), 'error');
    return;
  }
  uni.navigateTo({ url: `/pages/pay/mini?no=${encodeURIComponent(props.miniNo)}&t=${encodeURIComponent(props.miniToken)}` });
}

watch(() => props.show, async (open) => {
  if (open) {
    status.value = 'pending';
    countdown.value = 300;
    qrRows.value = [];
    qrError.value = false;
    qrErrMsg.value = '';
    await renderQr();
    startPolling();
    // 进场即拉起：小程序跳壳页 / 微信内 JSAPI 桥接（miniclient 同约定）
    /* #ifdef MP-WEIXIN */
    if (props.mode === 'miniapp') jumpMiniPay();
    /* #endif */
    /* #ifdef H5 */
    if (props.mode === 'jsapi') pullUpJsapi();
    /* #endif */
  } else {
    stopPolling();
  }
});

onBeforeUnmount(stopPolling);
</script>

<template>
  <AdSheet :show="show" :title="t('pay.title')" :closable="status !== 'paid'" @update:show="show ? close() : null">
    <view class="wps">
      <template v-if="status === 'pending'">
        <view class="wps-amt"><text v-if="yuan" class="wps-b">¥{{ yuan }}</text><text v-if="credits"> = {{ credits }}<text v-if="bonus" class="wps-bonus">+{{ bonus }}</text> {{ t('common.credits') }}</text></view>

        <!-- 小程序模式：状态 + 去支付/重试 -->
        <template v-if="mode === 'miniapp'">
          <view class="wps-mini">
            <m-icon name="wallet" :size="34" />
            <view class="wps-tip">{{ t('pay.miniappTip') }}</view>
          </view>
          <view class="mbtn wps-go" @tap="jumpMiniPay">{{ t('pay.miniappGo') }}</view>
        </template>

        <!-- JSAPI 模式（微信内 H5）：进场已桥接拉起，留重试入口 -->
        <template v-else-if="mode === 'jsapi'">
          <view class="wps-mini">
            <m-icon name="wallet" :size="34" />
            <view class="wps-tip">{{ t('pay.jsapiTip') }}</view>
          </view>
          <view class="mbtn ghost sm wps-go" @tap="pullUpJsapi">{{ t('pay.retryPay') }}</view>
        </template>

        <!-- 二维码模式 -->
        <template v-else>
          <view class="wps-qrwrap">
            <view v-if="qrRows.length" class="wps-qr-grid">
              <view v-for="(row, r) in qrRows" :key="r" class="wps-qr-row">
                <view v-for="(c, ci) in row" :key="ci" class="wps-qr-cell" :class="{ on: c === '1' }" />
              </view>
            </view>
            <view v-else class="wps-qr wps-qr-empty">
              <text v-if="!qrError">{{ t('common.loading') }}</text>
              <template v-else>
                <view class="mbtn ghost sm" @tap="renderQr">{{ t('common.retry') }}</view>
                <text class="wps-errmsg">{{ qrErrMsg }}</text>
              </template>
            </view>
          </view>
          <view class="wps-tip">{{ isCashierLink ? t('pay.h5ScanTip', { wechat: t('pay.wechat') }) : t('pay.scanTip', { wechat: t('pay.wechat') }) }}</view>
          <view class="wps-subtip">{{ t('pay.autoRefresh', { s: countdown }) }}</view>
        </template>
      </template>

      <template v-else>
        <view class="wps-ok">
          <m-icon name="check" :size="40" :sw="2.4" />
          <view class="wps-ok-title">{{ t('pay.successTitle') }}</view>
          <view class="wps-ok-sub">{{ t('pay.successDefault') }}</view>
        </view>
      </template>
    </view>
  </AdSheet>
</template>

<style scoped>
.wps { text-align: center; padding: 2px 0 8px; }
.wps-amt { font-size: 14px; color: var(--ad-text-soft); margin-bottom: 14px; }
.wps-b { color: var(--ad-text); font-size: 16px; font-weight: 800; }
.wps-bonus { color: var(--ad-accent); }
.wps-qrwrap { display: flex; justify-content: center; padding: 12px; border: 1px solid var(--ad-line); border-radius: 14px; width: fit-content; margin: 0 auto; background: #fff; }
.wps-qr-grid { width: 210px; height: 210px; display: flex; flex-direction: column; }
.wps-qr-row { flex: 1; display: flex; flex-direction: row; }
.wps-qr-cell { flex: 1; }
.wps-qr-cell.on { background: #1a1a1a; }
.wps-qr-empty { width: 210px; height: 210px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--ad-text-mut); font-size: 12px; }
.wps-errmsg { max-width: 190px; font-size: 10px; color: #c0392b; word-break: break-all; line-height: 1.4; }
.wps-tip { margin-top: 14px; font-size: 14px; color: var(--ad-text); font-weight: 600; line-height: 1.6; }
.wps-subtip { margin-top: 6px; font-size: 12px; color: var(--ad-text-mut); }
.wps-mini { padding: 20px 0 8px; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--ad-brand); }
.wps-go { margin-top: 14px; }
.wps-ok { padding: 20px 0; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--ad-accent); }
.wps-ok-title { font-size: 18px; font-weight: 800; color: var(--ad-text); }
.wps-ok-sub { font-size: 12px; color: var(--ad-text-mut); }
</style>
