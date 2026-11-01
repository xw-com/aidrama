<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import QRCode from 'qrcode';
import { rechargeApi } from '../api';
import { ElMessage } from 'element-plus';

const { t } = useI18n();

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  codeUrl: { type: String, default: '' },
  orderId: { type: [Number, String], default: null },
  credits: { type: Number, default: 0 },
  amountYuan: { type: [Number, String], default: '' },
  title: { type: String, default: '' },
  subject: { type: String, default: '' },
  successText: { type: String, default: '' },
  // 自定义轮询：(orderId) => Promise<{ status }>；默认查 rechargeApi.order
  pollFn: { type: Function, default: null },
});
const emit = defineEmits(['update:modelValue', 'paid']);

const qrDataUrl = ref('');
const status = ref('pending'); // pending | paid
const countdown = ref(300); // 二维码有效展示倒计时（秒）
let timer = null;
let cdTimer = null;

// 二维码内容两种形态：weixin:// 原生 Native 码；http(s):// 为 jsapi 模式的 H5 收银台链接
const isCashierLink = computed(() => /^https?:\/\//i.test(props.codeUrl));

async function renderQr() {
  if (!props.codeUrl) return;
  qrDataUrl.value = await QRCode.toDataURL(props.codeUrl, { width: 220, margin: 1, color: { dark: '#1a1a1a', light: '#ffffff' } });
}

function startPolling() {
  stopPolling();
  timer = setInterval(async () => {
    if (!props.orderId) return;
    try {
      const o = props.pollFn ? await props.pollFn(props.orderId) : await rechargeApi.order(props.orderId);
      if (o && o.status === 'paid') {
        status.value = 'paid';
        ElMessage.success(props.successText || t('pay.successDefault'));
        stopPolling();
        setTimeout(() => { emit('update:modelValue', false); emit('paid'); }, 900);
      }
    } catch { /* 轮询失败忽略，下次重试 */ }
  }, 2000);
  cdTimer = setInterval(() => { if (countdown.value > 0) countdown.value -= 1; }, 1000);
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
}

function onClose() {
  stopPolling();
  emit('update:modelValue', false);
}

watch(() => props.modelValue, async (open) => {
  if (open) {
    status.value = 'pending';
    countdown.value = 300;
    await renderQr();
    startPolling();
  } else {
    stopPolling();
  }
});

onBeforeUnmount(stopPolling);
</script>

<template>
  <el-dialog :model-value="modelValue" @update:model-value="onClose" :title="title || t('pay.title')" width="min(360px, 94vw)" :close-on-click-modal="false" align-center>
    <div class="wx-pay">
      <template v-if="status === 'pending'">
        <div class="wx-amt">{{ subject || t('pay.subject') }}<b v-if="credits"> · {{ credits }} {{ t('common.credits') }}</b><b v-if="amountYuan"> · ¥{{ amountYuan }}</b></div>
        <div class="qr-wrap">
          <img v-if="qrDataUrl" :src="qrDataUrl" :alt="t('pay.qrAlt')" class="qr-img" />
        </div>
        <i18n-t :keypath="isCashierLink ? 'pay.h5ScanTip' : 'pay.scanTip'" tag="div" class="wx-tip">
          <template #wechat><span class="green">{{ t('pay.wechat') }}</span></template>
        </i18n-t>
        <div class="wx-subtip">{{ t('pay.autoRefresh', { s: countdown }) }}</div>
      </template>
      <template v-else>
        <el-result icon="success" :title="t('pay.successTitle')" :sub-title="successText || t('pay.successDefault')" />
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.wx-pay { text-align: center; padding: 4px 0 8px; }
.wx-amt { font-size: 15px; color: var(--ad-text-soft); margin-bottom: 14px; }
.wx-amt b { color: var(--ad-text); font-size: 18px; }
.qr-wrap { display: flex; justify-content: center; padding: 12px; border: 1px solid var(--ad-border); border-radius: 12px; width: fit-content; margin: 0 auto; background: #fff; }
.qr-img { width: 220px; height: 220px; display: block; }
.wx-tip { margin-top: 16px; font-size: 15px; color: var(--ad-text); font-weight: 600; }
.green { color: #07c160; }
.wx-subtip { margin-top: 6px; font-size: 12px; color: var(--ad-text-muted); }
</style>
