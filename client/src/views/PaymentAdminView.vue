<script setup>
// 支付管理 admin：充值订单 / 积分流水（含人工调整）/ 充值档位与汇率 / 支付配置（脱敏只读）
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { paymentAdminApi } from '../api';

const { t } = useI18n();

const activeTab = ref('orders');

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '-');
const fmtYuan = (v) => (v === null || v === undefined ? '-' : `¥${Number(v).toFixed(2)}`);
const displayName = (u) => (u ? (u.nickname || u.username || `#${u.id}`) : '-');

// ===== 充值订单 =====
const orders = ref([]);
const ordersTotal = ref(0);
const ordersPage = ref(1);
const ordersSize = 20;
const ordersLoading = ref(false);
const orderStatus = ref('');
const orderKeyword = ref('');
const orderRange = ref(null);

const orderStatusType = (s) => ({ pending: 'warning', paid: 'success', failed: 'danger', canceled: 'info' }[s] || 'info');

async function loadOrders() {
  ordersLoading.value = true;
  try {
    const params = { page: ordersPage.value, size: ordersSize };
    if (orderStatus.value) params.status = orderStatus.value;
    if (orderKeyword.value.trim()) params.keyword = orderKeyword.value.trim();
    if (orderRange.value?.length === 2) {
      params.start = orderRange.value[0];
      params.end = orderRange.value[1];
    }
    const data = await paymentAdminApi.orders(params);
    orders.value = data.list || [];
    ordersTotal.value = data.total || 0;
  } finally {
    ordersLoading.value = false;
  }
}

function searchOrders() { ordersPage.value = 1; loadOrders(); }

// ===== 原路退款（微信 V3 /v3/refund；仅已支付且未在退款中的订单可发起）=====
const refundVisible = ref(false);
const refundSaving = ref(false);
const refundForm = reactive({ order_no: '', max: 0, amount: null, reason: '' });

const refundStatusType = (s) => ({ processing: 'warning', refunded: 'info', failed: 'danger' }[s] || 'info');

function openRefund(row) {
  refundForm.order_no = row.order_no;
  refundForm.max = Number(row.amount_yuan) || 0;
  refundForm.amount = Number(refundForm.max.toFixed(2));
  refundForm.reason = '';
  refundVisible.value = true;
}

async function submitRefund() {
  const amount = Math.round((Number(refundForm.amount) || 0) * 100) / 100;
  if (!(amount > 0) || amount > refundForm.max) {
    ElMessage.error(t('paymentAdmin.refund.badAmount'));
    return;
  }
  refundSaving.value = true;
  try {
    await paymentAdminApi.refund(refundForm.order_no, { amount, reason: refundForm.reason });
    ElMessage.success(t('paymentAdmin.refund.accepted'));
    refundVisible.value = false;
    loadOrders();
  } finally {
    refundSaving.value = false;
  }
}

// 受理中 → 主动向微信查单收敛终态
async function refreshRefund(row) {
  await paymentAdminApi.refundStatus(row.order_no);
  loadOrders();
}

// ===== 积分流水 =====
const txs = ref([]);
const txsTotal = ref(0);
const txsPage = ref(1);
const txsSize = 20;
const txsLoading = ref(false);
const txType = ref('');
const txUserId = ref(null);
const txRefId = ref('');
const txRange = ref(null);

const txTypeTag = (s) => ({ recharge: 'success', consume: 'warning', refund: 'info', settle: 'success', adjust: 'danger' }[s] || 'info');

async function loadTxs() {
  txsLoading.value = true;
  try {
    const params = { page: txsPage.value, size: txsSize };
    if (txType.value) params.type = txType.value;
    if (txUserId.value) params.user_id = txUserId.value;
    if (txRefId.value.trim()) params.ref_id = txRefId.value.trim();
    if (txRange.value?.length === 2) {
      params.start = txRange.value[0];
      params.end = txRange.value[1];
    }
    const data = await paymentAdminApi.transactions(params);
    txs.value = data.list || [];
    txsTotal.value = data.total || 0;
  } finally {
    txsLoading.value = false;
  }
}

function searchTxs() { txsPage.value = 1; loadTxs(); }

// ===== 人工调整 =====
const adjustVisible = ref(false);
const adjustSaving = ref(false);
const adjustForm = reactive({ user_id: null, dir: 'add', amount: null, remark: '' });

function openAdjust() {
  adjustForm.user_id = null;
  adjustForm.dir = 'add';
  adjustForm.amount = null;
  adjustForm.remark = '';
  adjustVisible.value = true;
}

async function submitAdjust() {
  // 积分一位小数精度：支持 0.1 步进
  const n = Math.round((Number(adjustForm.amount) || 0) * 10) / 10;
  if (!adjustForm.user_id || !Number.isFinite(Number(adjustForm.amount)) || n <= 0 || !adjustForm.remark.trim()) {
    ElMessage.warning(t('paymentAdmin.adjust.fillAll'));
    return;
  }
  try {
    await ElMessageBox.confirm(
      t('paymentAdmin.adjust.confirmText', {
        dir: t(`paymentAdmin.adjust.dir_${adjustForm.dir}`),
        amount: n,
        user: adjustForm.user_id,
      }),
      t('paymentAdmin.adjust.title'),
      { type: 'warning' },
    );
  } catch { return; }
  adjustSaving.value = true;
  try {
    const data = await paymentAdminApi.adjust({
      user_id: adjustForm.user_id,
      amount: adjustForm.dir === 'add' ? n : -n,
      remark: adjustForm.remark.trim(),
    });
    ElMessage.success(t('paymentAdmin.adjust.done', { balance: data.credits }));
    adjustVisible.value = false;
    loadTxs();
  } finally {
    adjustSaving.value = false;
  }
}

// ===== 充值档位与汇率 =====
const pkgLoading = ref(false);
const pkgSaving = ref(false);
const pkgRate = ref(10);
const pkgList = ref([]);

// 积分一位小数精度：档位积分/赠送积分支持 0.1 步进（×10 后须为整数）
const isCredit = (v) => Number.isFinite(Number(v)) && Math.round(Number(v) * 10) === Number(v) * 10;
const pkgFormValid = computed(() => pkgList.value.every((p) => (
  /^[a-z0-9_]{1,32}$/.test(p.id)
  && Number(p.yuan) > 0
  && isCredit(p.credits) && Number(p.credits) >= 0
  && isCredit(p.bonus) && Number(p.bonus) >= 0
  && p.label.trim().length > 0
)));

async function loadPackages() {
  pkgLoading.value = true;
  try {
    const data = await paymentAdminApi.packages();
    pkgRate.value = data.yuan_per_credit;
    pkgList.value = (data.packages || []).map((p) => ({ ...p }));
    payEnabled.value = !!data.enabled;
  } finally {
    pkgLoading.value = false;
  }
}

function addPackage() {
  pkgList.value.push({ id: `p${Date.now().toString(36)}`, yuan: 1, credits: 10, bonus: 0, label: '' });
}

function removePackage(idx) {
  pkgList.value.splice(idx, 1);
}

async function savePackages() {
  if (!pkgList.value.length || !pkgFormValid.value) {
    ElMessage.warning(t('paymentAdmin.pkg.invalid'));
    return;
  }
  try {
    await ElMessageBox.confirm(t('paymentAdmin.pkg.confirmText'), t('paymentAdmin.pkg.save'), { type: 'warning' });
  } catch { return; }
  pkgSaving.value = true;
  try {
    const data = await paymentAdminApi.savePackages({
      yuan_per_credit: pkgRate.value,
      packages: pkgList.value.map((p) => ({
        id: p.id.trim(),
        yuan: Number(p.yuan),
        credits: Number(p.credits),
        bonus: Number(p.bonus) || 0,
        label: p.label.trim(),
      })),
    });
    pkgRate.value = data.yuan_per_credit;
    pkgList.value = (data.packages || []).map((p) => ({ ...p }));
    ElMessage.success(t('paymentAdmin.pkg.saved'));
    loadPayConfig();
  } finally {
    pkgSaving.value = false;
  }
}

// ===== 支付配置（脱敏只读） =====
const payLoading = ref(false);
const payEnabled = ref(false);
const payConfig = ref(null);

async function loadPayConfig() {
  payLoading.value = true;
  try {
    payConfig.value = await paymentAdminApi.payConfig();
    payEnabled.value = !!payConfig.value?.enabled;
  } finally {
    payLoading.value = false;
  }
}

onMounted(() => {
  loadOrders();
  loadTxs();
  loadPackages();
  loadPayConfig();
});
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('paymentAdmin.title') }}</div>
        <div class="ad-sub">{{ t('paymentAdmin.subtitle') }}</div>
      </div>
      <div class="ad-rule pa-rule" />

      <el-tabs v-model="activeTab">
        <!-- 充值订单 -->
        <el-tab-pane :label="t('paymentAdmin.tab.orders')" name="orders">
          <div class="ad-card pa-block">
            <div class="pa-filters">
              <el-select v-model="orderStatus" clearable :placeholder="t('paymentAdmin.f.status')" style="width: 130px;" @change="searchOrders">
                <el-option v-for="s in ['pending', 'paid', 'failed', 'canceled']" :key="s" :value="s" :label="t(`paymentAdmin.status.${s}`)" />
              </el-select>
              <el-input v-model="orderKeyword" clearable :placeholder="t('paymentAdmin.f.keyword')" style="width: 220px;" @keyup.enter="searchOrders" @clear="searchOrders" />
              <el-date-picker v-model="orderRange" type="daterange" value-format="YYYY-MM-DD" :start-placeholder="t('paymentAdmin.f.start')" :end-placeholder="t('paymentAdmin.f.end')" style="width: 260px;" @change="searchOrders" />
              <el-button @click="searchOrders"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
            </div>
            <div class="pa-table-wrap" v-loading="ordersLoading">
              <el-table :data="orders" size="small">
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column prop="order_no" label="Order No" min-width="180" show-overflow-tooltip />
                <el-table-column :label="t('paymentAdmin.c.user')" min-width="120" show-overflow-tooltip>
                  <template #default="{ row }">{{ displayName(row.user) }}</template>
                </el-table-column>
                <el-table-column :label="t('paymentAdmin.c.amount')" width="90">
                  <template #default="{ row }">{{ fmtYuan(row.amount_yuan) }}</template>
                </el-table-column>
                <el-table-column prop="credits" :label="t('paymentAdmin.c.credits')" width="80" />
                <el-table-column :label="t('paymentAdmin.c.status')" width="150">
                  <template #default="{ row }">
                    <el-tag :type="orderStatusType(row.status)" size="small" effect="plain">{{ t(`paymentAdmin.status.${row.status}`) }}</el-tag>
                    <el-tag v-if="row.refund_status" :type="refundStatusType(row.refund_status)" size="small" effect="plain" style="margin-left: 4px;">{{ t(`paymentAdmin.refund.st_${row.refund_status}`) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="transaction_id" :label="t('paymentAdmin.c.transactionId')" min-width="160" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.transaction_id || '-' }}</template>
                </el-table-column>
                <el-table-column :label="t('paymentAdmin.c.paidAt')" width="160">
                  <template #default="{ row }">{{ fmtTime(row.paid_at) }}</template>
                </el-table-column>
                <el-table-column :label="t('common.createdAt')" width="160">
                  <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
                </el-table-column>
                <el-table-column :label="t('paymentAdmin.c.action')" width="150" fixed="right">
                  <template #default="{ row }">
                    <el-button
                      v-if="row.status === 'paid' && (!row.refund_status || row.refund_status === 'failed')"
                      link type="danger" size="small" @click="openRefund(row)"
                    >{{ t('paymentAdmin.refund.action') }}</el-button>
                    <el-button
                      v-if="row.refund_status === 'processing'"
                      link type="primary" size="small" @click="refreshRefund(row)"
                    >{{ t('paymentAdmin.refund.refresh') }}</el-button>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="ad-muted">{{ t('common.noData') }}</span>
                </template>
              </el-table>
            </div>
            <el-pagination
              layout="total, prev, pager, next" :total="ordersTotal" :page-size="ordersSize" :current-page="ordersPage"
              @current-change="(p) => { ordersPage = p; loadOrders(); }"
            />
          </div>
        </el-tab-pane>

        <!-- 积分流水 -->
        <el-tab-pane :label="t('paymentAdmin.tab.transactions')" name="transactions">
          <div class="ad-card pa-block">
            <div class="pa-filters">
              <el-select v-model="txType" clearable :placeholder="t('paymentAdmin.f.type')" style="width: 130px;" @change="searchTxs">
                <el-option v-for="s in ['recharge', 'consume', 'refund', 'settle', 'adjust']" :key="s" :value="s" :label="t(`paymentAdmin.txtype.${s}`)" />
              </el-select>
              <el-input-number v-model="txUserId" :min="1" :controls="false" :placeholder="t('paymentAdmin.f.userId')" style="width: 120px;" @keyup.enter="searchTxs" @change="searchTxs" />
              <el-input v-model="txRefId" clearable :placeholder="t('paymentAdmin.f.refId')" style="width: 160px;" @keyup.enter="searchTxs" @clear="searchTxs" />
              <el-date-picker v-model="txRange" type="daterange" value-format="YYYY-MM-DD" :start-placeholder="t('paymentAdmin.f.start')" :end-placeholder="t('paymentAdmin.f.end')" style="width: 260px;" @change="searchTxs" />
              <el-button @click="searchTxs"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
              <el-button type="primary" class="btn-ink" @click="openAdjust">{{ t('paymentAdmin.adjust.button') }}</el-button>
            </div>
            <div class="pa-table-wrap" v-loading="txsLoading">
              <el-table :data="txs" size="small">
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column :label="t('paymentAdmin.c.user')" min-width="120" show-overflow-tooltip>
                  <template #default="{ row }">{{ displayName(row.user) }}</template>
                </el-table-column>
                <el-table-column :label="t('paymentAdmin.c.type')" width="90">
                  <template #default="{ row }">
                    <el-tag :type="txTypeTag(row.type)" size="small" effect="plain">{{ t(`paymentAdmin.txtype.${row.type}`) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column :label="t('paymentAdmin.c.amount')" width="90">
                  <template #default="{ row }">
                    <span :class="row.amount >= 0 ? 'pa-plus' : 'pa-minus'">{{ row.amount >= 0 ? `+${row.amount}` : row.amount }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="balance_after" :label="t('paymentAdmin.c.balanceAfter')" width="90" />
                <el-table-column prop="feature" :label="t('paymentAdmin.c.feature')" width="100" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.feature || '-' }}</template>
                </el-table-column>
                <el-table-column prop="ref_id" :label="t('paymentAdmin.c.refId')" width="130" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.ref_id || '-' }}</template>
                </el-table-column>
                <el-table-column prop="remark" :label="t('paymentAdmin.c.remark')" min-width="160" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.remark || '-' }}</template>
                </el-table-column>
                <el-table-column :label="t('common.createdAt')" width="160">
                  <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
                </el-table-column>
                <template #empty>
                  <span class="ad-muted">{{ t('common.noData') }}</span>
                </template>
              </el-table>
            </div>
            <el-pagination
              layout="total, prev, pager, next" :total="txsTotal" :page-size="txsSize" :current-page="txsPage"
              @current-change="(p) => { txsPage = p; loadTxs(); }"
            />
          </div>
        </el-tab-pane>

        <!-- 充值档位 -->
        <el-tab-pane :label="t('paymentAdmin.tab.packages')" name="packages">
          <div class="ad-card pa-block" v-loading="pkgLoading">
            <el-alert type="info" show-icon :closable="false" :title="t('paymentAdmin.pkg.tip')" style="margin-bottom: 14px;" />
            <el-form label-position="top">
              <el-form-item :label="t('paymentAdmin.pkg.rate')" style="max-width: 280px;">
                <el-input-number v-model="pkgRate" :min="1" :max="10000" :precision="0" style="width: 100%;" controls-position="right" />
              </el-form-item>
            </el-form>
            <el-table :data="pkgList" size="small" style="margin-bottom: 12px;">
              <el-table-column label="ID" min-width="110">
                <template #default="{ row }"><el-input v-model="row.id" size="small" /></template>
              </el-table-column>
              <el-table-column :label="t('paymentAdmin.pkg.yuan')" min-width="110">
                <template #default="{ row }"><el-input-number v-model="row.yuan" :min="0.01" :max="100000" :precision="2" size="small" controls-position="right" style="width: 100%;" /></template>
              </el-table-column>
              <el-table-column :label="t('paymentAdmin.pkg.credits')" min-width="120">
                <template #default="{ row }"><el-input-number v-model="row.credits" :min="0" :max="10000000" :precision="1" :step="0.1" size="small" controls-position="right" style="width: 100%;" /></template>
              </el-table-column>
              <el-table-column :label="t('paymentAdmin.pkg.bonus')" min-width="120">
                <template #default="{ row }"><el-input-number v-model="row.bonus" :min="0" :max="10000000" :precision="1" :step="0.1" size="small" controls-position="right" style="width: 100%;" /></template>
              </el-table-column>
              <el-table-column :label="t('paymentAdmin.pkg.label')" min-width="140">
                <template #default="{ row }"><el-input v-model="row.label" size="small" maxlength="32" /></template>
              </el-table-column>
              <el-table-column :label="t('paymentAdmin.pkg.total')" width="90">
                <template #default="{ row }">{{ Number(row.credits || 0) + (Number(row.bonus) || 0) }}</template>
              </el-table-column>
              <el-table-column :label="t('common.actions')" width="80">
                <template #default="{ $index }">
                  <el-button size="small" text type="danger" @click="removePackage($index)">{{ t('common.delete') }}</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="ad-flex-between">
              <el-button @click="addPackage"><el-icon><Plus /></el-icon> {{ t('paymentAdmin.pkg.add') }}</el-button>
              <el-button type="primary" class="btn-ink" :disabled="!pkgFormValid" :loading="pkgSaving" @click="savePackages">{{ t('common.save') }}</el-button>
            </div>
          </div>
        </el-tab-pane>

        <!-- 支付配置 -->
        <el-tab-pane :label="t('paymentAdmin.tab.payConfig')" name="payConfig">
          <div class="ad-card pa-block" v-loading="payLoading">
            <el-alert type="warning" show-icon :closable="false" :title="t('paymentAdmin.pay.envHint')" style="margin-bottom: 14px;" />
            <el-descriptions v-if="payConfig" :column="1" border style="max-width: 720px;">
              <el-descriptions-item :label="t('paymentAdmin.pay.enabled')">
                <el-tag :type="payEnabled ? 'success' : 'danger'" size="small" effect="plain">{{ payEnabled ? t('common.on') : t('common.off') }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pay.appId')">{{ payConfig.app_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pay.mchId')">{{ payConfig.mch_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pay.serialNo')">
                <el-tag :type="payConfig.serial_no_set ? 'success' : 'info'" size="small" effect="plain">{{ payConfig.serial_no_set ? t('common.set') : t('common.unset') }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pay.apiV3Key')">
                <el-tag :type="payConfig.api_v3_key_set ? 'success' : 'info'" size="small" effect="plain">{{ payConfig.api_v3_key_set ? t('common.set') : t('common.unset') }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pay.privateKey')">
                <el-tag :type="payConfig.private_key_set ? 'success' : 'info'" size="small" effect="plain">{{ payConfig.private_key_set ? t('common.set') : t('common.unset') }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pay.notifyUrl')">{{ payConfig.notify_url || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('paymentAdmin.pkg.rate')">{{ payConfig.yuan_per_credit }}</el-descriptions-item>
            </el-descriptions>
          </div>
        </el-tab-pane>
      </el-tabs>

      <!-- 积分人工调整弹窗 -->
      <el-dialog v-model="adjustVisible" :title="t('paymentAdmin.adjust.title')" width="min(420px, 94vw)">
        <el-form label-position="top">
          <el-form-item :label="t('paymentAdmin.f.userId')">
            <el-input-number v-model="adjustForm.user_id" :min="1" :precision="0" :controls="false" style="width: 100%;" :placeholder="t('paymentAdmin.f.userId')" />
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.type')">
            <el-radio-group v-model="adjustForm.dir">
              <el-radio-button value="add">{{ t('paymentAdmin.adjust.dir_add') }}</el-radio-button>
              <el-radio-button value="deduct">{{ t('paymentAdmin.adjust.dir_deduct') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.credits')">
            <el-input-number v-model="adjustForm.amount" :min="0.1" :max="10000000" :precision="1" :step="0.1" style="width: 100%;" controls-position="right" />
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.remark')">
            <el-input v-model="adjustForm.remark" type="textarea" :rows="2" maxlength="200" show-word-limit />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="adjustVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" :loading="adjustSaving" @click="submitAdjust">{{ t('common.confirm') }}</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="refundVisible" :title="t('paymentAdmin.refund.title')" width="min(420px, 94vw)">
        <el-alert :title="t('paymentAdmin.refund.notice')" type="warning" :closable="false" show-icon style="margin-bottom: 12px;" />
        <el-form label-position="top">
          <el-form-item :label="t('paymentAdmin.refund.amount')">
            <el-input-number v-model="refundForm.amount" :min="0.01" :max="refundForm.max" :precision="2" :step="0.01" style="width: 100%;" controls-position="right" />
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.remark')">
            <el-input v-model="refundForm.reason" type="textarea" :rows="2" maxlength="100" show-word-limit />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="refundVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" :loading="refundSaving" @click="submitRefund">{{ t('common.confirm') }}</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.pa-rule { margin-bottom: 16px; }
.pa-block { padding: var(--ad-sp-5) var(--ad-sp-6); }
.pa-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.pa-table-wrap { overflow-x: auto; }
.pa-plus { color: var(--el-color-success); font-weight: 600; }
.pa-minus { color: var(--el-color-danger); font-weight: 600; }
</style>
