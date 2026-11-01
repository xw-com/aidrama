<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { scriptApi, projectApi } from '../../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../../components/EmptyState.vue';
import { can } from '../../utils/perms';

const { t } = useI18n();

const props = defineProps({ project: Object, projectId: [String, Number] });
const emit = defineEmits(['reload', 'next']);

// 剧本编辑权限（导入/解析/分集增改删；成员未授权时全部只读）
const canEdit = computed(() => can(props.project, 'script.edit'));

const episodes = ref([]);
const loading = ref(false);
const selectedId = ref(null);
const editingEpisode = ref(null);
const editTitle = ref('');
const editContent = ref('');
const saving = ref(false);

// 选中的分集正文（大文本不随项目详情下发，选中某集时按需单条拉取 GET /episodes/:eid；
// parse/编辑后分集自带 content 时直接复用，避免重复请求）
const selectedContent = ref('');
const detailBusy = ref(false);
// 字数兼容：lean 详情只给 content_length（整数），parse 结果自带 content 全文
const epLen = (ep) => (ep?.content_length != null ? ep.content_length : (ep?.content || '').length);
const epHasContent = (ep) => epLen(ep) > 0;

// 导入剧本
const showImport = ref(false);
const importText = ref('');
const importBusy = ref(false);

// 拆分执行中（同步接口，防重复点击）
const jsParsing = ref(false);

const totalEpisodes = computed(() => episodes.value.length);
const hasScript = computed(() => !!props.project?.has_script);

const selected = computed(() => episodes.value.find((e) => e.id === selectedId.value) || null);

// 默认选中第一集（选中即按需拉取该集正文）
watch(episodes, (list) => {
  if (list.length && !list.find((e) => e.id === selectedId.value)) {
    selectEp(list[0]);
  }
}, { immediate: true });

async function loadEpisodes() {
  loading.value = true;
  try {
    const p = await projectApi.get(props.projectId);
    emit('reload');
    episodes.value = p.episodes || [];
  } finally {
    loading.value = false;
  }
}

async function doImport() {
  if (!importText.value.trim()) return ElMessage.warning(t('outline.importContentRequired'));
  importBusy.value = true;
  try {
    await scriptApi.importText(props.projectId, importText.value);
    ElMessage.success(t('outline.imported'));
    showImport.value = false;
    importText.value = '';
    await loadEpisodes();
  } finally {
    importBusy.value = false;
  }
}

async function onUpload(file) {
  importBusy.value = true;
  try {
    await scriptApi.importFile(props.projectId, file.raw || file);
    ElMessage.success(t('outline.imported'));
    await loadEpisodes();
  } finally {
    importBusy.value = false;
  }
  return false;
}

// 拆分剧本（JS 本地、同步、零积分、不建任务）：按集级标记切分，无标记按篇幅兜底
async function parseScriptJs() {
  jsParsing.value = true;
  try {
    const data = await scriptApi.parseJs(props.projectId);
    episodes.value = data?.episodes || [];
    ElMessage.success(t('outline.parsed'));
    emit('reload');
  } finally {
    jsParsing.value = false;
  }
}

// 导出剧本（将全部分集拼成 .txt 下载，纯客户端）
// 分集正文不随项目详情下发，导出时并行按集单条拉取
async function exportScript() {
  if (!episodes.value.length) return ElMessage.warning(t('outline.noEpisodesToExport'));
  const projectName = props.project?.name || t('outline.scriptLabel');
  const full = await Promise.all(episodes.value.map(async (e) => {
    if (e.content != null) return e;
    const ep = await scriptApi.getEpisode(e.id);
    return { ...e, content: ep.content || '', summary: ep.summary || '' };
  }));
  const body = full
    .map((e) => `${t('outline.episodeNo', { n: e.idx })}${e.title ? ` ${e.title}` : ''}\n\n${e.content || e.summary || ''}`)
    .join('\n\n');
  const text = `${projectName}\n${t('outline.totalEpisodesCount', { n: totalEpisodes.value })}\n\n${body}\n`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName}-${t('outline.scriptLabel')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(t('outline.exported'));
}

// 选中分集：按需拉取该集正文（lean 详情不带 content）
async function selectEp(ep) {
  selectedId.value = ep.id;
  editingEpisode.value = null;
  if (ep.content != null) {
    selectedContent.value = ep.content;
    return;
  }
  detailBusy.value = true;
  try {
    const full = await scriptApi.getEpisode(ep.id);
    selectedContent.value = full.content || '';
    if (ep.content_length == null) ep.content_length = (full.content || '').length;
  } finally {
    detailBusy.value = false;
  }
}

async function startEdit(ep) {
  // 编辑回填用已加载正文；未加载则单条拉取
  if (selectedId.value !== ep.id || ep.content == null) await selectEp(ep);
  editingEpisode.value = ep.id;
  editTitle.value = ep.title || '';
  editContent.value = selectedContent.value || '';
}
function cancelEdit() {
  editingEpisode.value = null;
  editTitle.value = '';
  editContent.value = '';
}
async function saveEdit(ep) {
  saving.value = true;
  try {
    await scriptApi.updateEpisode(ep.id, { title: editTitle.value, content: editContent.value });
    ep.title = editTitle.value;
    ep.content = editContent.value;
    ep.content_length = editContent.value.length;
    selectedContent.value = editContent.value;
    editingEpisode.value = null;
    ElMessage.success(t('outline.saved'));
  } finally {
    saving.value = false;
  }
}

// 新增分集：创建后选中并直接进入编辑
async function createEpisode() {
  const created = await scriptApi.createEpisode(props.projectId, {});
  ElMessage.success(t('outline.episodeCreated'));
  await loadEpisodes();
  selectedId.value = created.id;
  const fresh = episodes.value.find((e) => e.id === created.id);
  if (fresh) startEdit(fresh);
}

// 删除分集
async function removeEpisode(ep) {
  try {
    await ElMessageBox.confirm(t('outline.deleteConfirmMsg', { name: ep.title }), t('outline.deleteConfirmTitle'), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
      confirmButtonClass: 'el-button--danger',
    });
  } catch { return; } // 用户取消
  await scriptApi.deleteEpisode(ep.id);
  if (selectedId.value === ep.id) selectedId.value = null;
  editingEpisode.value = null;
  ElMessage.success(t('outline.deleted'));
  await loadEpisodes();
}

// 进入下一步（资产提取）
function goNext() {
  if (!episodes.value.length) return ElMessage.warning(t('outline.pleaseParseFirst'));
  emit('next');
}

onMounted(loadEpisodes);
</script>

<template>
  <div class="ad-container outline" v-loading="loading">
    <!-- 标题区 -->
    <div class="ad-flex-between head" style="flex-wrap: wrap; gap: 12px;">
      <div>
        <div class="ad-title-lg">{{ t('outline.totalEpisodesCount', { n: totalEpisodes }) }}</div>
        <div class="ad-sub">{{ hasScript ? t('outline.titleImported') : t('outline.titleNotImported') }}</div>
      </div>
      <div class="ad-flex-center ad-gap-sm">
        <el-upload v-if="!hasScript && canEdit" :show-file-list="false" :before-upload="onUpload" accept=".txt,.md,.pdf">
          <el-button><el-icon><Upload /></el-icon> {{ t('outline.uploadScript') }}</el-button>
        </el-upload>
        <!-- 无剧集时标题区也放一个新增入口：未导入剧本的空项目不进左侧列表也能直接加集 -->
        <el-button v-if="canEdit && !episodes.length" @click="createEpisode">
          <el-icon><Plus /></el-icon> {{ t('outline.addEpisode') }}
        </el-button>
        <template v-if="hasScript">
          <el-button v-if="canEdit" type="primary" class="btn-ink" @click="showImport = true"><el-icon><Refresh /></el-icon> {{ t('outline.reimport') }}</el-button>
          <el-button
            v-if="!episodes.length && canEdit"
            type="primary"
            class="btn-ink"
            :loading="jsParsing"
            :disabled="jsParsing"
            @click="parseScriptJs"
          >
            <el-icon><MagicStick /></el-icon> {{ t('outline.jsParse') }}
          </el-button>
          <el-button v-if="episodes.length" @click="exportScript">
            <el-icon><Download /></el-icon> {{ t('outline.exportScript') }}
          </el-button>
        </template>
        <el-button v-else-if="canEdit" type="primary" class="btn-ink" @click="showImport = true"><el-icon><Plus /></el-icon> {{ t('outline.pasteScript') }}</el-button>
      </div>
    </div>

    <!-- 空状态：没导剧本且一个剧集都没有；手动加了剧集后隐藏，进入列表布局 -->
    <EmptyState
      v-if="!hasScript && !episodes.length"
      class="ad-card"
      icon="📖"
      :title="t('outline.emptyTitle')"
      :description="t('outline.emptyDesc')"
      :action-label="canEdit ? t('outline.startImport') : ''"
      @action="showImport = true"
    >
      <!-- 未导入剧本的空项目：也提供手动新增剧集（不必先导入/AI 解析） -->
      <template #extra>
        <el-button v-if="canEdit" text type="primary" @click="createEpisode">
          <el-icon><Plus /></el-icon> {{ t('outline.addEpisode') }}
        </el-button>
      </template>
    </EmptyState>
    <div v-else-if="!episodes.length" class="guide-banner">
      <el-icon class="gb-icon"><InfoFilled /></el-icon>
      <div class="gb-text">
        <div class="gb-title">{{ t('outline.guideTitle') }}</div>
        <div class="gb-sub">{{ t('outline.guideSub') }}</div>
      </div>
    </div>

    <!-- 左 LIST / 右 详情：导过剧本或已有剧集（手动加集不必先导剧本）即渲染 -->
    <template v-if="hasScript || episodes.length">
      <div class="md-layout">
        <!-- 左：分集列表 -->
        <aside class="md-list">
          <div class="md-list-head">
            <span class="ad-title"><el-icon><Document /></el-icon> {{ t('outline.episodesScript') }}</span>
            <!-- 新增剧集：无剧集时也显示（空态可直接手动加集，不必先 AI 解析） -->
            <el-button v-if="canEdit" text size="small" class="add-ep-btn" @click="createEpisode">
              <el-icon><Plus /></el-icon> {{ t('outline.addEpisode') }}
            </el-button>
          </div>
          <div class="md-list-body">
            <div
              v-for="ep in episodes"
              :key="ep.id"
              class="md-item"
              :class="{ active: ep.id === selectedId }"
              role="button"
              tabindex="0"
              @click="selectEp(ep)"
              @keydown.enter.prevent="selectEp(ep)"
            >
              <span class="ep-no">{{ ep.idx }}</span>
              <span class="md-item-main">
                <span class="md-item-title">{{ ep.title }}</span>
                <span class="ad-muted md-item-meta">{{ epLen(ep) }} {{ t('outline.charUnit') }}</span>
              </span>
              <span class="chip md-item-status" :class="epHasContent(ep) ? 'chip-success' : 'chip-warning'">
                {{ epHasContent(ep) ? t('outline.statusDone') : t('outline.statusPending') }}
              </span>
              <el-button
                v-if="canEdit"
                class="md-item-del"
                text
                size="small"
                :title="t('outline.deleteThisEpisode')"
                @click.stop="removeEpisode(ep)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <div v-if="!episodes.length" class="md-empty">
              <div class="ad-sub">{{ t('outline.emptyListHint') }}</div>
            </div>
          </div>
        </aside>

        <!-- 右：详情 -->
        <section class="md-detail ad-card">
          <template v-if="selected">
            <div class="md-detail-head">
              <div class="md-detail-title">
                <span class="ep-no lg">{{ selected.idx }}</span>
                <div class="md-detail-title-text">
                  <span class="ad-title-lg">{{ selected.title }}</span>
                  <span class="md-meta">
                    <el-icon><Document /></el-icon>
                    {{ (selectedContent || '').length }} {{ t('outline.charUnit') }}
                    <span class="md-dot">·</span>
                    {{ t('outline.aboutMinutes', { n: Math.max(1, Math.ceil(selectedContent.length / 300)) }) }}
                  </span>
                </div>
              </div>
              <div class="ad-flex-center ad-gap-sm" v-if="editingEpisode !== selected.id && canEdit">
                <el-button text size="small" @click="startEdit(selected)">
                  <el-icon><EditPen /></el-icon> {{ t('outline.modify') }}
                </el-button>
                <el-button text size="small" class="del-btn" @click="removeEpisode(selected)">
                  <el-icon><Delete /></el-icon> {{ t('common.delete') }}
                </el-button>
              </div>
            </div>

            <div class="md-detail-body">
              <template v-if="editingEpisode === selected.id">
                <div class="ep-edit-wrap">
                  <div class="ep-edit-field">
                    <div class="ep-col-label"><el-icon><EditPen /></el-icon> {{ t('outline.episodeTitle') }}</div>
                    <el-input size="large" v-model="editTitle" :placeholder="t('outline.episodeTitlePlaceholder')" />
                  </div>
                  <div class="ep-edit-field ep-edit-content">
                    <div class="ep-col-label"><el-icon><Document /></el-icon> {{ t('outline.episodeScript') }}</div>
                    <el-input size="large"
                      v-model="editContent"
                      type="textarea"
                      resize="none"
                      :placeholder="t('outline.episodeScriptPlaceholder')"
                    />
                  </div>
                  <div class="ad-flex-center ad-gap-sm" style="margin-top: 12px;">
                    <el-button size="large" @click="cancelEdit">{{ t('common.cancel') }}</el-button>
                    <el-button size="large" type="primary" class="btn-ink" :loading="saving" @click="saveEdit(selected)">{{ t('common.save') }}</el-button>
                  </div>
                </div>
              </template>
              <template v-else>
                <div v-loading="detailBusy" class="ep-content-wrap">
                  <p class="ep-content">{{ selectedContent }}</p>
                </div>
              </template>
            </div>
          </template>
          <div v-else class="md-detail-empty">
            <div class="empty-emoji">📑</div>
            <div class="ad-title">{{ t('outline.selectLeftHint') }}</div>
            <div class="ad-sub" style="margin-top:6px;">{{ t('outline.aiParseFirstHint') }}</div>
          </div>
        </section>
      </div>

      <!-- 底部操作条 -->
      <div class="action-bar ad-card">
        <div class="ad-flex-center ad-gap-sm">
          <el-icon><InfoFilled /></el-icon>
          <span class="ad-sub">{{ t('outline.bottomHint') }}</span>
        </div>
        <div class="ad-flex-center ad-gap-sm">
          <button class="next-cta" :class="{ disabled: !episodes.length }" :disabled="!episodes.length" @click="goNext">
            <span>{{ t('outline.nextStep') }}</span>
            <el-icon><Right /></el-icon>
          </button>
        </div>
      </div>
    </template>

    <!-- 导入弹窗 -->
    <el-dialog v-model="showImport" :title="t('outline.importDialogTitle')" width="min(640px, 94vw)">
      <el-input size="large" v-model="importText" type="textarea" :rows="14" :placeholder="t('outline.importDialogPlaceholder')" />
      <template #footer>
        <el-upload :show-file-list="false" :before-upload="onUpload" accept=".txt,.md,.pdf" style="display:inline-block; margin-right:8px;">
          <el-button><el-icon><Upload /></el-icon> {{ t('outline.uploadTxt') }}</el-button>
        </el-upload>
        <el-button @click="showImport = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="importBusy" @click="doImport">{{ t('outline.importBtn') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.outline { max-width: 1280px; }
.head { margin-bottom: 20px; }
.empty { text-align: center; padding: 56px 20px; margin-top: 8px; }
.empty-emoji { font-size: 52px; margin-bottom: 8px; }

/* 左右布局 */
.md-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  align-items: stretch;
}
.md-list {
  display: flex;
  flex-direction: column;
  background: var(--ad-bg-elevated);
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius);
  box-shadow: var(--ad-shadow);
  overflow: hidden;
  min-height: 420px;
}
.md-list-head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--ad-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.md-list-body { display: flex; flex-direction: column; gap: 4px; padding: 8px; overflow-y: auto; max-height: 560px; }
.md-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 12px;
  border: 1px solid transparent;
  border-radius: var(--ad-radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
}
.md-item:hover { background: var(--ad-bg-soft); }
.md-item.active { background: var(--ad-brand-soft-2); border-color: var(--ad-accent); }
.md-item-main { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 2px; }
.md-item-title { font-weight: 600; color: var(--ad-text); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-item-meta { font-size: 12px; }
.md-item-status { font-size: 11px; flex-shrink: 0; }
.md-item-del { flex-shrink: 0; opacity: 0; transition: opacity 0.15s, color 0.15s; color: var(--ad-text-muted); padding: 4px !important; }
.md-item:hover .md-item-del, .md-item.active .md-item-del { opacity: 1; }
.md-item-del:hover { color: var(--ad-danger) !important; }
.add-ep-btn { font-weight: 600; color: var(--ad-accent); }
.del-btn { color: var(--ad-text-muted); }
.del-btn:hover { color: var(--ad-danger) !important; }
.md-empty { padding: 32px 16px; text-align: center; }

.md-detail { display: flex; flex-direction: column; padding: 24px 28px; min-height: 420px; }
.md-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--ad-border); }
.md-detail-title { display: flex; align-items: center; gap: 14px; }
.md-detail-title-text { display: flex; flex-direction: column; gap: 4px; }
.md-meta { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ad-text-muted); }
.md-meta .el-icon { font-size: 13px; }
.md-dot { margin: 0 2px; opacity: 0.6; }
.md-detail-body { padding-top: 18px; flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ep-edit-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.ep-edit-field { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.ep-edit-field.ep-edit-content { flex: 1; min-height: 0; }
.ep-col-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--ad-text-soft); }
.ep-col-label .el-icon { font-size: 13px; }
.ep-edit-content :deep(.el-textarea) { flex: 1; display: flex; min-height: 200px; }
.ep-edit-content :deep(.el-textarea__inner) { flex: 1; height: 100% !important; resize: none; font-size: 15px; line-height: 1.75; }
.md-detail-empty { text-align: center; padding: 60px 20px; margin: auto; }
.md-detail-empty .empty-emoji { font-size: 44px; }

.ep-no { display: inline-flex; width: 24px; height: 24px; border-radius: 50%; background: var(--ad-accent); color: var(--ad-accent-contrast); align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.ep-no.lg { width: 36px; height: 36px; font-size: 15px; box-shadow: 0 4px 12px color-mix(in srgb, var(--ad-accent) 35%, transparent); }

/* 正文阅读区 */
.ep-content-wrap {
  position: relative;
  padding: 4px 8px 4px 22px;
  border-left: 3px solid var(--ad-accent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--ad-accent) 5%, transparent), transparent 60%);
  border-radius: 0 8px 8px 0;
}
.ep-content {
  color: var(--ad-text);
  line-height: 1.75;
  letter-spacing: 0.2px;
  white-space: pre-wrap;
  margin: 0;
  font-size: 15px;
  text-indent: 2em;
}

/* 底部操作条 + 醒目「下一步」 */
.action-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; padding: 16px 20px; flex-wrap: wrap; }
.next-cta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 30px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--ad-accent) 0%, var(--ad-brand) 100%);
  color: var(--ad-accent-contrast);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--ad-accent) 45%, transparent);
  animation: nextPulse 2.2s ease-in-out infinite;
  transition: transform 0.15s, box-shadow 0.15s;
}
.next-cta:hover { transform: translateY(-2px); box-shadow: 0 10px 28px color-mix(in srgb, var(--ad-accent) 60%, transparent); }
.next-cta:active { transform: translateY(0); }
.next-cta.disabled { opacity: 0.5; cursor: not-allowed; animation: none; box-shadow: none; transform: none; }

/* 引导横幅 */
.guide-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  margin-top: 16px;
  background: linear-gradient(90deg, var(--ad-brand-soft), transparent 80%);
  border: 1px solid var(--ad-border);
  border-left: 3px solid var(--ad-brand);
  border-radius: var(--ad-radius);
}
.gb-icon { font-size: 22px; color: var(--ad-brand); flex: 0 0 auto; }
.gb-text { display: flex; flex-direction: column; gap: 2px; }
.gb-title { font-size: 14px; font-weight: 700; color: var(--ad-text); }
.gb-sub { font-size: 13px; color: var(--ad-text-soft); line-height: 1.6; }
@keyframes nextPulse {
  0%, 100% { box-shadow: 0 6px 20px color-mix(in srgb, var(--ad-accent) 40%, transparent); }
  50% { box-shadow: 0 6px 28px color-mix(in srgb, var(--ad-accent) 72%, transparent); }
}

@media (max-width: 860px) {
  .md-layout { grid-template-columns: 1fr; }
  .md-list { min-height: auto; }
  .md-list-body { max-height: 320px; }
}
</style>
