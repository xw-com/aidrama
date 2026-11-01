<script setup>
/**
 * AI 编剧（client ScriptWriterView 移植，移动端单列）：
 * 4 步向导 —— ①对话生成大纲（免费 SSE）②大纲编辑+分集概要 ③逐集细化 ④导出到项目。
 * 草稿列表/切换走底部弹层；题材用原生 picker；计费入口全部走 useCostAction。
 * 做同款：?remake=1&name&desc&narrative&style&aspect 一次性消费自动建稿。
 * 中央菜单新建剧本：?new=1 一次性消费，进页自动新建空白稿。
 */
import { ref, reactive, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad, onShow, onUnload, onPullDownRefresh } from '@dcloudio/uni-app';
import { scriptDraftApi, streamOutlineChat } from '../../api';
import { useJobsStore } from '../../stores/jobs';
import { useThemeStore } from '../../stores/theme';
import { useCostAction } from '../../composables/useCostAction';
import { toast, confirm, selectSheet } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import ArtStylePicker from '../../components/art-style-picker/art-style-picker.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import { useKeyboardAvoid } from '../../composables/useKeyboardAvoid';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

// 聊天输入键盘避让：第 1 步页高≈视口高（46vh 聊天区），原生 adjust-position 无滚动余量且在
// 平移式软键盘端会与 JS 上移叠加成双倍，输入框直接 :adjust-position="false"，避让全权交给 kb；
// 量测 .sw-chatinput 行，kb.style 绑在标题栏/步骤条/卡片上整体上移
// （导航栏 sticky 带底色，上移内容从其下穿过；fixed 弹层 AdSheet/AdDialog 都在这三层之外）
const kb = useKeyboardAvoid({ fieldSelector: '.sw-chatinput' });

const { t } = useI18n();
const jobs = useJobsStore();
const theme = useThemeStore();
const { runJob, runJobs } = useCostAction();

const NARRATIVE_TYPES = [
  'Sweet_romance_novel', 'Urban_workplace_drama', 'Xianxia_fantasy', 'Comedy_humor',
  'Mystery_thriller', 'Hot_blooded_action', 'Coming_of_age', 'Family_warmth',
  'Historical_epic', 'Psychological_drama', 'Horror_supernatural', 'Scifi_post_apocalypse',
].map((key) => ({ key, name: t('script.genre.' + key) }));
const narrativeName = (key) => (NARRATIVE_TYPES.find((n) => n.key === key) || {}).name || t('script.topicPlaceholder');

const STEPS = computed(() => [
  { key: 1, label: t('script.step.1.label') },
  { key: 2, label: t('script.step.2.label') },
  { key: 3, label: t('script.step.3.label') },
  { key: 4, label: t('script.step.4.label') },
]);
const stageOrder = { chat: 1, outline: 2, episodes: 3, detail: 4, done: 4 };
const STAGES = ['chat', 'outline', 'episodes', 'detail', 'done'];
const stageLabel = (s) => (STAGES.includes(s) ? t('script.stage.' + s) : t('script.stage.chat'));

const list = ref([]);
const active = ref(null);
const episodes = ref([]);
const currentStep = ref(1);
const chatMessages = ref([]);
const chatInput = ref('');
const chatting = ref(false);

const narrativeType = ref('');
const outlineText = ref('');
const targetCount = ref(0);
const selectedEid = ref(null);
const exportName = ref('');
const exportStyle = ref('realpeople_modern_city');
const exportAspect = ref('9:16');
const exportNarrativeType = ref('');
const remakeStyle = ref('');
const remakeAspect = ref('');

const draftsShow = ref(false);
const chatScrollTop = ref(0);
let chatAbort = null; // { addEventListener, abort } 信号垫片（小程序无 AbortController）

const selectedEpisode = computed(() => episodes.value.find((e) => e.id === selectedEid.value) || null);
// 草稿弹层高亮当前稿（String 比较防 list/active id 类型不一致）
const activeId = computed(() => (active.value ? String(active.value.id) : ''));

const outlineJob = computed(() => (active.value ? jobs.activeOf('script_outline', active.value.id) : null));

// 大纲生成中：轮播提示（4s 一换），任务结束或离开页面即停（与 client ScriptWriterView 同款）
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
onUnload(() => { if (outlineTipTimer) clearInterval(outlineTipTimer); });
const splitJob = computed(() => (active.value ? jobs.activeOf('episode_split', active.value.id) : null));
const isBusyDetail = (ep) => !!jobs.activeOf('episode_detail', ep.id);
const detailBusyCount = computed(() => episodes.value.filter((e) => isBusyDetail(e)).length);

function reachable(step) {
  const a = active.value;
  if (!a) return false;
  if (step === 1) return true;
  if (step === 2) return !!a.outline;
  if (step === 3) return episodes.value.length > 0;
  if (step === 4) return !!a.outline || episodes.value.length > 0;
  return false;
}
function gotoStep(n) { if (reachable(n)) currentStep.value = n; }

// 中央菜单「新建剧本」带入 ?new=1：进页自动新建空白稿，不恢复上次草稿（一次性消费）
let pendingNewDraft = false;
// 任务页「查看结果」深链 ?sid=：草稿列表就绪后预选该稿（一次性消费）
let pendingSid = null;

async function load() {
  try {
    list.value = await scriptDraftApi.list();
    if (pendingNewDraft) { pendingNewDraft = false; await createDraft(); return; }
    if (pendingSid) {
      const hit = list.value.find((s) => String(s.id) === String(pendingSid));
      pendingSid = null;
      if (hit) { await select(hit); return; }
    }
    if (!active.value && list.value.length) select(list.value[0]);
  } catch { /* http 层已提示 */ }
}

async function select(s) {
  try {
    const full = await scriptDraftApi.get(s.id);
    active.value = full;
    episodes.value = full.episodes || [];
    chatMessages.value = Array.isArray(full.chat) ? full.chat.map((m) => ({ ...m })) : [];
    narrativeType.value = full.narrative_type || '';
    outlineText.value = full.outline || '';
    currentStep.value = stageOrder[full.stage] || 1;
    if (!selectedEid.value || !episodes.value.find((e) => e.id === selectedEid.value)) {
      selectedEid.value = episodes.value[0]?.id || null;
    }
    draftsShow.value = false;
    scrollChatBottom();
  } catch (e) { toast(e?.message || t('script.loadFailed'), 'error'); }
}

async function createDraft() {
  try {
    const row = await scriptDraftApi.create({ title: t('script.untitledDraft'), content: '' });
    list.value.unshift(row);
    await select(row);
  } catch (e) { toast(e?.message || t('script.loadFailed'), 'error'); }
}

async function removeDraft(s) {
  const ok = await confirm({
    title: t('common.tip'),
    content: t('script.deleteConfirm', { name: s.title || t('script.untitledDraft') }),
    danger: true,
  });
  if (!ok) return;
  try {
    await scriptDraftApi.remove(s.id);
    if (active.value?.id === s.id) { active.value = null; episodes.value = []; chatMessages.value = []; }
    list.value = list.value.filter((x) => x.id !== s.id);
    if (!active.value && list.value.length) select(list.value[0]);
    toast(t('common.deleteSuccess'), 'success');
  } catch { /* http 层已提示 */ }
}

// ============ 做同款（展示中心跳入，query 一次性消费） ============
// H5/小程序端 onLoad query 已自动解码，App/鸿蒙端仍是 %XX 原样：兜底手动解一次，
// 汉字才不会以 %E5%B9... 形式落进创作提示词；含 %XX 才解，避免对已解码文本二次误伤
function safeDecodeQuery(v) {
  const s = String(v || '');
  if (!/%[0-9a-fA-F]{2}/.test(s)) return s;
  try { return decodeURIComponent(s); } catch { return s; }
}
async function consumeRemakeQuery(q) {
  if (!q || q.remake !== '1') return;
  const name = safeDecodeQuery(q.name).slice(0, 40).trim();
  const desc = safeDecodeQuery(q.desc).slice(0, 200).trim();
  const narrative = String(q.narrative || '');
  const style = String(q.style || '');
  const aspect = String(q.aspect || '');
  remakeStyle.value = style;
  remakeAspect.value = ['9:16', '16:9', '1:1'].includes(aspect) ? aspect : '';
  // 就地消费 query（redirectTo 自身会重挂载丢状态）；H5 再抹掉地址栏参数防刷新重复建稿
  /* #ifdef H5 */
  try {
    const u = new URL(window.location.href);
    ['remake', 'name', 'desc', 'narrative', 'style', 'aspect'].forEach((k) => u.searchParams.delete(k));
    window.history.replaceState({}, '', u);
  } catch { /* ignore */ }
  /* #endif */
  try {
    const row = await scriptDraftApi.create({
      title: name ? t('script.remakeTitle', { name }) : t('script.untitledDraft'),
      content: '',
    });
    list.value.unshift(row);
    await select(row);
    if (NARRATIVE_TYPES.some((n) => n.key === narrative)) narrativeType.value = narrative;
    chatInput.value = name && desc
      ? t('script.remakeSeed', { name, desc })
      : name
        ? t('script.remakeSeedPlain', { name })
        : t('script.remakeSeedNoName', { desc });
    toast(t('script.remadeReady'), 'success');
  } catch (e) { toast(e?.message || t('script.loadFailed'), 'error'); }
}

// ============ 第 1 步：对话 ============
function scrollChatBottom() {
  nextTick(() => { chatScrollTop.value = chatScrollTop.value + 99999; });
}
function makeSignal() {
  // 极简 AbortSignal 垫片：streamOutlineChat 只用 addEventListener
  const listeners = [];
  return {
    addEventListener: (_ev, fn) => listeners.push(fn),
    abort: () => listeners.forEach((f) => f()),
  };
}
async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatting.value || !active.value) return;
  chatting.value = true;
  chatInput.value = '';
  chatMessages.value.push({ role: 'user', content: text });
  const ai = reactive({ role: 'assistant', content: '', streaming: true });
  chatMessages.value.push(ai);
  scrollChatBottom();
  const signal = makeSignal();
  chatAbort = signal;
  try {
    await streamOutlineChat({
      scriptId: active.value.id, message: text,
      narrativeType: narrativeType.value || undefined,
      onDelta: (d) => { ai.content += d; scrollChatBottom(); },
      onError: (m) => { toast(m || t('script.sendFailed'), 'error'); },
      signal,
    });
  } catch (e) {
    toast(e?.message || t('script.sendFailed'), 'error');
  } finally {
    ai.streaming = false;
    chatting.value = false;
    chatAbort = null;
    load(); // 刷新列表时间
  }
}
function stopChat() { if (chatAbort) chatAbort.abort(); }

// 题材下拉（selectSheet 底部选择面板，弃用原生 picker）：0 号位 = 不限 → null；变更即时保存
async function onNarrativePick() {
  const k = await selectSheet({
    title: t('script.topicPlaceholder'),
    items: [{ key: '', label: t('script.topicPlaceholder') }, ...NARRATIVE_TYPES.map((n) => ({ key: n.key, label: n.name }))],
    current: narrativeType.value || '',
  });
  if (k === null) return;
  const v = k;
  if (!active.value || v === (active.value.narrative_type || '')) { narrativeType.value = v; return; }
  narrativeType.value = v;
  active.value.narrative_type = v || null;
  try { await scriptDraftApi.update(active.value.id, { narrative_type: v || null }); } catch { /* ignore */ }
}
// 导出分镜弹层里的题材下拉
async function onExportNarrativePick() {
  const k = await selectSheet({
    title: t('script.topicPlaceholder'),
    items: [{ key: '', label: t('script.topicPlaceholder') }, ...NARRATIVE_TYPES.map((n) => ({ key: n.key, label: n.name }))],
    current: exportNarrativeType.value || '',
  });
  if (k !== null) exportNarrativeType.value = k;
}

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

// 剧本名编辑：防抖自动保存
let titleTimer = null;
function scheduleSaveTitle() {
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
  scriptDraftApi.update(active.value.id, { title: active.value.title }).catch(() => {});
}

// ============ 第 1 步定稿：生成大纲 ============
async function genOutline() {
  if (!chatMessages.value.length) { toast(t('script.chatFirst'), 'error'); return; }
  await runJob({
    modelType: 'text',
    estimateFor: (sel) => scriptDraftApi.outlineEstimate(active.value.id, sel),
    createFor: (sel) => scriptDraftApi.outline(active.value.id, sel),
    title: t('script.outlineJobTitle'), desc: t('script.outlineJobDesc'), confirmText: t('script.outlineJobConfirm'),
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result) {
        active.value.outline = j.result.outline || '';
        active.value.stage = j.result.stage || 'outline';
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

// ============ 第 2 步：分集 + 概要 ============
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

// 任务完成后以服务器为准重拉单集（兜底 result 透传不全）
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

// ============ 第 3 步：逐集细化 ============
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
      if (j.status === 'succeeded') syncEpisode(ep.id);
    },
  });
}

async function genDetailBatch() {
  const targets = episodes.value.filter((e) => !(e.content || '').trim() && !isBusyDetail(e));
  if (!targets.length) { toast(t('script.noPendingDetail'), 'error'); return; }
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
        if (j.status === 'succeeded') syncEpisode(e.id);
      },
    })),
    title: t('script.batchJobTitle'), desc: t('script.batchJobDesc', { count: targets.length }), confirmText: t('script.batchJobConfirm'),
  });
  if (active.value) active.value.stage = 'detail';
}

// ============ 第 4 步：导出到项目 ============
function openExport() {
  exportName.value = active.value?.title || t('script.untitledProject');
  exportStyle.value = remakeStyle.value || 'realpeople_modern_city';
  exportAspect.value = remakeAspect.value || '9:16';
  exportNarrativeType.value = active.value?.narrative_type || '';
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
    toast(t('script.exportedToProject', { name: res.project.name, count: res.episodeCount }), 'success');
    active.value.stage = 'done';
    // reLaunch 重建栈：创作前的旧栈（展示中心→详情→编剧）不入栈，
    // 工作台的返回键才能只回父级（我的项目），不穿回祖父级页面
    uni.reLaunch({ url: `/pages/workspace/index?id=${res.project.id}` });
  } catch (e) { toast(e?.message || t('script.exportFailed'), 'error'); }
}

watch(currentStep, (n) => { if (n === 4 && active.value) openExport(); });

onLoad((q) => {
  consumeRemakeQuery(q);
  pendingSid = (q && q.sid) || null;
  if (q && q.new === '1' && q.remake !== '1') {
    pendingNewDraft = true;
    /* #ifdef H5 */
    // 抹掉地址栏参数，防刷新重复建稿
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('new');
      window.history.replaceState({}, '', u);
    } catch { /* ignore */ }
    /* #endif */
  }
});
onShow(() => { jobs.fetchAll(); });
// 下拉刷新：重拉草稿列表 + 任务状态
onPullDownRefresh(async () => {
  try {
    jobs.fetchAll();
    await load();
  } finally { uni.stopPullDownRefresh(); }
});
load();
</script>

<template>
  <view class="ad-page sw-page" :class="theme.rootCls">
    <AdNavbar :title="t('script.title')">
      <template #right>
        <view class="sw-headacts">
          <view class="chip glass sm" @tap="createDraft">
            <m-icon name="plus" :size="13" :sw="2" />
          </view>
        </view>
      </template>
    </AdNavbar>

    <!-- 我的剧本下拉框：全宽金描边常驻第一屏，标签行 + 大字当前稿名，点击打开草稿列表 -->
    <view class="sw-myscripts" :style="kb.style.value" @tap="draftsShow = true">
      <view class="sw-ms-icon"><m-icon name="case" :size="19" /></view>
      <view class="sw-ms-main">
        <view class="sw-ms-labelrow">
          <text class="sw-ms-label">{{ t('script.myScripts') }}</text>
          <text class="sw-ms-count mono">{{ list.length }}</text>
        </view>
        <text class="sw-ms-value">{{ active ? (active.title || t('script.untitledDraft')) : t('script.emptyTitle') }}</text>
      </view>
      <text class="sw-ms-caret">▾</text>
    </view>

    <template v-if="active">
      <!-- 剧本名 + 阶段 -->
      <view class="sw-titlebar" :style="kb.style.value">
        <input v-model="active.title" class="sw-title-input" :placeholder="t('script.untitledDraft')" maxlength="60" @input="scheduleSaveTitle" @blur="saveTitleNow" />
        <text class="chip gold sm">{{ stageLabel(active.stage) }}</text>
      </view>

      <!-- 步骤条 -->
      <view class="sw-steps" :style="kb.style.value">
        <text
          v-for="s in STEPS"
          :key="s.key"
          class="pchip"
          :class="{ on: currentStep === s.key, dim: !reachable(s.key) }"
          @tap="gotoStep(s.key)"
        >{{ s.key }}. {{ s.label }}</text>
      </view>

      <!-- ① 对话 -->
      <view v-if="currentStep === 1" class="card sw-panel" :style="kb.style.value">
        <view class="sw-toprow">
          <view class="chip glass sm" @tap="onNarrativePick">
            <text>{{ narrativeType ? narrativeName(narrativeType) : t('script.topicPlaceholder') }}</text>
            <text class="sw-caret">▾</text>
          </view>
          <view class="mbtn sm" :class="{ dis: !chatMessages.length || !!outlineJob }" @tap="genOutline">
            <m-icon name="spark" :size="14" :sw="2" />
            <text>{{ t('script.genOutline') }}</text>
          </view>
        </view>

        <!-- 大纲生成中：状态文案 + 进度条 + 轮播提示（数据来自任务轮询的 stage/progress） -->
        <view v-if="outlineJob" class="sw-op">
          <view class="sw-op-row">
            <view class="sw-op-spin" />
            <text class="sw-op-status">{{ outlineJob.stage || t('script.taskQueued') }}</text>
            <text class="sw-op-pct mono">{{ outlineJob.progress || 0 }}%</text>
          </view>
          <view class="sw-op-bar"><view class="sw-op-fill" :style="{ width: (outlineJob.progress || 0) + '%' }" /></view>
          <text class="sw-op-hint">{{ outlineHint }}</text>
        </view>

        <scroll-view scroll-y class="sw-chatbody" :scroll-top="chatScrollTop" scroll-with-animation>
          <view v-if="!chatMessages.length" class="sw-chatempty">{{ t('script.chatEmptyHint') }}</view>
          <view v-for="(m, i) in chatMessages" :key="i" class="sw-bubble" :class="m.role">
            <text class="sw-brole">{{ m.role === 'user' ? t('script.roleUser') : t('script.roleAssistant') }}</text>
            <view class="sw-btext">
              <text v-if="m.content" user-select>{{ m.content }}<text v-if="m.streaming" class="sw-cursor">▌</text></text>
              <view v-else-if="m.streaming" class="sw-thinking">
                <text>{{ t('script.thinking') }}</text>
                <view class="sw-typing"><view class="d" /><view class="d d2" /><view class="d d3" /></view>
              </view>
            </view>
          </view>
          <view style="height: 6px" />
        </scroll-view>

        <view class="sw-chatinput">
          <textarea
            v-model="chatInput"
            class="sw-input"
            :placeholder="t('script.chatInputPlaceholder')"
            :maxlength="2000"
            auto-height
            :disable-default-padding="true"
            :adjust-position="false"
            @focus="kb.focus(0)"
            @linechange="kb.focus(0)"
          />
          <view v-if="chatting" class="mbtn ghost sm" @tap="stopChat">{{ t('script.stop') }}</view>
          <view v-else class="mbtn sm sw-send" :class="{ dis: !chatInput.trim() }" @tap="sendChat">{{ t('script.send') }}</view>
        </view>
      </view>

      <!-- ② 大纲 + 分集 -->
      <view v-if="currentStep === 2" class="card sw-panel" :style="kb.style.value">
        <text class="sw-lab">{{ t('script.outlineEditable') }}</text>
        <textarea v-model="outlineText" class="sw-input sw-outline" :maxlength="20000" auto-height :disable-default-padding="true" />

        <view class="sw-splitcta">
          <view class="sw-splitcta-t">
            <text class="sw-ctatitle">{{ t('script.splitCtaTitle') }}</text>
            <text class="sw-ctasub">{{ t('script.splitCtaSub') }}</text>
          </view>
          <view class="sw-splitrow">
            <text class="sw-sub">{{ t('script.targetCount') }}</text>
            <view class="sw-stepper">
              <view class="sw-step-btn" @tap="targetCount = Math.max(0, targetCount - 1)">−</view>
              <text class="sw-step-val mono">{{ targetCount || t('script.targetAuto') }}</text>
              <view class="sw-step-btn" @tap="targetCount = Math.min(60, targetCount + 1)">+</view>
            </view>
            <view class="mbtn sm" :class="{ dis: !!splitJob }" @tap="genSplit">
              <m-icon name="film" :size="14" :sw="2" />
              <text>{{ t('script.splitAndGen') }}</text>
            </view>
          </view>
          <view v-if="splitJob" class="sw-progress">
            <text>{{ splitJob.stage || t('script.taskQueued') }}</text>
            <text class="sw-sub">{{ splitJob.progress || 0 }}%</text>
          </view>
        </view>

        <!-- 已分集概要（可编辑） -->
        <template v-if="episodes.length">
          <text class="sw-lab">{{ t('script.totalEpisodes', { count: episodes.length }) }}</text>
          <view v-for="ep in episodes" :key="ep.id" class="sw-epcard">
            <view class="sw-eptop">
              <text class="sw-epidx mono">{{ t('script.episodeTitleShort', { idx: ep.idx }) }}</text>
              <input class="sw-eptitle" v-model="ep.title" @blur="saveEpisode(ep, { title: ep.title })" />
            </view>
            <textarea
              class="sw-input sw-epsummary"
              v-model="ep.summary"
              :placeholder="t('script.episodeSummaryPlaceholder')"
              :maxlength="2000"
              auto-height
              :disable-default-padding="true"
              @blur="saveEpisode(ep, { summary: ep.summary })"
            />
          </view>
        </template>
        <text v-else-if="!splitJob" class="sw-emptyhint">{{ t('script.noEpisodesHint') }}</text>
      </view>

      <!-- ③ 逐集细化 -->
      <view v-if="currentStep === 3" class="card sw-panel" :style="kb.style.value">
        <view class="sw-toprow">
          <text class="sw-sub">
            {{ t('script.totalEpisodes', { count: episodes.length }) }}
            <text v-if="detailBusyCount"> · {{ t('script.detailingCount', { count: detailBusyCount }) }}</text>
          </text>
          <view class="mbtn sm" @tap="genDetailBatch">
            <m-icon name="spark" :size="14" :sw="2" />
            <text>{{ t('script.batchDetailIncomplete') }}</text>
          </view>
        </view>

        <!-- 集选择条 -->
        <scroll-view scroll-x class="sw-epstrip">
          <view class="sw-epstrip-in">
            <view
              v-for="ep in episodes"
              :key="ep.id"
              class="pchip"
              :class="{ on: ep.id === selectedEid }"
              @tap="selectedEid = ep.id"
            >
              <text>{{ t('script.episodeTitleShort', { idx: ep.idx }) }}</text>
              <view class="sw-dot" :class="{ done: (ep.content || '').trim() }" />
            </view>
          </view>
        </scroll-view>

        <template v-if="selectedEpisode">
          <view class="sw-eptop">
            <text class="sw-eptitle2">{{ t('script.episodePaneTitle', { idx: selectedEpisode.idx, title: selectedEpisode.title }) }}</text>
            <view class="mbtn sm" :class="{ dis: isBusyDetail(selectedEpisode) }" @tap="genDetail(selectedEpisode)">
              {{ (selectedEpisode.content || '').trim() ? t('script.refine') : t('script.detailThis') }}
            </view>
          </view>
          <text v-if="selectedEpisode.summary" class="sw-epsyn">{{ t('script.summaryLabel', { summary: selectedEpisode.summary }) }}</text>
          <view v-if="isBusyDetail(selectedEpisode)" class="sw-progress">
            <text>{{ t('script.detailing', { idx: selectedEpisode.idx }) }}</text>
          </view>
          <textarea
            class="sw-input sw-epcontent"
            v-model="selectedEpisode.content"
            :placeholder="t('script.contentPlaceholder')"
            :maxlength="30000"
            auto-height
            :disable-default-padding="true"
            @blur="saveEpisode(selectedEpisode, { content: selectedEpisode.content })"
          />
        </template>

        <view class="sw-nextrow">
          <view class="mbtn sm" @tap="gotoStep(4)">{{ t('script.nextExport') }}</view>
        </view>
      </view>

      <!-- ④ 导出 -->
      <view v-if="currentStep === 4" class="card sw-panel" :style="kb.style.value">
        <text class="sw-sub">{{ t('script.exportIntro') }}</text>
        <text class="sw-lab">{{ t('script.projectName') }}</text>
        <input v-model="exportName" class="sw-input" :placeholder="t('script.projectName')" maxlength="40" />
        <text class="sw-lab">{{ t('script.narrativeType') }}</text>
        <view class="chip glass sm" @tap="onExportNarrativePick">
          <text>{{ exportNarrativeType ? narrativeName(exportNarrativeType) : t('script.topicPlaceholder') }}</text>
          <text class="sw-caret">▾</text>
        </view>
        <text class="sw-lab">{{ t('script.styleAndRatio') }}</text>
        <ArtStylePicker v-model="exportStyle" v-model:aspect="exportAspect" default-style="realpeople_modern_city" />
        <view class="sw-nextrow">
          <view class="mbtn sm" @tap="doExport">
            <m-icon name="import" :size="14" :sw="2" />
            <text>{{ t('script.exportToProject') }}</text>
          </view>
        </view>
      </view>
    </template>

    <!-- 无草稿空态 -->
    <view v-else class="ad-empty sw-nonactive">
      <m-icon name="clap" :size="40" />
      <text>{{ t('script.chatEmptyHint') }}</text>
      <view class="mbtn sm" @tap="createDraft">{{ t('script.createDraft') }}</view>
    </view>

    <!-- 草稿列表弹层 -->
    <AdSheet v-model:show="draftsShow" :title="t('script.myScripts')">
      <!-- scroll-view 限高：草稿多时可滚动（ad-sheet 自身 max-height 不会让内容区滚动） -->
      <scroll-view scroll-y class="sw-drafts-body">
        <view class="sw-drafts">
          <view v-for="s in list" :key="s.id" class="sw-draft" :class="{ on: activeId === String(s.id) }" @tap="select(s)">
            <view class="sw-draft-l">
              <view class="sw-draft-namerow">
                <text class="sw-draft-name">{{ s.title || t('script.untitledDraft') }}</text>
                <m-icon v-if="activeId === String(s.id)" name="check" :size="13" class="sw-draft-check" />
              </view>
              <text class="sw-draft-stage">{{ stageLabel(s.stage) }}</text>
            </view>
            <view class="mbtn ghost sm" @tap.stop="removeDraft(s)">
              <m-icon name="trash" :size="15" />
            </view>
          </view>
          <view class="mbtn soft sm sw-draft-new" @tap="createDraft">
            <m-icon name="plus" :size="14" :sw="2" />
            <text>{{ t('script.createDraft') }}</text>
          </view>
        </view>
      </scroll-view>
    </AdSheet>
    <GenConfirmSheet />
  <AdDialog />
  </view>
</template>

<style scoped>
.sw-headacts { display: flex; gap: 8px; align-items: center; }
.sw-titlebar { display: flex; align-items: center; gap: 10px; padding: 2px 4px 12px; }
.sw-title-input {
  flex: 1; height: 40px; padding: 0 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 15px; font-weight: 700;
}
.sw-steps { display: flex; gap: 8px; padding: 0 2px 14px; overflow-x: auto; }
.sw-steps .pchip.dim { opacity: 0.38; }

.sw-panel { padding: 14px 14px 16px; display: flex; flex-direction: column; gap: 10px; }
/* 键盘避让：标题栏/步骤条/卡片绑同一 kb.style 整体上移（导航栏 sticky 带底色，上移内容从其下穿过） */
.sw-titlebar, .sw-steps, .sw-panel, .sw-myscripts { transition: transform 0.22s ease-out; }
.sw-toprow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
/* 大纲生成进度：状态行 + 细进度条 + 轮播提示，钉在聊天流上方不随滚动 */
.sw-op {
  padding: 9px 11px; border-radius: 11px;
  border: 1px solid rgba(224, 182, 78, 0.3);
  background: rgba(224, 182, 78, 0.06);
  display: flex; flex-direction: column; gap: 6px;
}
.sw-op-row { display: flex; align-items: center; gap: 7px; }
.sw-op-spin {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(224, 182, 78, 0.25); border-top-color: var(--ad-brand);
  animation: sw-op-rotate 0.9s linear infinite;
}
@keyframes sw-op-rotate { to { transform: rotate(360deg); } }
.sw-op-status { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; color: var(--ad-brand); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-op-pct { flex-shrink: 0; font-size: 12px; color: var(--ad-brand); font-weight: 700; }
.sw-op-bar { height: 4px; border-radius: 2px; background: rgba(224, 182, 78, 0.15); overflow: hidden; }
.sw-op-fill { height: 100%; border-radius: 2px; background: var(--ad-brand); transition: width 0.5s ease; }
.sw-op-hint { font-size: 11px; color: var(--ad-text-mut); line-height: 1.5; }
.sw-caret { margin-left: 4px; color: var(--ad-brand); font-size: 10px; }
.sw-sub { font-size: 12px; color: var(--ad-text-mut); }

.sw-chatbody { height: 46vh; }
.sw-chatempty { padding: 30px 20px; text-align: center; font-size: 13px; color: var(--ad-text-mut); line-height: 1.7; }
.sw-bubble { max-width: 88%; margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; }
.sw-bubble.user { margin-left: auto; align-items: flex-end; }
.sw-brole { font-size: 10px; color: var(--ad-text-mut); }
.sw-btext {
  padding: 9px 12px; border-radius: 13px; font-size: 13px; line-height: 1.7; color: var(--ad-text);
  background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.sw-bubble.user .sw-btext { background: rgba(224, 182, 78, 0.14); border-color: rgba(224, 182, 78, 0.35); }
.sw-cursor { color: var(--ad-brand); }
.sw-thinking { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ad-text-mut); }
.sw-typing { display: flex; gap: 3px; }
.sw-typing .d {
  width: 5px; height: 5px; border-radius: 50%; background: var(--ad-brand); opacity: 0.4;
  animation: sw-blink 1.2s infinite;
}
.sw-typing .d2 { animation-delay: 0.2s; }
.sw-typing .d3 { animation-delay: 0.4s; }
@keyframes sw-blink { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }

.sw-chatinput { display: flex; align-items: flex-end; gap: 8px; padding-top: 6px; border-top: 1px solid var(--ad-line); }
.sw-input {
  flex: 1; min-height: 40px; padding: 9px 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 13px; line-height: 1.6; width: auto;
}
.sw-send { min-width: 72px; height: 40px; display: flex; align-items: center; justify-content: center; }
.sw-outline { min-height: 200px; }

.sw-splitcta { padding: 12px; border: 1px solid rgba(224, 182, 78, 0.3); border-radius: 13px; background: rgba(224, 182, 78, 0.06); display: flex; flex-direction: column; gap: 10px; }
.sw-splitcta-t { display: flex; flex-direction: column; gap: 3px; }
.sw-ctatitle { font-size: 14px; font-weight: 700; color: var(--ad-text); }
.sw-ctasub { font-size: 11px; color: var(--ad-text-mut); line-height: 1.5; }
.sw-splitrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sw-stepper { display: flex; align-items: center; gap: 8px; }
.sw-step-btn {
  width: 28px; height: 28px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
  background: var(--ad-inset); border: 1px solid var(--ad-line); color: var(--ad-text); font-size: 15px;
}
.sw-step-val { min-width: 44px; text-align: center; font-size: 13px; color: var(--ad-brand); font-weight: 700; }
.sw-progress { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ad-accent); }

.sw-lab { font-size: 12px; color: var(--ad-text-mut); }
.sw-epcard { padding: 10px 12px; border: 1px solid var(--ad-line); border-radius: 13px; display: flex; flex-direction: column; gap: 8px; }
.sw-eptop { display: flex; align-items: center; gap: 8px; }
.sw-epidx { font-size: 11px; color: var(--ad-brand); font-weight: 700; flex-shrink: 0; }
.sw-eptitle {
  flex: 1; height: 32px; padding: 0 10px; border-radius: 9px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 13px;
}
.sw-eptitle2 { flex: 1; font-size: 14px; font-weight: 700; color: var(--ad-text); }
.sw-epsummary { min-height: 54px; }
.sw-emptyhint { font-size: 12px; color: var(--ad-text-mut); padding: 8px 2px; }

.sw-epstrip { width: 100%; white-space: nowrap; }
.sw-epstrip-in { display: inline-flex; gap: 8px; padding: 2px; }
.sw-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ad-text-mut); margin-left: 5px; display: inline-block; }
.sw-dot.done { background: var(--ad-accent); }
.sw-epsyn { font-size: 11px; color: var(--ad-text-mut); line-height: 1.6; }
.sw-epcontent { min-height: 260px; }
.sw-nextrow { display: flex; justify-content: flex-end; padding-top: 4px; }
.sw-nextrow .mbtn { min-width: 130px; display: flex; align-items: center; justify-content: center; gap: 6px; }

.sw-nonactive { padding: 70px 30px; gap: 14px; color: var(--ad-text-mut); }

.sw-drafts-body { max-height: 78vh; min-height: 0; -webkit-overflow-scrolling: touch; }
.sw-drafts { display: flex; flex-direction: column; gap: 12px; }
.sw-draft { display: flex; align-items: center; gap: 12px; padding: 13px 14px; border: 1px solid var(--ad-line); border-radius: 14px; }
.sw-draft-l { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sw-draft-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-draft-stage { font-size: 11.5px; color: var(--ad-text-mut); }
.sw-draft .mbtn.ghost { color: var(--ad-danger); min-width: 40px; height: 40px; flex-shrink: 0; }
.sw-draft-new { display: flex; align-items: center; justify-content: center; gap: 6px; }

/* 我的剧本下拉框：全宽金描边，常驻第一屏最上方，点击展开草稿列表 */
.sw-myscripts {
  display: flex; align-items: center; gap: 11px;
  margin: 0 2px 12px; padding: 11px 14px;
  border-radius: 14px;
  border: 1px solid rgba(224, 182, 78, 0.55);
  background: linear-gradient(135deg, rgba(224, 182, 78, 0.2), rgba(224, 182, 78, 0.06));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
}
.sw-ms-icon {
  width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(224, 182, 78, 0.22);
  border: 1px solid rgba(224, 182, 78, 0.45);
  color: var(--ad-brand);
}
.sw-ms-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sw-ms-labelrow { display: flex; align-items: center; gap: 6px; }
.sw-ms-label { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--ad-brand); }
.sw-ms-count {
  min-width: 18px; height: 17px; padding: 0 5px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-brand); color: rgba(24, 18, 6, 0.92);
  font-size: 10.5px; font-weight: 800;
}
.sw-ms-value {
  font-size: 16px; font-weight: 800; color: var(--ad-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sw-ms-caret { flex-shrink: 0; color: var(--ad-brand); font-size: 15px; font-weight: 700; }
.sw-draft.on { border-color: rgba(224, 182, 78, 0.55); background: rgba(224, 182, 78, 0.07); }
.sw-draft-namerow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sw-draft-check { flex-shrink: 0; color: var(--ad-brand); }
</style>
