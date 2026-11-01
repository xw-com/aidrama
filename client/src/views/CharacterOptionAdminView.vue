<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { characterOptionApi, jobApi } from '../api';
import { useCostAction } from '../composables/useCostAction';
import { ElMessage } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

/**
 * 角色自定义选项示例图管理：注册表来自服务端代码常量，
 * 这里只负责生成/重新生成各选项的 AI 示例图（单个或批量补缺）。
 */
const { t, te } = useI18n();
const { runJob } = useCostAction();

const groups = ref([]);
const stats = ref({ total: 0, generated: 0, missing: 0 });
const loading = ref(false);
const filterGroup = ref('all');
const previewUrl = ref(''); // 4K 大图预览（el-image-viewer）

// 行内生成任务：`${group}/${key}` -> job；批量任务单独跟踪（带进度）
const genJobs = ref({});
const batchJob = ref(null);
let pollTimer = null;

// i18n 缺失回退：显示服务端下发的中文 label
const label = (keyPath, zh) => (te(keyPath) ? t(keyPath) : zh);

const groupTabs = computed(() => [{ key: 'all', zh: t('charOptionAdmin.allGroups'), count: stats.value.total }].concat(
  groups.value.map((g) => ({ key: g.key, zh: label(`charCreator.group.${g.key}`, g.zh), count: g.options.length })),
));

const filtered = computed(() => {
  if (filterGroup.value === 'all') {
    return groups.value.flatMap((g) => g.options.map((o) => ({ ...o, groupKey: g.key, groupZh: g.zh })));
  }
  const g = groups.value.find((x) => x.key === filterGroup.value);
  return g ? g.options.map((o) => ({ ...o, groupKey: g.key, groupZh: g.zh })) : [];
});

async function load() {
  loading.value = true;
  try {
    const data = await characterOptionApi.adminList();
    groups.value = data.groups || [];
    stats.value = data.stats || { total: 0, generated: 0, missing: 0 };
  } finally {
    loading.value = false;
  }
}

// 单个（重新）生成示例图
async function genImage(groupKey, opt) {
  const id = `${groupKey}/${opt.key}`;
  const job = await runJob({
    modelType: 'image',
    estimateFor: (sel) => characterOptionApi.adminGenEstimate(sel),
    createFor: (sel) => characterOptionApi.adminGen(groupKey, opt.key, sel.modelConfigId).then((d) => ({ job: d.job })),
    title: t('charOptionAdmin.title'),
    desc: label(`charCreator.option.${groupKey}.${opt.key}`, opt.zh),
    onDone: () => { load(); },
  });
  if (job) {
    genJobs.value[id] = job;
    startPolling();
  }
}

// 批量补齐缺失示例图
async function genMissing() {
  const job = await runJob({
    modelType: 'image',
    estimateFor: (sel) => characterOptionApi.adminBatchEstimate(sel),
    createFor: (sel) => characterOptionApi.adminBatch(sel.modelConfigId).then((d) => ({ job: d.job })),
    title: t('charOptionAdmin.batchGen'),
    desc: t('charOptionAdmin.batchDesc', { n: stats.value.missing }),
  });
  if (job) {
    batchJob.value = job;
    startPolling();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    let busy = false;
    for (const id of Object.keys(genJobs.value)) {
      try {
        const j = await jobApi.get(genJobs.value[id].id);
        if (['succeeded', 'failed', 'cancelled'].includes(j.status)) delete genJobs.value[id];
        else busy = true;
      } catch { delete genJobs.value[id]; }
    }
    if (batchJob.value) {
      try {
        const j = await jobApi.get(batchJob.value.id);
        if (['succeeded', 'failed', 'cancelled'].includes(j.status)) {
          const done = j.status === 'succeeded';
          batchJob.value = null;
          if (done) ElMessage.success(t('charOptionAdmin.batchDone'));
        } else {
          batchJob.value = { ...j };
          busy = true;
        }
      } catch { batchJob.value = null; }
    }
    await load(); // 刷新已生成计数/预览 URL
    if (!busy && !batchJob.value) stopPolling();
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function openPreview(o) {
  if (o.previewLarge) previewUrl.value = o.previewLarge;
}

onMounted(load);
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <!-- 页头 -->
      <div class="page-head ad-page-head">
        <div class="page-head-text">
          <div class="ad-title-lg ad-title">{{ t('charOptionAdmin.title') }}</div>
          <div class="ad-sub page-head-sub">
            {{ t('charOptionAdmin.total', { n: stats.total }) }} ·
            {{ t('charOptionAdmin.generated', { n: stats.generated }) }} ·
            {{ t('charOptionAdmin.missing', { n: stats.missing }) }}
          </div>
        </div>
        <el-button type="primary" class="btn-ink" :disabled="!stats.missing || !!batchJob" :loading="!!batchJob" @click="genMissing">
          <el-icon><MagicStick /></el-icon> {{ t('charOptionAdmin.batchGen') }}<span v-if="stats.missing">（{{ stats.missing }}）</span>
        </el-button>
      </div>
      <hr class="ad-rule" />

      <!-- 批量任务进度 -->
      <div v-if="batchJob" class="job-progress ad-card">
        <div class="jp-head">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span class="jp-title">{{ batchJob.stage || batchJob.title || t('charOptionAdmin.batchGen') }}</span>
          <span class="ad-muted">{{ batchJob.progress || 0 }}%</span>
        </div>
        <el-progress :percentage="batchJob.progress || 0" :show-text="false" :stroke-width="6" />
      </div>

      <!-- 分组筛选 -->
      <div class="grp-tabs">
        <button
          v-for="g in groupTabs" :key="g.key"
          class="grp-tab" :class="{ active: filterGroup === g.key }"
          @click="filterGroup = g.key"
        >{{ g.zh }} <span class="cnt">{{ g.count }}</span></button>
      </div>

      <!-- 选项列表 -->
      <div class="opt-list ad-stagger">
        <div v-for="o in filtered" :key="`${o.groupKey}/${o.key}`" class="opt-item ad-card">
          <div class="opt-thumb" :class="{ clickable: o.previewLarge && !genJobs[`${o.groupKey}/${o.key}`] }" @click="o.previewLarge && !genJobs[`${o.groupKey}/${o.key}`] && openPreview(o)">
            <img v-if="o.preview" :src="o.preview" :alt="label(`charCreator.option.${o.groupKey}.${o.key}`, o.zh)" @error="(e) => e.target.style.display = 'none'" />
            <div v-else class="opt-thumb-missing">{{ label(`charCreator.option.${o.groupKey}.${o.key}`, o.zh) }}</div>
            <div v-if="genJobs[`${o.groupKey}/${o.key}`]" class="thumb-gen">{{ t('charOptionAdmin.generating') }}</div>
          </div>
          <div class="opt-main">
            <div class="opt-title-row">
              <span class="ad-title">{{ label(`charCreator.option.${o.groupKey}.${o.key}`, o.zh) }}</span>
              <span class="chip">{{ label(`charCreator.group.${o.groupKey}`, o.groupZh) }}</span>
              <span class="chip" :class="o.preview ? 'chip-success' : 'chip-danger'">{{ o.preview ? t('charOptionAdmin.generatedChip') : t('charOptionAdmin.missingChip') }}</span>
            </div>
            <div class="opt-meta"><code class="key-code">{{ o.groupKey }}/{{ o.key }}</code></div>
          </div>
          <div class="opt-ops">
            <el-button size="small" text type="primary" :disabled="!!genJobs[`${o.groupKey}/${o.key}`] || !!batchJob" @click="genImage(o.groupKey, o)">
              <el-icon><MagicStick /></el-icon> {{ o.preview ? t('charOptionAdmin.regen') : t('charOptionAdmin.gen') }}
            </el-button>
          </div>
        </div>
        <EmptyState v-if="!filtered.length" class="ad-card" icon="👤" :title="t('charOptionAdmin.title')" />
      </div>

      <!-- 4K 大图预览 -->
      <!-- z-index 3000：刻意压过编辑抽屉/弹窗（Element 默认层级 2000+），保证预览浮在最上层 -->
      <el-image-viewer v-if="previewUrl" :url-list="[previewUrl]" :z-index="3000" @close="previewUrl = ''" />
    </div>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.page-head-sub { margin-top: 4px; font-size: 13px; }
/* 页头下金色分隔线 */
.page-head + .ad-rule { margin: 0 0 16px; }

.job-progress { padding: 12px 16px; margin-bottom: 16px; }
.jp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
.jp-head .is-loading { color: var(--ad-brand); }
.jp-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 分组筛选 */
.grp-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.grp-tab {
  padding: 6px 14px; border-radius: 999px; cursor: pointer; font-size: 13px; font-weight: 600;
  border: 1px solid var(--ad-border); background: transparent; color: var(--ad-text-soft); transition: all 0.15s;
}
.grp-tab:hover { border-color: var(--ad-border-strong); color: var(--ad-text); }
.grp-tab.active { background: var(--ad-brand); color: var(--ad-brand-contrast); border-color: var(--ad-brand); }
.grp-tab .cnt { opacity: 0.75; font-weight: 500; margin-left: 2px; }

/* 选项列表 */
.opt-list { display: flex; flex-direction: column; gap: 10px; }
.opt-item { display: flex; align-items: center; gap: 14px; padding: 12px 16px; }
.opt-item:hover { box-shadow: var(--ad-shadow-hover); }

.opt-thumb {
  width: 128px; aspect-ratio: 16 / 9; border-radius: var(--ad-radius-sm); overflow: hidden; flex-shrink: 0;
  background: var(--ad-bg-soft); position: relative; box-shadow: inset 0 0 0 1px var(--ad-border);
}
/* 中窄屏（平板）缩略图收一档，给标题/操作留宽度 */
@media (max-width: 1024px) {
  .opt-thumb { width: 96px; }
}
.opt-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.opt-thumb.clickable { cursor: zoom-in; }
.opt-thumb.clickable:hover { box-shadow: inset 0 0 0 2px var(--ad-brand); }
.opt-thumb-missing {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  padding: 6px; text-align: center; font-size: 12px; font-weight: 600; color: var(--ad-text-muted);
  background: linear-gradient(135deg, var(--ad-brand-soft), var(--ad-bg-soft));
}
.thumb-gen {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 12px; font-weight: 600;
}

.opt-main { flex: 1; min-width: 0; }
.opt-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.opt-meta { margin-top: 6px; }
.key-code {
  font-family: var(--ad-font-mono); font-size: 12px;
  padding: 1px 8px; border-radius: 6px; background: var(--ad-bg-soft); color: var(--ad-text-soft);
}
.opt-ops { flex-shrink: 0; }

@media (max-width: 768px) {
  .opt-item { padding: 10px 12px; gap: 10px; }
  .opt-thumb { width: 96px; }
  .opt-ops { width: 100%; }
}
</style>
