<script setup>
/**
 * 接单中心订单详情：需求 + 交付成片播放 + 事件时间线 + 按角色/状态的操作
 * （接单 / 取消 / 放弃 / 交付 / 验收 / 驳回 / 争议 / admin 仲裁）。
 */
import { ref, computed, onMounted } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { marketApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { useVideoPlayer } from '../../composables/useVideoPlayer';
import { formatCredits, formatDuration } from '../../utils/format';
import { toAbsolute } from '../../utils/media';
import { toast, toastError, confirm, promptInput, actionSheet, selectSheet } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import VideoPlayerPopup from '../../components/video-player-popup/video-player-popup.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import MarketTakeSheet from '../../components/market-take-sheet/market-take-sheet.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();
const { play } = useVideoPlayer();

const loading = ref(false);
const acting = ref(false);
const order = ref(null);
const events = ref([]);
let orderId = null;

const myId = computed(() => auth.user?.id);
const amPublisher = computed(() => order.value?.publisher_id === myId.value);
const amWorker = computed(() => order.value?.worker_id === myId.value);
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
  open: 'ok', working: 'warn', delivered: 'gold',
  disputed: 'bad', completed: 'teal', cancelled: 'glass',
};
const EVENT_ICON = {
  publish: '📝', take: '🎯', deliver: '📦', reject: '↩️', accept: '✅',
  dispute: '⚖️', arbitrate: '👑', cancel: '🚫', quit: '🚪',
};
const fmtTime = (s) => {
  try { return new Date(s).toLocaleString(); } catch (e) { return s; }
};

async function load() {
  loading.value = true;
  try {
    const data = await marketApi.order(orderId);
    order.value = data.order;
    events.value = data.events || [];
    maybeAutoTake();
  } catch (e) {
    toastError(e);
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
  } catch (e) {
    toastError(e);
  } finally {
    acting.value = false;
  }
}

// 接单：弹作品选择抽屉（须有本站作品，可附带自己的项目供发布方评估）
const takeShow = ref(false);
function take() { takeShow.value = true; }
function submitTake(works) {
  act(
    () => marketApi.take(order.value.id, { works }),
    () => { takeShow.value = false; toast(t('market.takenToast'), 'success'); },
  );
}

// 列表页快捷接单跳转进来（?take=1）：加载完自动弹抽屉（仅 open 且非发布方）
let autoTake = false;
function maybeAutoTake() {
  if (!autoTake) return;
  autoTake = false;
  if (order.value?.status === 'open' && !amPublisher.value) takeShow.value = true;
}
async function cancelOrder() {
  if (!(await confirm(t('market.detail.cancelConfirm'), t('market.detail.cancel')))) return;
  act(() => marketApi.cancel(order.value.id));
}
async function quit() {
  if (!(await confirm(t('market.detail.quitConfirm'), t('market.detail.quit')))) return;
  act(() => marketApi.quit(order.value.id));
}
async function accept() {
  const ok = await confirm(
    t('market.detail.acceptConfirm', { n: formatCredits(order.value.total_price) }),
    t('market.detail.acceptTitle'),
  );
  if (!ok) return;
  act(() => marketApi.accept(order.value.id));
}

// 驳回 / 争议：必填意见
async function reject() {
  const reason = await promptInput(t('market.detail.rejectTitle'), t('market.detail.rejectReason'), t('market.detail.rejectPlaceholder'));
  if (!reason || !reason.trim()) return;
  act(() => marketApi.reject(order.value.id, reason.trim()));
}
async function dispute() {
  const reason = await promptInput(t('market.detail.disputeTitle'), t('market.detail.disputeReason'), t('market.detail.disputePlaceholder'));
  if (!reason || !reason.trim()) return;
  act(() => marketApi.dispute(order.value.id, reason.trim()));
}

// admin 仲裁：actionSheet 选裁决 + prompt 填备注
async function arbitrate() {
  const decision = await actionSheet([
    { key: 'release', label: t('market.detail.arbitrateRelease') },
    { key: 'refund', label: t('market.detail.arbitrateRefund') },
  ]);
  if (!decision) return;
  const note = await promptInput(t('market.detail.arbitrateTitle'), t('market.detail.arbitrateNote'), '');
  act(() => marketApi.arbitrate(order.value.id, decision, (note || '').trim()));
}

// 交付：从自己项目成片中选一集（后端返回的即「批量下载同口径」的当前成片）
const deliverShow = ref(false);
const deliverables = ref([]);
const deliverProjectId = ref(null);
const deliverEpisodeId = ref(null);
const deliverNote = ref('');
const deliverEpisodes = computed(() =>
  deliverables.value.find((p) => p.id === deliverProjectId.value)?.episodes || []);

async function openDeliver() {
  deliverShow.value = true;
  if (deliverables.value.length) return;
  try {
    deliverables.value = await marketApi.myDeliverables();
    if (deliverables.value.length) {
      deliverProjectId.value = deliverables.value[0].id;
      deliverEpisodeId.value = deliverEpisodes.value.length ? deliverEpisodes.value[0].id : null;
    }
  } catch (e) { toastError(e); }
}
// 项目/分集下拉（selectSheet 底部选择面板，弃用原生 picker）；xxOpen 驱动箭头朝向（关=向下，开=向上）
const deliverProjectOpen = ref(false);
async function pickDeliverProject() {
  deliverProjectOpen.value = true;
  try {
    const k = await selectSheet({
      title: t('mobile.market.pickProject'),
      items: deliverables.value.map((p) => ({ key: String(p.id), label: p.name })),
      current: deliverProjectId.value != null ? String(deliverProjectId.value) : '',
    });
    if (k === null) return;
    deliverProjectId.value = Number(k) || null;
    deliverEpisodeId.value = deliverEpisodes.value.length ? deliverEpisodes.value[0].id : null;
  } finally {
    deliverProjectOpen.value = false;
  }
}
const deliverEpisodeOpen = ref(false);
async function pickDeliverEpisode() {
  deliverEpisodeOpen.value = true;
  try {
    const k = await selectSheet({
      title: t('mobile.market.pickEpisode'),
      items: deliverEpisodes.value.map((ep) => ({ key: String(ep.id), label: `${ep.idx}. ${ep.title}` })),
      current: deliverEpisodeId.value != null ? String(deliverEpisodeId.value) : '',
    });
    if (k !== null) deliverEpisodeId.value = Number(k) || null;
  } finally {
    deliverEpisodeOpen.value = false;
  }
}
function submitDeliver() {
  if (!deliverProjectId.value || !deliverEpisodeId.value) return;
  act(
    () => marketApi.deliver(order.value.id, {
      project_id: deliverProjectId.value,
      episode_id: deliverEpisodeId.value,
      note: deliverNote.value.trim(),
    }),
    () => { deliverShow.value = false; deliverNote.value = ''; },
  );
}

const deliveryVideoUrl = computed(() =>
  (lastDelivery.value?.payload?.video_url ? toAbsolute(lastDelivery.value.payload.video_url) : ''));

// 接单者附上的作品（最新一条 take 事件的 payload.works 快照；null=尚未接单）
const takeWorks = computed(() => {
  const ts = events.value.filter((e) => e.type === 'take' && Array.isArray(e.payload?.works));
  return ts.length ? ts[ts.length - 1].payload.works : null;
});
function playWork(w, ep) {
  play({ url: toAbsolute(ep.video_url), title: `${w.project_name} · ${ep.idx}. ${ep.title}` });
}

onLoad((q) => { orderId = q?.id; autoTake = q?.take === '1'; });
onMounted(() => { if (orderId) load(); });
// 下拉刷新：重拉订单详情
onPullDownRefresh(async () => {
  try { if (orderId) await load(); } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="order?.title || t('market.title')" />

    <view v-if="loading && !order" class="od-loading"><text>{{ t('common.loading') }}</text></view>

    <template v-if="order">
      <!-- 头部 -->
      <view class="od-head">
        <view class="od-title-row">
          <text class="chip sm" :class="STATUS_CLS[order.status] || ''">{{ t('market.status.' + order.status) }}</text>
          <text class="od-name">{{ order.title }}</text>
        </view>
        <view class="od-meta">
          <text>{{ t('market.publisher') }}：{{ userName(order.publisher) }}</text>
          <text class="od-sep">·</text>
          <text>{{ t('market.worker') }}：{{ order.worker ? userName(order.worker) : t('market.noWorker') }}</text>
        </view>
        <view class="od-meta">
          <text>{{ t('market.durationVal', { s: order.duration_seconds }) }}</text>
          <text class="od-sep">·</text>
          <text>{{ order.resolution }}</text>
          <text v-if="order.aspect_ratio"><text class="od-sep">·</text> {{ order.aspect_ratio }}</text>
        </view>
        <view class="chip gold sm od-escrow">{{ t('market.escrow', { n: formatCredits(order.total_price) }) }}</view>
      </view>

      <!-- 需求 -->
      <view class="od-card">
        <view class="od-card-title">{{ t('market.detail.requirement') }}</view>
        <view class="od-req">{{ order.requirement }}</view>
      </view>

      <!-- 接单者作品（接单时附带，供发布方评估） -->
      <view v-if="takeWorks" class="od-card">
        <view class="od-card-title">{{ t('market.detail.works') }}</view>
        <template v-if="takeWorks.length">
          <view v-for="w in takeWorks" :key="w.project_id" class="od-work">
            <view class="od-work-head">
              <image v-if="w.cover" :src="toAbsolute(w.cover)" class="od-work-cover" mode="aspectFill" />
              <view v-else class="od-work-cover od-work-cover-ph"><m-icon name="film" :size="18" /></view>
              <text class="od-work-name">{{ w.project_name }}</text>
            </view>
            <view v-for="ep in w.episodes" :key="ep.id" class="od-work-ep" @tap="playWork(w, ep)">
              <text class="od-work-ep-t">{{ ep.idx }}. {{ ep.title }}</text>
              <text class="od-work-ep-d">{{ t('market.durationVal', { s: Math.round(ep.duration || 0) }) }}</text>
              <m-icon name="play" :size="13" />
            </view>
          </view>
        </template>
        <view v-else class="od-none">{{ t('market.detail.noWorks') }}</view>
      </view>

      <!-- 交付 -->
      <view class="od-card">
        <view class="od-card-title">{{ t('market.detail.delivery') }}</view>
        <template v-if="lastDelivery?.payload?.video_url">
          <view class="od-video-wrap">
            <image
              v-if="lastDelivery.payload.cover_url"
              :src="toAbsolute(lastDelivery.payload.cover_url)"
              mode="aspectFill"
              class="od-video-poster"
            />
            <view class="od-video-play" @tap="play({ url: deliveryVideoUrl, title: order.title })">
              <m-icon name="play" :size="22" color="#fff" />
            </view>
          </view>
          <view class="od-dmeta">
            <text>{{ t('market.detail.deliveryFrom', { name: lastDelivery.payload.project_name, idx: lastDelivery.payload.episode_idx }) }}</text>
            <text>{{ t('market.durationVal', { s: Math.round(lastDelivery.payload.duration || 0) }) }}</text>
          </view>
          <view v-if="lastDelivery.content" class="od-note">{{ lastDelivery.content }}</view>
          <view v-if="durationMismatch" class="od-mismatch">
            {{ t('market.detail.durationMismatch', { a: Math.round(lastDelivery.payload.duration || 0), b: order.duration_seconds }) }}
          </view>
        </template>
        <view v-else class="od-none">{{ t('market.detail.noDelivery') }}</view>
      </view>

      <!-- 时间线 -->
      <view class="od-card">
        <view class="od-card-title">{{ t('market.detail.timeline') }}</view>
        <view v-for="e in events" :key="e.id" class="od-event">
          <text class="od-event-icon">{{ EVENT_ICON[e.type] || '•' }}</text>
          <view class="od-event-body">
            <view class="od-event-head">
              <text class="od-event-actor">{{ e.actor ? userName(e.actor) : '-' }}</text>
              <text class="od-event-what">{{ t('market.detail.events.' + e.type) }}</text>
              <text class="od-event-time">{{ fmtTime(e.created_at) }}</text>
            </view>
            <view v-if="e.content" class="od-event-content">{{ e.content }}</view>
          </view>
        </view>
        <view v-if="!events.length" class="od-none">{{ t('common.noData') }}</view>
      </view>

      <!-- 操作区 -->
      <view class="od-acts">
        <view v-if="order.status === 'open' && !amPublisher" class="mbtn teal" :class="{ dis: acting }" @tap="!acting && take()">
          {{ t('market.take') }}
        </view>
        <view v-if="order.status === 'open' && amPublisher" class="mbtn danger" :class="{ dis: acting }" @tap="!acting && cancelOrder()">
          {{ t('market.detail.cancel') }}
        </view>
        <view v-if="order.status === 'working' && amWorker" class="mbtn" :class="{ dis: acting }" @tap="!acting && openDeliver()">
          {{ t('market.detail.deliver') }}
        </view>
        <view v-if="order.status === 'working' && amWorker" class="mbtn ghost" :class="{ dis: acting }" @tap="!acting && quit()">
          {{ t('market.detail.quit') }}
        </view>
        <view v-if="order.status === 'delivered' && amPublisher" class="mbtn teal" :class="{ dis: acting }" @tap="!acting && accept()">
          {{ t('market.detail.accept') }} · {{ formatCredits(order.total_price) }}
        </view>
        <view v-if="order.status === 'delivered' && amPublisher" class="mbtn danger" :class="{ dis: acting }" @tap="!acting && reject()">
          {{ t('market.detail.reject') }}
        </view>
        <view v-if="['working', 'delivered'].includes(order.status) && (amPublisher || amWorker)" class="mbtn ghost" :class="{ dis: acting }" @tap="!acting && dispute()">
          {{ t('market.detail.dispute') }}
        </view>
        <view v-if="order.status === 'disputed' && auth.isAdmin" class="mbtn" :class="{ dis: acting }" @tap="!acting && arbitrate()">
          {{ t('market.detail.arbitrate') }}
        </view>
      </view>
    </template>

    <VideoPlayerPopup v-model:show="playerShow" :url="playerUrl" :title="playerTitle" :aspect="order?.aspect_ratio || ''" />
    <MarketTakeSheet v-model:show="takeShow" :acting="acting" @submit="submitTake" />
    <AdSheet :show="deliverShow" :title="t('market.detail.deliver')" @update:show="deliverShow = $event">
      <view class="odv">
        <view class="ad-field">
          <view class="ad-field-label">{{ t('mobile.market.pickProject') }}</view>
          <view class="ad-input ad-picker" @tap="pickDeliverProject">
            <text>{{ deliverables.find((p) => p.id === deliverProjectId)?.name || t('common.pleaseSelect') }}</text>
            <m-icon :name="deliverProjectOpen ? 'up' : 'down'" :size="16" />
          </view>
        </view>
        <view class="ad-field">
          <view class="ad-field-label">{{ t('mobile.market.pickEpisode') }}</view>
          <view class="ad-input ad-picker" @tap="pickDeliverEpisode">
            <text>{{ deliverEpisodes.find((ep) => ep.id === deliverEpisodeId)?.title || t('common.pleaseSelect') }}</text>
            <m-icon :name="deliverEpisodeOpen ? 'up' : 'down'" :size="16" />
          </view>
        </view>
        <view class="ad-field">
          <view class="ad-field-label">{{ t('market.detail.deliverNote') }}</view>
          <textarea v-model="deliverNote" class="ad-textarea" :maxlength="300" :placeholder="t('common.pleaseInput')" placeholder-class="ad-ph" />
        </view>
        <view class="mbtn" :class="{ dis: acting }" @tap="!acting && submitDeliver()">{{ t('market.detail.deliver') }}</view>
      </view>
    </AdSheet>
  <AdDialog />
  </view>
</template>

<style scoped>
.od-loading { padding: 60px 0; text-align: center; color: var(--ad-text-mut); font-size: 13px; }
.od-head { padding: 14px 18px 4px; }
.od-title-row { display: flex; align-items: center; gap: 10px; }
.od-name { flex: 1; min-width: 0; font-family: var(--ad-font-serif); font-weight: 900; font-size: 20px; color: var(--ad-text); }
.od-meta { margin-top: 8px; font-size: 12px; color: var(--ad-text-mut); display: flex; flex-wrap: wrap; gap: 6px; }
.od-sep { opacity: 0.5; }
.od-escrow { margin-top: 10px; display: inline-flex; }
.od-card {
  margin: 12px 18px 0; padding: 14px 16px; border-radius: 18px;
  background: var(--ad-panel); border: 1px solid var(--ad-line);
}
.od-card-title { font-weight: 800; font-size: 14px; color: var(--ad-text); margin-bottom: 10px; }
.od-req { font-size: 13px; color: var(--ad-text-soft); line-height: 1.7; }
.od-work { padding: 10px 0; border-bottom: 1px solid var(--ad-line); }
.od-work:last-child { border-bottom: none; padding-bottom: 0; }
.od-work:not(:first-child) { border-top: none; }
.od-work-head { display: flex; align-items: center; gap: 10px; }
.od-work-cover {
  flex: none; width: 64px; height: 44px; border-radius: 8px;
  background: var(--ad-inset); overflow: hidden;
}
.od-work-cover-ph { display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
.od-work-name { font-size: 14px; font-weight: 800; color: var(--ad-text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.od-work-ep {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 0 0 74px; padding: 6px 10px; border-radius: 10px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.od-work-ep-t { flex: 1; min-width: 0; font-size: 12px; color: var(--ad-text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.od-work-ep-d { flex: none; font-size: 11px; color: var(--ad-text-mut); }
.od-video-wrap {
  position: relative; width: 100%; height: 0; padding-bottom: 56%;
  border-radius: 12px; overflow: hidden; background: #000;
}
.od-video-poster { position: absolute; top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; }
.od-video-play {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 52px; height: 52px; border-radius: 50%;
  background: rgba(224, 182, 78, 0.9);
  display: flex; align-items: center; justify-content: center;
}
.od-dmeta { display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; color: var(--ad-text-mut); }
.od-note { margin-top: 8px; font-size: 12px; color: var(--ad-text-soft); }
.od-mismatch { margin-top: 8px; font-size: 12px; color: var(--ad-danger); }
.od-none { font-size: 12px; color: var(--ad-text-mut); padding: 8px 0; }
.od-event { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--ad-line); }
.od-event:last-child { border-bottom: none; }
.od-event-icon { flex: none; font-size: 16px; }
.od-event-body { flex: 1; min-width: 0; }
.od-event-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.od-event-actor { font-size: 12px; font-weight: 700; color: var(--ad-text); }
.od-event-what { font-size: 12px; color: var(--ad-text-soft); }
.od-event-time { margin-left: auto; font-size: 10px; color: var(--ad-text-mut); }
.od-event-content { margin-top: 4px; font-size: 12px; color: var(--ad-text-mut); }
.od-acts { display: flex; flex-wrap: wrap; gap: 10px; padding: 18px 18px 40px; }
.od-acts .mbtn { flex: 1; min-width: 44%; }
.od-picker { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
</style>
