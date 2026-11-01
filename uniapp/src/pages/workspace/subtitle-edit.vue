<script setup>
/**
 * 字幕编辑器独立页（原 episodes 页「字幕编辑」AdSheet 迁出，参照 char-create 页面模式）：
 * 校对台词/时间码 → 智能校正（LLM 对照剧本只小改读音字数相近的错字）→ 合并烧录（免费，本地 ffmpeg）。
 * 入口：/pages/workspace/subtitle-edit?pid=<projectId>&vid=<episodeVideoId>（vid=成片记录 id）。
 * 成片记录经 opener 事件通道传入（episodes 页 emit('video', v)）；页面端仍会按 vid
 * 拉本项目成片列表兜底解析 —— 源片 URL 需按 source_job_id 找兄弟行，单条记录不够。
 * 项目字幕样式（嵌套 AdSheet + selectSheet 字体选择）随编辑器一并迁入。
 * 保存留在本页；烧录提交成功后 uni.$emit('episodes:reload') 通知列表页重拉再返回。
 */
import { ref, reactive, computed, watch, getCurrentInstance } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { projectApi, videoApi } from '../../api';
import { useJobsStore } from '../../stores/jobs';
import { useThemeStore } from '../../stores/theme';
import { useCostAction } from '../../composables/useCostAction';
import { useVideoPlayer } from '../../composables/useVideoPlayer';
import { can } from '../../utils/perms';
import { toast, confirm, selectSheet } from '../../utils/ui';
import { toAbsolute } from '../../utils/media';
import { defaultSubtitleStyle } from '../../utils/subtitleStyle';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import VideoPlayerPopup from '../../components/video-player-popup/video-player-popup.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const jobs = useJobsStore();
const theme = useThemeStore();
const { runJob } = useCostAction();
const { play, playerShow, playerUrl, playerTitle } = useVideoPlayer();
const instance = getCurrentInstance();

let pid = null;
let vid = null;
const chanVideo = ref(null); // opener 事件通道传来的成片记录（vid 缺失时兜底）
const project = ref(null);
const loadError = ref('');
const allRows = ref([]); // 本项目全部成片行（含字幕版），按 source_job_id 找源片 URL 用

// ---------- 编辑器状态 ----------
const subLoading = ref(false);
const subJobId = ref(null);
const subVideoUrl = ref('');
const subRows = ref([]);
const subInitial = ref([]);
const corrected = ref(false);
const correctedCount = ref(null);
const savingDraft = ref(false);
const burning = ref(false);
const submittingCorrect = ref(false);
const correctJobId = ref(null);
const subReadonly = computed(() => !can(project.value, 'video.manage')); // 无成片管理权限时只读查看
const subLocked = computed(() => submittingCorrect.value || correcting.value || subReadonly.value);

const correctJob = computed(() => (correctJobId.value != null ? jobs.items.find((j) => j.id === correctJobId.value) : null));
const correcting = computed(() => {
  const j = correctJob.value;
  return !!j && (j.status === 'pending' || j.status === 'running');
});
const correctPct = computed(() => Math.min(100, Math.max(0, Number(correctJob.value?.progress) || 0)));

// 源成片 URL（源成片已删时为空，预览入口随之隐藏）
function sourceVideoUrlOf(v) {
  const src = allRows.value.find((c) => c.kind !== 'subtitle' && String(c.job_id) === String(v.source_job_id));
  return src?.video_url || '';
}

// ---------- 数据初始化（onLoad 后异步拉取，表单不得在挂载帧同步回填） ----------
onLoad((q) => {
  pid = (q && (q.pid || q.id)) || null;
  vid = (q && q.vid) || null;
  // opener 事件通道：episodes 页 navigateTo 成功回调里 emit('video', v)
  try {
    const ch = instance.proxy.getOpenerEventChannel && instance.proxy.getOpenerEventChannel();
    if (ch && ch.on) ch.on('video', (v) => { chanVideo.value = v; });
  } catch { /* 个别端拿不到 opener channel，走 vid 解析兜底 */ }
  init();
});
onShow(() => {
  jobs.fetchAll(); // 回页同步任务列表（智能校正进度 / 烧录任务跟踪依赖它）
});

async function init() {
  subLoading.value = true;
  try {
    // 项目（权限 + 字幕样式默认值）、成片列表（解析 vid/源片）、任务列表（挂回在途校正）相互独立，并行发出
    const [p, list] = await Promise.all([
      projectApi.get(pid),
      videoApi.projectVideos(pid),
      jobs.fetchAll(),
    ]);
    project.value = p;
    allRows.value = list || [];
    // 解析目标成片记录：优先 vid（成片记录 id），事件通道数据兜底
    const rec = allRows.value.find((r) => String(r.id) === String(vid))
      || allRows.value.find((r) => chanVideo.value && String(r.job_id) === String(chanVideo.value.job_id));
    if (!rec || !rec.job_id) {
      loadError.value = t('common.noData');
      return;
    }
    subJobId.value = rec.job_id;
    subVideoUrl.value = sourceVideoUrlOf(rec);
    await loadDraft();
  } catch (e) {
    loadError.value = t('common.error');
  } finally {
    subLoading.value = false;
  }
}

// 时间量化到毫秒：ASR 草稿常见亚毫秒精度，fmt/parse 往返有损耗，不量化会导致行被静默丢弃
const qTime = (x) => Math.floor(Math.max(0, Number(x) || 0) * 1000) / 1000;

// 写入编辑基准（加载草稿/保存回写/校正回填共用）：量化时间 + 收敛空白 + 按开始时间排序
function applySegments(segs) {
  subInitial.value = (segs || [])
    .map((s) => ({ start: qTime(s.start), end: qTime(s.end), text: String(s.text || '').trim() }))
    .sort((a, b) => a.start - b.start);
}
function applyCorrectState(data) {
  corrected.value = !!data?.corrected;
  correctedCount.value = data?.corrected_count ?? null;
}

function fmtTime(sec) {
  const v = Math.max(0, Number(sec) || 0);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  const ms = Math.min(999, Math.round((v - Math.floor(v)) * 1000)); // 毫秒进位兜底
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
function parseTime(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

async function loadDraft() {
  if (!subJobId.value) return;
  subRows.value = [];
  corrected.value = false;
  correctedCount.value = null;
  // 该草稿已有在跑的智能校正任务（上次离开页面后仍在后台执行）：挂回等待态并锁定编辑
  const running = jobs.items.find(
    (j) => j.type === 'subtitle_correct' && String(j.ref_id) === String(subJobId.value)
      && (j.status === 'pending' || j.status === 'running'),
  );
  correctJobId.value = running?.id || null;
  try {
    const data = await videoApi.subtitleSegments(subJobId.value);
    applySegments(data.segments);
    applyCorrectState(data);
    resetRows();
  } catch (e) { /* http 层已提示 */ }
}

function resetRows() {
  subRows.value = subInitial.value.map((s) => ({ start: s.start, end: s.end, startStr: fmtTime(s.start), endStr: fmtTime(s.end), text: s.text }));
}

// 失焦解析时间：非法则提示并回退为当前值
function commitTime(row, field, e) {
  const raw = e && e.detail ? e.detail.value : '';
  const parsed = parseTime(raw);
  if (parsed === null) {
    toast(t('episode.videos.invalidTime'));
    row[`${field}Str`] = fmtTime(row[field]);
    return;
  }
  row[field] = parsed;
  row[`${field}Str`] = fmtTime(parsed);
}

function addRow() {
  const last = subRows.value[subRows.value.length - 1];
  const start = last ? Number(last.end) || 0 : 0;
  subRows.value.push({ start, end: start + 1, startStr: fmtTime(start), endStr: fmtTime(start + 1), text: '' });
}
function removeRow(i) { subRows.value.splice(i, 1); }
function resetAll() { resetRows(); }

const validSegments = computed(() => subRows.value
  .filter((r) => r.text.trim() && parseTime(r.startStr) !== null && parseTime(r.endStr) !== null)
  .map((r) => ({ start: parseTime(r.startStr), end: parseTime(r.endStr), text: r.text.trim() }))
  .sort((a, b) => a.start - b.start));

// 取校验通过的段落（台词非空 + 时间码合法 + 开始早于结束），不通过则提示并返回 null
function collectSegments() {
  const segs = validSegments.value;
  if (!segs.length) { toast(t('episode.videos.editorEmpty')); return null; }
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].end <= segs[i].start) { toast(t('episode.videos.badRange', { n: i + 1 })); return null; }
  }
  return segs;
}

// 保存校对结果：服务端按「一行不超过 15 个汉字」标准重新分段并回写草稿（留在本页继续编辑）
async function saveDraft() {
  const segs = collectSegments();
  if (!segs) return;
  savingDraft.value = true;
  try {
    const data = await videoApi.saveSubtitleSegments(subJobId.value, segs);
    applySegments(data.segments);
    resetRows();
    toast(t('episode.videos.subSaved'), 'success');
  } catch (e) { /* http 层已提示 */ } finally {
    savingDraft.value = false;
  }
}

// 智能校正：当前段落连同本集剧本交给文本大模型，逐条修正 ASR 听写错误（只小改、时间码不动）
async function smartCorrect() {
  const segs = collectSegments();
  if (!segs) return;
  submittingCorrect.value = true;
  try {
    const job = await runJob({
      modelType: 'text',
      estimateFor: (sel) => videoApi.subtitleCorrectEstimate(subJobId.value, sel),
      createFor: (sel) => videoApi.correctSubtitle(subJobId.value, segs, sel),
      title: t('episode.videos.correctTitle'),
      desc: t('episode.videos.correctDesc'),
      confirmText: t('episode.videos.correctConfirm'),
    });
    if (job) correctJobId.value = job.id; // 用户在确认页取消则不进入等待态
  } catch (e) { /* http 层已提示 */ } finally {
    submittingCorrect.value = false;
  }
}

// 校正任务到达终态：成功 → 拉最新草稿刷新；失败 → 报错；取消 → 静默解锁（按状态驱动，不漏判不重复）
watch(correctJob, (job) => {
  if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
  correctJobId.value = null;
  finishCorrect(job);
});

async function finishCorrect(job) {
  if (job.status === 'succeeded') {
    try {
      const data = await videoApi.subtitleSegments(subJobId.value);
      applySegments(data.segments);
      applyCorrectState(data);
      resetRows();
    } catch (e) { /* 保持原稿 */ }
    const n = Number(job.result?.subtitle?.changed_count) || 0;
    if (n > 0) toast(t('episode.videos.correctDone', { n }), 'success');
    else toast(t('episode.videos.correctNone'));
  } else if (job.status === 'failed') {
    toast(job.error || t('common.error'));
  }
}

// 合并字幕到视频（免费，纯本地 ffmpeg）：提交后任务中心跟踪，完成 toast 由 store 统一播报；
// 成功后通知列表页重拉（新增字幕版成片）并返回
async function burn() {
  const segs = collectSegments();
  if (!segs) return;
  const okGo = await confirm({ title: t('common.tip'), content: t('episode.videos.burnConfirm') });
  if (!okGo) return;
  burning.value = true;
  try {
    const data = await videoApi.burnSubtitle(subJobId.value, segs);
    jobs.track(data.job);
    toast(t('episode.videos.burnSubmitted'), 'success');
    uni.$emit('episodes:reload');
    uni.navigateBack();
  } catch (e) { /* http 层已提示 */ } finally {
    burning.value = false;
  }
}

function playSource() {
  if (subVideoUrl.value) play({ url: toAbsolute(subVideoUrl.value), title: t('episode.videos.preview') });
}

// ---------- 项目字幕样式（存 project.settings.subtitle，短边 1080 基准；嵌套 AdSheet） ----------
const FONT_PRESETS = [
  'Noto Sans CJK SC', 'Noto Serif CJK SC', 'Source Han Sans SC', 'Source Han Serif SC',
  'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'SimHei', 'SimSun', 'Microsoft YaHei',
  'KaiTi', 'PingFang SC', 'Songti SC',
];
const styleShow = ref(false);
const savingStyle = ref(false);
const styleForm = reactive({ font: '', fontSize: null, marginV: null });
const styleDefaults = computed(() => defaultSubtitleStyle(project.value?.aspect_ratio));
const styleCustomized = computed(() => !!(styleForm.font || styleForm.fontSize != null || styleForm.marginV != null));
// 预览画布：短边固定 180px，与烧录同公式「值/1080×短边」等比渲染，所见即所得
const STAGE_SHORT = 180;
const subStyle = computed(() => ({
  fontSize: `${(((styleForm.fontSize ?? styleDefaults.value.fontSize) / 1080) * STAGE_SHORT).toFixed(1)}px`,
  bottom: `${(((styleForm.marginV ?? styleDefaults.value.marginV) / 1080) * STAGE_SHORT).toFixed(1)}px`,
  fontFamily: styleForm.font ? `'${styleForm.font.replace(/'/g, '')}', sans-serif` : '',
}));

function openStyle() {
  const sub = project.value?.settings?.subtitle || null;
  styleForm.font = sub?.font || '';
  styleForm.fontSize = sub?.fontSize ?? null;
  styleForm.marginV = sub?.marginV ?? null;
  styleShow.value = true;
}
// 字体下拉（selectSheet 底部选择面板，弃用原生 picker）；fontOpen 驱动箭头朝向（关=向下，开=向上）
const fontOpen = ref(false);
async function pickFont() {
  fontOpen.value = true;
  try {
    const k = await selectSheet({
      title: t('project.subtitleSettings.font'),
      items: FONT_PRESETS.map((f) => ({ key: f, label: f })),
      current: styleForm.font || '',
    });
    if (k !== null) styleForm.font = k;
  } finally {
    fontOpen.value = false;
  }
}
function onNumInput(field, e) {
  const raw = String(e && e.detail ? e.detail.value : '').trim();
  styleForm[field] = raw === '' ? null : Math.round(Number(raw));
}
async function resetStyleDefault() {
  const okGo = await confirm({ title: t('common.tip'), content: t('project.subtitleSettings.resetConfirm') });
  if (!okGo) return;
  styleForm.font = '';
  styleForm.fontSize = null;
  styleForm.marginV = null;
}
// 保存：任一字段已设置 → 写入子树；全部为空 → subtitle 传 null（服务端删除子树恢复默认）
async function saveStyle() {
  savingStyle.value = true;
  try {
    const patch = {};
    if (styleForm.font) patch.font = styleForm.font;
    if (styleForm.fontSize != null) patch.fontSize = styleForm.fontSize;
    if (styleForm.marginV != null) patch.marginV = styleForm.marginV;
    const subtitle = Object.keys(patch).length ? patch : null;
    await projectApi.update(pid, { settings: { subtitle } });
    project.value = { ...project.value, settings: { ...(project.value.settings || {}), subtitle } };
    toast(t('project.subtitleSettings.updated'), 'success');
    styleShow.value = false;
  } catch (e) { /* http 层已提示 */ } finally {
    savingStyle.value = false;
  }
}
</script>

<template>
  <view class="ad-page se-page" :class="theme.rootCls">
    <AdNavbar :title="t('episode.videos.editorTitle')" />

    <view class="se-body">
      <view class="se-hints">
        <text class="se-hint">{{ t('episode.videos.editorHint') }}</text>
        <text class="se-hint">{{ t('episode.videos.segRule') }}</text>
        <text v-if="subReadonly" class="se-readonly">{{ t('team.readonlySubtitle') }}</text>
      </view>

      <view v-if="subVideoUrl" class="se-src">
        <view class="mbtn ghost sm" @tap="playSource"><m-icon name="play" :size="13" /><text>{{ t('episode.videos.preview') }}</text></view>
      </view>

      <view v-if="subLoading && !loadError" class="se-loading"><text>{{ t('common.loading') }}</text></view>
      <view v-else-if="loadError" class="se-loading"><text>{{ loadError }}</text></view>

      <template v-else>
        <!-- 智能校正等待框：进度 + 服务端阶段文案 -->
        <view v-if="correcting" class="se-correcting">
          <view class="se-cl"><view class="pulse" /><text>{{ t('episode.videos.correctRunning') }}</text></view>
          <view class="se-bar"><view class="fill" :style="{ width: correctPct + '%' }" /></view>
          <text v-if="correctJob && correctJob.stage" class="se-stage">{{ correctJob.stage }}</text>
        </view>

        <!-- 字幕行：时间码 + 台词（行数据在草稿拉到后才写入，避开 App/小程序 input 挂载帧吃初值的坑） -->
        <view class="se-rows">
          <view v-for="(r, i) in subRows" :key="i" class="se-row">
            <view class="se-row-top">
              <text class="se-idx">{{ i + 1 }}</text>
              <input class="se-time" :value="r.startStr" :disabled="subLocked" @blur="commitTime(r, 'start', $event)" />
              <text class="se-arrow">→</text>
              <input class="se-time" :value="r.endStr" :disabled="subLocked" @blur="commitTime(r, 'end', $event)" />
              <view class="se-row-del" :class="{ dis: subLocked }" @tap="!subLocked && removeRow(i)"><text>×</text></view>
            </view>
            <textarea
              v-model="r.text"
              class="ad-textarea se-text"
              :disabled="subLocked"
              :maxlength="300"
              auto-height
              :placeholder="t('episode.videos.colText')"
              placeholder-class="ad-ph"
            />
          </view>
          <view v-if="!subRows.length" class="se-empty"><text>{{ t('episode.videos.editorEmpty') }}</text></view>
        </view>

        <!-- 编辑操作行：样式/加行/重置/智能校正 + 校正状态徽标 -->
        <view class="se-ops">
          <view v-if="!subReadonly" class="mbtn ghost sm" :class="{ dis: subLocked }" @tap="!subLocked && openStyle()"><text>{{ t('project.subtitleSettings.title') }}</text></view>
          <view v-if="!subReadonly" class="mbtn ghost sm" :class="{ dis: subLocked }" @tap="!subLocked && addRow()"><text>+ {{ t('episode.videos.addSeg') }}</text></view>
          <view v-if="!subReadonly" class="mbtn ghost sm" :class="{ dis: subLocked }" @tap="!subLocked && resetAll()"><text>{{ t('episode.videos.reset') }}</text></view>
          <view v-if="!subReadonly" class="mbtn soft sm" :class="{ dis: subLocked }" @tap="!subLocked && smartCorrect()">
            <m-icon name="spark" :size="13" /><text>{{ t('episode.videos.correct') }}</text>
          </view>
          <!-- 校正状态徽标：是否已跑过智能校正（手动编辑不清除） -->
          <text v-if="!correcting" class="chip" :class="corrected ? 'ok' : 'glass'">
            {{ corrected ? t('episode.videos.correctStateDone') : t('episode.videos.correctStateNone') }}
          </text>
        </view>
      </template>
    </view>

    <!-- 底部动作条：保存校对稿 / 合并烧录（只读时隐藏） -->
    <view v-if="!subReadonly && !loadError" class="se-foot">
      <view class="mbtn soft" :class="{ dis: burning || subLocked }" @tap="!(burning || subLocked) && saveDraft()"><text>{{ t('episode.videos.saveSub') }}</text></view>
      <view class="mbtn burn" :class="{ dis: savingDraft || subLocked }" @tap="!(savingDraft || subLocked) && burn()"><text>{{ t('episode.videos.burn') }}</text></view>
    </view>

    <!-- 全屏播放弹层（页面不内嵌 video，统一走此组件） -->
    <VideoPlayerPopup v-model:show="playerShow" :url="playerUrl" :title="playerTitle" :aspect="project?.aspect_ratio || ''" />

    <!-- 项目字幕样式：字体/字号/离底边距（烧录时按分辨率等比缩放，所见即所得） -->
    <AdSheet :show="styleShow" :title="t('project.subtitleSettings.title')" @update:show="styleShow = $event">
      <view class="ss">
        <text class="se-hint">{{ t('project.subtitleSettings.hint') }}</text>
        <view class="ss-stage">
          <text class="ss-sample" :style="subStyle">{{ t('project.subtitleSettings.previewText') }}</text>
        </view>
        <view class="ad-field">
          <view class="ss-label"><text>{{ t('project.subtitleSettings.font') }}</text><text v-if="!styleForm.font" class="ss-def">{{ t('project.subtitleSettings.defaultTag') }} {{ styleDefaults.fontSize }}</text></view>
          <view class="ad-input ad-picker" @tap="pickFont">
            <text :class="{ ph: !styleForm.font }">{{ styleForm.font || t('project.subtitleSettings.fontDefault') }}</text>
            <m-icon :name="fontOpen ? 'up' : 'down'" :size="16" />
          </view>
          <text class="ad-hint">{{ t('project.subtitleSettings.fontHint') }}</text>
        </view>
        <view class="ad-field">
          <view class="ss-label"><text>{{ t('project.subtitleSettings.fontSize') }}</text><text v-if="styleForm.fontSize == null" class="ss-def">{{ t('project.subtitleSettings.defaultTag') }} {{ styleDefaults.fontSize }}</text></view>
          <input class="ad-input" type="number" :value="styleForm.fontSize == null ? '' : String(styleForm.fontSize)" :placeholder="String(styleDefaults.fontSize)" placeholder-class="ad-ph" @input="onNumInput('fontSize', $event)" />
        </view>
        <view class="ad-field">
          <view class="ss-label"><text>{{ t('project.subtitleSettings.marginV') }}</text><text v-if="styleForm.marginV == null" class="ss-def">{{ t('project.subtitleSettings.defaultTag') }} {{ styleDefaults.marginV }}</text></view>
          <input class="ad-input" type="number" :value="styleForm.marginV == null ? '' : String(styleForm.marginV)" :placeholder="String(styleDefaults.marginV)" placeholder-class="ad-ph" @input="onNumInput('marginV', $event)" />
        </view>
        <text class="ad-hint">{{ t('project.subtitleSettings.scaleHint') }}</text>
        <view class="ss-foot">
          <view class="mbtn ghost sm" :class="{ dis: !styleCustomized }" @tap="styleCustomized && resetStyleDefault()"><text>{{ t('project.subtitleSettings.reset') }}</text></view>
          <view class="mbtn sm" :class="{ dis: savingStyle }" @tap="!savingStyle && saveStyle()"><text>{{ t('common.save') }}</text></view>
        </view>
      </view>
    </AdSheet>

    <!-- 统一「模型+价格」确认页（智能校正走 useCostAction，本页挂一份） -->
    <GenConfirmSheet />
    <AdDialog />
  </view>
</template>

<style scoped>
.se-body { padding: 12px 18px 110px; }
.se-foot {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 80;
  display: flex; gap: 9px;
  padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
  background: var(--ad-ink);
}
.se-foot .mbtn { height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; }
/* 合并字幕到视频：比保存按钮宽 20% */
.se-foot .mbtn.burn { flex: 1.2; }
.se-foot .mbtn.soft { flex: 1; }

.se-hints { display: flex; flex-direction: column; gap: 5px; padding-bottom: 11px; }
.se-hint { font-size: 11.5px; line-height: 1.65; color: var(--ad-text-mut); }
.se-readonly {
  padding: 8px 11px; border-radius: 9px; font-size: 12px; color: var(--ad-warning);
  background: rgba(251, 191, 36, 0.14); border: 1px solid rgba(251, 191, 36, 0.4);
}
.se-src { display: flex; padding-bottom: 10px; }
.se-loading { padding: 18px 0; text-align: center; font-size: 12px; color: var(--ad-text-mut); }
.se-correcting {
  display: flex; flex-direction: column; gap: 7px; margin-bottom: 11px; padding: 11px 13px;
  border: 1px solid rgba(224, 182, 78, 0.5); border-radius: 12px; background: var(--ad-brand-soft);
}
.se-cl { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ad-brand); }
.se-bar { height: 4px; border-radius: 3px; background: var(--ad-line); overflow: hidden; }
.se-bar .fill { height: 100%; border-radius: 3px; background: var(--ad-brand-gradient); transition: width 0.3s; }
.se-stage { font-size: 11px; color: var(--ad-text-mut); }
.se-rows { display: flex; flex-direction: column; }
.se-row { padding: 11px 12px; border-radius: 13px; background: var(--ad-elev); border: 1px solid var(--ad-line); margin-bottom: 9px; }
.se-row-top { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.se-idx {
  flex: none; width: 26px; height: 26px; border-radius: 8px; text-align: center; line-height: 26px;
  font-size: 12px; font-weight: 700; color: var(--ad-brand-contrast); background: var(--ad-brand);
}
.se-time {
  flex: 1; min-width: 0; height: 34px; padding: 0 8px; border-radius: 8px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  font-size: 11.5px; color: var(--ad-text); font-variant-numeric: tabular-nums;
}
.se-arrow { flex: none; font-size: 12px; color: var(--ad-text-mut); }
.se-row-del {
  flex: none; width: 30px; height: 30px; border-radius: 9px; text-align: center; line-height: 28px;
  background: rgba(248, 113, 113, 0.12); color: var(--ad-danger); font-size: 17px;
}
.se-row-del.dis { opacity: 0.4; }
.se-text { min-height: 60px; }
.se-empty { padding: 26px 0; text-align: center; font-size: 12.5px; color: var(--ad-text-mut); }
.se-ops { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 6px; }

/* ---------- 字幕样式抽屉 ---------- */
.ss { display: flex; flex-direction: column; }
.ss-stage {
  position: relative; height: 180px; margin-bottom: 13px;
  border-radius: 12px; background: var(--ad-inset); border: 1px solid var(--ad-line); overflow: hidden;
}
.ss-sample {
  position: absolute; left: 0; right: 0; text-align: center;
  color: #fff; text-shadow: 0 2px 6px rgba(0, 0, 0, 0.9); line-height: 1.35;
}
.ss-label { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--ad-text-soft); margin-bottom: 7px; }
.ss-def { font-size: 10.5px; font-weight: 500; color: var(--ad-text-mut); }
.ad-picker { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ad-picker .ph { color: var(--ad-text-mut); }
.ss-foot { display: flex; gap: 9px; margin-top: 12px; }
.ss-foot .mbtn { flex: 1; }
</style>
