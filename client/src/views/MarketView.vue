<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { marketApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { formatCredits } from '../utils/format';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

// 接单中心列表：广场（全部/进行中）· 我发布的 · 我接的；右上角「发布任务单」
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();

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
  open: 'chip-success', working: 'chip-warning', delivered: 'chip-accent',
  disputed: 'chip-danger', completed: '', cancelled: '',
};

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
    list.value = data.list || [];
    total.value = data.total || 0;
  } finally {
    loading.value = false;
  }
}

function search() { page.value = 1; load(); }
function setRole(r) { role.value = r; page.value = 1; load(); }
function toggleActive(v) { activeOnly.value = v; page.value = 1; load(); }

function open(o) { router.push({ name: 'marketDetail', params: { id: o.id } }); }

const myId = computed(() => auth.user?.id);
const isMine = (o) => o.publisher_id === myId.value;
const userName = (u) => u?.nickname || u?.username || '-';

// ---- 接单（列表快捷入口，二次确认）----
async function take(o) {
  try {
    await ElMessageBox.confirm(t('market.takeConfirm'), t('market.take'), {
      type: 'info', confirmButtonText: t('market.take'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; }
  await marketApi.take(o.id);
  ElMessage.success(t('market.takenToast'));
  open(o);
}

// ---- 发布任务单 ----
const createVisible = ref(false);
const creating = ref(false);
const RESOLUTIONS = ['720p', '1080p', '4k'];
const ASPECTS = ['16:9', '9:16', '1:1'];
const form = ref({
  title: '', requirement: '',
  duration_seconds: 60, price_per_second: 1,
  resolution: '1080p', aspect_ratio: '',
});

const totalPrice = computed(() =>
  Math.max(0, (parseInt(form.value.duration_seconds, 10) || 0) * (Math.round((Number(form.value.price_per_second) || 0) * 10) / 10)));
const balance = computed(() => (auth.credits ?? 0));
const insufficient = computed(() => totalPrice.value > balance.value);

function openCreate() {
  auth.refreshCredits();
  form.value = { title: '', requirement: '', duration_seconds: 60, price_per_second: 1, resolution: '1080p', aspect_ratio: '' };
  createVisible.value = true;
}

async function submitCreate() {
  if (!form.value.title.trim() || !form.value.requirement.trim()) {
    ElMessage.warning(t('market.form.required'));
    return;
  }
  creating.value = true;
  try {
    const order = await marketApi.create({
      ...form.value,
      aspect_ratio: form.value.aspect_ratio || undefined,
    });
    createVisible.value = false;
    auth.refreshCredits();
    ElMessage.success(t('market.createdToast'));
    open(order);
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-flex-between ad-page-head mk-head" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg">{{ t('market.title') }}</div>
          <div class="ad-sub">{{ t('market.subtitle') }}</div>
        </div>
        <div class="ad-flex-center ad-gap-sm mk-tools">
          <el-input
            v-model="q" clearable :placeholder="t('market.searchPlaceholder')"
            style="width: min(220px, 56vw)" @keyup.enter="search" @clear="search"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon></el-button>
          <el-button type="primary" class="btn-ink" @click="openCreate">
            <el-icon><Plus /></el-icon> {{ t('market.newOrder') }}
          </el-button>
        </div>
      </div>

      <div class="mk-tabs">
        <el-radio-group :model-value="role" @update:model-value="setRole">
          <el-radio-button value="">{{ t('market.all') }}</el-radio-button>
          <el-radio-button value="published">{{ t('market.mine') }}</el-radio-button>
          <el-radio-button value="taken">{{ t('market.taken') }}</el-radio-button>
        </el-radio-group>
        <el-checkbox
          v-if="!role" :model-value="activeOnly" @update:model-value="toggleActive"
        >{{ t('market.filterActive') }}</el-checkbox>
      </div>

      <div class="ad-rule mk-rule" />

      <div v-if="list.length" v-loading="loading" class="mk-list ad-stagger">
        <div v-for="o in list" :key="o.id" class="ad-card mk-card" @click="open(o)">
          <div class="mk-card-main">
            <div class="mk-title-row">
              <span class="chip mini" :class="STATUS_CLS[o.status] || ''">{{ t('market.status.' + o.status) }}</span>
              <span class="mk-title">{{ o.title }}</span>
            </div>
            <div class="mk-req">{{ o.requirement }}</div>
            <div class="mk-meta">
              <span><el-icon><Timer /></el-icon> {{ t('market.durationVal', { s: o.duration_seconds }) }}</span>
              <span><el-icon><DataLine /></el-icon> {{ o.resolution }}</span>
              <span v-if="o.aspect_ratio"><el-icon><Crop /></el-icon> {{ o.aspect_ratio }}</span>
              <span class="mk-price">{{ t('market.perSecond', { p: formatCredits(o.price_per_second) }) }}</span>
            </div>
            <div class="mk-people">
              <span>{{ t('market.publisher') }}：{{ userName(o.publisher) }}</span>
              <span v-if="o.worker" class="mk-worker">{{ t('market.worker') }}：{{ userName(o.worker) }}</span>
            </div>
          </div>
          <div class="mk-card-side">
            <div class="mk-total">
              <div class="mk-total-num">{{ formatCredits(o.total_price) }}</div>
              <div class="mk-total-label">{{ t('market.totalUnit') }}</div>
            </div>
            <div class="mk-actions" @click.stop>
              <el-button v-if="o.status === 'open' && !isMine(o)" type="primary" class="btn-ink" size="small" @click="take(o)">
                {{ t('market.take') }}
              </el-button>
              <el-button size="small" @click="open(o)">{{ t('market.view') }}</el-button>
            </div>
          </div>
        </div>
      </div>

      <EmptyState v-else-if="!loading" icon="📋" :title="t('market.empty')" />

      <div v-if="total > SIZE" class="mk-pager">
        <el-pagination
          background layout="prev, pager, next" :total="total"
          :page-size="SIZE" :current-page="page"
          @current-change="(p) => { page = p; load(); }"
        />
      </div>

      <!-- 发布任务单 -->
      <el-dialog v-model="createVisible" width="min(480px, 94vw)" top="6vh" append-to-body>
        <template #header>
          <div class="mk-dlg-head">{{ t('market.newOrder') }}</div>
        </template>
        <div class="mk-form">
          <el-form label-position="top">
            <el-form-item :label="t('market.form.title')" required>
              <el-input v-model="form.title" maxlength="100" show-word-limit :placeholder="t('market.form.titlePlaceholder')" />
            </el-form-item>
            <el-form-item :label="t('market.form.requirement')" required>
              <el-input v-model="form.requirement" type="textarea" :rows="5" maxlength="5000" show-word-limit :placeholder="t('market.form.requirementPlaceholder')" />
            </el-form-item>
            <div class="mk-form-row">
              <el-form-item :label="t('market.form.duration')">
                <el-input-number v-model="form.duration_seconds" :min="1" :max="7200" :step="10" style="width: 100%" />
              </el-form-item>
              <el-form-item :label="t('market.form.price')">
                <el-input-number v-model="form.price_per_second" :min="0.1" :max="100000" :step="0.1" :precision="1" style="width: 100%" />
              </el-form-item>
            </div>
            <div class="mk-form-row">
              <el-form-item :label="t('market.form.resolution')">
                <el-select v-model="form.resolution" style="width: 100%">
                  <el-option v-for="r in RESOLUTIONS" :key="r" :label="r" :value="r" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('market.form.aspect')">
                <el-select v-model="form.aspect_ratio" clearable :placeholder="t('market.aspectAny')" style="width: 100%">
                  <el-option v-for="a in ASPECTS" :key="a" :label="a" :value="a" />
                </el-select>
              </el-form-item>
            </div>
          </el-form>

          <div class="mk-total-bar" :class="{ warn: insufficient }">
            <span>{{ t('market.form.total') }}</span>
            <span class="mk-total-bar-calc">{{ t('market.form.totalCalc', { d: form.duration_seconds, p: form.price_per_second, t: formatCredits(totalPrice) }) }}</span>
          </div>
          <div class="mk-balance-row">
            <span>{{ t('market.form.balance', { n: formatCredits(balance) }) }}</span>
            <span v-if="insufficient" class="mk-insufficient">{{ t('market.form.insufficient') }}</span>
          </div>
          <div class="ad-sub">{{ t('market.form.escrowTip') }}</div>
        </div>
        <template #footer>
          <el-button :disabled="creating" @click="createVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" :loading="creating" :disabled="insufficient || !totalPrice" @click="submitCreate">
            {{ t('market.form.submit') }}
          </el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.mk-head { margin-bottom: 0; }
.mk-rule { margin-bottom: 16px; }
.mk-tools { flex-wrap: wrap; }
.mk-tabs { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }

.mk-list { display: flex; flex-direction: column; gap: 12px; }
.mk-card {
  display: flex; gap: 18px; padding: var(--ad-sp-5) var(--ad-sp-6); cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.mk-card:hover { transform: translateY(-2px); box-shadow: var(--ad-shadow-hover); }
.mk-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.mk-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mk-title { font-weight: 700; font-size: var(--ad-fz-lg); color: var(--ad-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mk-req {
  font-size: var(--ad-fz-sm); color: var(--ad-text-soft); line-height: 1.6;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.mk-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; font-size: var(--ad-fz-xs); color: var(--ad-text-muted); }
.mk-meta span { display: inline-flex; align-items: center; gap: 4px; }
.mk-price { font-weight: 600; font-variant-numeric: tabular-nums; }
.mk-people { display: flex; gap: 14px; font-size: var(--ad-fz-xs); color: var(--ad-text-muted); }
.mk-worker { color: var(--ad-brand-600); }

.mk-card-side {
  flex: 0 0 150px; display: flex; flex-direction: column; align-items: stretch; justify-content: space-between; gap: 10px;
}
.mk-total {
  border-radius: var(--ad-radius); padding: 10px 12px; text-align: center;
  background: var(--ad-brand-soft);
}
.mk-total-num { font-size: 20px; font-weight: 800; color: var(--ad-brand-600); font-variant-numeric: tabular-nums; }
.mk-total-label { font-size: var(--ad-fz-xs); color: var(--ad-text-muted); margin-top: 2px; }
.mk-actions { display: flex; flex-direction: column; gap: 8px; }
.mk-actions .el-button { margin-left: 0; width: 100%; }

.mk-pager { display: flex; justify-content: center; margin-top: 20px; }

.mk-dlg-head { font-weight: 800; font-size: 16px; }
.mk-form { display: flex; flex-direction: column; gap: 4px; }
.mk-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.mk-total-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 12px 14px; border-radius: var(--ad-radius);
  background: var(--ad-brand-soft);
  font-weight: 700; color: var(--ad-text-strong);
}
.mk-total-bar.warn { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.mk-total-bar-calc { font-variant-numeric: tabular-nums; }
.mk-balance-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--ad-text-muted); }
.mk-insufficient { color: var(--el-color-danger); font-weight: 700; }

@media (max-width: 768px) {
  .mk-card { flex-direction: column; }
  .mk-card-side { flex: 1 1 auto; flex-direction: row; align-items: center; }
  .mk-total { flex: 1; }
  .mk-actions { flex: 1; flex-direction: row; }
  .mk-actions .el-button { width: auto; }
  .mk-form-row { grid-template-columns: 1fr; }
}
</style>
