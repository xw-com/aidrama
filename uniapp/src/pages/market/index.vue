<script setup>
/**
 * 接单中心（二级页）：广场 / 我发布的 / 我接的 + 发布任务单（独立页 pages/market/create）。
 * proposal「接单中心」mstrip + ocard 1:1；列表快捷「接单」带二次确认。
 */
import { ref, computed, onMounted } from 'vue';
import { onLoad, onUnload, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { marketApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { formatCredits } from '../../utils/format';
import { toastError } from '../../utils/ui';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();

const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const SIZE = 10;
const q = ref('');
// role: ''（广场）| published（我发布的）| taken（我接的）；status 仅广场视图有意义
const role = ref('');
const activeOnly = ref(true);

const STATUS_CLS = {
  open: 'ok', working: 'warn', delivered: 'gold',
  disputed: 'bad', completed: 'teal', cancelled: 'glass',
};
const statusCls = (s) => STATUS_CLS[s] || '';

async function load() {
  loading.value = true;
  try {
    const data = await marketApi.orders({
      page: page.value,
      size: SIZE,
      q: q.value || undefined,
      role: role.value || undefined,
      status: role.value ? undefined : (activeOnly.value ? 'active' : undefined),
    });
    list.value = page.value === 1 ? (data.list || []) : list.value.concat(data.list || []);
    total.value = data.total || 0;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

function setRole(r) {
  if (role.value === r) return;
  role.value = r;
  page.value = 1;
  list.value = [];
  load();
}
function toggleActive() {
  activeOnly.value = !activeOnly.value;
  page.value = 1;
  list.value = [];
  load();
}
function doSearch() { page.value = 1; list.value = []; load(); }

function open(o) { uni.navigateTo({ url: `/pages/market/detail?id=${o.id}` }); }

const myId = computed(() => auth.user?.id);
const userName = (u) => u?.nickname || u?.username || '-';

// 接单（列表快捷入口）：跳详情页并自动弹出作品选择抽屉（接单须有本站作品，可附带作品供评估）
function take(o) {
  uni.navigateTo({ url: `/pages/market/detail?id=${o.id}&take=1` });
}

// ---- 发布任务单（独立页） ----
function openCreate() {
  if (!auth.isLoggedIn) { uni.navigateTo({ url: '/pages/login/index' }); return; }
  uni.navigateTo({ url: '/pages/market/create' });
}

onMounted(() => {
  load();
});

onLoad(() => {
  // 发布页提交成功后回传：重拉列表
  uni.$on('market:reload', load);
});
onUnload(() => {
  uni.$off('market:reload', load);
});

onPullDownRefresh(async () => {
  page.value = 1;
  try { await load(); } finally { uni.stopPullDownRefresh(); }
});
onReachBottom(() => {
  if (loading.value || list.value.length >= total.value) return;
  page.value += 1;
  load();
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <!-- 头部 -->
    <AdNavbar :title="t('market.title')">
      <template #right>
        <view class="iconbtn gold" @tap="openCreate"><m-icon name="plus" :size="18" /></view>
      </template>
    </AdNavbar>

    <!-- 任务单条 -->
    <view class="mstrip" @tap="openCreate">
      <m-icon name="spark" :size="16" />
      <text class="mstrip-t">{{ t('mobile.market.strip') }}</text>
      <m-icon name="right" :size="13" />
    </view>

    <!-- 视角 tabs + 进行中过滤 -->
    <view class="chips">
      <text class="pchip" :class="{ on: role === '' }" @tap="setRole('')">{{ t('market.all') }}</text>
      <text class="pchip" :class="{ on: role === 'published' }" @tap="setRole('published')">{{ t('market.mine') }}</text>
      <text class="pchip" :class="{ on: role === 'taken' }" @tap="setRole('taken')">{{ t('market.taken') }}</text>
      <text v-if="!role" class="pchip" :class="{ on: activeOnly }" @tap="toggleActive">{{ t('market.filterActive') }}</text>
    </view>

    <!-- 订单卡列表 -->
    <view v-for="o in list" :key="o.id" class="ocard" @tap="open(o)">
      <view class="otop">
        <text class="chip sm" :class="statusCls(o.status)">{{ t('market.status.' + o.status) }}</text>
        <text class="otitle">{{ o.title }}</text>
      </view>
      <view class="odesc">{{ o.requirement }}</view>
      <view class="ometa">
        <text class="chip glass sm">{{ t('market.durationVal', { s: o.duration_seconds }) }}</text>
        <text class="chip glass sm">{{ o.resolution }}</text>
        <text v-if="o.aspect_ratio" class="chip glass sm">{{ o.aspect_ratio }}</text>
        <text class="oprice">{{ t('market.perSecond', { p: formatCredits(o.price_per_second) }) }}</text>
      </view>
      <view class="opeople">
        <text>{{ t('market.publisher') }}：{{ userName(o.publisher) }}</text>
        <text v-if="o.worker">{{ t('market.worker') }}：{{ userName(o.worker) }}</text>
      </view>
      <view class="oact">
        <text class="ototal">{{ t('market.totalPrice', { n: formatCredits(o.total_price) }) }}</text>
        <view
          v-if="o.status === 'open' && o.publisher_id !== myId"
          class="mbtn teal sm"
          @tap.stop="take(o)"
        >{{ t('market.take') }}</view>
      </view>
    </view>

    <view v-if="!list.length && !loading" class="ad-empty"><text class="et">{{ t('market.empty') }}</text></view>
    <view v-if="loading" class="ad-loading"><text>{{ t('common.loading') }}</text></view>
    <view v-if="!loading && list.length >= total && list.length" class="ad-endfoot"><text>{{ t('mobile.common.noMore') }}</text></view>

    <AdDialog />
  </view>
</template>

<style scoped>
.mstrip {
  margin: 4px 18px 10px; padding: 10px 14px; border-radius: 14px;
  display: flex; align-items: center; gap: 8px;
  background: linear-gradient(135deg, rgba(224, 182, 78, 0.14), rgba(224, 182, 78, 0.05));
  border: 1px solid rgba(224, 182, 78, 0.3);
  color: var(--ad-brand);
}
.mstrip-t { flex: 1; font-size: 12px; color: var(--ad-brand); }
.otitle { flex: 1; min-width: 0; font-weight: 800; font-size: 15px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.odesc { margin-top: 8px; font-size: 12.5px; color: var(--ad-text-soft); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ometa { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.oprice { margin-left: auto; color: var(--ad-brand); font-size: 12px; font-weight: 700; }
.opeople { display: flex; gap: 12px; margin-top: 8px; font-size: 11px; color: var(--ad-text-mut); }
.oact { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.ototal { font-size: 13px; font-weight: 700; color: var(--ad-brand); }
.ad-loading { padding: 24px 0; text-align: center; color: var(--ad-text-mut); font-size: 12px; }
.ad-endfoot { padding: 14px 0 6px; text-align: center; color: var(--ad-text-mut); font-size: 11px; }
.ad-empty { padding: 60px 30px; text-align: center; color: var(--ad-text-mut); font-size: 13px; }
.iconbtn.gold { color: var(--ad-brand); }
</style>
