<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { creditApi, rechargeApi, pricingApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { ElMessage } from 'element-plus';
import WechatPayDialog from '../components/WechatPayDialog.vue';

const { t } = useI18n();
const auth = useAuthStore();
const balance = ref(0);
const orders = ref([]);
const transactions = ref([]);
const packages = ref([]);
const pricing = ref([]);
const loading = ref(false);
const paying = ref(null);

// 支付方式（仅微信支付；未配置时为空，充值入口禁用）
const payMethod = ref('wechat');
const payMethods = ref([]);
const hasWechat = computed(() => payMethods.value.includes('wechat'));
// 微信支付弹窗
const wxDialog = ref(false);
const wxCodeUrl = ref('');
const wxOrderId = ref(null);
const wxCredits = ref(0);

// 积分流水分页：每页 10 条
const TX_SIZE = 10;
const txPage = ref(1);
const txTotal = ref(0);

async function fetchTx() {
  const txs = await creditApi.transactions(txPage.value, TX_SIZE);
  transactions.value = txs.list;
  txTotal.value = txs.total;
}

async function load() {
  loading.value = true;
  try {
    const [bal, ords, pkgs, prc] = await Promise.all([
      creditApi.balance(),
      rechargeApi.orders(),
      rechargeApi.packages(),
      pricingApi.list(),
    ]);
    balance.value = bal.credits;
    auth.credits = bal.credits;
    orders.value = ords;
    packages.value = pkgs.packages;
    pricing.value = prc;
    payMethods.value = Array.isArray(pkgs.payMethods) ? pkgs.payMethods : [];
    if (!payMethods.value.includes(payMethod.value)) payMethod.value = payMethods.value[0] || '';
    await fetchTx();
  } finally {
    loading.value = false;
  }
}

function onTxPageChange(p) {
  txPage.value = p;
  fetchTx();
}

async function pay(pkg) {
  if (!payMethods.value.length) return;
  paying.value = pkg.id;
  try {
    const order = await rechargeApi.create({
      package_id: pkg.id,
      pay_method: payMethod.value,
    });
    // 微信支付：native 拿 code_url（微信原生码）；jsapi 模式拿 pay_url（H5 收银台链接）——
    // 二者都由弹窗画成二维码 + 轮询订单状态，扫码后到账链路相同
    wxCodeUrl.value = order.code_url || order.pay_url;
    wxOrderId.value = order.id;
    wxCredits.value = order.credits;
    wxDialog.value = true;
  } finally {
    paying.value = null;
  }
}

// 微信支付成功回调：刷新余额与流水
function onWechatPaid() {
  load();
  auth.fetchMe();
}

function txType(row) {
  const clsMap = { recharge: 'chip-success', consume: 'chip-warning', refund: 'chip-accent', settle: 'chip-success' };
  const known = !!clsMap[row.type];
  return { txt: known ? t('credits.type.' + row.type) : row.type, cls: clsMap[row.type] || '' };
}

const yuanRate = computed(() => packages.value.length ? 10 : 10); // 1元=10积分（后端固定）

onMounted(load);
</script>

<template>
  <div class="ad-page" v-loading="loading">
    <div class="ad-container">
      <!-- 余额卡片 -->
      <div class="balance-card ad-card">
        <div>
          <div class="ad-sub">{{ t('credits.balanceLabel') }}</div>
          <div class="balance-num">{{ balance.toLocaleString() }}</div>
          <div class="ad-muted">1 {{ t('common.yuan') }} = 10 {{ t('common.credits') }}</div>
        </div>
        <div class="bal-emoji">💰</div>
      </div>

      <!-- 充值套餐 -->
      <div class="section-head">
        <h3 class="section-title">{{ t('credits.rechargePackages') }}</h3>
        <div class="recharge-scope">
          <el-tag v-if="hasWechat" type="success" effect="plain" size="large">{{ t('credits.wechatPay') }}</el-tag>
        </div>
      </div>
      <div v-if="!payMethods.length" class="ad-card no-pay-tip">{{ t('credits.noPaymentConfigured') }}</div>
      <div class="ad-rule cr-rule" />
      <div class="pkg-grid ad-stagger">
        <div v-for="p in packages" :key="p.id" class="pkg-card ad-card" :class="{ hot: p.id === 'p100' }">
          <div v-if="p.bonus" class="hot-tag">{{ t('credits.gift', { n: p.bonus }) }}</div>
          <div class="pkg-label">{{ p.label }}</div>
          <div class="pkg-yuan">¥ {{ p.yuan }}</div>
          <div class="pkg-credits">{{ p.credits }} {{ t('common.credits') }}</div>
          <el-button type="primary" class="btn-ink" :disabled="!payMethods.length" :loading="paying === p.id" @click="pay(p)">{{ t('credits.rechargeNow') }}</el-button>
        </div>
      </div>

      <!-- 定价说明 -->
      <h3 class="section-title">{{ t('credits.pricing') }}</h3>
      <div class="pricing ad-card">
        <div v-for="p in pricing" :key="p.feature" class="price-row">
          <span>{{ p.name }}</span>
          <span class="ad-muted">{{ p.unit_desc }}</span>
          <span class="price-credit">{{ p.credits_per_unit }} {{ t('common.credits') }}</span>
        </div>
      </div>

      <!-- 流水 -->
      <h3 class="section-title">{{ t('credits.transactions') }}</h3>
      <div class="tx-list ad-card">
        <div v-for="t in transactions" :key="t.id" class="tx-row">
          <div>
            <div class="ad-flex-center ad-gap-sm">
              <span class="chip" :class="txType(t).cls">{{ txType(t).txt }}</span>
              <span style="font-size:13px;">{{ t.remark || t.feature || '—' }}</span>
            </div>
            <div class="ad-muted" style="font-size:12px; margin-top:2px;">{{ new Date(t.created_at).toLocaleString() }}</div>
          </div>
          <div class="tx-amt" :class="t.amount >= 0 ? 'plus' : 'minus'">{{ t.amount >= 0 ? '+' : '' }}{{ t.amount }}</div>
        </div>
        <div v-if="!transactions.length" class="ad-muted" style="padding: 24px; text-align:center;">{{ t('credits.noTransactions') }}</div>
        <el-pagination
          v-if="txTotal > 0"
          background
          layout="prev, pager, next, total"
          :pager-count="5"
          :total="txTotal"
          :page-size="TX_SIZE"
          :current-page="txPage"
          @current-change="onTxPageChange"
          class="tx-pager"
        />
      </div>
    </div>

    <!-- 微信支付二维码弹窗 -->
    <WechatPayDialog
      v-model="wxDialog"
      :code-url="wxCodeUrl"
      :order-id="wxOrderId"
      :credits="wxCredits"
      @paid="onWechatPaid"
    />
  </div>
</template>

<style scoped>
/* 余额卡片 */
.balance-card { display: flex; align-items: center; justify-content: space-between; padding: var(--ad-sp-6) var(--ad-sp-7); margin-bottom: 28px; background: var(--ad-brand-gradient); color: var(--ad-brand-contrast); border: none; position: relative; overflow: hidden; }
.balance-card::before { content: ''; position: absolute; top: -80px; right: -60px; width: 220px; height: 220px; border-radius: 50%; background: rgba(255,255,255,0.12); }
.balance-card > * { position: relative; z-index: 1; }
.balance-num { font-family: var(--ad-font-display); font-size: 42px; font-weight: 800; margin: 4px 0; font-variant-numeric: tabular-nums; }
.balance-card .ad-sub, .balance-card .ad-muted { color: color-mix(in srgb, var(--ad-brand-contrast) 72%, transparent); }
.bal-emoji { font-size: 40px; opacity: 0.9; }
.cr-rule { margin-bottom: 16px; }
.section-title { font-size: 18px; font-weight: 700; color: var(--ad-text); margin: 28px 0 14px; }
.no-pay-tip { padding: 18px 22px; color: var(--ad-text-soft); font-size: 14px; text-align: center; border: 1px dashed var(--ad-border); }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.section-head .section-title { margin: 28px 0 14px; }
.pkg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
.pkg-card { padding: 24px 20px; text-align: center; position: relative; transition: all 0.18s; }
.pkg-card:hover { box-shadow: var(--ad-shadow-hover); transform: translateY(-2px); }
.pkg-card.hot { border: 2px solid var(--ad-warning); }
.hot-tag { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: var(--ad-warning); color: var(--ad-brand-contrast); font-size: 12px; padding: 2px 12px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
.pkg-label { color: var(--ad-text-soft); font-size: 14px; }
.pkg-yuan { font-size: 30px; font-weight: 800; color: var(--ad-text); margin: 6px 0; font-variant-numeric: tabular-nums; }
.pkg-credits { color: var(--ad-warning); font-weight: 700; margin-bottom: 14px; }
.pricing { padding: 6px 0; }
.price-row { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--ad-border); }
.price-row:last-child { border-bottom: none; }
.price-row .ad-muted { flex: 1; font-size: 13px; }
.price-credit { font-weight: 700; color: var(--ad-text); }
.tx-list { padding: 6px 0; }
.tx-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--ad-border); }
.tx-row:last-child { border-bottom: none; }
.tx-amt { font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; }
.tx-amt.plus { color: var(--ad-success); }
.tx-amt.minus { color: var(--ad-danger); }
.tx-pager { margin-top: 14px; justify-content: center; display: flex; }
/* 手机：分页条收敛——允许换行、隐藏总条数、缩小按钮，避免撑出显示区 */
@media (max-width: 768px) {
  .tx-pager { flex-wrap: wrap; row-gap: 6px; max-width: 100%; }
  .tx-pager :deep(.el-pagination__total) { display: none; }
  .tx-pager :deep(.el-pager li),
  .tx-pager :deep(.el-pagination .btn-prev),
  .tx-pager :deep(.el-pagination .btn-next) { min-width: 28px; height: 28px; }
}
</style>
