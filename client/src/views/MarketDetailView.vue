<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { marketApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { formatCredits, formatDuration } from '../utils/format';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

// 订单详情：需求 + 交付成片播放 + 事件时间线 + 按角色/状态的操作（接单/交付/验收/驳回/仲裁）
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();

const loading = ref(false);
const acting = ref(false);
const order = ref(null);
const events = ref([]);

const myId = computed(() => auth.user?.id);
const amPublisher = computed(() => order.value?.publisher_id === myId.value);
const amWorker = computed(() => order.value?.worker_id === myId.value);
const isAdmin = computed(() => auth.isAdmin);
const userName = (u) => u?.nickname || u?.username || '-';

// 最新一次交付（事件流里最后一条 deliver；源项目后续重新生成不影响快照）
const lastDelivery = computed(() => {
  const ds = events.value.filter((e) => e.type === 'deliver');
  return ds.length ? ds[ds.length - 1] : null;
});
const durationMismatch = computed(() => {
  const d = lastDelivery.value?.payload?.duration;
  if (!d || !order.value) return false;
  return Math.abs(d - order.value.duration_seconds) > Math.max(3, order.value.duration_seconds * 0.2);
});

const STATUS_CLS = {
  open: 'chip-success', working: 'chip-warning', delivered: 'chip-accent',
  disputed: 'chip-danger', completed: '', cancelled: '',
};

const EVENT_ICON = {
  publish: '📝', take: '🎯', deliver: '📦', reject: '↩️', accept: '✅',
  dispute: '⚖️', arbitrate: '👑', cancel: '🚫', quit: '🚪',
};

async function load() {
  loading.value = true;
  try {
    const data = await marketApi.order(route.params.id);
    order.value = data.order;
    events.value = data.events || [];
  } finally {
    loading.value = false;
  }
}

async function act(fn, done) {
  acting.value = true;
  try {
    await fn();
    await load();
    auth.refreshCredits();
    done?.();
  } finally {
    acting.value = false;
  }
}

function take() {
  ElMessageBox.confirm(t('market.takeConfirm'), t('market.take'), {
    type: 'info', confirmButtonText: t('market.take'), cancelButtonText: t('common.cancel'),
  }).then(() => act(() => marketApi.take(order.value.id)))
    .catch(() => {});
}

function cancel() {
  ElMessageBox.confirm(t('market.detail.cancelConfirm'), t('market.detail.cancel'), {
    type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'),
  }).then(() => act(() => marketApi.cancel(order.value.id)))
    .catch(() => {});
}

function quit() {
  ElMessageBox.confirm(t('market.detail.quitConfirm'), t('market.detail.quit'), {
    type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'),
  }).then(() => act(() => marketApi.quit(order.value.id)))
    .catch(() => {});
}

function accept() {
  ElMessageBox.confirm(
    t('market.detail.acceptConfirm', { n: formatCredits(order.value.total_price) }),
    t('market.detail.acceptTitle'),
    { type: 'warning', confirmButtonText: t('market.detail.accept'), cancelButtonText: t('common.cancel') },
  ).then(() => act(() => marketApi.accept(order.value.id)))
    .catch(() => {});
}

// 驳回/仲裁申请：必填意见（prompt 校验非空）
function reject() {
  ElMessageBox.prompt(t('market.detail.rejectReason'), t('market.detail.rejectTitle'), {
    inputType: 'textarea', inputPlaceholder: t('market.detail.rejectPlaceholder'),
    inputValidator: (v) => !!(v && v.trim()) || t('market.detail.rejectReason'),
    confirmButtonText: t('market.detail.reject'), cancelButtonText: t('common.cancel'),
  }).then(({ value }) => act(() => marketApi.reject(order.value.id, value.trim())))
    .catch(() => {});
}

function dispute() {
  ElMessageBox.prompt(t('market.detail.disputeReason'), t('market.detail.disputeTitle'), {
    inputType: 'textarea', inputPlaceholder: t('market.detail.disputePlaceholder'),
    inputValidator: (v) => !!(v && v.trim()) || t('market.detail.disputeReason'),
    confirmButtonText: t('market.detail.dispute'), cancelButtonText: t('common.cancel'),
  }).then(({ value }) => act(() => marketApi.dispute(order.value.id, value.trim())))
    .catch(() => {});
}

// ---- admin 仲裁面板 ----
const arbitrateVisible = ref(false);
const arbitrateDecision = ref('release');
const arbitrateNote = ref('');
function openArbitrate() {
  arbitrateDecision.value = 'release';
  arbitrateNote.value = '';
  arbitrateVisible.value = true;
}
function submitArbitrate() {
  act(
    () => marketApi.arbitrate(order.value.id, arbitrateDecision.value, arbitrateNote.value.trim()),
    () => { arbitrateVisible.value = false; },
  );
}

// ---- 交付：从自己项目成片中选一集（后端返回的即「批量下载同口径」的当前成片）----
const deliverVisible = ref(false);
const deliverables = ref([]);
const deliverProjectId = ref(null);
const deliverEpisodeId = ref(null);
const deliverNote = ref('');
const deliverLoading = ref(false);

const deliverEpisodes = computed(() =>
  deliverables.value.find((p) => p.id === deliverProjectId.value)?.episodes || []);
const selectedFilm = computed(() =>
  deliverEpisodes.value.find((e) => e.id === deliverEpisodeId.value) || null);

async function openDeliver() {
  deliverVisible.value = true;
  if (deliverables.value.length) return;
  deliverLoading.value = true;
  try {
    deliverables.value = await marketApi.myDeliverables();
    if (deliverables.value.length) {
      deliverProjectId.value = deliverables.value[0].id;
      deliverEpisodesFirst();
    }
  } finally {
    deliverLoading.value = false;
  }
}
function deliverEpisodesFirst() {
  deliverEpisodeId.value = deliverEpisodes.value.length ? deliverEpisodes.value[0].id : null;
}
function submitDeliver() {
  if (!deliverProjectId.value || !deliverEpisodeId.value) return;
  act(
    () => marketApi.deliver(order.value.id, {
      project_id: deliverProjectId.value,
      episode_id: deliverEpisodeId.value,
      note: deliverNote.value.trim(),
    }),
    () => { deliverVisible.value = false; deliverNote.value = ''; },
  );
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="od-top">
        <el-button text @click="router.push({ name: 'market' })">
          <el-icon><ArrowLeft /></el-icon> {{ t('market.back') }}
        </el-button>
      </div>

      <template v-if="order">
        <div class="od-head">
          <div class="od-title-row">
            <span class="chip" :class="STATUS_CLS[order.status] || ''">{{ t('market.status.' + order.status) }}</span>
            <span class="ad-title-lg">{{ order.title }}</span>
          </div>
          <div class="od-meta">
            <span>{{ t('market.publisher') }}：{{ userName(order.publisher) }}</span>
            <span class="od-sep">·</span>
            <span>{{ t('market.worker') }}：{{ order.worker ? userName(order.worker) : t('market.noWorker') }}</span>
            <span class="od-sep">·</span>
            <span>{{ t('market.durationVal', { s: order.duration_seconds }) }}</span>
            <span class="od-sep">·</span>
            <span>{{ t('market.perSecond', { p: formatCredits(order.price_per_second) }) }}</span>
            <span class="od-sep">·</span>
            <span>{{ order.resolution }}</span>
            <span v-if="order.aspect_ratio"><span class="od-sep">·</span> {{ order.aspect_ratio }}</span>
          </div>
          <div class="od-escrow chip chip-accent">
            {{ t('market.escrow', { n: formatCredits(order.total_price) }) }}
          </div>
        </div>

        <div class="od-layout">
          <div class="od-main">
            <section class="ad-card od-card">
              <div class="od-card-title">{{ t('market.detail.requirement') }}</div>
              <p class="od-req">{{ order.requirement }}</p>
            </section>

            <section class="ad-card od-card">
              <div class="od-card-title">{{ t('market.detail.delivery') }}</div>
              <template v-if="lastDelivery?.payload?.video_url">
                <video :src="lastDelivery.payload.video_url" controls playsinline class="od-video"></video>
                <div class="od-delivery-meta">
                  <span>{{ t('market.detail.deliveryFrom', { name: lastDelivery.payload.project_name, idx: lastDelivery.payload.episode_idx }) }}</span>
                  <span>{{ t('market.durationVal', { s: Math.round(lastDelivery.payload.duration || 0) }) }}</span>
                </div>
                <div v-if="lastDelivery.content" class="od-delivery-note">{{ lastDelivery.content }}</div>
                <div v-if="durationMismatch" class="od-mismatch">
                  <el-icon><WarningFilled /></el-icon>
                  {{ t('market.detail.durationMismatch', { a: Math.round(lastDelivery.payload.duration || 0), b: order.duration_seconds }) }}
                </div>
              </template>
              <EmptyState v-else icon="📦" :title="t('market.detail.noDelivery')" />
            </section>

            <section class="ad-card od-card">
              <div class="od-card-title">{{ t('market.detail.timeline') }}</div>
              <div class="od-timeline">
                <div v-for="e in events" :key="e.id" class="od-event">
                  <span class="od-event-icon">{{ EVENT_ICON[e.type] || '•' }}</span>
                  <div class="od-event-body">
                    <div class="od-event-head">
                      <span class="od-event-actor">{{ e.actor ? userName(e.actor) : '-' }}</span>
                      <span class="od-event-what">{{ t('market.detail.events.' + e.type) }}</span>
                      <span v-if="e.type === 'arbitrate' && e.payload?.decision" class="chip mini" :class="e.payload.decision === 'release' ? 'chip-success' : ''">
                        {{ e.payload.decision === 'release' ? t('market.detail.arbitrateRelease') : t('market.detail.arbitrateRefund') }}
                      </span>
                      <span class="od-event-time">{{ new Date(e.created_at).toLocaleString() }}</span>
                    </div>
                    <div v-if="e.content" class="od-event-content">{{ e.content }}</div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <aside class="od-side">
            <section class="ad-card od-card">
              <div class="od-card-title">{{ t('market.detail.actions') }}</div>
              <div class="od-actions">
                <!-- 待接单 -->
                <template v-if="order.status === 'open'">
                  <el-button v-if="!amPublisher" type="primary" class="btn-ink" :loading="acting" @click="take">
                    {{ t('market.take') }}
                  </el-button>
                  <el-button v-if="amPublisher" :loading="acting" @click="cancel">
                    {{ t('market.detail.cancel') }}
                  </el-button>
                </template>

                <!-- 开发中 -->
                <template v-else-if="order.status === 'working'">
                  <el-button v-if="amWorker" type="primary" class="btn-ink" :loading="acting" @click="openDeliver">
                    {{ lastDelivery ? t('market.detail.redeliver') : t('market.detail.deliver') }}
                  </el-button>
                  <el-button v-if="amWorker" :loading="acting" @click="quit">{{ t('market.detail.quit') }}</el-button>
                </template>

                <!-- 待验收 -->
                <template v-else-if="order.status === 'delivered'">
                  <el-button v-if="amPublisher" type="primary" class="btn-ink" :loading="acting" @click="accept">
                    {{ t('market.detail.accept') }}
                  </el-button>
                  <el-button v-if="amPublisher" :loading="acting" @click="reject">{{ t('market.detail.reject') }}</el-button>
                </template>

                <!-- 仲裁中 -->
                <template v-else-if="order.status === 'disputed'">
                  <el-button v-if="isAdmin" type="primary" class="btn-ink" @click="openArbitrate">
                    {{ t('market.detail.arbitrate') }}
                  </el-button>
                </template>

                <!-- 非终态双方均可申请仲裁 -->
                <el-button
                  v-if="['working', 'delivered'].includes(order.status) && (amPublisher || amWorker)"
                  :loading="acting" @click="dispute"
                >{{ t('market.detail.dispute') }}</el-button>

                <div v-if="['completed', 'cancelled'].includes(order.status)" class="od-done-hint ad-sub">
                  {{ t('market.status.' + order.status) }}
                </div>
              </div>
              <div v-if="order.meta?.arbitrated" class="od-arb-hint">
                ⚖️ {{ order.meta.arbitrated === 'release' ? t('market.detail.arbitrateRelease') : t('market.detail.arbitrateRefund') }}
              </div>
            </section>
          </aside>
        </div>

        <!-- 交付成片 -->
        <el-dialog v-model="deliverVisible" width="min(520px, 94vw)" top="6vh" append-to-body>
          <template #header>
            <div class="mk-dlg-head">{{ t('market.deliver.title') }}</div>
          </template>
          <div v-loading="deliverLoading" class="od-deliver">
            <div class="ad-sub">{{ t('market.deliver.tip') }}</div>
            <template v-if="deliverables.length">
              <el-form label-position="top">
                <el-form-item :label="t('market.deliver.project')">
                  <el-select v-model="deliverProjectId" style="width: 100%" @change="deliverEpisodesFirst">
                    <el-option v-for="p in deliverables" :key="p.id" :label="p.name" :value="p.id" />
                  </el-select>
                </el-form-item>
                <el-form-item :label="t('market.deliver.episode')">
                  <el-select v-model="deliverEpisodeId" style="width: 100%">
                    <el-option v-for="ep in deliverEpisodes" :key="ep.id" :value="ep.id"
                      :label="`第${ep.idx}集 ${ep.title}（${formatDuration(ep.duration)}）`" />
                  </el-select>
                </el-form-item>
                <el-form-item :label="t('market.deliver.note')">
                  <el-input v-model="deliverNote" type="textarea" :rows="2" maxlength="500" show-word-limit :placeholder="t('market.deliver.notePlaceholder')" />
                </el-form-item>
              </el-form>
              <div v-if="selectedFilm" class="od-deliver-preview">
                <video :src="selectedFilm.video_url" controls playsinline muted></video>
              </div>
            </template>
            <EmptyState v-else-if="!deliverLoading" icon="🎬" :title="t('market.deliver.empty')" />
            <div class="od-deliver-foot">
              <el-button type="primary" class="btn-ink" :loading="acting" :disabled="!deliverEpisodeId" @click="submitDeliver">
                {{ t('market.deliver.submit') }}
              </el-button>
            </div>
          </div>
        </el-dialog>

        <!-- admin 仲裁 -->
        <el-dialog v-model="arbitrateVisible" width="min(480px, 94vw)" align-center append-to-body>
          <template #header>
            <div class="mk-dlg-head">{{ t('market.detail.arbitrate') }}</div>
          </template>
          <div class="od-arb">
            <el-radio-group v-model="arbitrateDecision" class="od-arb-radios">
              <el-radio value="release">{{ t('market.detail.arbitrateRelease') }}（{{ formatCredits(order.total_price) }} → {{ userName(order.worker) }}）</el-radio>
              <el-radio value="refund">{{ t('market.detail.arbitrateRefund') }}（{{ formatCredits(order.total_price) }} → {{ userName(order.publisher) }}）</el-radio>
            </el-radio-group>
            <el-input v-model="arbitrateNote" type="textarea" :rows="3" maxlength="1000" show-word-limit :placeholder="t('market.detail.arbitrateNote')" />
            <div class="od-deliver-foot">
              <el-button type="primary" class="btn-ink" :loading="acting" @click="submitArbitrate">
                {{ t('market.detail.arbitrate') }}
              </el-button>
            </div>
          </div>
        </el-dialog>
      </template>
    </div>
  </div>
</template>

<style scoped>
.od-top { margin-bottom: 4px; }
.od-head { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.od-title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.od-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--ad-text-muted); }
.od-sep { opacity: 0.5; }
.od-escrow { align-self: flex-start; }

.od-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 16px;
  align-items: start;
}
.od-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.od-card { padding: 16px 18px; }
.od-card-title { font-weight: 700; font-size: 15px; margin-bottom: 12px; color: var(--ad-text-strong); }
.od-req { margin: 0; font-size: 14px; line-height: 1.8; color: var(--ad-text); white-space: pre-wrap; word-break: break-word; }

.od-video { width: 100%; max-height: 60vh; background: #000; border-radius: var(--ad-radius-sm); display: block; }
.od-delivery-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 10px; font-size: 13px; color: var(--ad-text-muted); }
.od-delivery-meta span { font-variant-numeric: tabular-nums; }
.od-delivery-note { margin-top: 8px; font-size: 13px; line-height: 1.7; color: var(--ad-text); }
.od-mismatch { margin-top: 8px; font-size: var(--ad-fz-xs); color: var(--ad-warning); font-weight: 600; display: flex; align-items: center; gap: 4px; }

.od-timeline { display: flex; flex-direction: column; gap: 2px; max-height: 420px; overflow-y: auto; }
.od-event { display: flex; gap: 10px; padding: 9px 4px; border-bottom: 1px dashed var(--ad-border); }
.od-event:last-child { border-bottom: none; }
.od-event-icon { flex: 0 0 auto; font-size: 16px; line-height: 1.4; }
.od-event-body { flex: 1; min-width: 0; }
.od-event-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.od-event-actor { font-weight: 700; color: var(--ad-text-strong); }
.od-event-what { color: var(--ad-text); }
.od-event-time { margin-left: auto; font-size: var(--ad-fz-xs); color: var(--ad-text-muted); font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; }
.od-event-content { margin-top: 4px; font-size: 13px; line-height: 1.6; color: var(--ad-text-muted); white-space: pre-wrap; word-break: break-word; }

.od-actions { display: flex; flex-direction: column; gap: 10px; }
.od-actions .el-button { margin-left: 0; width: 100%; }
.od-done-hint { text-align: center; }
.od-arb-hint { margin-top: 12px; font-size: var(--ad-fz-xs); color: var(--ad-text-muted); }

.mk-dlg-head { font-weight: 800; font-size: 16px; }
.od-deliver { display: flex; flex-direction: column; gap: 8px; }
.od-deliver-preview video { width: 100%; max-height: 300px; background: #000; border-radius: var(--ad-radius-sm); display: block; }
.od-deliver-foot { display: flex; justify-content: flex-end; }
.od-arb { display: flex; flex-direction: column; gap: 12px; }
.od-arb-radios { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.od-arb-radios :deep(.el-radio) { height: auto; padding: 6px 0; }

@media (max-width: 900px) {
  .od-layout { grid-template-columns: 1fr; }
}
</style>
