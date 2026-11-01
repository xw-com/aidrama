<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { scriptDraftApi, streamOutlineChat } from '../api';
import { useCostAction } from '../composables/useCostAction';
import { useJobsStore } from '../stores/jobs';
import EmptyState from '../components/EmptyState.vue';
import ArtStylePicker from '../components/ArtStylePicker.vue';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const jobs = useJobsStore();
const { runJob, runJobs } = useCostAction();

// 与后端 NARRATIVE_TYPES 一致（运行时加载 story_skills md 作风味）
const NARRATIVE_TYPES = computed(() => [
  { key: 'Sweet_romance_novel', name: t('script.genre.Sweet_romance_novel') },
  { key: 'Urban_workplace_drama', name: t('script.genre.Urban_workplace_drama') },
  { key: 'Xianxia_fantasy', name: t('script.genre.Xianxia_fantasy') },
  { key: 'Comedy_humor', name: t('script.genre.Comedy_humor') },
  { key: 'Mystery_thriller', name: t('script.genre.Mystery_thriller') },
  { key: 'Hot_blooded_action', name: t('script.genre.Hot_blooded_action') },
  { key: 'Coming_of_age', name: t('script.genre.Coming_of_age') },
  { key: 'Family_warmth', name: t('script.genre.Family_warmth') },
  { key: 'Historical_epic', name: t('script.genre.Historical_epic') },
  { key: 'Psychological_drama', name: t('script.genre.Psychological_drama') },
  { key: 'Horror_supernatural', name: t('script.genre.Horror_supernatural') },
  { key: 'Scifi_post_apocalypse', name: t('script.genre.Scifi_post_apocalypse') },
]);

const STEPS = computed(() => [
  { key: 1, label: t('script.step.1.label'), hint: t('script.step.1.hint') },
  { key: 2, label: t('script.step.2.label'), hint: t('script.step.2.hint') },
  { key: 3, label: t('script.step.3.label'), hint: t('script.step.3.hint') },
  { key: 4, label: t('script.step.4.label'), hint: t('script.step.4.hint') },
]);
const stageOrder = { chat: 1, outline: 2, episodes: 3, detail: 4, done: 4 };
const STAGES = ['chat', 'outline', 'episodes', 'detail', 'done'];
const stageLabel = (s) => STAGES.includes(s) ? t(`script.stage.${s}`) : t('script.stage.chat');

const list = ref([]);
const loading = ref(false);
const activeId = ref(null);
const active = ref(null);       // 当前剧本草稿（含 outline/stage/narrative_type/chat/episodes）
const episodes = ref([]);       // ScriptEpisode[]
const currentStep = ref(1);
const chatMessages = ref([]);   // UI 对话气泡
const chatInput = ref('');
const chatting = ref(false);
let chatAbort = null;
const narrativeType = ref('');
const outlineText = ref('');    // 大纲可编辑文本
const targetCount = ref(0);     // 第2步目标集数（0=自动）
const selectedEid = ref(null);
const exportName = ref('');
const exportStyle = ref('realpeople_modern_city'); // 导出项目默认风格：写实·都市影像
const exportAspect = ref('9:16');                    // 导出项目默认画面比例：竖屏
const exportNarrativeType = ref('');                 // 导出项目叙事类型：默认沿用剧本草稿的 narrative_type
// 「做同款」（来自展示中心）：同款视觉风格/画幅，导出时优先沿用（缺省回退常规默认值）
const remakeStyle = ref('');
const remakeAspect = ref('');

const selectedEpisode = computed(() => episodes.value.find((e) => e.id === selectedEid.value) || null);
const episodeLabel = (ep) => `${t('script.episodeTitleShort', { idx: ep.idx })} · ${ep.title}`; // 手机下拉选中项展示文案

const outlineJob = computed(() => active.value ? jobs.activeOf('script_outline', active.value.id) : null);

// 大纲生成中：轮播提示（4s 一换），任务结束或离开页面即停
const OUTLINE_TIP_KEYS = ['script.outlineTip0', 'script.outlineTip1', 'script.outlineTip2'];
const outlineTipIdx = ref(0);
let outlineTipTimer = null;
const outlineHint = computed(() => t(OUTLINE_TIP_KEYS[outlineTipIdx.value % OUTLINE_TIP_KEYS.length]));
watch(outlineJob, (j, prev) => {
  // 仅在「无任务→有任务」跃迁时重置并起定时器：store 每次轮询都以新对象替换 items，
  // 若按引用变化就重置，提示会被 2s 轮询钉死在第 1 条
  if (j && !prev) {
    outlineTipIdx.value = 0;
    if (!outlineTipTimer) outlineTipTimer = setInterval(() => { outlineTipIdx.value += 1; }, 4000);
  } else if (!j && outlineTipTimer) {
    clearInterval(outlineTipTimer);
    outlineTipTimer = null;
  }
});
onUnmounted(() => { if (outlineTipTimer) clearInterval(outlineTipTimer); });
const splitJob = computed(() => active.value ? jobs.activeOf('episode_split', active.value.id) : null);
const isBusyDetail = (ep) => !!jobs.activeOf('episode_detail', ep.id);
const detailBusyCount = computed(() => episodes.value.filter((e) => isBusyDetail(e)).length);

function reachable(step) {
  const a = active.value;
  if (!a) return step === 1;
  if (step === 1) return true;
  if (step === 2) return !!a.outline;
  if (step === 3) return episodes.value.length > 0;
  if (step === 4) return !!a.outline || episodes.value.length > 0;
  return false;
}
function gotoStep(n) { if (reachable(n)) currentStep.value = n; }

// 任务页「查看结果」深链 ?sid=：草稿列表就绪后预选该稿，只消费一次（范式同 uniapp writer.vue）
let pendingSid = null;

async function load() {
  loading.value = true;
  try {
    list.value = await scriptDraftApi.list();
    if (pendingSid) {
      const hit = list.value.find((s) => String(s.id) === String(pendingSid));
      pendingSid = null;
      if (hit) { await select(hit); return; }
    }
    if (!activeId.value && list.value.length) select(list.value[0]);
  } finally { loading.value = false; }
}

async function select(s) {
  activeId.value = s.id;
  try {
    const full = await scriptDraftApi.get(s.id);
    active.value = full;
    episodes.value = full.episodes || [];
    chatMessages.value = Array.isArray(full.chat) ? full.chat.map((m) => ({ ...m })) : [];
    narrativeType.value = full.narrative_type || '';
    outlineText.value = full.outline || '';
    const reached = stageOrder[full.stage] || 1;
    currentStep.value = reached;
    if (!selectedEid.value || !episodes.value.find((e) => e.id === selectedEid.value)) {
      selectedEid.value = episodes.value[0]?.id || null;
    }
    await nextTick(); scrollToBottom();
  } catch (e) { ElMessage.error(e.message || t('script.loadFailed')); }
}

async function createDraft() {
  const row = await scriptDraftApi.create({ title: t('script.untitledDraft'), content: '' });
  list.value.unshift(row);
  await select(row);
}

// ============ 做同款（展示中心跳入）：remake=1&name&desc&narrative&style&aspect ============
// 消费一次：自动建「同款 · 剧名」草稿，预填叙事类型（watch 自动保存）与聊天创意种子，
// 导出时默认沿用同款风格/画幅；随后清掉 query，防止刷新重复建稿
async function consumeRemakeQuery() {
  const q = route.query;
  if (q.remake !== '1') return;
  const name = String(q.name || '').slice(0, 40).trim();
  const desc = String(q.desc || '').slice(0, 200).trim();
  const narrative = String(q.narrative || '');
  const style = String(q.style || '');
  const aspect = String(q.aspect || '');
  remakeStyle.value = style;
  remakeAspect.value = ['9:16', '16:9', '1:1'].includes(aspect) ? aspect : '';
  router.replace({ query: {} });
  try {
    const row = await scriptDraftApi.create({
      title: name ? t('script.remakeTitle', { name }) : t('script.untitledDraft'),
      content: '',
    });
    list.value.unshift(row);
    await select(row);
    if (NARRATIVE_TYPES.value.some((n) => n.key === narrative)) narrativeType.value = narrative;
    chatInput.value = name && desc
      ? t('script.remakeSeed', { name, desc })
      : name
        ? t('script.remakeSeedPlain', { name })
        : t('script.remakeSeedNoName', { desc });
    ElMessage.success(t('script.remadeReady'));
  } catch (e) { ElMessage.error(e.message || t('script.loadFailed')); }
}

async function removeDraft(s) {
  await ElMessageBox.confirm(t('script.deleteConfirm', { name: s.title }), t('common.tip'), { type: 'warning' });
  await scriptDraftApi.remove(s.id);
  if (activeId.value === s.id) { activeId.value = null; active.value = null; episodes.value = []; }
  list.value = list.value.filter((x) => x.id !== s.id);
  if (!activeId.value && list.value.length) select(list.value[0]);
  ElMessage.success(t('common.deleteSuccess'));
}

function onPick(id) {
  const s = list.value.find((x) => x.id === id);
  if (s) select(s);
}
function removeActive() {
  if (active.value) removeDraft(active.value);
}

// ============ 第 1 步：对话（免费 SSE） ============
function scrollToBottom() {
  const el = document.querySelector('.sw-chat-body');
  if (el) el.scrollTop = el.scrollHeight;
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatting.value || !active.value) return;
  chatting.value = true;
  chatInput.value = '';
  chatMessages.value.push({ role: 'user', content: text });
  const ai = reactive({ role: 'assistant', content: '', streaming: true });
  chatMessages.value.push(ai);
  await nextTick(); scrollToBottom();
  const ctrl = new AbortController();
  chatAbort = ctrl;
  try {
    await streamOutlineChat({
      scriptId: active.value.id, message: text,
      narrativeType: narrativeType.value || undefined,
      onDelta: (d) => { ai.content += d; scrollToBottom(); },
      onError: (m) => { ElMessage.error(m); },
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name !== 'AbortError') ElMessage.error(e.message || t('script.sendFailed'));
  } finally {
    ai.streaming = false;
    chatting.value = false;
    chatAbort = null;
    await load(); // 刷新列表时间
  }
}
function stopChat() { if (chatAbort) chatAbort.abort(); }

// 题材变更即时保存
watch(narrativeType, async (v) => {
  if (active.value && v !== (active.value.narrative_type || '')) {
    active.value.narrative_type = v || null;
    try { await scriptDraftApi.update(active.value.id, { narrative_type: v || null }); }
    catch { /* ignore */ }
  }
});

// 大纲编辑防抖保存
let outlineTimer = null;
watch(outlineText, (v) => {
  if (!active.value) return;
  active.value.outline = v;
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    scriptDraftApi.update(active.value.id, { outline: v }).catch(() => {});
  }, 600);
});

// 剧本名编辑：防抖自动保存 + 即时同步左侧列表
let titleTimer = null;
function syncListTitle() {
  const item = list.value.find((x) => x.id === active.value?.id);
  if (item) item.title = active.value.title;
}
function scheduleSaveTitle() {
  syncListTitle();
  if (titleTimer) clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    if (!active.value) return;
    scriptDraftApi.update(active.value.id, { title: active.value.title }).catch(() => {});
  }, 600);
}
async function saveTitleNow() {
  if (!active.value) return;
  if (titleTimer) { clearTimeout(titleTimer); titleTimer = null; }
  const v = (active.value.title || '').trim();
  active.value.title = v || t('script.untitledDraft');
  syncListTitle();
  try { await scriptDraftApi.update(active.value.id, { title: active.value.title }); }
  catch { /* ignore */ }
}

// ============ 第 1 步定稿：生成大纲（计费 job） ============
async function genOutline() {
  if (!chatMessages.value.length) return ElMessage.info(t('script.chatFirst'));
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => scriptDraftApi.outlineEstimate(active.value.id, sel),
    createFor: (sel) => scriptDraftApi.outline(active.value.id, sel),
    title: t('script.outlineJobTitle'), desc: t('script.outlineJobDesc'), confirmText: t('script.outlineJobConfirm'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result) {
        active.value.outline = j.result.outline || '';
        active.value.stage = j.result.stage || 'outline';
        // 仅当用户未自定义剧名时，采用 AI 生成的标题
        if (j.result.title && (!active.value.title || active.value.title === t('script.untitledDraft'))) {
          active.value.title = j.result.title;
        }
        outlineText.value = active.value.outline;
        currentStep.value = 2;
        load();
      }
    },
  });
}

// ============ 第 2 步：分集 + 概要（计费 job） ============
async function genSplit() {
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => scriptDraftApi.splitEstimate(active.value.id, sel),
    createFor: (sel) => scriptDraftApi.split(active.value.id, { targetCount: targetCount.value || undefined, ...sel }),
    title: t('script.splitJobTitle'), desc: t('script.splitJobDesc'), confirmText: t('script.splitJobConfirm'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.episodes) {
        episodes.value = j.result.episodes;
        active.value.stage = j.result.stage || 'episodes';
        selectedEid.value = episodes.value[0]?.id || null;
        currentStep.value = 3;
      }
    },
  });
}

async function saveEpisode(ep, patch) {
  try {
    await scriptDraftApi.updateEpisode(active.value.id, ep.id, patch);
    Object.assign(ep, patch);
  } catch { /* ignore */ }
}

// ============ 第 3 步：逐集细化（计费 job，可批量） ============
// 任务完成后以服务器为准重拉单集，兜底轮询 result 透传不全导致的客户端不同步
async function syncEpisode(epId) {
  if (!active.value) return;
  try {
    const full = await scriptDraftApi.get(active.value.id);
    const fresh = (full.episodes || []).find((e) => e.id === epId);
    if (fresh) {
      const i = episodes.value.findIndex((x) => x.id === epId);
      if (i > -1) episodes.value[i] = { ...episodes.value[i], ...fresh };
    }
  } catch { /* ignore */ }
}

async function genDetail(ep) {
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => scriptDraftApi.detailEstimate(active.value.id, ep.id, sel),
    createFor: (sel) => scriptDraftApi.detail(active.value.id, ep.id, sel),
    title: t('script.detailJobTitle', { idx: ep.idx }), desc: t('script.detailJobDesc'), confirmText: t('script.detailJobConfirm'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.episode) {
        const i = episodes.value.findIndex((x) => x.id === ep.id);
        if (i > -1) episodes.value[i] = { ...episodes.value[i], ...j.result.episode };
      }
      if (j.status === 'succeeded') syncEpisode(ep.id); // 兜底：以服务器为准同步
    },
  });
}

async function genDetailBatch() {
  const targets = episodes.value.filter((e) => !(e.content || '').trim() && !isBusyDetail(e));
  if (!targets.length) return ElMessage.info(t('script.noPendingDetail'));
  await runJobs({
    modelType: 'text',
    items: targets.map((e) => ({
      estimateFor: (sel) => scriptDraftApi.detailEstimate(active.value.id, e.id, sel),
      createFor: (sel) => scriptDraftApi.detail(active.value.id, e.id, sel),
      onDone: (j) => {
        if (j.status === 'succeeded' && j.result?.episode) {
          const i = episodes.value.findIndex((x) => x.id === e.id);
          if (i > -1) episodes.value[i] = { ...episodes.value[i], ...j.result.episode };
        }
        if (j.status === 'succeeded') syncEpisode(e.id); // 兜底：以服务器为准同步
      },
    })),
    title: t('script.batchJobTitle'), desc: t('script.batchJobDesc', { count: targets.length }), confirmText: t('script.batchJobConfirm'),
  });
  if (active.value) { active.value.stage = 'detail'; }
}

// ============ 第 4 步：导出到项目 ============
function openExport() {
  exportName.value = active.value?.title || t('script.untitledProject');
  exportStyle.value = remakeStyle.value || 'realpeople_modern_city'; // 做同款时优先沿用同款风格，默认写实·都市影像
  exportAspect.value = remakeAspect.value || '9:16';                 // 做同款时优先沿用同款画幅，默认竖屏
  exportNarrativeType.value = active.value?.narrative_type || ''; // 默认沿用剧本草稿的叙事类型
}
async function doExport() {
  const name = (exportName.value || '').trim() || active.value.title;
  try {
    const res = await scriptDraftApi.exportTo(active.value.id, {
      name,
      style: exportStyle.value,
      aspect_ratio: exportAspect.value,
      ...(exportNarrativeType.value ? { narrative_type: exportNarrativeType.value } : {}),
    });
    ElMessage.success(t('script.exportedToProject', { name: res.project.name, count: res.episodeCount }));
    active.value.stage = 'done';
    router.push(`/projects/${res.project.id}`);
  } catch (e) { ElMessage.error(e.message || t('script.exportFailed')); }
}

// 进入第 4 步时初始化默认项目名
watch(currentStep, (n) => { if (n === 4 && active.value) openExport(); });

onMounted(async () => {
  pendingSid = route.query.sid || null;
  await load();
  await consumeRemakeQuery();
});
</script>

<template>
  <div class="sw-page">
    <!-- 与任务中心/积分中心统一：ad-container 限宽 1200px 居中 + padding 24px -->
    <div class="ad-container sw-wrap">
    <div class="sw-head ad-flex-between">
      <div class="sw-head-title">
        <h2 class="ad-title">{{ t('script.title') }}</h2>
        <div class="ad-muted ad-sub">{{ t('script.subtitle') }}</div>
      </div>
      <div class="sw-head-tools ad-flex-center ad-gap-sm">
        <el-select size="large"
          v-model="activeId"
          :placeholder="t('script.selectDraft')"
          filterable
          class="sw-draft-select"
          @change="onPick"
        >
          <el-option v-for="s in list" :key="s.id" :value="s.id" :label="s.title || t('script.untitledDraft')">
            <span class="sw-opt-title">{{ s.title || t('script.untitledDraft') }}</span>
            <span class="sw-opt-stage ad-muted">{{ stageLabel(s.stage) }}</span>
          </el-option>
        </el-select>
        <button class="btn-ghost sw-icon-btn" :title="t('script.deleteCurrent')" :disabled="!active" @click="removeActive">
          <el-icon><Delete /></el-icon>
        </button>
        <!-- 聊天区为空（含无剧本时的空状态，那里有大按钮）时隐藏，避免误点新建打断当前草稿 -->
        <button v-if="chatMessages.length" class="btn-ink" @click="createDraft"><el-icon><Plus /></el-icon> {{ t('script.createDraft') }}</button>
      </div>
    </div>

    <div class="sw-body">
      <!-- 工作区 -->
      <section class="sw-main">
        <template v-if="active">
          <!-- 剧本名（可编辑） -->
          <div class="sw-titlebar">
            <el-icon class="sw-title-ico"><EditPen /></el-icon>
            <input
              class="sw-title-input"
              v-model="active.title"
              :placeholder="t('script.untitledDraft')"
              maxlength="60"
              @input="scheduleSaveTitle"
              @blur="saveTitleNow"
            />
            <span class="stage-tag">{{ stageLabel(active.stage) }}</span>
          </div>

          <!-- 第 1 步：对话（紧跟标题下方） -->
          <div v-if="currentStep === 1" class="sw-panel ad-card">
            <div class="sw-chat">
              <div class="sw-chat-top ad-flex-between">
                <div class="ad-flex-center ad-gap-sm">
                  <span class="ad-sub ad-muted">{{ t('script.topic') }}</span>
                  <el-select class="narrative-select" v-model="narrativeType" :placeholder="t('script.topicPlaceholder')" clearable size="large" style="width: 160px;">
                    <el-option v-for="n in NARRATIVE_TYPES" :key="n.key" :label="n.name" :value="n.key" />
                  </el-select>
                </div>
                <button class="btn-ink" :disabled="!chatMessages.length || !!outlineJob" @click="genOutline">
                  <el-icon><MagicStick /></el-icon> {{ t('script.genOutline') }}
                </button>
              </div>
              <!-- 大纲生成中：状态文案 + 进度条 + 轮播提示（数据来自任务轮询的 stage/progress） -->
              <div v-if="outlineJob" class="sw-op">
                <div class="sw-op-row">
                  <el-icon class="is-loading"><Loading /></el-icon>
                  <span class="sw-op-status">{{ outlineJob.stage || t('script.taskQueued') }}</span>
                  <span class="sw-op-pct">{{ outlineJob.progress || 0 }}%</span>
                </div>
                <el-progress :percentage="outlineJob.progress || 0" :stroke-width="6" :show-text="false" />
                <div class="sw-op-hint">{{ outlineHint }}</div>
              </div>
              <div class="sw-chat-body">
                <div v-if="!chatMessages.length" class="sw-chat-empty ad-muted">
                  {{ t('script.chatEmptyHint') }}
                </div>
                <div v-for="(m, i) in chatMessages" :key="i" class="sw-bubble" :class="m.role">
                  <div class="sw-bubble-role">{{ m.role === 'user' ? t('script.roleUser') : t('script.roleAssistant') }}</div>
                  <div class="sw-bubble-text">
                    <template v-if="m.content">{{ m.content }}<span v-if="m.streaming" class="sw-cursor">▌</span></template>
                    <span v-else-if="m.streaming" class="sw-thinking">
                      <span class="sw-thinking-text">{{ t('script.thinking') }}</span>
                      <span class="sw-typing"><i></i><i></i><i></i></span>
                    </span>
                  </div>
                </div>
              </div>
              <div class="sw-chat-input">
                <textarea
                  v-model="chatInput"
                  :placeholder="t('script.chatInputPlaceholder')"
                  @keydown.enter.exact.prevent="sendChat"
                ></textarea>
                <button v-if="chatting" class="btn-ghost" @click="stopChat">{{ t('script.stop') }}</button>
                <button v-else class="btn-ink" :disabled="!chatInput.trim()" @click="sendChat">
                  <el-icon><Promotion /></el-icon> {{ t('script.send') }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="currentStep !== 1" class="sw-panel ad-card">
            <!-- 第 2 步：分集概要 -->
            <div v-if="currentStep === 2" class="sw-outline">
              <div class="sw-cols">
                <!-- 左：大纲 -->
                <div class="sw-outline-box">
                  <div class="sw-outline-summary">{{ t('script.outlineEditable') }}</div>
                  <textarea v-model="outlineText" class="sw-outline-area"></textarea>
                </div>
                <!-- 右：分集 -->
                <div class="sw-eps-wrap">
                  <div v-if="episodes.length" class="sw-eps-list">
                    <div v-for="ep in episodes" :key="ep.id" class="sw-ep-card">
                      <div class="ad-flex-between sw-ep-top">
                        <div class="ad-flex-center ad-gap-sm">
                          <span class="sw-ep-idx">{{ t('script.episodeTitle', { idx: ep.idx }) }}</span>
                          <input class="sw-ep-title" v-model="ep.title" @blur="saveEpisode(ep, { title: ep.title })" />
                        </div>
                      </div>
                      <textarea
                        class="sw-ep-summary"
                        v-model="ep.summary"
                        :placeholder="t('script.episodeSummaryPlaceholder')"
                        @blur="saveEpisode(ep, { summary: ep.summary })"
                      ></textarea>
                    </div>
                  </div>
                  <div v-else-if="!splitJob" class="ad-muted ad-sub sw-eps-empty">
                    {{ t('script.noEpisodesHint') }}
                  </div>
                </div>
              </div>
              <div class="sw-split-cta">
                <div class="sw-split-cta-text">
                  <div class="sw-split-cta-title">{{ t('script.splitCtaTitle') }}</div>
                  <div class="sw-split-cta-sub">{{ t('script.splitCtaSub') }}</div>
                </div>
                <div class="sw-split-cta-actions">
                  <span class="ad-sub">{{ t('script.targetCount') }}</span>
                  <el-input-number v-model="targetCount" :min="0" :max="60" size="large" style="width: 110px;" />
                  <span class="ad-sub" style="font-size:12px;">{{ t('script.targetAuto') }}</span>
                  <button class="sw-split-btn" :disabled="!!splitJob" @click="genSplit">
                    <el-icon><Collection /></el-icon> {{ t('script.splitAndGen') }}
                  </button>
                </div>
              </div>
              <div v-if="splitJob" class="sw-progress">
                <el-icon class="is-loading"><Loading /></el-icon>
                <span>{{ splitJob.stage || t('script.taskQueued') }}</span>
                <span class="ad-muted">{{ splitJob.progress || 0 }}%</span>
              </div>
            </div>

            <!-- 第 3 步：逐集细化 -->
            <div v-else-if="currentStep === 3" class="sw-detail">
              <div class="sw-detail-head ad-flex-between">
                <div class="ad-sub ad-muted">
                  {{ t('script.totalEpisodes', { count: episodes.length }) }}
                  <span v-if="detailBusyCount">{{ t('script.detailingCount', { count: detailBusyCount }) }}</span>
                </div>
                <button class="btn-ink" @click="genDetailBatch">
                  <el-icon><MagicStick /></el-icon> {{ t('script.batchDetailIncomplete') }}
                </button>
              </div>
              <div class="sw-detail-body">
                <!-- 手机：剧集列表以下拉选择展示 -->
                <el-select class="sw-detail-combo" v-model="selectedEid" size="large">
                  <el-option
                    v-for="ep in episodes"
                    :key="ep.id"
                    :value="ep.id"
                    :label="episodeLabel(ep)"
                  >
                    <span class="sw-ep-idx">{{ t('script.episodeTitleShort', { idx: ep.idx }) }}</span>
                    <span class="sw-detail-name">{{ ep.title }}</span>
                    <span class="sw-dot" :class="{ done: (ep.content || '').trim() }"></span>
                  </el-option>
                </el-select>
                <div class="sw-detail-list">
                  <div
                    v-for="ep in episodes"
                    :key="ep.id"
                    class="sw-detail-item"
                    :class="{ active: ep.id === selectedEid, busy: isBusyDetail(ep) }"
                    @click="selectedEid = ep.id"
                  >
                    <span class="sw-ep-idx">{{ t('script.episodeTitleShort', { idx: ep.idx }) }}</span>
                    <span class="sw-detail-name">{{ ep.title }}</span>
                    <span class="sw-dot" :class="{ done: (ep.content || '').trim() }"></span>
                  </div>
                </div>
                <div class="sw-detail-pane">
                  <template v-if="selectedEpisode">
                    <div class="ad-flex-between sw-ep-top">
                      <div class="ad-flex-center ad-gap-sm">
                        <span class="sw-ep-idx">{{ t('script.episodePaneTitle', { idx: selectedEpisode.idx, title: selectedEpisode.title }) }}</span>
                      </div>
                      <button class="btn-ink" :disabled="isBusyDetail(selectedEpisode)" @click="genDetail(selectedEpisode)">
                        <el-icon><MagicStick /></el-icon> {{ (selectedEpisode.content || '').trim() ? t('script.refine') : t('script.detailThis') }}
                      </button>
                    </div>
                    <div v-if="selectedEpisode.summary" class="sw-ep-syn">{{ t('script.summaryLabel', { summary: selectedEpisode.summary }) }}</div>
                    <div v-if="isBusyDetail(selectedEpisode)" class="sw-progress">
                      <el-icon class="is-loading"><Loading /></el-icon>
                      <span>{{ t('script.detailing', { idx: selectedEpisode.idx }) }}</span>
                    </div>
                    <textarea
                      class="sw-ep-content"
                      v-model="selectedEpisode.content"
                      :placeholder="t('script.contentPlaceholder')"
                      @blur="saveEpisode(selectedEpisode, { content: selectedEpisode.content })"
                    ></textarea>
                  </template>
                  <div v-else class="ad-muted ad-sub" style="padding: 24px;">{{ t('script.selectLeftHint') }}</div>
                </div>
              </div>
              <div class="sw-next">
                <button class="btn-ink" @click="gotoStep(4)">{{ t('script.nextExport') }} <el-icon><Right /></el-icon></button>
              </div>
            </div>

            <!-- 第 4 步：导出 -->
            <div v-else-if="currentStep === 4" class="sw-export">
              <div class="sw-export-scroll">
                <div class="ad-sub ad-muted">{{ t('script.exportIntro') }}</div>
                <div class="sw-export-form">
                  <label class="ad-sub ad-muted">{{ t('script.projectName') }}</label>
                  <el-input size="large" v-model="exportName" :placeholder="t('script.projectName')" maxlength="40" show-word-limit />
                </div>
                <div class="sw-export-form">
                  <label class="ad-sub ad-muted">{{ t('script.narrativeType') }}</label>
                  <el-select class="narrative-select" v-model="exportNarrativeType" :placeholder="t('script.topicPlaceholder')" clearable size="large" style="width: 100%;">
                    <el-option v-for="n in NARRATIVE_TYPES" :key="n.key" :label="n.name" :value="n.key" />
                  </el-select>
                </div>
                <div class="sw-export-form">
                  <label class="ad-sub ad-muted">{{ t('script.styleAndRatio') }}</label>
                  <ArtStylePicker
                    v-model="exportStyle"
                    v-model:aspect="exportAspect"
                    default-style="realpeople_modern_city"
                    expand
                    :hint="t('script.styleHint')"
                  />
                </div>
                <div class="sw-export-map ad-card">
                  <div class="ad-sub ad-muted">{{ t('script.mapPreview', { count: episodes.length }) }}</div>
                </div>
              </div>
              <div class="sw-next">
                <button class="btn-ink" @click="doExport">
                  <el-icon><Upload /></el-icon> {{ t('script.exportToProject') }}
                </button>
              </div>
            </div>
          </div>

          <!-- 步骤导航（固定最底部） -->
          <div class="sw-steps">
            <div
              v-for="st in STEPS"
              :key="st.key"
              class="sw-step"
              :class="{ active: currentStep === st.key, done: currentStep > st.key, disabled: !reachable(st.key) }"
              @click="gotoStep(st.key)"
            >
              <span class="sw-step-no">{{ currentStep > st.key ? '✓' : st.key }}</span>
              <span class="sw-step-label">{{ st.label }}</span>
            </div>
          </div>
        </template>

        <EmptyState
          v-else
          icon="🎬"
          :title="t('script.emptyTitle')"
          :description="t('script.emptyDesc')"
          :action-label="t('script.createDraft')"
          @action="createDraft"
        >
          <template #action-icon><el-icon><Plus /></el-icon></template>
        </EmptyState>
      </section>
    </div>
    </div>
  </div>
</template>

<style scoped>
/* 外层只负责「视口高度 + 隐藏溢出」，左右边距交给 ad-container（限宽居中，与任务中心一致） */
.sw-page { display: flex; flex-direction: column; height: calc(100vh - var(--ad-topbar-h, 56px)); box-sizing: border-box; overflow: hidden; }
/* 父级 .sw-page 是 flex 列容器，ad-container 的 margin:0 auto 会令 stretch 失效（按内容收缩变窄），
   需显式 width:100% + border-box（content-box 叠加 padding 会横向溢出） */
.sw-wrap { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; }
.sw-head { align-items: center; gap: 12px; flex-wrap: wrap; }
.sw-head-title { min-width: 0; }
.sw-head .ad-title { font-size: 18px; line-height: 1.2; margin: 0; }
.sw-head .ad-sub { font-size: 12px; margin-top: 2px; }
/* 工具行不换行：选择框弹性收缩，删除/新建按钮始终与其同行 */
.sw-head-tools { flex-wrap: nowrap; min-width: 0; }
.sw-draft-select { width: 240px; flex: 0 1 240px; min-width: 140px; }
.sw-opt-title { float: left; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-opt-stage { float: right; font-size: 12px; }
.sw-icon-btn { width: 36px; height: 36px; padding: 0; justify-content: center; flex-shrink: 0; }
.sw-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.stage-tag { color: var(--ad-brand); }

.sw-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; min-height: 0; flex: 1; }

/* 空状态「新建剧本」大按钮，与项目页空状态主按钮同规格 */
:deep(.es-action) {
  height: 56px;
  min-width: 260px;
  padding: 0 40px;
  font-size: 17px;
  font-weight: 700;
  border-radius: 14px;
}
:deep(.es-action .el-icon) { font-size: 20px; }

/* 剧本名（可编辑） */
.sw-titlebar {
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  padding: 6px 14px; border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-elevated, #fff);
  border: 1px solid var(--ad-border, #eef0f4);
}
.sw-title-ico { color: var(--ad-text-muted, #94a3b8); flex-shrink: 0; font-size: 16px; }
.sw-title-input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-size: 16px; font-weight: 700; color: var(--ad-text, #1f2330);
  padding: 4px 6px; border-radius: 6px; font-family: inherit;
}
.sw-title-input::placeholder { color: var(--ad-text-muted, #94a3b8); font-weight: 600; }
.sw-title-input:focus { background: var(--ad-bg-soft); }

/* 步骤导航 */
.sw-steps { display: flex; gap: 8px; flex-shrink: 0; }
.sw-step {
  flex: 1; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-elevated, #fff); border: 1px solid var(--ad-border, #eef0f4);
  cursor: pointer; transition: all .15s; color: var(--ad-text, #1f2330);
}
.sw-step:hover:not(.disabled) { border-color: var(--ad-brand); }
.sw-step.active { border-color: var(--ad-brand); background: var(--ad-brand-soft); }
.sw-step.done { color: var(--ad-brand); }
.sw-step.disabled { opacity: .45; cursor: not-allowed; }
.sw-step-no {
  width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; background: var(--ad-bg-soft); color: var(--ad-text-muted);
}
.sw-step.active .sw-step-no { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.sw-step.done .sw-step-no { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.sw-step-label { font-weight: 600; font-size: 14px; }

.sw-panel { padding: 18px 20px; flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* 第 1 步：对话 */
.sw-chat { display: flex; flex-direction: column; flex: 1; min-height: 450px; gap: 12px; }
.sw-chat-top { padding-bottom: 8px; border-bottom: 1px solid var(--ad-border, #eef0f4); flex-shrink: 0; }
/* 大纲生成进度：状态行 + 细进度条 + 轮播提示，钉在聊天流上方不随滚动 */
.sw-op {
  flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--ad-radius-sm);
  background: var(--ad-brand-soft); border: 1px solid color-mix(in srgb, var(--ad-brand) 35%, transparent);
}
.sw-op-row { display: flex; align-items: center; gap: 8px; color: var(--ad-brand); font-size: 13px; font-weight: 600; }
.sw-op-pct { margin-left: auto; font-variant-numeric: tabular-nums; }
.sw-op-hint { font-size: 12px; color: var(--ad-text-muted, #94a3b8); line-height: 1.5; }
.sw-chat-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px;
  background: var(--ad-bg-soft, #f7f8fc); border-radius: 12px;
}
.sw-chat-empty { padding: 32px 16px; text-align: center; line-height: 1.8; }
.sw-bubble { max-width: 80%; }
.sw-bubble.user { align-self: flex-end; }
.sw-bubble.assistant { align-self: flex-start; }
.sw-bubble-role { font-size: 12px; color: var(--ad-text-muted, #94a3b8); margin-bottom: 4px; }
.sw-bubble.user .sw-bubble-role { text-align: right; }
.sw-bubble-text {
  padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.7;
  background: var(--ad-bg-elevated, #fff); color: var(--ad-text, #1f2330);
  border: 1px solid var(--ad-border, #eef0f4);
}
.sw-bubble.user .sw-bubble-text { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.sw-cursor { animation: swblink 1s step-end infinite; }
@keyframes swblink { 50% { opacity: 0; } }

/* 思考中：等待首个 token 时显示「正在思考」+ 三点跳动动画 */
.sw-thinking { display: inline-flex; align-items: center; gap: 6px; }
.sw-thinking-text { color: var(--ad-text-muted, #94a3b8); font-size: 13px; }
.sw-typing { display: inline-flex; gap: 4px; align-items: center; padding: 2px 0; }
.sw-typing i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ad-brand);
  animation: sw-dot 1.2s infinite ease-in-out;
}
.sw-typing i:nth-child(2) { animation-delay: 0.2s; }
.sw-typing i:nth-child(3) { animation-delay: 0.4s; }
@keyframes sw-dot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
/* 输入区：悬浮卡片（独立于聊天流，靠投影抬升显眼，flex 布局天然不遮挡消息区） */
.sw-chat-input {
  position: relative; z-index: 2; flex-shrink: 0;
  display: flex; gap: 8px; align-items: flex-end;
  padding: 8px; margin-top: 10px; border-radius: 14px;
  background: var(--ad-bg, #fff);
  border: 2px solid var(--ad-brand);
  box-shadow: var(--ad-shadow-md);
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}
.sw-chat-input:focus-within {
  border-color: var(--ad-brand-600, var(--ad-brand));
  box-shadow: 0 12px 30px var(--ad-brand-soft);
}
.sw-chat-input textarea {
  flex: 1; resize: none; min-height: 44px; max-height: 120px; padding: 10px 12px; border-radius: var(--ad-radius-sm);
  border: 1px solid transparent; outline: none; font-family: inherit; font-size: 14px;
  background: transparent; color: var(--ad-text, #1f2330);
}
.sw-chat-input textarea:focus { border-color: transparent; }

/* 第 2 步：大纲 + 分集 */
.sw-outline { display: flex; flex-direction: column; gap: 14px; flex: 1; min-height: 0; }
/* 分集 CTA（醒目置顶） */
.sw-split-cta {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; flex-shrink: 0;
  padding: 14px 18px; border-radius: var(--ad-radius-md);
  background: linear-gradient(135deg, var(--ad-brand-600), var(--ad-brand-700)); color: var(--ad-brand-contrast);
}
.sw-split-cta-title { font-size: 16px; font-weight: 700; }
.sw-split-cta-sub { font-size: 13px; margin-top: 2px; color: var(--ad-brand-contrast); opacity: .85; }
.sw-split-cta-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sw-split-cta-actions .ad-sub { color: var(--ad-brand-contrast); opacity: .9; }
/* 手搓按钮对齐 el-button 观感：同高、同字重、同圆角，浮在金色 CTA 上 */
.sw-split-btn {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--ad-border); cursor: pointer;
  font-size: 15px; font-weight: 600; height: 40px; padding: 0 18px; border-radius: var(--ad-radius-sm);
  background: var(--ad-bg-elevated); color: var(--ad-text-strong); transition: background .15s, filter .15s;
}
.sw-split-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--ad-brand) 6%, var(--ad-bg-elevated)); }
.sw-split-btn:disabled { opacity: .6; cursor: not-allowed; }
.sw-outline-box { background: var(--ad-bg-soft, #f7f8fc); border-radius: var(--ad-radius-sm); padding: 10px 14px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sw-outline-summary { font-weight: 600; flex-shrink: 0; }
.sw-outline-area {
  flex: 1; width: 100%; min-height: 300px; margin-top: 8px; resize: none; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--ad-border, #eef0f4); outline: none; font-family: inherit; font-size: 14px; line-height: 1.7;
  background: var(--ad-bg, #fff); color: var(--ad-text, #1f2330); white-space: pre-wrap;
}
.sw-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sw-eps-wrap { display: flex; flex-direction: column; min-height: 0; }
.sw-eps-empty { padding: 24px; text-align: center; }
.sw-eps-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
.sw-ep-card { border: 1px solid var(--ad-border, #eef0f4); border-radius: var(--ad-radius-sm); padding: 12px 14px; }
.sw-ep-top { margin-bottom: 8px; }
.sw-ep-idx { font-weight: 700; color: var(--ad-brand); white-space: nowrap; }
.sw-ep-title { font-weight: 600; border: none; outline: none; background: transparent; color: var(--ad-text, #1f2330); }
.sw-ep-title:focus { border-bottom: 2px solid var(--ad-brand); }
.sw-ep-summary {
  width: 100%; min-height: 70px; resize: vertical; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--ad-border, #eef0f4); outline: none; font-family: inherit; font-size: 14px; line-height: 1.7;
  background: var(--ad-bg, #fff); color: var(--ad-text, #1f2330);
}
.sw-ep-syn { font-size: 13px; color: var(--ad-text-muted, #94a3b8); margin-bottom: 8px; line-height: 1.6; white-space: pre-wrap; }

/* 第 3 步：逐集细化 */
.sw-detail { display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0; }
.sw-detail-head { flex-wrap: wrap; gap: 10px; }
.sw-detail-body { display: grid; grid-template-columns: 220px 1fr; gap: 14px; flex: 1; min-height: 0; }
.sw-detail-list { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.sw-detail-item {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent; color: var(--ad-text, #1f2330);
}
.sw-detail-item:hover { background: var(--ad-bg-soft); }
.sw-detail-item.active { background: var(--ad-brand-soft); border-color: var(--ad-brand); }
.sw-detail-item.busy { opacity: .7; }
.sw-detail-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.sw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ad-text-muted, #cbd5e1); flex-shrink: 0; }
.sw-dot.done { background: var(--ad-success); }
.sw-detail-combo { display: none; } /* 手机下拉选择，仅窄屏显示 */
.sw-detail-pane { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sw-ep-content {
  flex: 1; min-height: 400px; resize: none; padding: 12px 14px; border-radius: var(--ad-radius-sm);
  border: 1px solid var(--ad-border, #eef0f4); outline: none; font-family: inherit; font-size: 14px; line-height: 1.8;
  background: var(--ad-bg, #fff); color: var(--ad-text, #1f2330); white-space: pre-wrap;
}

.sw-progress {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px;
  background: var(--ad-brand-soft); color: var(--ad-brand); font-size: 13px;
}

/* 第 4 步：导出 */
.sw-export { display: flex; flex-direction: column; gap: 14px; flex: 1; min-height: 0; }
.sw-export-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 2px 6px 2px 2px; }
.sw-export-form { display: flex; flex-direction: column; gap: 6px; }
/* 叙事风格下拉：比常规 large 更高一些，与视觉风格选择器视觉分量匹配 */
.narrative-select :deep(.el-select__wrapper) { min-height: 48px; font-size: 15px; }
.sw-export-map { padding: 12px 14px; }

.sw-next { display: flex; justify-content: flex-end; padding-top: 4px; flex-shrink: 0; }

.btn-ghost, .btn-ink {
  display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; cursor: pointer;
  font-size: 14px; padding: 8px 14px; border: none;
}
.btn-ghost { background: var(--ad-bg-soft); color: var(--ad-text, #1f2330); }
.btn-ghost:hover { background: var(--ad-brand-soft); }
.btn-ink { background: var(--ad-brand); color: var(--ad-brand-contrast); }
.btn-ink:hover { background: var(--ad-brand-700); }
.btn-ink:disabled { opacity: .5; cursor: not-allowed; }

@media (max-width: 860px) {
  .sw-page { height: auto; overflow: visible; }
  .sw-head { gap: 8px; }
  .sw-head-title { flex: 1 1 100%; } /* 窄屏：标题独占一行，工具行整体换到下一行 */
  .sw-cols { grid-template-columns: 1fr; }
  .sw-detail-body { grid-template-columns: 1fr; }
  /* 窄屏：剧集侧栏列表换成下拉选择 */
  .sw-detail-list { display: none; }
  .sw-detail-combo { display: block; }
  .sw-detail-combo .el-select__wrapper { width: 100%; }
  .sw-detail-combo .el-select__selection .el-select__selected-item { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 窄屏保留步骤文字：一行放不下时条目整体换行 */
  .sw-steps { flex-wrap: wrap; }
  .sw-step { padding: 8px 10px; }
  .sw-step-label { font-size: 13px; }
}
/* 手机：步骤条目两两一行，文字过长在条目内折行 */
@media (max-width: 560px) {
  .sw-step { flex: 1 1 calc(50% - 6px); }
}
@media (max-width: 1023px) {
  .sw-wrap { padding-left: 16px; padding-right: 16px; }
}
/* 手机：解除高度后给内部滚动区设限高，保证输入框/操作按钮不被长内容顶出屏幕 */
@media (max-width: 768px) {
  .sw-page { min-height: calc(100dvh - var(--ad-topbar-h, 56px)); }
  .sw-wrap { padding: 10px 12px; }
  .sw-panel { padding: 14px 12px; }
  .sw-chat-body { max-height: 52vh; }
  .sw-detail-list { max-height: 32vh; }
  .sw-ep-content { min-height: 300px; }
}
</style>
