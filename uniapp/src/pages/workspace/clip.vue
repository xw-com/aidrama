<script setup>
/**
 * 成片在线剪辑（满页 · 剪映式移动端 UX）· 自 client/src/views/VideoEditorView.vue 引擎移植。
 * 布局（竖排）：预览舞台（恒暗，tap 播放暂停）→ 播放条 → 时间轴（横向拖拽、固定中央播放头、
 * 段块两端拖拽裁剪）→ 选中段检查器（入/出点秒输入 + 前移/后移）→ 底部操作栏（分割/删除/重置/导出）。
 *
 * 段模型（同桌面端）：segments=[{id,startMs,endMs}] 源时间轴毫秒、数组序=输出序；初始整段，
 * 分割（播放头处）是唯一的加段方式。契约同后端 /videos/:jobId/edit：越界 ≤50ms 收敛、
 * 段长 ≥0.2s、≤100 段；导出走 runJob（确认页 + 任务进度）。
 *
 * 跨端要点：
 *  - uni 无法读 video.currentTime：播放头由 @timeupdate（真值锚点）+ 播放中 setInterval 插值驱动；
 *    paused 由 play/pause 事件镜像（play/share.vue 同款）。
 *  - 段尾跳段提前量 120ms（timeupdate 粒度 ~250ms，桌面 rAF 的 40ms 会越界出声）。
 *  - 时间轴 = scroll-view 横向滚动 + 固定居中播放头：content 左右各留半屏内边距，
 *    使 scrollLeft === 播放头输出像素；syncLane 是唯一回写口（手指按下/微位移/限频不写），
 *    写入记回声，@scroll 事件在回声窗口内丢弃——防「滚动↔播放头」反馈环。
 *  - 几何两条铁律（踩过坑）：① 轨道/标尺按输出域 totalMs 定长（裁剪重叠后 totalMs 可超源时长，
 *    按源时长定长会让红线到尾钳住、拖到底时间码到不了末尾）；② 时间原点必须用 in-flow
 *    margin-left: halfW 实现——ruler/track 若用 absolute，定位基准是 padding box 边缘，
 *    content 的 padding-left 推不动它们（实测偏移半屏），只有 in-flow margin 对谁都能生效。
 *  - 裁剪手柄 @touchmove.stop.prevent 压住原生滚动（catchtouchmove）；绝对位移换算毫秒，无累积漂移。
 *  - 鸿蒙/微信端无 rAF/ResizeObserver 依赖；不请求全屏（鸿蒙全屏强制横屏）；导航不包 setTimeout。
 *  - H5 返回守卫：页面级 pushState/popstate（video-player-popup 同款上提）；App/鸿蒙走 useBackGuard。
 *  - jobs 轮询是全局 store，本页卸载时不得停止。
 */
import { ref, computed, watch, getCurrentInstance, onMounted, onBeforeUnmount } from 'vue';
import { onLoad, onReady, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { videoApi } from '../../api';
import { useJobsStore } from '../../stores/jobs';
import { useThemeStore } from '../../stores/theme';
import { useCostAction } from '../../composables/useCostAction';
import { useBackGuard } from '../../composables/useBackGuard';
import { toAbsolute } from '../../utils/media';
import { formatTimecode } from '../../utils/format';
import { windowWidth } from '../../utils/system';
import { toast, confirm } from '../../utils/ui';
import { saveVideo } from '../../utils/download';
import { backToParent } from '../../utils/back';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import AdDownloadDialog from '../../components/ad-download-dialog/ad-download-dialog.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';

// ---------- 0. 常量 ----------
const MIN_SEG_MS = 200; // 最短段长（与服务端一致）
const JUMP_EPS_MS = 120; // 段尾跳段提前量（timeupdate 粒度兜底，见头注释）
const HISTORY_LIMIT = 50; // undo 栈深
const MIN_PX_PER_SEC = 8; // 时间轴最小密度（px/s）：超屏源自动出横向滚动
const MAX_SEGS = 100; // 服务端上限
const LOOP_STEP = 70; // 播放头插值步长（ms；setInterval 全端安全）
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]; // 秒，取首个 ≥56px 的档
const COMPOSE_RESOLUTIONS = ['480p', '720p', '768p', '1080p', '2K', '4K']; // 与合成/后端 EDIT_RESOLUTIONS 同源
const CLIP_RES_KEY = 'ad_clip_res'; // 与旧剪辑弹层同 key：用户上次档位无缝延续
const VID = 'clip-video';

const { t } = useI18n();
const jobs = useJobsStore();
const theme = useThemeStore();
const { runJob } = useCostAction();
const instance = getCurrentInstance();

// ---------- 1. 源 ----------
const loading = ref(true);
const loadError = ref('');
const source = ref(null);
let srcJobId = '';
let initialSnap = '';
let pendingSeek = null;
let laneLeft = 0; // 时间轴视口左缘（tap→ms 换算基准）

const readonly = computed(() => !!source.value && !source.value.can_edit);
const srcUrl = computed(() => toAbsolute(source.value?.video_url || ''));
const srcDurationMs = computed(() => Math.round((Number(source.value?.duration) || 0) * 1000));

// ---------- 2. 段模型 + undo/redo（桌面 L60-115 移植） ----------
let nextSegId = 1;
const segments = ref([]); // [{id, startMs, endMs}] 源时间轴、保序
const selectedId = ref(null);

const segDur = (s) => s.endMs - s.startMs;
const totalMs = computed(() => segments.value.reduce((n, s) => n + segDur(s), 0));
const offsetsMs = computed(() => { // 每段在输出域的起点
  const out = []; let acc = 0;
  for (const s of segments.value) { out.push(acc); acc += segDur(s); }
  return out;
});
const selectedSeg = computed(() => segments.value.find((s) => s.id === selectedId.value) || null);
const selIndex = computed(() => segments.value.findIndex((s) => s.id === selectedId.value));

function snapshot() {
  return JSON.stringify(segments.value.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
}
const undoStack = [];
const redoStack = [];
const dirty = ref(false);
const historyTick = ref(0); // 栈是命令式数组，computed 感知不到，用计数驱动可用态
function commitPre(pre) { // 一次编辑结束（含拖拽收尾）后入栈：pre = 变更前快照
  if (snapshot() === pre) return;
  undoStack.push(pre);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  dirty.value = snapshot() !== initialSnap; // 撤光也不是干净态以外的判定：与初始结构比对
  historyTick.value++;
}
function mutate(fn) { // 即时编辑操作统一入口：自动记录历史
  const pre = snapshot();
  fn();
  commitPre(pre);
}
function restore(json) {
  segments.value = JSON.parse(json);
  if (!segments.value.some((s) => s.id === selectedId.value)) selectedId.value = segments.value[0]?.id ?? null;
  activeIndex.value = Math.min(activeIndex.value, Math.max(0, segments.value.length - 1));
  inspectorEcho();
  resyncAfterStructureChange();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  dirty.value = snapshot() !== initialSnap;
  historyTick.value++;
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  dirty.value = snapshot() !== initialSnap;
  historyTick.value++;
}
const canUndo = computed(() => { void historyTick.value; return undoStack.length > 0 && !readonly.value; });
const canRedo = computed(() => { void historyTick.value; return redoStack.length > 0 && !readonly.value; });

// ---------- 3. 时间映射：输出域 → 源域（桌面 L119-132 原样） ----------
function outputToSource(outMs) {
  const segs = segments.value;
  if (!segs.length) return { i: -1, sourceMs: 0 };
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const d = segDur(segs[i]);
    if (outMs < acc + d || i === segs.length - 1) {
      const local = Math.min(Math.max(outMs - acc, 0), d);
      return { i, sourceMs: segs[i].startMs + local };
    }
    acc += d;
  }
  return { i: segs.length - 1, sourceMs: segs[segs.length - 1].endMs };
}

// ---------- 4. 播放引擎（桌面 tick 逻辑，时间源换 @timeupdate + 插值） ----------
const isPlaying = ref(false);
const playheadMs = ref(0);
const activeIndex = ref(0); // 视频元素当前所处的段下标
const metaReady = ref(false);
let loop = null;
let lastSeekAt = 0;

function ctx() {
  try { return uni.createVideoContext(VID, instance); } catch (e) { return null; }
}
function seekSource(ms) {
  if (!metaReady.value) { pendingSeek = ms; return; } // 元数据就绪前 mp 端忽略 seek，先记账
  try { ctx()?.seek(Math.max(0, ms / 1000)); } catch (e) { /* ignore */ }
}
function seekOutput(outMs, opts = {}) { // 定位唯一入口：点轴/拖播放头/段跳/结构重锚
  playheadMs.value = Math.min(Math.max(outMs, 0), totalMs.value);
  const { i, sourceMs } = outputToSource(playheadMs.value);
  activeIndex.value = i;
  seekSource(sourceMs);
  if (opts.center !== false) syncLane(!!opts.force);
}
function resyncAfterStructureChange() { // 结构变化后：播放头按输出位置重锚到新结构
  seekOutput(Math.min(playheadMs.value, totalMs.value));
}
function engineAdvance(curMs) { // 真值驱动（timeupdate）：跳段/锚定播放头
  const seg = segments.value[activeIndex.value];
  if (!seg) { pausePlayback(); return; }
  if (curMs >= seg.endMs - JUMP_EPS_MS) {
    if (activeIndex.value < segments.value.length - 1) {
      activeIndex.value += 1;
      const nx = segments.value[activeIndex.value];
      seekSource(nx.startMs);
      playheadMs.value = offsetsMs.value[activeIndex.value];
      syncLane(true);
    } else {
      playheadMs.value = totalMs.value;
      pausePlayback();
    }
  } else {
    playheadMs.value = offsetsMs.value[activeIndex.value] + Math.max(0, curMs - seg.startMs);
    syncLane();
  }
}
function onTimeUpdate(e) {
  if (!isPlaying.value) return;
  const curMs = (Number(e?.detail?.currentTime) || 0) * 1000;
  if (curMs > 0 || activeIndex.value === 0) engineAdvance(curMs);
}
function startLoop() { // 插值：timeupdate 间隙平滑播放头（真值每次事件重锚，漂移不累积）
  stopLoop();
  loop = setInterval(() => {
    const seg = segments.value[activeIndex.value];
    if (!seg) { stopLoop(); return; }
    const cap = offsetsMs.value[activeIndex.value] + segDur(seg) - JUMP_EPS_MS;
    playheadMs.value = Math.min(playheadMs.value + LOOP_STEP, Math.max(cap, offsetsMs.value[activeIndex.value]));
    syncLane();
  }, LOOP_STEP);
}
function stopLoop() {
  if (loop) { clearInterval(loop); loop = null; }
}
function playPlayback() {
  if (playheadMs.value >= totalMs.value - 1) seekOutput(0, { force: true }); // 播完再按：从头来
  const { i, sourceMs } = outputToSource(playheadMs.value);
  activeIndex.value = i;
  seekSource(sourceMs);
  try { ctx()?.play(); } catch (e) { /* ignore */ }
  isPlaying.value = true; // 事件镜像兜底（iOS 要求 tap 同步栈起播，状态先行）
  startLoop();
}
function pausePlayback() {
  try { ctx()?.pause(); } catch (e) { /* ignore */ }
  isPlaying.value = false;
  stopLoop();
}
function togglePlay() { if (isPlaying.value) pausePlayback(); else playPlayback(); }
function onPlayEvt() { if (!isPlaying.value) { isPlaying.value = true; startLoop(); } }
function onPauseEvt() { isPlaying.value = false; stopLoop(); }
function onVideoEnded() { // 兜底：末段源尾恰好触达视频真实结尾、timeupdate 不再推进
  onPauseEvt();
  if (activeIndex.value < segments.value.length - 1) {
    activeIndex.value += 1;
    const nx = segments.value[activeIndex.value];
    seekSource(nx.startMs);
    playheadMs.value = offsetsMs.value[activeIndex.value];
    syncLane(true);
    // 此处 isPlaying 已被 onPauseEvt 置 false，直接接播下一段
    try { ctx()?.play(); } catch (e) { /* ignore */ }
  } else {
    playheadMs.value = totalMs.value;
  }
}
function onVideoError() {
  onPauseEvt();
  toast(t('editor.loadFail'));
}
function onLoadedMetadata(e) {
  metaReady.value = true;
  const real = Math.round((Number(e?.detail?.duration) || 0) * 1000);
  // 元数据时长与接口不符（转码尾差等）：钳住末段，防越界源 seek
  if (real > 0 && Math.abs(real - srcDurationMs.value) > 1500) {
    for (const s of segments.value) {
      if (s.endMs > real) s.endMs = real;
      if (s.startMs > real) s.startMs = Math.max(0, real - MIN_SEG_MS);
    }
  }
  if (pendingSeek != null) {
    try { ctx()?.seek(Math.max(0, pendingSeek / 1000)); } catch (e2) { /* ignore */ }
    pendingSeek = null;
  }
}
function gotoSegment(dir) { // 上/下一段（以播放头所在段为基准）
  const i = Math.min(Math.max(activeIndex.value + dir, 0), segments.value.length - 1);
  activeIndex.value = i;
  seekOutput(offsetsMs.value[i], { force: true });
}

// ---------- 5. 时间轴几何 + 滚动↔播放头同步 ----------
const laneW = ref(windowWidth());
const laneScroll = ref(0);
const laneDragging = ref(false);
let echoX = -1; // 最近一次程序写入的 scroll-left（吞 @scroll 回声）
let echoAt = 0;
let lastWriteAt = 0;
let lastScrubSeekAt = 0;

const msToX = (ms) => ms * pxPerMs.value;
const pxPerMs = computed(() => Math.max(laneW.value / Math.max(srcDurationMs.value, 1), MIN_PX_PER_SEC / 1000));
const halfW = computed(() => Math.floor(laneW.value / 2));
const trackW = computed(() => Math.ceil(Math.max(totalMs.value, 1) * pxPerMs.value)); // 输出域定长（重叠裁剪后可超源时长）
const contentW = computed(() => trackW.value + laneW.value); // halfW(margin) + trackW + 右侧余量 → maxScrollLeft === trackW
const maxScroll = computed(() => trackW.value);
const rulerStepMs = computed(() => {
  for (const s of RULER_STEPS) if (s * 1000 * pxPerMs.value >= 56) return s * 1000;
  return 600000;
});
const rulerTicks = computed(() => { // v-for 只遍历数组（各端一致）；输出域 0..totalMs，与段块/播放头同域
  let step = rulerStepMs.value;
  while (totalMs.value / step > 90) step *= 2;
  const out = [];
  for (let m = 0; m <= totalMs.value; m += step) out.push(m);
  return out;
});
function fmtRuler(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return String(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function syncLane(force = false) { // 播放头 → scroll-left（唯一写入口）
  if (laneDragging.value) return; // 手指在轴上：绝不写 prop（防打架）
  const target = Math.min(Math.max(msToX(playheadMs.value), 0), maxScroll.value);
  if (!force && Math.abs(target - laneScroll.value) < 1.5) return; // 无位移不 setData
  const now = Date.now();
  if (!force && now - lastWriteAt < 120) return; // 播放中限频（mp 端 setData 有成本）
  lastWriteAt = now;
  echoX = target; echoAt = now; // 记回声
  laneScroll.value = target;
}
function onLaneScroll(e) { // 用户拖轴 → 播放头跟随（只改模型；seek 节流防 mp 卡顿）
  const x = Number(e?.detail?.scrollLeft) || 0;
  if (echoX >= 0 && Math.abs(x - echoX) < 2 && Date.now() - echoAt < 320) return; // 程序滚动回声
  echoX = -1;
  laneScroll.value = x;
  const outMs = Math.min(Math.max(x / pxPerMs.value, 0), totalMs.value);
  playheadMs.value = outMs;
  const now = Date.now();
  if (now - lastScrubSeekAt >= 120) { // 拖动中预览帧节流；松手后由 touchend 精确 seek
    lastScrubSeekAt = now;
    const { i, sourceMs } = outputToSource(outMs);
    activeIndex.value = i;
    seekSource(sourceMs);
  }
}
function onLaneTouchEnd() {
  if (!laneDragging.value) return;
  laneDragging.value = false;
  const { i, sourceMs } = outputToSource(playheadMs.value); // 松手：精确重锚一帧
  activeIndex.value = i;
  seekSource(sourceMs);
}
function outMsFromClientX(clientX) { // 视口坐标 → 轨道毫秒：+scrollLeft 越过左半屏内边距
  return Math.max(0, (clientX - laneLeft - halfW.value + laneScroll.value) / pxPerMs.value);
}
function onTrackTap(e) { // 空白轨道/标尺：定位到点按处（点段块走 selectSeg，.stop 隔开）
  const x = (e?.detail && e.detail.x != null) ? e.detail.x
    : (e?.changedTouches?.[0]?.clientX ?? e?.touches?.[0]?.clientX ?? e?.clientX ?? e?.pageX ?? 0);
  pausePlayback();
  seekOutput(outMsFromClientX(x), { force: true });
}
function selectSeg(seg) { // 点段：选中 + 播放头跳到该段输出起点
  selectedId.value = seg.id;
  const i = segments.value.findIndex((s) => s.id === seg.id);
  pausePlayback();
  seekOutput(offsetsMs.value[i], { force: true });
}

// ---------- 6. 裁剪手势（段两端拖拽；无邻段耦合——源域可重叠可调序，同桌面） ----------
let trim = null; // { id, side:'L'|'R', x0, pre, s0, e0 }
const trimActive = ref(false);
function onTrimStart(e, seg, side) {
  if (readonly.value || !seg) return;
  pausePlayback();
  selectedId.value = seg.id;
  trim = {
    id: seg.id, side,
    x0: (e?.touches && e.touches[0] && e.touches[0].clientX) || 0,
    pre: snapshot(), s0: seg.startMs, e0: seg.endMs,
  };
  trimActive.value = true;
}
function onTrimMove(e) {
  if (!trim) return;
  const seg = segments.value.find((s) => s.id === trim.id);
  if (!seg) return;
  const cx = (e?.touches && e.touches[0] && e.touches[0].clientX) || 0;
  const dMs = Math.round((cx - trim.x0) / pxPerMs.value); // 绝对位移 → 毫秒（无累积漂移）
  if (trim.side === 'L') seg.startMs = Math.round(Math.min(Math.max(trim.s0 + dMs, 0), trim.e0 - MIN_SEG_MS));
  else seg.endMs = Math.round(Math.min(Math.max(trim.e0 + dMs, trim.s0 + MIN_SEG_MS), srcDurationMs.value));
  inspectorEcho();
}
function onTrimEnd() {
  if (!trim) return;
  commitPre(trim.pre);
  trim = null;
  trimActive.value = false;
  resyncAfterStructureChange();
}

// ---------- 7. 编辑操作（桌面 L457-525 移植） ----------
function splitAtPlayhead() { // 分割是唯一加段方式
  if (readonly.value || !segments.value.length) return;
  if (segments.value.length >= MAX_SEGS) { toast(t('editor.m.maxSegs', { n: MAX_SEGS })); return; }
  const { i, sourceMs } = outputToSource(playheadMs.value);
  const seg = segments.value[i];
  if (!seg) return;
  const local = sourceMs - seg.startMs;
  if (local < MIN_SEG_MS || segDur(seg) - local < MIN_SEG_MS) {
    toast(t('editor.splitShort'));
    return;
  }
  const cut = Math.round(seg.startMs + local);
  mutate(() => {
    const at = segments.value.findIndex((s) => s.id === seg.id);
    const right = { id: nextSegId++, startMs: cut, endMs: seg.endMs };
    seg.endMs = cut;
    segments.value.splice(at + 1, 0, right);
    selectedId.value = right.id;
  });
}
function deleteSelected() {
  const seg = selectedSeg.value;
  if (!seg) { toast(t('editor.inspector.empty')); return; }
  if (segments.value.length <= 1) { toast(t('editor.atLeastOne')); return; }
  pausePlayback();
  const at = segments.value.findIndex((s) => s.id === seg.id);
  mutate(() => { segments.value.splice(at, 1); });
  selectedId.value = segments.value[Math.min(at, segments.value.length - 1)]?.id ?? null;
  resyncAfterStructureChange();
}
function moveSelected(dir) { // 前移/后移（触屏拖拽调序的后备交互）
  const seg = selectedSeg.value;
  if (!seg || readonly.value) return;
  const i = segments.value.findIndex((s) => s.id === seg.id);
  const j = i + dir;
  if (j < 0 || j >= segments.value.length) return;
  pausePlayback();
  mutate(() => {
    const rows = segments.value.slice();
    [rows[i], rows[j]] = [rows[j], rows[i]];
    segments.value = rows;
  });
  resyncAfterStructureChange();
}
async function resetAll() {
  if (readonly.value) return;
  const ok = await confirm({
    title: t('editor.reset'),
    content: t('editor.resetConfirm'),
    confirmText: t('common.ok'),
    cancelText: t('common.cancel'),
  });
  if (!ok) return;
  pausePlayback();
  const pre = snapshot();
  segments.value = [{ id: nextSegId++, startMs: 0, endMs: srcDurationMs.value }];
  selectedId.value = segments.value[0].id;
  undoStack.length = 0; redoStack.length = 0;
  dirty.value = false;
  historyTick.value++;
  initialSnap = snapshot();
  inspectorEcho();
  resyncAfterStructureChange();
}

// 检查器：入/出点秒输入（失焦提交、非法回显；秒 2 位与旧弹层交互一致）
const inStr = ref('');
const outStr = ref('');
const secStr = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(2);
function inspectorEcho() {
  const s = selectedSeg.value;
  if (!s) return;
  inStr.value = secStr(s.startMs);
  outStr.value = secStr(s.endMs);
}
watch(selectedSeg, () => inspectorEcho());
function commitInspector(field, e) {
  const seg = selectedSeg.value;
  if (!seg || readonly.value) return;
  const raw = String(e?.detail?.value ?? '').trim();
  const v = Number(raw);
  const ms = Math.round(v * 1000);
  const bad = raw === '' || !Number.isFinite(v) || ms < 0 || ms > srcDurationMs.value
    || (field === 'in' ? ms > seg.endMs - MIN_SEG_MS : ms < seg.startMs + MIN_SEG_MS);
  if (bad) { toast(t('editor.m.badPoint')); inspectorEcho(); return; }
  mutate(() => { if (field === 'in') seg.startMs = ms; else seg.endMs = ms; });
  inspectorEcho();
  resyncAfterStructureChange();
}

// ---------- 8. 导出（runJob 契约同旧弹层/桌面） ----------
let savedRes = '';
try { savedRes = uni.getStorageSync(CLIP_RES_KEY) || ''; } catch (e) { savedRes = ''; }
if (!COMPOSE_RESOLUTIONS.includes(savedRes)) savedRes = '';
const exportRes = ref(savedRes);
const doneInfo = ref(null);
const doneShow = ref(false);

// 本页在途导出 Job（ref_id = 源成片 jobId）
const exportJob = computed(() => jobs.items.find((j) => j.type === 'video_edit'
  && String(j.ref_id) === srcJobId && (j.status === 'pending' || j.status === 'running')));
const exportDisabled = computed(() => readonly.value || !!exportJob.value || totalMs.value <= 0);

async function openExport() {
  if (exportDisabled.value) return;
  const res = exportRes.value || '720p';
  await runJob({
    resolutionOptions: COMPOSE_RESOLUTIONS, // 与合成同档位（后端 EDIT_RESOLUTIONS 同 casing 同系数）
    resolutionHint: t('editor.export.resolutionHint'),
    selection: { resolution: res },
    estimateFor: (sel) => videoApi.editEstimate(srcJobId, sel.resolution, Math.max(1, Math.round(totalMs.value / 1000))),
    createFor: (sel) => videoApi.exportEdit(srcJobId, {
      resolution: sel.resolution,
      segments: segments.value.map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) })),
    }),
    onConfirm: (sel) => {
      exportRes.value = sel.resolution;
      try { uni.setStorageSync(CLIP_RES_KEY, sel.resolution); } catch (e) { /* 存储不可用 */ }
    },
    title: t('editor.export.confirmTitle'),
    desc: t('editor.export.confirmDesc', { n: segments.value.length, res }),
    confirmText: t('editor.export.confirm'),
    onDone: onExportDone,
  });
}
function onExportDone(j) {
  if (j.status === 'succeeded') {
    doneInfo.value = j.result?.edit || null;
    doneShow.value = true;
  }
  /* failed 的 toast 由 jobs store 统一播报，不重复 */
}
function saveDone() {
  const u = doneInfo.value?.video_url;
  if (!u) return;
  saveVideo(toAbsolute(u), `edit_${srcJobId}.mp4`, {
    loading: t('common.loading'),
    ok: t('editor.m.saved'),
    fail: t('editor.m.saveFail'),
    perm: t('editor.m.albumPerm'),
    tip: t('common.tip'),
    okBtn: t('common.ok'),
  });
}
function finishDone() {
  doneShow.value = false;
  dirty.value = false;
  backToParent();
}

// ---------- 9. 返回守卫（App/鸿蒙：useBackGuard；H5：页面级 pushState/popstate） ----------
function leaveNow() {
  dirty.value = false;
  backToParent(); // 不包 setTimeout（鸿蒙导航规则）
}
function beforeBack() {
  if (!dirty.value) return false;
  confirm({
    title: t('editor.m.discardTitle'),
    content: t('editor.m.discardBody'),
    confirmText: t('editor.m.leave'),
    cancelText: t('editor.m.stay'),
  }).then((ok) => { if (ok) leaveNow(); });
  return true; // 消费本次返回，等用户决断
}
useBackGuard(beforeBack);
/* #ifdef H5 */
let h5GuardOn = false;
function onH5Pop() {
  if (dirty.value) {
    history.pushState({ clipGuard: true }, ''); // 推回守卫记录，留在本页等决断
    confirm({
      title: t('editor.m.discardTitle'),
      content: t('editor.m.discardBody'),
      confirmText: t('editor.m.leave'),
      cancelText: t('editor.m.stay'),
    }).then((ok) => {
      if (ok) { dirty.value = false; history.back(); } // 再退一次：越过守卫记录回父级
    });
  } else {
    window.removeEventListener('popstate', onH5Pop);
    h5GuardOn = false;
    history.back(); // 刚才那次 back 只弹掉了守卫记录（URL 仍是本页），再退一次才是真正的离开
  }
}
onMounted(() => {
  history.pushState({ clipGuard: true }, '');
  h5GuardOn = true;
  window.addEventListener('popstate', onH5Pop);
});
onBeforeUnmount(() => {
  if (h5GuardOn) window.removeEventListener('popstate', onH5Pop);
});
/* #endif */

// ---------- 10. 生命周期 ----------
onLoad(async (q) => {
  srcJobId = String((q && (q.vid || q.job_id)) || '');
  if (!srcJobId) {
    loadError.value = t('editor.loadFail');
    loading.value = false;
    return;
  }
  try {
    const [src] = await Promise.all([videoApi.editSource(srcJobId), jobs.fetchAll()]); // 顺带挂回在途导出
    if (!src?.video_url || !(Number(src.duration) > 0)) throw new Error(t('editor.loadFail'));
    source.value = src;
    segments.value = [{ id: nextSegId++, startMs: 0, endMs: srcDurationMs.value }];
    selectedId.value = segments.value[0].id;
    initialSnap = snapshot();
    inspectorEcho();
    if (exportJob.value) jobs.registerOnDone(exportJob.value.id, onExportDone); // 重进页面接回在途导出
  } catch (e) {
    loadError.value = e?.message || t('editor.loadFail');
  } finally {
    loading.value = false;
  }
});
onReady(() => { // 实测时间轴视口（windowWidth 只是初值；页面固定不滚，client 坐标即页面坐标）
  uni.createSelectorQuery().select('.clip-scroll').boundingClientRect((r) => {
    if (r) {
      laneLeft = r.left || 0;
      laneW.value = r.width || laneW.value;
    }
  }).exec();
});
onShow(() => {
  jobs.fetchAll(); // 回页同步任务（在途导出进度/完成依赖它）
  if (exportJob.value) jobs.registerOnDone(exportJob.value.id, onExportDone);
});
onHide(() => { pausePlayback(); });
onUnload(() => { pausePlayback(); }); // jobs 轮询是全局 store，不停
</script>

<template>
  <view class="ad-page clip" :class="theme.rootCls">
    <AdNavbar :title="t('route.videoEditor')">
      <template #right>
        <view class="clip-top" :class="{ dis: !canUndo }" @tap="canUndo && undo()"><m-icon name="undo" :size="17" /></view>
        <view class="clip-top" :class="{ dis: !canRedo }" @tap="canRedo && redo()"><m-icon name="redo" :size="17" /></view>
      </template>
    </AdNavbar>

    <!-- 加载 / 失败 -->
    <view v-if="loadError" class="clip-state">
      <text class="clip-state-ic">⚠️</text>
      <text class="clip-state-t">{{ loadError }}</text>
      <view class="mbtn ghost sm" @tap="backToParent"><text>{{ t('editor.back') }}</text></view>
    </view>
    <view v-else-if="loading" class="clip-state"><text>{{ t('common.loading') }}</text></view>

    <template v-else>
      <!-- 只读横幅（无成片管理权限） -->
      <view v-if="readonly" class="clip-readonly"><text>{{ t('editor.readonlyBanner') }}</text></view>

      <!-- 预览舞台：恒暗；覆盖层固定影院色（主题例外，同 play/share 约定） -->
      <view class="clip-stage" @tap="togglePlay">
        <video
          :id="VID"
          class="clip-video"
          :src="srcUrl"
          :controls="false"
          :show-center-play-btn="false"
          :show-play-btn="false"
          :show-fullscreen-btn="false"
          :enable-progress-gesture="false"
          object-fit="contain"
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="onTimeUpdate"
          @play="onPlayEvt"
          @pause="onPauseEvt"
          @ended="onVideoEnded"
          @error="onVideoError"
        />
        <view v-if="!isPlaying" class="clip-stage-play"><m-icon name="play" :size="34" color="#fff" /></view>
        <view v-if="exportJob" class="clip-exporting">
          <view class="clip-bar"><view class="clip-bar-f" :style="{ width: (exportJob.progress || 0) + '%' }" /></view>
          <text class="clip-exporting-t">{{ exportJob.stage || t('editor.export.running') }}</text>
        </view>
      </view>

      <!-- 播放条 -->
      <view class="clip-pbar">
        <view class="clip-pbtn" :class="{ dis: activeIndex <= 0 }" @tap="activeIndex > 0 && gotoSegment(-1)"><m-icon name="left" :size="16" /></view>
        <view class="clip-pbtn main" @tap="togglePlay"><m-icon :name="isPlaying ? 'pause' : 'play'" :size="20" /></view>
        <view class="clip-pbtn" :class="{ dis: activeIndex >= segments.length - 1 }" @tap="activeIndex < segments.length - 1 && gotoSegment(1)"><m-icon name="right" :size="16" /></view>
        <text class="clip-time mono">{{ formatTimecode(playheadMs) }} / {{ formatTimecode(totalMs) }}</text>
      </view>

      <!-- 时间轴：固定居中播放头 + 拖轴 scrub + 段块两端裁剪 -->
      <view class="clip-tl">
        <view class="clip-tl-hint">
          <text class="clip-tl-hint-t">{{ t('editor.m.hint') }}</text>
          <text class="clip-tl-total">{{ t('editor.totalDuration') }} {{ formatTimecode(totalMs) }}</text>
        </view>
        <view class="clip-lane">
          <!-- 轨道背景条：整条横向凹槽（不随内容滚动）。段块按输出序背靠背铺满 trackW，
               挂在 track 上永远被盖住，故挂 lane 全宽；DOM 序在滚动内容之前，段块浮于其上 -->
          <view class="clip-rail" />
          <scroll-view
            class="clip-scroll"
            scroll-x
            :scroll-left="laneScroll"
            :scroll-with-animation="false"
            :show-scrollbar="false"
            @scroll="onLaneScroll"
            @touchstart="laneDragging = true"
            @touchend="onLaneTouchEnd"
            @touchcancel="onLaneTouchEnd"
          >
            <view class="clip-content" :style="{ width: contentW + 'px' }">
              <!-- 原点用 in-flow margin-left 定位（absolute 不吃 padding，见头注释）：margin 后的
                   右侧剩余宽 = laneW - halfW，恰好构成右半屏内边距，maxScrollLeft 仍 === trackW -->
              <view class="clip-ruler" :style="{ marginLeft: halfW + 'px', width: trackW + 'px' }" @tap="onTrackTap">
                <view v-for="m in rulerTicks" :key="m" class="clip-tick" :style="{ left: msToX(m) + 'px' }">
                  <view class="clip-tick-i" />
                  <text class="clip-tick-t">{{ fmtRuler(m) }}</text>
                </view>
              </view>
              <view class="clip-track" :style="{ marginLeft: halfW + 'px', width: trackW + 'px' }" @tap="onTrackTap">
                <view
                  v-for="(seg, i) in segments"
                  :key="seg.id"
                  class="clip-seg"
                  :class="{ on: seg.id === selectedId, ro: readonly }"
                  :style="{ left: msToX(offsetsMs[i]) + 'px', width: Math.max(6, segDur(seg) * pxPerMs) + 'px' }"
                  @tap.stop="selectSeg(seg)"
                >
                  <text class="clip-seg-no">{{ i + 1 }}</text>
                  <text class="clip-seg-dur">{{ formatTimecode(segDur(seg)) }}</text>
                  <template v-if="!readonly">
                    <view
                      class="clip-hd l"
                      @touchstart.stop.prevent="onTrimStart($event, seg, 'L')"
                      @touchmove.stop.prevent="onTrimMove"
                      @touchend.stop="onTrimEnd"
                      @touchcancel.stop="onTrimEnd"
                    ><view class="clip-hd-b" /></view>
                    <view
                      class="clip-hd r"
                      @touchstart.stop.prevent="onTrimStart($event, seg, 'R')"
                      @touchmove.stop.prevent="onTrimMove"
                      @touchend.stop="onTrimEnd"
                      @touchcancel.stop="onTrimEnd"
                    ><view class="clip-hd-b" /></view>
                  </template>
                </view>
              </view>
            </view>
          </scroll-view>
          <!-- 播放头：兄弟节点绝对居中，不拦截触摸（拖轴即拖播放头） -->
          <view class="clip-ph">
            <view class="clip-ph-cap" />
          </view>
        </view>
      </view>

      <!-- 检查器：选中段的入/出点 + 移序 -->
      <view v-if="selectedSeg" class="clip-ins">
        <text class="clip-ins-n">{{ t('editor.inspector.segN', { n: selIndex + 1 }) }}</text>
        <view class="clip-ins-f">
          <text class="clip-ins-l">{{ t('editor.inspector.inPoint') }}</text>
          <input class="clip-ins-in mono" type="digit" :value="inStr" :disabled="readonly" @blur="commitInspector('in', $event)" />
        </view>
        <view class="clip-ins-f">
          <text class="clip-ins-l">{{ t('editor.inspector.outPoint') }}</text>
          <input class="clip-ins-in mono" type="digit" :value="outStr" :disabled="readonly" @blur="commitInspector('out', $event)" />
        </view>
        <text class="clip-ins-d mono">{{ formatTimecode(segDur(selectedSeg)) }}</text>
        <view class="clip-op" :class="{ dis: selIndex <= 0 || readonly }" @tap="moveSelected(-1)"><m-icon name="up" :size="14" /></view>
        <view class="clip-op" :class="{ dis: selIndex >= segments.length - 1 || readonly }" @tap="moveSelected(1)"><m-icon name="down" :size="14" /></view>
      </view>
      <view v-else class="clip-ins empty"><text class="clip-ins-empty-t">{{ t('editor.inspector.empty') }}</text></view>

      <!-- 底部操作栏 -->
      <view class="clip-foot">
        <view class="clip-fbtn" :class="{ dis: readonly }" @tap="!readonly && splitAtPlayhead()">
          <m-icon name="cut" :size="17" /><text class="clip-fbtn-t">{{ t('editor.m.split') }}</text>
        </view>
        <view class="clip-fbtn" :class="{ dis: !selectedSeg || readonly || segments.length <= 1 }" @tap="!readonly && deleteSelected()">
          <m-icon name="trash" :size="17" /><text class="clip-fbtn-t">{{ t('editor.m.delSeg') }}</text>
        </view>
        <view class="clip-fbtn" :class="{ dis: readonly }" @tap="!readonly && resetAll()">
          <m-icon name="remake" :size="17" /><text class="clip-fbtn-t">{{ t('editor.m.reset') }}</text>
        </view>
        <view class="mbtn sm clip-export" :class="{ dis: exportDisabled }" @tap="!exportDisabled && openExport()">
          <text>{{ exportJob ? t('editor.export.runningShort') : t('editor.export.button') }}</text>
        </view>
      </view>
    </template>

    <!-- 导出完成面板 -->
    <AdSheet :show="doneShow" :title="t('editor.export.done')" @update:show="doneShow = $event">
      <view class="clip-done" v-if="doneInfo">
        <view class="clip-done-row">
          <text class="chip ok">{{ doneInfo.resolution || exportRes || '' }}</text>
          <text class="chip glass">{{ formatTimecode((Number(doneInfo.duration) || 0) * 1000) }}</text>
          <text class="chip glass">{{ t('editor.export.segCount', { n: doneInfo.segments_count || segments.length }) }}</text>
        </view>
        <view class="clip-done-acts">
          <view class="mbtn ghost" @tap="saveDone"><text>{{ t('editor.export.download') }}</text></view>
          <view class="mbtn" @tap="finishDone"><text>{{ t('editor.m.done') }}</text></view>
        </view>
      </view>
    </AdSheet>

    <!-- 统一「模型+价格」确认页（runJob 驱动，每页一份） -->
    <GenConfirmSheet />
    <!-- confirm() 主题化宿主（缺了会回退原生弹窗） -->
    <AdDialog />
    <!-- 导出成片保存进度条（utils/download.saveVideo 驱动） -->
    <AdDownloadDialog />
  </view>
</template>

<style scoped>
/* 满页固定布局：页面 disableScroll，根节点纵向 flex 撑满视口 */
.clip {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 导航栏右侧 undo/redo */
.clip-top {
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 10px;
  color: var(--ad-text-soft);
}
.clip-top.dis { opacity: 0.35; }

/* 加载 / 失败态 */
.clip-state {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px;
  color: var(--ad-text-soft);
  font-size: 14px;
}
.clip-state-ic { font-size: 40px; }

/* 只读横幅 */
.clip-readonly {
  padding: 7px 16px;
  font-size: 12px;
  color: var(--ad-brand);
  background: var(--ad-brand-soft);
  border-bottom: 1px solid var(--ad-line);
  text-align: center;
}

/* 预览舞台：恒暗（影院色为主题许可例外，同 play/share） */
.clip-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  background: #000;
}
.clip-video { width: 100%; height: 100%; }
.clip-stage-play {
  position: absolute; top: 50%; left: 50%;
  width: 64px; height: 64px;
  margin: -32px 0 0 -32px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  border: 1.5px solid rgba(255, 255, 255, 0.55);
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.clip-exporting {
  position: absolute; left: 14px; right: 14px; bottom: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.62);
  display: flex; flex-direction: column; gap: 7px;
  pointer-events: none;
}
.clip-exporting-t { color: #fff; font-size: 12px; }
.clip-bar { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.22); overflow: hidden; }
.clip-bar-f { height: 100%; border-radius: 999px; background: #e0b64e; }

/* 播放条 */
.clip-pbar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px;
  background: var(--ad-inset);
  border-top: 1px solid var(--ad-line);
}
.clip-pbtn {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  color: var(--ad-text);
  background: var(--ad-wbar-bg);
  border: 1px solid var(--ad-line);
}
.clip-pbtn.main { width: 42px; height: 42px; background: var(--ad-brand); border-color: var(--ad-brand); color: var(--ad-brand-contrast); }
.clip-pbtn.dis { opacity: 0.35; }
.clip-time {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--ad-text-soft);
}

/* 时间轴 */
.clip-tl {
  background: var(--ad-wbar-bg);
  border-top: 1px solid var(--ad-line);
}
.clip-tl-hint {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 7px 14px 0;
}
.clip-tl-hint-t { flex: 1; font-size: 11px; color: var(--ad-text-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clip-tl-total { font-size: 11px; color: var(--ad-text-soft); }
.clip-lane { position: relative; height: 106px; }
/* 轨道背景条：竖向对齐 72px 段块带（标尺 24 + 间距 2 = top 26），横向留 12px 呼吸边 */
.clip-rail {
  position: absolute; left: 12px; right: 12px; top: 26px; height: 72px;
  border-radius: 10px;
  background: var(--ad-line);
}
.clip-scroll { width: 100%; height: 106px; white-space: nowrap; }
.clip-content { position: relative; height: 100%; }
/* ruler/track 必须 in-flow：原点靠 margin-left（绝对定位不认 padding，见头注释）；
   子刻度/段块 absolute 相对各自 border-box 定位，即时间原点 */
.clip-ruler { position: relative; height: 24px; }
.clip-tick { position: absolute; top: 0; height: 24px; }
.clip-tick-i { width: 1px; height: 8px; background: var(--ad-line-strong); margin-left: 0.5px; }
.clip-tick-t { display: block; margin-top: 2px; margin-left: 3px; font-size: 9px; color: var(--ad-text-mut); }
.clip-track { position: relative; height: 72px; margin-top: 2px; }
.clip-seg {
  position: absolute; top: 0; height: 100%;
  border-radius: 10px;
  background: var(--ad-inset);
  border: 1.5px solid var(--ad-line-strong);
  overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px;
}
.clip-seg.on { border-color: var(--ad-brand); box-shadow: 0 0 0 2px var(--ad-brand-soft); }
.clip-seg.ro { opacity: 0.8; }
.clip-seg-no { font-size: 11px; font-weight: 700; color: var(--ad-text); }
.clip-seg-dur { font-size: 9px; color: var(--ad-text-mut); }
/* 裁剪手柄：左右 24px 触控区，中置竖条 */
.clip-hd { position: absolute; top: 0; width: 24px; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 2; }
.clip-hd.l { left: 0; }
.clip-hd.r { right: 0; }
.clip-hd-b { width: 3.5px; height: 26px; border-radius: 999px; background: rgba(255, 255, 255, 0.65); box-shadow: 0 0 3px rgba(0, 0, 0, 0.5); }
.clip-seg.on .clip-hd-b { background: var(--ad-brand); }
/* 播放头：绝对居中红线 + 顶帽（兄弟节点，不拦触摸） */
.clip-ph {
  position: absolute; top: 0; bottom: 0; left: 50%;
  width: 2px; margin-left: -1px;
  background: #f43f5e;
  pointer-events: none;
}
.clip-ph-cap {
  position: absolute; top: 0; left: 50%;
  width: 10px; height: 10px; margin-left: -5px;
  border-radius: 3px;
  background: #f43f5e;
}

/* 检查器条 */
.clip-ins {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 14px;
  background: var(--ad-inset);
  border-top: 1px solid var(--ad-line);
}
.clip-ins.empty { justify-content: center; }
.clip-ins-empty-t { font-size: 12px; color: var(--ad-text-mut); }
.clip-ins-n { font-size: 12px; font-weight: 700; color: var(--ad-text); white-space: nowrap; }
.clip-ins-f { display: flex; align-items: center; gap: 5px; }
.clip-ins-l { font-size: 11px; color: var(--ad-text-mut); white-space: nowrap; }
.clip-ins-in {
  width: 58px;
  /* uni-input 默认 height:1.4em + border-box + overflow:hidden，垂直 padding 会把内容区压到几像素致文字被裁；
     仿 .ad-input：显式定高 + 只留横向 padding */
  height: 28px;
  box-sizing: border-box;
  padding: 0 7px;
  border-radius: 8px;
  border: 1px solid var(--ad-line);
  background: var(--ad-wbar-bg);
  font-size: 12px;
  color: var(--ad-text);
  text-align: center;
}
.clip-ins-d { font-size: 11px; color: var(--ad-text-soft); margin-left: auto; }
.clip-op {
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--ad-line);
  background: var(--ad-wbar-bg);
  color: var(--ad-text-soft);
}
.clip-op.dis { opacity: 0.35; }

/* 底部操作栏 */
.clip-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px calc(9px + env(safe-area-inset-bottom));
  background: var(--ad-wbar-bg);
  border-top: 1px solid var(--ad-line);
}
.clip-fbtn {
  width: 62px;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 6px 0;
  border-radius: 10px;
  color: var(--ad-text-soft);
}
.clip-fbtn.dis { opacity: 0.35; }
.clip-fbtn-t { font-size: 10px; }
.clip-export { flex: 1; margin-left: 4px; }

/* 完成面板 */
.clip-done { display: flex; flex-direction: column; gap: 16px; }
.clip-done-row { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.clip-done-acts { display: flex; gap: 10px; }
.clip-done-acts .mbtn { flex: 1; }
</style>
