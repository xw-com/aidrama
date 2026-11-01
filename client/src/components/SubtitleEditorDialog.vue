<script setup>
import { ref, computed, watch, watchEffect, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { videoApi } from '../api';
import { useJobsStore } from '../stores/jobs';
import { useCostAction } from '../composables/useCostAction';
import { ElMessage, ElMessageBox } from 'element-plus';
import SubtitleSettingsDialog from './SubtitleSettingsDialog.vue';

/**
 * 字幕编辑器（两段式第二步入口）：拉取提取 Job 的段落，
 * 支持改文本/时间码、增删段，配合顶部视频预览定位校对；
 * 「合并字幕到视频」提交 burn 任务（免费，纯本地 ffmpeg）。
 * footer 左侧提供「字幕设置」入口：改项目级字幕样式（字体/字号/底距），烧录时生效。
 * 「智能校正」提交 AI 校正任务：对照本集剧本逐条修正 ASR 听写错误（按文本模型计费）。
 */
const props = defineProps({
  jobId: { type: [Number, String], default: null },
  videoUrl: { type: String, default: '' },
  projectId: { type: [Number, String], default: null },
  aspectRatio: { type: String, default: '9:16' },
  subtitle: { type: Object, default: null }, // project.settings?.subtitle
  readonly: { type: Boolean, default: false }, // 团队共享：无 video.manage 权限时只读查看字幕草稿
});
const emit = defineEmits(['update:modelValue', 'done', 'styleUpdated']);
const model = defineModel({ type: Boolean, default: false });

const { t } = useI18n();
const jobsStore = useJobsStore();
const { runJob } = useCostAction();
const loading = ref(false);
const burning = ref(false);
const saving = ref(false);
// 智能校正等待态：submitting = 确认弹窗/提交请求中；correctJobId = 等待终态的任务
// （本弹窗提交，或打开时已有在跑的——关闭弹窗再打开仍能挂回等待并锁定编辑）。
const submitting = ref(false);
const correctJobId = ref(null);
const correctJob = computed(() => (correctJobId.value != null ? jobsStore.items.find((j) => j.id === correctJobId.value) : null));
const correcting = computed(() => {
  const j = correctJob.value;
  return !!j && (j.status === 'pending' || j.status === 'running');
});
// 等待校正期间锁定：编辑/增删/重置/保存/合成全部禁用（取消可关弹窗，任务继续在后台跑）；只读模式同样锁定
const locked = computed(() => submitting.value || correcting.value || props.readonly);
// 已智能校正状态（接口随草稿返回：草稿标记 + 历史成功校正任务回溯），手动编辑不清除；
// correctedCount = 上次校正实际修正条数（旧草稿回溯不到时为 null，不显示 tooltip）
const corrected = ref(false);
const correctedCount = ref(null);
function applyCorrectState(data) {
  corrected.value = !!data?.corrected;
  correctedCount.value = data?.corrected_count ?? null;
}
const videoRef = ref(null);
// 项目字幕样式设置（烧录前调整字体/字号/底距；保存后由父级刷新 project 回传新值）
const styleVisible = ref(false);
// 编辑副本：时间以 HH:MM:SS,mmm 字符串编辑，失焦解析回秒并回写格式化
const rows = ref([]);
const initial = ref([]);

// 时间量化到毫秒：ASR 草稿常见亚毫秒精度，fmt/parse 往返有损耗，不量化会导致行被静默丢弃
const qTime = (x) => Math.floor(Math.max(0, Number(x) || 0) * 1000) / 1000;
// 写入编辑基准（加载草稿/保存回写/校正回填共用）：量化时间 + 收敛首尾空白 + 按开始时间排序
function applySegments(segs) {
  initial.value = (segs || [])
    .map((s) => ({ start: qTime(s.start), end: qTime(s.end), text: String(s.text || '').trim() }))
    .sort((a, b) => a.start - b.start);
}

function fmtTime(sec) {
  const v = Math.max(0, Number(sec) || 0);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  // 毫秒进位兜底：如 1.9999 会算出 1000，须夹回 999，否则格式非法解析为 null
  const ms = Math.min(999, Math.round((v - Math.floor(v)) * 1000));
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
function parseTime(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

// immediate：父组件 v-if + 同 tick 置 true，首次挂载时 model 已是 true，watch 不会触发，须立即拉一次
watch(model, async (visible) => {
  if (!visible || !props.jobId) return;
  loading.value = true;
  rows.value = [];
  corrected.value = false;
  correctedCount.value = null;
  // 该草稿已有在跑的智能校正任务（上次弹窗关闭后仍在后台执行）：挂回等待态，锁定编辑
  const running = jobsStore.items.find(
    (j) => j.type === 'subtitle_correct' && String(j.ref_id) === String(props.jobId)
      && (j.status === 'pending' || j.status === 'running'),
  );
  correctJobId.value = running?.id || null;
  try {
    const data = await videoApi.subtitleSegments(props.jobId);
    applySegments(data.segments);
    applyCorrectState(data);
  } catch (err) {
    ElMessage.error(err?.message || t('episode.videos.editorLoadFail'));
  } finally {
    loading.value = false;
  }
  resetRows();
}, { immediate: true });

function resetRows() {
  rows.value = initial.value.map((s) => ({ start: s.start, end: s.end, startStr: fmtTime(s.start), endStr: fmtTime(s.end), text: s.text }));
}

// 失焦解析时间：非法则提示并回退为当前值
function commitTime(row, field) {
  const parsed = parseTime(row[`${field}Str`]);
  if (parsed === null) {
    ElMessage.warning(t('episode.videos.invalidTime'));
    row[`${field}Str`] = fmtTime(row[field]);
    return;
  }
  row[field] = parsed;
  row[`${field}Str`] = fmtTime(parsed);
}

function seek(row) {
  const v = videoRef.value;
  if (!v) return;
  v.currentTime = Math.max(0, Number(row.start) || 0);
  v.play().catch(() => {});
}

function addRow() {
  const last = rows.value[rows.value.length - 1];
  const start = last ? Number(last.end) || 0 : 0;
  const row = { start, end: start + 1, text: '' };
  row.startStr = fmtTime(row.start);
  row.endStr = fmtTime(row.end);
  rows.value.push(row);
  nextTick(() => {
    const box = document.querySelector('.sub-rows');
    if (box) box.scrollTop = box.scrollHeight;
  });
}
function removeRow(i) { rows.value.splice(i, 1); }
function resetAll() { resetRows(); }

const validSegments = computed(() =>
  rows.value
    .filter((r) => r.text.trim() && parseTime(r.startStr) !== null && parseTime(r.endStr) !== null)
    .map((r) => ({ start: parseTime(r.startStr), end: parseTime(r.endStr), text: r.text.trim() }))
    .sort((a, b) => a.start - b.start),
);

// 有未保存的修改：当前行与写入基准（草稿载入/保存回写/校正回填）不一致即视为脏
// （时间毫秒级容差比较，滤掉 fmt/parse 往返的浮点噪声；清空台词的行会让条数不同，同样算脏）
const isDirty = computed(() => {
  const cur = validSegments.value;
  const base = initial.value;
  if (cur.length !== base.length) return true;
  return cur.some((s, i) =>
    Math.abs(s.start - base[i].start) >= 0.001
    || Math.abs(s.end - base[i].end) >= 0.001
    || s.text !== base[i].text);
});

// 取校验通过的段落（台词非空 + 时间码合法 + 开始早于结束），不通过则提示并返回 null
function collectSegments() {
  const segs = validSegments.value;
  if (!segs.length) { ElMessage.warning(t('episode.videos.editorEmpty')); return null; }
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].end <= segs[i].start) { ElMessage.warning(t('episode.videos.badRange', { n: i + 1 })); return null; }
  }
  return segs;
}

// 保存校对结果：服务端按「一行不超过屏宽可容纳汉字数」标准重新分段并回写草稿，用返回结果刷新编辑器
async function save() {
  const segs = collectSegments();
  if (!segs) return;
  saving.value = true;
  try {
    const data = await videoApi.saveSubtitleSegments(props.jobId, segs);
    applySegments(data.segments);
    resetRows();
    ElMessage.success(t('episode.videos.subSaved'));
  } catch (err) {
    ElMessage.error(err?.message || t('common.fail'));
  } finally {
    saving.value = false;
  }
}

// 智能校正：把当前段落（含未保存的校对）连同本集剧本交给文本大模型，逐条修正 ASR 听写错误
// （只小改、读音/字数相近、时间码不动）。统一「模型+价格」确认 → 异步任务；提交后进入等待态
// （显示任务进度，锁定编辑/保存/合成），终态由下方 watchEffect 统一处理，中途不下「未完成/失败」结论。
async function smartCorrect() {
  const segs = collectSegments();
  if (!segs) return;
  submitting.value = true;
  try {
    const job = await runJob({
      modelType: 'text',
      estimateFor: (sel) => videoApi.subtitleCorrectEstimate(props.jobId, sel),
      createFor: (sel) => videoApi.correctSubtitle(props.jobId, segs, sel),
      title: t('episode.videos.correctTitle'),
      desc: t('episode.videos.correctDesc'),
      confirmText: t('episode.videos.correctConfirm'),
    });
    if (job) correctJobId.value = job.id; // 用户在确认弹窗取消则不进入等待态
  } catch (err) {
    // 维护 503 已由 http 层统一弹「维护中」提示（限频），这里不再重复报错
    if (!err?.maintenance) ElMessage.error(err?.message || t('common.fail'));
  } finally {
    submitting.value = false;
  }
}

// 校正任务到达终态：成功 → 拉最新草稿刷新编辑器并提示「校正完成」；失败 → 报错；取消 → 静默解锁。
// watchEffect 按状态驱动（非边沿触发），任务列表轮询竞态丢行/补回也不会漏判或重复处理。
watchEffect(() => {
  const job = correctJob.value;
  if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
  correctJobId.value = null; // 先清等待态解锁，再异步处理回填
  void finishCorrect(job);
});

async function finishCorrect(job) {
  if (job.status === 'succeeded') {
    try {
      const data = await videoApi.subtitleSegments(props.jobId);
      applySegments(data.segments);
      applyCorrectState(data);
      resetRows();
    } catch { /* 草稿拉取失败保持原稿，错误提示由 http 层统一处理 */ }
    const n = Number(job.result?.subtitle?.changed_count) || 0;
    if (n > 0) ElMessage.success(t('episode.videos.correctDone', { n }));
    else ElMessage.info(t('episode.videos.correctNone'));
  } else if (job.status === 'failed') {
    ElMessage.error(job.error || t('common.fail'));
  }
}

async function burn() {
  const segs = collectSegments();
  if (!segs) return;
  await ElMessageBox.confirm(t('episode.videos.burnConfirm'), t('common.tip'), { type: 'info' });
  burning.value = true;
  try {
    // 有未保存的修改先静默自动保存（服务端按行宽标准重分段并回写草稿），再提交合成
    let toBurn = segs;
    if (isDirty.value) {
      const saved = await videoApi.saveSubtitleSegments(props.jobId, segs);
      applySegments(saved.segments);
      resetRows();
      toBurn = saved.segments;
    }
    const data = await videoApi.burnSubtitle(props.jobId, toBurn);
    jobsStore.track(data.job); // 立即进任务中心：角标计数 + 启动轮询（完成 toast / 状态跃迁靠它驱动）
    ElMessage.success(t('episode.videos.burnSubmitted'));
    model.value = false;
    emit('done');
  } catch (err) {
    ElMessage.error(err?.message || t('common.fail'));
  } finally {
    burning.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="model" :title="t('episode.videos.editorTitle')" width="min(860px, 94vw)" top="6vh" append-to-body destroy-on-close>
    <div v-loading="loading" class="sub-editor">
      <div v-if="videoUrl" class="sub-preview">
        <video ref="videoRef" :src="videoUrl" controls preload="metadata" playsinline />
      </div>
      <div class="sub-hint">{{ t('episode.videos.editorHint') }}</div>
      <div class="sub-hint">{{ t('episode.videos.segRule') }}</div>
      <div v-if="readonly" class="sub-readonly">{{ t('team.readonlySubtitle') }}</div>
      <div v-if="correcting" class="sub-correcting-box">
        <div class="sub-correcting-line">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ t('episode.videos.correctRunning') }}</span>
        </div>
        <el-progress :percentage="Math.min(100, Math.max(0, Number(correctJob?.progress) || 0))" :stroke-width="8" />
        <div v-if="correctJob?.stage" class="sub-correcting-stage">{{ correctJob.stage }}</div>
      </div>
      <div class="sub-rows">
        <div v-for="(r, i) in rows" :key="i" class="sub-row ad-card">
          <button class="sub-seek" :title="t('episode.videos.seekTo')" @click="seek(r)">{{ i + 1 }}</button>
          <div class="sub-times">
            <input v-model="r.startStr" class="sub-time" :disabled="locked" @blur="commitTime(r, 'start')" />
            <span class="sub-arrow">→</span>
            <input v-model="r.endStr" class="sub-time" :disabled="locked" @blur="commitTime(r, 'end')" />
          </div>
          <el-input v-model="r.text" type="textarea" :rows="2" resize="none" :disabled="locked" :placeholder="t('episode.videos.colText')" />
          <el-button text type="danger" class="sub-del" :disabled="locked" @click="removeRow(i)"><el-icon><Delete /></el-icon></el-button>
        </div>
        <div v-if="!rows.length && !loading" class="sub-empty">{{ t('episode.videos.editorEmpty') }}</div>
      </div>
    </div>
    <!-- 项目全局字幕样式：烧录前可调整字体/字号/底距（对本项目所有分集生效） -->
    <SubtitleSettingsDialog
      v-model="styleVisible"
      :project-id="projectId"
      :aspect-ratio="aspectRatio"
      :subtitle="subtitle"
      @updated="emit('styleUpdated')"
    />
    <template #footer>
      <div class="sub-footer">
        <div class="sub-footer-left">
          <el-button v-if="projectId && !readonly" size="small" :disabled="locked" @click="styleVisible = true">{{ t('project.subtitleSettings.title') }}</el-button>
          <el-button v-if="!readonly" size="small" :disabled="locked" @click="addRow"><el-icon><Plus /></el-icon> {{ t('episode.videos.addSeg') }}</el-button>
          <el-button v-if="!readonly" size="small" :disabled="locked" @click="resetAll">{{ t('episode.videos.reset') }}</el-button>
          <el-button v-if="!readonly" size="small" type="primary" plain :disabled="locked" :loading="submitting" @click="smartCorrect"><el-icon><MagicStick /></el-icon> {{ t('episode.videos.correct') }}</el-button>
          <!-- 校正状态徽标：提示该草稿是否已跑过智能校正（手动编辑不清除）；等待态由上方进度框展示，此处置空 -->
          <el-tag
            v-if="!correcting"
            class="sub-correct-state"
            :type="corrected ? 'success' : 'info'"
            size="small"
            :title="corrected && correctedCount != null ? t('episode.videos.correctStateTip', { n: correctedCount }) : undefined"
          >{{ t(corrected ? 'episode.videos.correctStateDone' : 'episode.videos.correctStateNone') }}</el-tag>
        </div>
        <el-button @click="model = false">{{ t('common.close') }}</el-button>
        <el-button v-if="!readonly" type="primary" plain :disabled="burning || locked" :loading="saving" @click="save">{{ t('episode.videos.saveSub') }}</el-button>
        <el-button v-if="!readonly" type="primary" class="btn-ink" :disabled="saving || locked" :loading="burning" @click="burn">{{ t('episode.videos.burn') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.sub-editor { display: flex; flex-direction: column; gap: 10px; }
.sub-preview { background: #000; border-radius: 10px; overflow: hidden; }
.sub-preview video { display: block; width: 100%; max-height: 42vh; }
.sub-hint { font-size: 12px; color: var(--ad-text-muted); }
/* 只读模式提示条（团队共享：无成片管理权限） */
.sub-readonly { padding: 8px 12px; font-size: 13px; border-radius: 8px; color: var(--ad-warning); background: rgba(251, 191, 36, 0.14); border: 1px solid color-mix(in srgb, var(--ad-warning) 40%, transparent); }
/* 智能校正等待框：进度条 + 服务端阶段文案（排队中 / AI 校正台词… / 写回字幕草稿…） */
.sub-correcting-box { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--ad-brand); border-radius: 8px; background: var(--ad-bg-soft); }
.sub-correcting-line { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ad-brand); }
.sub-correcting-stage { font-size: 12px; color: var(--ad-text-muted); }
.sub-rows { display: flex; flex-direction: column; gap: 8px; max-height: 40vh; overflow-y: auto; padding-right: 2px; }
.sub-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; }
.sub-seek { flex-shrink: 0; width: 30px; height: 30px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--ad-brand-contrast); background: var(--ad-brand); }
.sub-seek:hover { opacity: 0.85; }
.sub-times { flex-shrink: 0; display: flex; align-items: center; gap: 4px; padding-top: 3px; }
.sub-time { width: 104px; padding: 5px 6px; font-size: 12px; font-variant-numeric: tabular-nums; border: 1px solid var(--ad-border); border-radius: 6px; outline: none; }
.sub-time:focus { border-color: var(--ad-brand); }
.sub-arrow { color: var(--ad-text-muted); font-size: 12px; }
.sub-row :deep(.el-textarea) { flex: 1; }
.sub-del { flex-shrink: 0; margin-top: 2px; }
.sub-empty { text-align: center; color: var(--ad-text-muted); padding: 24px 0; font-size: 13px; }
.sub-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.sub-footer-left { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-right: auto; }
.sub-correct-state { flex-shrink: 0; }
@media (max-width: 768px) {
  .sub-row { flex-wrap: wrap; }
  .sub-row :deep(.el-textarea) { flex-basis: 100%; order: 3; }
  .sub-times { padding-top: 0; }
}
</style>
