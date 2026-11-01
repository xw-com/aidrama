<script setup>
/**
 * 积分中心：余额卡 + 充值套餐 + 定价说明 + 流水（触底分页）。
 * 支付分端（自 miniclient CreditsView 移植）：
 *  - 小程序：channel=miniapp 下单拿 pay_token → 弹层跳壳支付页拉起
 *  - 微信内 H5（jsapi 模式）：静默授权拿 openid → 弹层 WeixinJSBridge 拉起（回跳自动续起）
 *  - 其余（PC 浏览器 / native 模式）：code_url 或收银台链接画二维码 + 轮询
 */
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { creditApi, rechargeApi, pricingApi } from '../../api';
import { API_ORIGIN } from '../../api/config';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { toast } from '../../utils/ui';
import { isIosApp } from '../../utils/system';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import { inWechat, ensureOpenid, consumeAuthCode, takePendingWxPay } from '../../utils/wxpay';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import WechatPaySheet from '../../components/wechat-pay-sheet/wechat-pay-sheet.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();

// App Store 3.1.1 合规：iOS App 端禁应用内充值/支付入口，改为「网页版充值」引导卡
//（余额/定价/流水仍正常展示；402 全局引导在 api/http.js 同步分流）
const iosBlocked = isIosApp();
const webOrigin = API_ORIGIN;
function copyWebUrl() {
  uni.setClipboardData({
    data: webOrigin,
    success: () => toast(t('credits.ios.copied'), { icon: 'none' }),
  });
}

const loading = ref(false);
const balance = ref(0);
const packages = ref([]);
const pricing = ref([]);
const payMethods = ref([]);
const wechatPayMode = ref('native');
const wechatMiniappPay = ref(false);
const paying = ref('');


// 支付弹层状态（miniclient wx 对象同构）
const payShow = ref(false);
const payMode = ref('qr');
const codeUrl = ref('');
const payParams = ref(null);
const orderId = ref(null);
const orderPkg = ref(null); // 点中的套餐（弹层展示 ¥x = 积分+赠送 用）
const miniNo = ref('');
const miniToken = ref('');

const TX_SIZE = 15;
const txPage = ref(0);
const txTotal = ref(0);
const transactions = ref([]);
const txLoading = ref(false);
let txGen = 0;

async function loadTx() {
  const myGen = ++txGen;
  txLoading.value = true;
  try {
    const res = await creditApi.transactions(txPage.value + 1, TX_SIZE);
    if (myGen !== txGen) return; // 作废在途请求
    transactions.value = txPage.value === 0 ? (res.list || []) : transactions.value.concat(res.list || []);
    txTotal.value = res.total || 0;
  } catch { /* http 层已提示 */ }
  finally { if (myGen === txGen) txLoading.value = false; }
}

async function load() {
  loading.value = true;
  try {
    const [bal, pkgs, prc] = await Promise.all([
      creditApi.balance(),
      rechargeApi.packages(),
      pricingApi.list(),
    ]);
    balance.value = bal.credits;
    auth.credits = bal.credits;
    packages.value = pkgs.packages || [];
    pricing.value = prc || [];
    payMethods.value = Array.isArray(pkgs.payMethods) ? pkgs.payMethods : [];
    wechatPayMode.value = pkgs.wechatPayMode || 'native';
    wechatMiniappPay.value = !!pkgs.wechatMiniappPay;
    txGen += 1; // 作废在途流水请求
    txPage.value = 0;
    transactions.value = [];
  } catch { /* http 层已提示 */ }
  finally { loading.value = false; }
  await loadTx();
}

function canPay() {
  if (!payMethods.value.length) { toast(t('credits.noPaymentConfigured'), 'error'); return false; }
  return true;
}

async function pay(pkg) {
  if (!canPay()) return;
  // #ifdef MP-WEIXIN
  return payMiniapp(pkg);
  // #endif
  // #ifdef H5
  if (wechatPayMode.value === 'jsapi' && inWechat()) return payJsapi(pkg);
  return payQr(pkg);
  // #endif
  // #ifndef H5 || MP-WEIXIN
  return payQr(pkg);
  // #endif
}

function openSheet({ mode, order, pkg = null, url = '', params = null, no = '', token = '' }) {
  payMode.value = mode;
  codeUrl.value = url;
  payParams.value = params;
  orderId.value = order.id;
  orderPkg.value = pkg;
  miniNo.value = no;
  miniToken.value = token;
  payShow.value = true;
}

// 小程序支付：本步只落单拿 pay_token（服务端不向微信提交），拉起由弹层跳壳页完成
async function payMiniapp(pkg) {
  paying.value = pkg.id;
  try {
    const order = await rechargeApi.create({ package_id: pkg.id, pay_method: 'wechat', channel: 'miniapp' });
    openSheet({ mode: 'miniapp', order, pkg, no: order.order_no, token: order.pay_token });
  } catch { /* http 层已提示 */ }
  finally { paying.value = ''; }
}

// 微信内 H5：ensureOpenid 可能整页跳授权（回跳后 onMounted 续起）
async function payJsapi(pkg) {
  paying.value = pkg.id;
  try {
    const openid = await ensureOpenid({ package_id: pkg.id });
    const order = await rechargeApi.create({ package_id: pkg.id, pay_method: 'wechat', openid });
    if (order.pay_params) openSheet({ mode: 'jsapi', order, pkg, params: order.pay_params });
    else openSheet({ mode: 'qr', order, pkg, url: order.pay_url || order.code_url || '' });
  } catch { /* http 层已提示 */ }
  finally { paying.value = ''; }
}

async function payQr(pkg) {
  paying.value = pkg.id;
  try {
    const order = await rechargeApi.create({ package_id: pkg.id, pay_method: 'wechat' });
    // native：code_url（微信原生码）；jsapi 模式非微信环境：pay_url（H5 收银台链接）
    openSheet({ mode: 'qr', order, pkg, url: order.code_url || order.pay_url || '' });
  } catch { /* http 层已提示 */ }
  finally { paying.value = ''; }
}

// 支付成功：刷新余额与流水
function onPaid() {
  load();
  auth.refreshCredits();
}

const TX_CLS = { recharge: 'ok', consume: 'warn', refund: 'gold', settle: 'ok' };
function txType(row) {
  const known = !!TX_CLS[row.type];
  return { txt: known ? t('credits.type.' + row.type) : row.type, cls: TX_CLS[row.type] || 'glass' };
}
function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(async () => {
  await load();
  // JSAPI 授权回跳：消费 code 换 openid；有跳授权前的充值意图则自动续起
  /* #ifdef H5 */
  try {
    const openid = await consumeAuthCode();
    const pending = takePendingWxPay();
    const pkg = openid && pending && packages.value.find((p) => p.id === pending.package_id);
    if (pkg) pay(pkg);
  } catch { /* 授权失败静默，用户可手动重试 */ }
  /* #endif */
});

onPullDownRefresh(async () => { try { await load(); } finally { uni.stopPullDownRefresh(); } });
onReachBottom(() => {
  if (txLoading.value || transactions.value.length >= txTotal.value) return;
  txPage.value += 1;
  loadTx();
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('route.credits')" />

    <!-- 余额卡 -->
    <view class="cr-bal card">
      <view class="cr-bal-l">
        <text class="ad-sub">{{ t('credits.balanceLabel') }}</text>
        <text class="cr-bal-num mono">{{ Number(balance || 0) }}</text>
        <text class="cr-bal-hint">1 {{ t('common.yuan') }} = 10 {{ t('common.credits') }}</text>
      </view>
      <text class="cr-bal-emoji">💰</text>
    </view>

    <!-- 套餐（iOS App 端不渲染：App Store 3.1.1 禁应用内充值，改引导网页版） -->
    <template v-if="!iosBlocked">
      <view class="sect-title">{{ t('credits.rechargePackages') }}</view>
      <view v-if="!payMethods.length" class="card cr-nopay">{{ t('credits.noPaymentConfigured') }}</view>
      <view class="pkggrid">
        <view v-for="p in packages" :key="p.id" class="card pkg" :class="{ hot: p.id === 'p100' }">
          <view v-if="p.bonus" class="pkg-gift">{{ t('credits.gift', { n: p.bonus }) }}</view>
          <text class="pkg-label">{{ p.label }}</text>
          <text class="pkg-yuan mono">¥{{ p.yuan }}</text>
          <view class="pkg-creditsrow">
            <text class="pkg-credits mono">{{ p.credits }}<text v-if="p.bonus" class="pkg-bonus">+{{ p.bonus }}</text></text>
            <text class="pkg-credits-unit">{{ t('common.credits') }}</text>
          </view>
          <view class="mbtn sm pkg-btn" @tap="pay(p)">
            <text v-if="paying === p.id" class="pkg-spin" />
            <text>{{ t('credits.rechargeNow') }}</text>
          </view>
        </view>
      </view>
    </template>

    <!-- iOS App 端充值引导卡 -->
    <template v-else>
      <view class="sect-title">{{ t('credits.rechargePackages') }}</view>
      <view class="card cr-ios">
        <text class="cr-ios-emoji">📲</text>
        <text class="cr-ios-title">{{ t('credits.ios.title') }}</text>
        <text class="cr-ios-desc">{{ t('credits.ios.desc') }}</text>
        <view class="mbtn sm cr-ios-btn" @tap="copyWebUrl">
          <text>{{ t('credits.ios.copy') }}</text>
        </view>
        <text class="cr-ios-url mono">{{ webOrigin }}</text>
      </view>
    </template>

    <!-- 定价 -->
    <view class="sect-title">{{ t('credits.pricing') }}</view>
    <view class="card">
      <view v-for="p in pricing" :key="p.feature" class="prow">
        <text class="prow-name">{{ p.name }}</text>
        <text class="prow-unit">{{ p.unit_desc }}</text>
        <text class="prow-price mono">{{ p.credits_per_unit }} {{ t('common.credits') }}</text>
      </view>
      <view v-if="!pricing.length" class="cr-emptytx"><text>{{ loading ? t('common.loading') : t('common.noData') }}</text></view>
    </view>

    <!-- 流水 -->
    <view class="sect-title">{{ t('credits.transactions') }}</view>
    <view class="card">
      <view v-for="tx in transactions" :key="tx.id" class="txrow">
        <view class="tx-l">
          <view class="tx-line">
            <text class="chip sm" :class="txType(tx).cls">{{ txType(tx).txt }}</text>
            <text class="tx-remark">{{ tx.remark || tx.feature || '—' }}</text>
          </view>
          <text class="tx-time">{{ fmtTime(tx.created_at) }}</text>
        </view>
        <text class="tx-amt mono" :class="tx.amount >= 0 ? 'plus' : 'minus'">{{ tx.amount >= 0 ? '+' : '' }}{{ tx.amount }}</text>
      </view>
      <view v-if="!transactions.length && !txLoading" class="cr-emptytx"><text>{{ t('credits.noTransactions') }}</text></view>
      <view v-if="txLoading" class="cr-emptytx"><text>{{ t('common.loading') }}</text></view>
      <view v-if="!txLoading && transactions.length >= txTotal && transactions.length" class="cr-endfoot"><text>{{ t('mobile.common.noMore') }}</text></view>
    </view>
    <view style="height: 30px" />

    <WechatPaySheet
      v-model:show="payShow"
      :mode="payMode"
      :code-url="codeUrl"
      :pay-params="payParams"
      :order-id="orderId"
      :yuan="orderPkg ? orderPkg.yuan : 0"
      :credits="orderPkg ? orderPkg.credits : 0"
      :bonus="orderPkg ? orderPkg.bonus : 0"
      :mini-no="miniNo"
      :mini-token="miniToken"
      @paid="onPaid"
    />
    <AdToast />
    <AdDialog />
  </view>
</template>

<style scoped>
.cr-bal { display: flex; align-items: center; justify-content: space-between; padding: 20px; margin-top: 20px;}
.cr-bal-l { display: flex; flex-direction: column; gap: 6px; }
.cr-bal-num { font-size: 34px; font-weight: 800; color: var(--ad-text); line-height: 1.1; }
.cr-bal-hint { font-size: 12px; color: var(--ad-text-mut); }
.cr-bal-emoji { font-size: 38px; }

.sect-title { font-family: var(--ad-serif); font-size: 16px; font-weight: 700; color: var(--ad-text); margin: 20px 12px 12px; }
/* 企业池充值范围开关（manager 点切）/成员只读说明 */
.cr-nopay { padding: 18px; font-size: 13px; color: var(--ad-text-mut); text-align: center; }

/* iOS App 端充值引导卡（App Store 3.1.1） */
.cr-ios {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 26px 20px; margin-bottom: 14px; text-align: center;
}
.cr-ios-emoji { font-size: 34px; }
.cr-ios-title { font-family: var(--ad-serif); font-size: 16px; font-weight: 700; color: var(--ad-text); }
.cr-ios-desc { font-size: 13px; line-height: 1.7; color: var(--ad-text-soft); }
.cr-ios-btn { min-width: 160px; margin-top: 4px; }
.cr-ios-url { font-size: 11px; color: var(--ad-text-mut); word-break: break-all; }

/* 套餐两列铺满全宽（flex + space-between 比 grid 跨端兼容性更稳）；卡片抵消 .card 的 margin/overflow，角标才能悬浮在卡片上缘。
   间距走 grid 的 gap：末行卡片下不留残边（margin 方案会让底部空隙多出 10px） */
.pkggrid { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin: 0 0 14px; padding-top: 10px; }
.pkg {
  width: calc(50% - 30px);
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 20px 10px 16px; text-align: center; overflow: visible;
}
.pkg.hot { border-color: rgba(224, 182, 78, 0.55); box-shadow: 0 0 0 1px rgba(224, 182, 78, 0.25), var(--ad-sh-card); }
.pkg-gift {
  position: absolute; top: 0; left: 50%; transform: translate(-50%, -50%);
  font-size: 10px; font-weight: 700; color: #0a0a0f; white-space: nowrap;
  background: linear-gradient(135deg, #f2d489, #e0b64e);
  border-radius: 999px; padding: 3px 10px;
}
.pkg-label { font-size: 12px; color: var(--ad-text-soft); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 价格为卡片主视觉，积分数退居其下：xxx+xx（+后为赠送） */
.pkg-yuan { font-size: 24px; font-weight: 800; color: var(--ad-brand); line-height: 1.2; }
.pkg-credits { font-size: 15px; font-weight: 700; color: var(--ad-text-soft); line-height: 1.2; }
.pkg-bonus { color: var(--ad-accent); }
/* 积分数与「积分」单位同行，基线对齐 */
.pkg-creditsrow { display: flex; align-items: baseline; gap: 3px; }
.pkg-credits-unit { font-size: 11px; color: var(--ad-text-mut); }
.pkg-btn { margin-top: auto; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; }
.pkg-spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid rgba(10, 10, 15, 0.25); border-top-color: #0a0a0f;
  animation: pkg-rotate 0.8s linear infinite;
}
@keyframes pkg-rotate { to { transform: rotate(360deg); } }

/* 分隔线用「相邻行加上边框」而非底边框 + :last-child 去线：卡内混有 loading/空态节点时 :last-child/:last-of-type 会失配，末行多出一条线 */
.prow { display: flex; align-items: center; gap: 8px; padding: 11px 12px; font-size: 13px; }
.prow + .prow { border-top: 1px solid var(--ad-line); }
/* 名称可收缩截断，防止超长名称把单价挤出卡片 */
.prow-name { color: var(--ad-text); flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prow-unit { color: var(--ad-text-mut); font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prow-price { color: var(--ad-brand); font-weight: 700; flex-shrink: 0; }

.txrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 12px; }
.txrow + .txrow { border-top: 1px solid var(--ad-line); }
.tx-l { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tx-line { display: flex; align-items: center; gap: 8px; }
/* min-width:0 是 flex 内 ellipsis 生效的关键，长备注不再把金额挤出卡外 */
.tx-remark { font-size: 13px; color: var(--ad-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-time { font-size: 11px; color: var(--ad-text-mut); }
.tx-amt { font-size: 15px; font-weight: 800; flex-shrink: 0; }
.tx-amt.plus { color: var(--ad-accent); }
.tx-amt.minus { color: var(--ad-text); }

.cr-emptytx { padding: 22px 0; text-align: center; color: var(--ad-text-mut); font-size: 12px; }
.cr-endfoot { padding: 10px 0 2px; text-align: center; color: var(--ad-text-mut); font-size: 11px; }
</style>
