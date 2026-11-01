<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { artStyleApi, jobApi } from '../api';
import { useCostAction } from '../composables/useCostAction';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

const { t } = useI18n();
const { runJob } = useCostAction();

const PROMPT_KEYS = [
  'prefix', 'art_character', 'art_scene', 'art_prop', 'art_storyboard_video',
  'director_storyboard', 'director_planning_style', 'director_storyboard_table_style',
];
const CATEGORIES = [
  { value: 'realistic', labelKey: 'artStyle.realistic' },
  { value: 'anime', labelKey: 'artStyle.anime' },
];

const list = ref([]);
const loading = ref(false);
const filterCat = ref('all');

// 新建对话框
const showCreate = ref(false);
const createForm = ref({ name: '', category: 'anime', clone_from: '' });

// 编辑对话框
const showEdit = ref(false);
const editing = ref(null);
const editTab = ref('basic');
const promptList = ref([]); // 克隆源用
const activePrompt = ref('prefix');
const promptContent = ref('');
const promptLoading = ref(false);
const promptSaving = ref(false);

// 行内生成中任务：styleId -> job
const genJobs = ref({});
let pollTimer = null;

const filtered = computed(() => {
  if (filterCat.value === 'all') return list.value;
  return list.value.filter((s) => s.category === filterCat.value);
});

const categoryLabel = (c) => t(`artStyle.${c}`);

function thumbUrl(s) {
  return `/skills/art_skills/${s.key}/images/preview.webp?v=${s.image_version || 1}`;
}

// 大图（1.webp）预览
const previewList = ref([]);
const showPreview = ref(false);
function openPreview(s) {
  previewList.value = [`/skills/art_skills/${s.key}/images/1.webp?v=${s.image_version || 1}`];
  showPreview.value = true;
}

async function load() {
  loading.value = true;
  try {
    list.value = (await artStyleApi.adminList()) || [];
    promptList.value = list.value.map((s) => ({ key: s.key, name: s.name }));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createForm.value = { name: '', category: 'anime', clone_from: '2D_chinese_guofeng' };
  showCreate.value = true;
}

async function doCreate() {
  if (!createForm.value.name.trim()) return ElMessage.error(t('artStyle.nameRequired'));
  try {
    await artStyleApi.create({
      name: createForm.value.name.trim(),
      category: createForm.value.category,
      clone_from: createForm.value.clone_from || undefined,
    });
    ElMessage.success(t('artStyle.created'));
    showCreate.value = false;
    await load();
  } catch (e) { /* http 拦截器已提示 */ }
}

async function openEdit(s) {
  editing.value = s;
  editTab.value = 'basic';
  activePrompt.value = 'prefix';
  promptContent.value = '';
  showEdit.value = true;
  await loadPrompt(s.id, 'prefix');
}

async function loadPrompt(id, logical) {
  promptLoading.value = true;
  try {
    const data = await artStyleApi.getPrompt(id, logical);
    promptContent.value = data.content || '';
  } finally {
    promptLoading.value = false;
  }
}

function onSelectPrompt(logical) {
  activePrompt.value = logical;
  loadPrompt(editing.value.id, logical);
}

async function savePrompt() {
  promptSaving.value = true;
  try {
    await artStyleApi.savePrompt(editing.value.id, activePrompt.value, promptContent.value);
    ElMessage.success(t('artStyle.promptSaved'));
  } finally {
    promptSaving.value = false;
  }
}

async function toggleEnabled(s) {
  try {
    await artStyleApi.update(s.id, { enabled: s.enabled });
  } catch (e) {
    s.enabled = !s.enabled; // 回滚
  }
}

async function saveBasic() {
  const s = editing.value;
  await artStyleApi.update(s.id, { name: s.name, category: s.category, sort_order: s.sort_order, enabled: s.enabled });
  ElMessage.success(t('artStyle.updated'));
  await load();
}

async function remove(s) {
  await ElMessageBox.confirm(t('artStyle.deleteConfirm'), t('common.tip'), { type: 'warning' });
  try {
    await artStyleApi.remove(s.id);
    ElMessage.success(t('artStyle.deleted'));
    await load();
  } catch (e) { /* 拦截器提示（如默认风格不可删） */ }
}

async function move(s, dir) {
  const arr = filtered.value;
  const i = arr.findIndex((x) => x.id === s.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  // 交换并按当前可见顺序重排（全局 ids 用全量列表，保持其它段不动）
  const ids = list.value.map((x) => x.id);
  const gi = ids.indexOf(arr[i].id);
  const gj = ids.indexOf(arr[j].id);
  [ids[gi], ids[gj]] = [ids[gj], ids[gi]];
  await artStyleApi.reorder(ids);
  ElMessage.success(t('artStyle.reordered'));
  await load();
}

// 上传图片
async function onUploadImage(file, type) {
  try {
    await artStyleApi.uploadImage(editing.value.id, file, type);
    ElMessage.success(t('artStyle.imageUploaded'));
    await load();
    const fresh = list.value.find((x) => x.id === editing.value.id);
    if (fresh) editing.value = fresh;
  } catch (e) { /* 拦截器提示 */ }
  return false; // 阻止 el-upload 自动上传
}

// 生成示例图（走统一「模型+价格」确认页）
async function genImage(s) {
  const job = await runJob({
    modelType: 'image',
    selection: {},
    estimateFor: (sel) => artStyleApi.genImageEstimate(sel.modelConfigId),
    createFor: (sel) => artStyleApi.genImage(s.id, sel.modelConfigId).then((data) => ({ job: data.job })),
    title: t('artStyle.genImage'),
    desc: s.name,
    onDone: () => { load(); },
  });
  if (job) {
    genJobs.value[s.id] = job;
    ElMessage.success(t('artStyle.genImageQueued'));
    startPolling();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const ids = Object.keys(genJobs.value);
    if (!ids.length) { stopPolling(); return; }
    for (const sid of ids) {
      const job = genJobs.value[sid];
      try {
        const j = await jobApi.get(job.id);
        if (['succeeded', 'failed', 'cancelled'].includes(j.status)) {
          delete genJobs.value[sid];
          await load();
        }
      } catch { /* 忽略 */ }
    }
    if (!Object.keys(genJobs.value).length) stopPolling();
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

onMounted(() => {
  load();
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <!-- 页头 -->
      <div class="page-head ad-page-head">
        <div class="page-head-text">
          <div class="ad-title-lg ad-title">{{ t('artStyle.title') }}</div>
          <div class="ad-sub page-head-sub">
            {{ filterCat === 'all' ? list.length : list.filter((s) => s.category === filterCat).length }}
            / {{ list.length }} · {{ t('artStyle.title') }}
          </div>
        </div>
        <el-button type="primary" class="btn-ink" @click="openCreate">
          <el-icon><Plus /></el-icon> {{ t('artStyle.add') }}
        </el-button>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <!-- 大类筛选 -->
      <div class="type-tabs ad-stagger">
        <button class="type-tab ad-card" :class="{ active: filterCat === 'all' }" @click="filterCat = 'all'">
          <span class="type-tab-icon"><el-icon><Brush /></el-icon></span>
          <span class="type-tab-text">
            <span class="ad-title">{{ t('artStyle.title') }}</span>
            <span class="type-tab-count">{{ list.length }}</span>
          </span>
        </button>
        <button v-for="c in CATEGORIES" :key="c.value" class="type-tab ad-card" :class="{ active: filterCat === c.value }" @click="filterCat = c.value">
          <span class="type-tab-icon"><el-icon><PictureFilled v-if="c.value === 'realistic'" /><MagicStick v-else /></el-icon></span>
          <span class="type-tab-text">
            <span class="ad-title">{{ t(c.labelKey) }}</span>
            <span class="type-tab-count">{{ list.filter((s) => s.category === c.value).length }}</span>
          </span>
        </button>
      </div>

      <!-- 风格列表 -->
      <div class="cfg-list ad-stagger">
        <div v-for="s in filtered" :key="s.id" class="cfg-item ad-card">
          <div class="style-thumb" :class="{ clickable: !genJobs[s.id] }" @click="!genJobs[s.id] && openPreview(s)">
            <img :src="thumbUrl(s)" :alt="s.name" @error="(e) => e.target.style.display='none'" />
            <div v-if="genJobs[s.id]" class="thumb-gen">{{ t('artStyle.creating') }}</div>
          </div>
          <div class="cfg-main">
            <div class="cfg-title-row">
              <span class="ad-title">{{ s.name }}</span>
              <span class="chip">{{ categoryLabel(s.category) }}</span>
              <span class="chip" :class="s.enabled ? 'chip-success' : 'chip-danger'">{{ s.enabled ? t('common.enable') : t('common.disable') }}</span>
            </div>
            <div class="cfg-meta">
              <span class="cfg-meta-item"><span class="ad-muted">{{ t('artStyle.key') }}</span><code class="key-code">{{ s.key }}</code></span>
              <span class="cfg-meta-item"><span class="ad-muted">{{ t('artStyle.order') }}</span>{{ s.sort_order }}</span>
            </div>
          </div>
          <div class="cfg-ops">
            <el-switch size="small" v-model="s.enabled" @change="toggleEnabled(s)" />
            <el-button size="small" text @click="move(s, -1)"><el-icon><ArrowUp /></el-icon></el-button>
            <el-button size="small" text @click="move(s, 1)"><el-icon><ArrowDown /></el-icon></el-button>
            <el-button size="small" text @click="openEdit(s)"><el-icon><Edit /></el-icon>{{ t('common.edit') }}</el-button>
            <el-button size="small" text type="danger" @click="remove(s)"><el-icon><Delete /></el-icon></el-button>
          </div>
        </div>
        <EmptyState
          v-if="!filtered.length"
          class="ad-card"
          icon="🎨"
          :title="t('artStyle.add')"
          :action-label="t('artStyle.add')"
          @action="openCreate"
        />
      </div>

      <!-- 新建对话框 -->
      <el-dialog v-model="showCreate" :title="t('artStyle.add')" width="min(520px, 94vw)">
        <el-form label-position="top">
          <el-form-item :label="t('artStyle.name')">
            <el-input size="large" v-model="createForm.name" placeholder="如：都市影像" />
          </el-form-item>
          <el-form-item :label="t('artStyle.category')">
            <el-select size="large" v-model="createForm.category" style="width:100%">
              <el-option v-for="c in CATEGORIES" :key="c.value" :label="t(c.labelKey)" :value="c.value" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('artStyle.cloneFrom')">
            <el-select size="large" v-model="createForm.clone_from" style="width:100%" filterable>
              <el-option v-for="p in promptList" :key="p.key" :label="p.name" :value="p.key" />
            </el-select>
            <div class="ad-sub" style="font-size:12px; margin-top:4px;">{{ t('artStyle.cloneFromHint') }}</div>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="showCreate = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="doCreate">{{ t('common.confirm') }}</el-button>
        </template>
      </el-dialog>

      <!-- 编辑对话框 -->
      <el-dialog v-model="showEdit" :title="t('artStyle.edit')" width="min(860px, 94vw)" top="5vh">
        <el-tabs v-model="editTab">
          <!-- 基本信息 -->
          <el-tab-pane :label="t('common.edit')" name="basic">
            <el-form label-position="top" class="model-form-grid" v-if="editing">
              <el-form-item :label="t('artStyle.name')"><el-input size="large" v-model="editing.name" /></el-form-item>
              <el-form-item :label="t('artStyle.category')">
                <el-select size="large" v-model="editing.category" style="width:100%">
                  <el-option v-for="c in CATEGORIES" :key="c.value" :label="t(c.labelKey)" :value="c.value" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('artStyle.key')"><el-input size="large" :model-value="editing.key" disabled /></el-form-item>
              <el-form-item :label="t('artStyle.order')"><el-input-number size="large" v-model="editing.sort_order" :min="0" /></el-form-item>
              <el-form-item :label="t('artStyle.enabled')"><el-switch v-model="editing.enabled" /></el-form-item>
            </el-form>
            <div style="text-align:right; margin-top:12px;">
              <el-button type="primary" class="btn-ink" @click="saveBasic">{{ t('common.save') }}</el-button>
            </div>
          </el-tab-pane>

          <!-- 提示词 -->
          <el-tab-pane :label="t('artStyle.prompts')" name="prompts">
            <div class="prompt-editor" v-if="editing">
              <div class="prompt-tabs">
                <button v-for="k in PROMPT_KEYS" :key="k" class="prompt-tab" :class="{ active: activePrompt === k }" @click="onSelectPrompt(k)">{{ k }}</button>
              </div>
              <el-input v-model="promptContent" type="textarea" :rows="18" v-loading="promptLoading" style="margin-top:8px;" />
              <div style="text-align:right; margin-top:8px;">
                <el-button type="primary" class="btn-ink" :loading="promptSaving" @click="savePrompt">{{ t('artStyle.savePrompt') }}</el-button>
              </div>
            </div>
          </el-tab-pane>

          <!-- 图片 -->
          <el-tab-pane :label="t('artStyle.images')" name="images">
            <div class="img-pane" v-if="editing">
              <div class="img-block">
                <div class="ad-sub">{{ t('artStyle.uploadPreview') }}</div>
                <img v-if="editing" :src="thumbUrl(editing)" class="img-preview" @error="(e) => e.target.style.opacity=0.2" />
                <el-upload :show-file-list="false" :before-upload="(f) => onUploadImage(f, 'preview')" accept="image/png,image/jpeg">
                  <el-button size="small">{{ t('artStyle.uploadPreview') }}</el-button>
                </el-upload>
              </div>
              <div class="img-block">
                <div class="ad-sub">{{ t('artStyle.uploadLarge') }}</div>
                <el-upload :show-file-list="false" :before-upload="(f) => onUploadImage(f, 'large')" accept="image/png,image/jpeg">
                  <el-button size="small">{{ t('artStyle.uploadLarge') }}</el-button>
                </el-upload>
                <el-button size="small" type="primary" class="btn-ink" @click="genImage(editing)">{{ t('artStyle.regenImage') }}</el-button>
                <div class="ad-sub" style="font-size:12px;">{{ t('artStyle.noImage') }}</div>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </el-dialog>

      <!-- 大图预览（1.webp） -->
      <!-- z-index 3000：刻意压过编辑抽屉/弹窗（Element 默认层级 2000+），保证从弹窗内点开的预览浮在最上层 -->
      <el-image-viewer v-if="showPreview" :url-list="previewList" :z-index="3000" @close="showPreview = false" />
    </div>
  </div>
</template>

<style scoped>
/* ===== 页头 ===== */
.page-head {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
}
.page-head-sub { margin-top: 4px; font-size: 13px; }

/* ===== 大类筛选卡 ===== */
.type-tabs {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px;
}
.type-tab {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; cursor: pointer;
  border: 2px solid transparent; transition: all 0.15s; text-align: left;
}
.type-tab:hover { box-shadow: var(--ad-shadow-hover); transform: translateY(-1px); }
.type-tab.active { border-color: var(--ad-brand); }
.type-tab-icon {
  font-size: 22px; line-height: 1; color: var(--ad-brand);
  width: 40px; height: 40px; border-radius: var(--ad-radius-sm);
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-brand-soft); flex-shrink: 0;
}
.type-tab-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.type-tab-count { font-size: 12px; color: var(--ad-text-muted); }

/* ===== 列表 ===== */
.cfg-list { display: flex; flex-direction: column; gap: 12px; }
.cfg-item {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 18px; transition: box-shadow 0.15s, transform 0.1s;
}
.cfg-item:hover { box-shadow: var(--ad-shadow-hover); }

/* 缩略图 */
.style-thumb {
  width: 72px; height: 72px; border-radius: 12px; overflow: hidden;
  background: var(--ad-bg-soft); position: relative; flex-shrink: 0;
  box-shadow: inset 0 0 0 1px var(--ad-border);
}
.style-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.style-thumb.clickable { cursor: zoom-in; }
.style-thumb.clickable:hover { box-shadow: inset 0 0 0 2px var(--ad-brand); }
.thumb-gen {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.55); color: #fff; font-size: 12px; font-weight: 600;
}

.cfg-main { flex: 1; min-width: 0; }
.cfg-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cfg-meta {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  margin-top: 6px; font-size: 13px; color: var(--ad-text-soft);
}
.cfg-meta-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.key-code {
  font-family: var(--ad-font-mono); font-size: 12px;
  padding: 1px 8px; border-radius: 6px; background: var(--ad-bg-soft);
  color: var(--ad-text-soft); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.cfg-ops {
  display: flex; align-items: center; gap: 2px; flex-shrink: 0;
  flex-wrap: wrap; justify-content: flex-end;
}

/* ===== 提示词编辑 ===== */
.prompt-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.prompt-tab {
  padding: 5px 12px; border-radius: 8px; border: 1px solid var(--ad-border);
  background: transparent; cursor: pointer; font-size: 12px; font-weight: 600;
  color: var(--ad-text-soft); transition: all 0.15s;
}
.prompt-tab:hover { border-color: var(--ad-border-strong); color: var(--ad-text); }
.prompt-tab.active {
  background: var(--ad-brand); color: var(--ad-brand-contrast); border-color: var(--ad-brand);
}

/* ===== 图片 tab ===== */
.img-pane { display: flex; gap: 24px; flex-wrap: wrap; }
.img-block { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.img-preview { width: 160px; height: 100px; object-fit: cover; border-radius: var(--ad-radius-sm); background: var(--ad-bg-soft); box-shadow: inset 0 0 0 1px var(--ad-border); }

/* ===== 编辑弹窗：基本信息双列表单 ===== */
.model-form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; row-gap: 0; }
.model-form-grid :deep(.span-full) { grid-column: 1 / -1; }

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .type-tabs { grid-template-columns: 1fr; }
  .cfg-item { padding: 12px 14px; gap: 12px; }
  .style-thumb { width: 60px; height: 60px; border-radius: var(--ad-radius-sm); }
  .cfg-ops { width: 100%; justify-content: flex-start; gap: 0; }
  .model-form-grid { grid-template-columns: 1fr; }
  .img-pane { gap: 16px; }
}</style>
