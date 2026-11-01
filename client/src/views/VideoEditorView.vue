<script setup>
/**
 * 单视频在线剪辑（独立全屏窗口，无 DefaultLayout）。
 *
 * 由成片历史卡「剪刀」按钮 window.open('/editor/video/:jobId') 打开：
 *  - 纯剪辑：掐头去尾 / 播放头分割 / 删段 / 拖拽调序，导出 480p/720p/768p/1080p/2K/4K（Job video_edit）。
 *  - 一次性会话：段列表仅存内存（undo/redo 快照栈），不落库。
 *  - 独立窗口三件事：自挂 <GenConfirmDialog/>；自起 jobs 轮询；挂回在途导出任务。
 *
 * 数据模型：segments = [{id, startMs, endMs}]（源时间轴坐标、数组顺序即成片顺序）。
 * 时间线按「输出域」展示：各段按顺序首尾相接，总长 = Σ段长；播放调度在段边界跳源时间。
 */
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { videoApi } from '../api';
import { useCostAction } from '../composables/useCostAction';
import { useJobsStore } from '../stores/jobs';
import GenConfirmDialog from '../components/GenConfirmDialog.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const jobs = useJobsStore();
const { runJob } = useCostAction();

// ---------- 0. 常量 ----------
const MIN_SEG_MS = 200;            // 最短段长（与服务端一致）
const FRAME_MS = 1000 / 30;        // 预览帧步进（30fps，近似源帧率）
const JUMP_EPS_MS = 40;            // 播放调度：距段尾该毫秒数时跳下一段
const HISTORY_LIMIT = 50;          // undo 栈深
const THUMB_H = 56;                // 缩略图高（与段块同高）
const THUMB_BUCKET_MS = 200;       // 缩略图采样桶（同段移动把手后可复用邻帧）
const DRAG_ARM_PX = 6;             // 段体按下位移超过该值才算拖拽调序
const MIN_PX_PER_SEC = 8;          // 时间线最小刻度密度（窄屏放大出横向滚动）

// ---------- 1. 源加载 ----------
const jobId = String(route.params.jobId || '');
// 分镜源路由形如 seg-<id>：导出 Job 的 ref_id 存的是数字分镜 id（meta.editSource='segment' 区分同号 jobId）
const isSegSource = jobId.startsWith('seg-');
const refKey = isSegSource ? jobId.slice(4) : jobId;
const loading = ref(true);
const loadError = ref('');
const source = ref(null); // { job_id, kind, video_url, duration, width, height, has_audio, aspect_ratio, project_id, project_name, episode_id, episode_title, can_edit, segment_id?, segment_title?, write_back? }

const srcDurationMs = computed(() => Math.round((source.value?.duration || 0) * 1000));
const videoAspect = computed(() => {
  const w = Number(source.value?.width) || 9;
  const h = Number(source.value?.height) || 16;
  return w / h;
});
const kindBadge = computed(() => ({
  compose: 'editor.kindCompose',
  subtitle: 'editor.kindSubtitle',
  edit: 'editor.kindEdit',
  segment: 'editor.kindSegment',
}[source.value?.kind] || ''));

// ---------- 2. 段模型 + undo/redo ----------
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

function snapshot() {
  return JSON.stringify(segments.value.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
}
const undoStack = [];
const redoStack = [];
const dirty = ref(false);
const historyTick = ref(0); // 栈是命令式数组，computed 感知不到，用计数驱动 undo/redo 可用态
function commitPre(pre) { // 一次编辑结束（含拖拽 up）后入栈：pre = 变更前快照
  if (snapshot() === pre) return;
  undoStack.push(pre);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  dirty.value = true;
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
  resyncAfterStructureChange();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  dirty.value = undoStack.length > 0;
  historyTick.value++;
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  dirty.value = true;
  historyTick.value++;
}
const canUndo = computed(() => { void historyTick.value; return undoStack.length > 0; });
const canRedo = computed(() => { void historyTick.value; return redoStack.length > 0; });

// ---------- 3. 时间映射 ----------
// 输出域 → 源域：定位输出位置落在哪一段、对应源时间
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

// ---------- 4. 播放调度 ----------
const videoRef = ref(null);
const isPlaying = ref(false);
const playheadMs = ref(0);
const activeIndex = ref(0); // 当前播放的段下标（视频元素在源时间轴上）
let rafId = 0;

function ensureVideo() { return videoRef.value; }
function seekOutput(outMs) { // 时间线点击/拖播放头/帧步进/Home/End 唯一入口
  const total = totalMs.value;
  playheadMs.value = Math.min(Math.max(outMs, 0), total);
  const { i, sourceMs } = outputToSource(playheadMs.value);
  activeIndex.value = i;
  const v = ensureVideo();
  if (v && Number.isFinite(sourceMs)) {
    try { v.currentTime = Math.max(0, sourceMs / 1000); } catch { /* 元数据未就绪 */ }
  }
  keepPlayheadVisible();
}
function tick() {
  const v = ensureVideo();
  if (v && !v.paused && !v.ended) {
    const segs = segments.value;
    const seg = segs[activeIndex.value];
    const curMs = v.currentTime * 1000;
    if (!seg) {
      pausePlayback();
    } else if (curMs >= seg.endMs - JUMP_EPS_MS) {
      if (activeIndex.value < segs.length - 1) {
        activeIndex.value += 1;
        const nx = segs[activeIndex.value];
        try { v.currentTime = nx.startMs / 1000; } catch { /* ignore */ }
        playheadMs.value = offsetsMs.value[activeIndex.value];
      } else {
        playheadMs.value = totalMs.value;
        pausePlayback();
      }
    } else {
      playheadMs.value = offsetsMs.value[activeIndex.value] + Math.max(0, curMs - seg.startMs);
    }
    keepPlayheadVisible();
  }
  rafId = requestAnimationFrame(tick);
}
function playPlayback() {
  const v = ensureVideo();
  if (!v) return;
  if (playheadMs.value >= totalMs.value - 1) seekOutput(0); // 播完后再按播放：从头来
  const { i, sourceMs } = outputToSource(playheadMs.value);
  activeIndex.value = i;
  try { v.currentTime = Math.max(0, sourceMs / 1000); } catch { /* ignore */ }
  v.play().then(() => { isPlaying.value = true; }).catch(() => {});
}
function pausePlayback() {
  const v = ensureVideo();
  v?.pause?.();
  isPlaying.value = false;
}
function togglePlay() { if (isPlaying.value) pausePlayback(); else playPlayback(); }
function stepFrame(dirMs) {
  pausePlayback();
  seekOutput(playheadMs.value + dirMs);
}
function onVideoEnded() { // 兜底：末段源时间恰好触达视频结尾
  if (activeIndex.value < segments.value.length - 1) {
    activeIndex.value += 1;
    const nx = segments.value[activeIndex.value];
    const v = ensureVideo();
    if (v) { try { v.currentTime = nx.startMs / 1000; if (isPlaying.value) v.play().catch(() => {}); } catch { /* ignore */ } }
  } else {
    playheadMs.value = totalMs.value;
    pausePlayback();
  }
}
// 结构变化（分割/删除/调序/撤销）后：播放头按输出位置重定位到新结构
function resyncAfterStructureChange() {
  seekOutput(Math.min(playheadMs.value, totalMs.value));
}

// ---------- 5. 缩略图采样（隐藏同源 video + canvas，串行队列） ----------
const thumbVideoRef = ref(null);
const thumbMap = reactive({}); // key(`${segId}:${bucket}`) -> dataURL | null(失败降级)
const thumbQueue = [];
let thumbBusy = false;
const thumbW = computed(() => Math.max(24, Math.round(THUMB_H * videoAspect.value)));

function requestThumb(key, srcMs) {
  if (thumbMap[key] !== undefined) return;
  thumbMap[key] = null; // 占位：失败/未取到前显示纯色底
  thumbQueue.push({ key, srcMs });
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const { key, srcMs } = thumbQueue.shift();
    if (thumbMap[key]) continue;
    thumbMap[key] = await captureThumb(srcMs);
  }
  thumbBusy = false;
}
function captureThumb(srcMs) {
  return new Promise((resolve) => {
    const v = thumbVideoRef.value;
    if (!v) return resolve(null);
    const done = (val) => { clearTimeout(timer); v.removeEventListener('seeked', onSeeked); v.removeEventListener('error', onErr); resolve(val); };
    const timer = setTimeout(() => done(null), 1500); // 超时降级纯色底
    const onSeeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = thumbW.value; c.height = THUMB_H;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        done(c.toDataURL('image/jpeg', 0.55));
      } catch { done(null); }
    };
    const onErr = () => done(null);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onErr);
    try {
      const sec = Math.min(Math.max(srcMs / 1000, 0), Math.max(0, (source.value?.duration || 0) - 0.05));
      v.currentTime = sec;
    } catch { done(null); }
  });
}

// ---------- 6. 时间线几何 ----------
const laneWrapRef = ref(null); // 滚动容器
const laneW = ref(800);
// 打开即与页面等宽：初次测量走纯适配（无视最小密度下限）；窗口尺寸变化后恢复下限
const fitOpen = ref(true);
const pxPerMs = computed(() => {
  const srcMs = Math.max(srcDurationMs.value, 1);
  const fit = laneW.value / srcMs;
  const floor = fitOpen.value ? 0 : MIN_PX_PER_SEC / 1000;
  return Math.max(fit, floor);
});
const contentW = computed(() => Math.ceil(srcDurationMs.value * pxPerMs.value));
const playheadX = computed(() => playheadMs.value * pxPerMs.value);

const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const rulerStepMs = computed(() => {
  for (const s of RULER_STEPS) {
    if (s * 1000 * pxPerMs.value >= 56) return s * 1000;
  }
  return 600000;
});
const rulerTicks = computed(() => {
  const out = [];
  for (let m = 0; m <= srcDurationMs.value + 1; m += rulerStepMs.value) out.push(m);
  return out;
});
function fmtRuler(ms) {
  const s = ms / 1000;
  if (s < 60) return String(Math.round(s));
  const m = Math.floor(s / 60);
  const ss = Math.round(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}
function fmtMs(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = String(ms % 1000).padEnd(3, '0').slice(0, 3);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}.${mm}` : `${pad(m)}:${pad(s)}.${mm}`;
}
// 检查器输入解析：SS(.mmm) / MM:SS(.mmm) / HH:MM:SS(.mmm)，小数点/逗号皆可
function parseMs(str) {
  const m = String(str || '').trim().match(/^(?:(\d{1,2}):)?(?:(\d{1,2}):)?(\d{1,4})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, g1, g2, g3, frac] = m;
  let h = 0; let mi = 0; let se;
  if (g2 !== undefined) { h = Number(g1 || 0); mi = Number(g2); se = Number(g3); }
  else if (g1 !== undefined) { mi = Number(g1); se = Number(g3); }
  else { se = Number(g3); }
  if (mi > 59 || se > 59) return null;
  const ms = ((h * 3600 + mi * 60 + se) * 1000) + Number((frac || '').padEnd(3, '0') || 0);
  return Number.isFinite(ms) ? ms : null;
}
function keepPlayheadVisible() {
  const el = laneWrapRef.value;
  if (!el) return;
  const x = playheadX.value;
  if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 48) {
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }
}

// 时间轴宽度/密度变化后同步横向滚动：按「视口中心对应的时间点」重新落位（越界由浏览器钳制），并保证播放头可见
function syncScrollAfterScale(prevPpm) {
  const el = laneWrapRef.value;
  if (!el) return;
  const centerMs = (el.scrollLeft + el.clientWidth / 2) / prevPpm;
  nextTick(() => {
    el.scrollLeft = centerMs * pxPerMs.value - el.clientWidth / 2;
    keepPlayheadVisible();
  });
}

// 段块缩略图规格（宽度内均布采样）：computed 只算规格，采样由 watcher 驱动（不在渲染期产生副作用）
const segThumbSpecs = computed(() => segments.value.map((seg) => {
  const w = segDur(seg) * pxPerMs.value;
  const n = Math.max(1, Math.ceil(w / thumbW.value));
  const specs = [];
  for (let k = 0; k < n; k++) {
    const srcMs = seg.startMs + ((k + 0.5) / n) * segDur(seg);
    specs.push({ key: `${seg.id}:${Math.round(srcMs / THUMB_BUCKET_MS)}`, srcMs, left: (k * w) / n, w: Math.ceil(w / n) + 1 });
  }
  return { segId: seg.id, specs };
}));
watch(segThumbSpecs, (all) => {
  for (const { specs } of all) for (const s of specs) requestThumb(s.key, s.srcMs);
}, { immediate: true });
function segThumbs(seg) { // 模板只查表
  return segThumbSpecs.value.find((e) => e.segId === seg.id)?.specs || [];
}

// ---------- 7. 指针状态机（scrub / trimL / trimR / arm→reorder） ----------
const pointerMode = ref(''); // '' | scrub | trimL | trimR | arm | reorder
const dragSegId = ref(null);
const dragDX = ref(0);
const dropIndex = ref(-1); // reorder 插入位（相对其余段）
let pStart = null; // {x, y, pre(快照), segId, outMs}
let winMove = null; let winUp = null;

function laneRect() { return laneWrapRef.value?.querySelector('.ve-lane-content')?.getBoundingClientRect(); }
function xToOutMs(clientX) {
  const r = laneRect();
  if (!r) return 0;
  return (clientX - r.left) / pxPerMs.value;
}
function bindWinPointer(move, up) {
  // 多指/多指针防叠加：新手势绑定前先解掉在途监听（旧引用被覆盖却不解绑时，
  // 任一指针抬起会先后触发新旧两个 up 回调，修剪会被误判成 tap/提前 commit）
  if (winMove) window.removeEventListener('pointermove', winMove);
  if (winUp) { window.removeEventListener('pointerup', winUp); window.removeEventListener('pointercancel', winUp); }
  winMove = (e) => move(e);
  // 先回调再解绑：up 里要读 pointerMode 判定 reorder/trim，unbind 会清掉它
  winUp = (e) => { up?.(e); unbindWinPointer(); };
  window.addEventListener('pointermove', winMove);
  window.addEventListener('pointerup', winUp);
  window.addEventListener('pointercancel', winUp);
}
function unbindWinPointer() {
  if (winMove) window.removeEventListener('pointermove', winMove);
  if (winUp) { window.removeEventListener('pointerup', winUp); window.removeEventListener('pointercancel', winUp); }
  winMove = null; winUp = null;
  pointerMode.value = '';
}

function onRulerDown(e) { // 标尺/播放头：实时 seek（不入历史）
  e.preventDefault();
  const move = (ev) => seekOutput(xToOutMs(ev.clientX));
  move(e);
  pointerMode.value = 'scrub';
  bindWinPointer(move);
}
function onSegDown(e, seg) {
  if (e.button !== undefined && e.button !== 0) return;
  e.stopPropagation();
  selectedId.value = seg.id;
  pStart = { x: e.clientX, y: e.clientY, pre: snapshot(), segId: seg.id, outMs: xToOutMs(e.clientX) };
  pointerMode.value = 'arm';
  dragDX.value = 0; dropIndex.value = -1;
  bindWinPointer(onSegMove, onSegUp);
}
function onHandleDown(e, seg, side) {
  if (e.button !== undefined && e.button !== 0) return;
  e.stopPropagation();
  selectedId.value = seg.id;
  pStart = { x: e.clientX, y: e.clientY, pre: snapshot(), segId: seg.id, side };
  pointerMode.value = side;
  bindWinPointer(onHandleMove, onHandleUp);
}
function onHandleMove(e) {
  if (!pStart) return;
  const seg = segments.value.find((s) => s.id === pStart.segId);
  if (!seg) return;
  const dMs = (e.clientX - pStart.x) / pxPerMs.value;
  if (pStart.side === 'trimL') {
    seg.startMs = Math.round(Math.min(Math.max(seg.startMs + dMs, 0), seg.endMs - MIN_SEG_MS));
  } else {
    seg.endMs = Math.round(Math.min(Math.max(seg.endMs + dMs, seg.startMs + MIN_SEG_MS), srcDurationMs.value));
  }
  pStart.x = e.clientX;
}
function onHandleUp() {
  if (pStart) commitPre(pStart.pre);
  pStart = null;
}
function onSegMove(e) {
  if (!pStart) return;
  const dx = e.clientX - pStart.x;
  if (pointerMode.value === 'arm' && Math.abs(dx) >= DRAG_ARM_PX) pointerMode.value = 'reorder';
  if (pointerMode.value === 'reorder') {
    pausePlayback();
    dragSegId.value = pStart.segId;
    dragDX.value = dx;
    // 以「其余段」的中点比较得出插入位
    const without = segments.value.filter((s) => s.id !== pStart.segId);
    let acc = 0; let idx = 0;
    for (const s of without) {
      const mid = acc + segDur(s) / 2;
      if (xToOutMs(e.clientX) >= mid) idx += 1;
      acc += segDur(s);
    }
    dropIndex.value = idx;
  }
}
function onSegUp() {
  const st = pStart; pStart = null;
  if (pointerMode.value === 'reorder' && st) {
    const id = st.segId; const to = dropIndex.value; // to 已是「其余段」数组里的下标
    mutate(() => {
      const from = segments.value.findIndex((s) => s.id === id);
      if (from < 0) return;
      const [moved] = segments.value.splice(from, 1);
      segments.value.splice(Math.min(Math.max(to, 0), segments.value.length), 0, moved);
      selectedId.value = id;
    });
  } else if (st) {
    commitPre(st.pre); // 未形成拖拽也应清掉（无变化时 commitPre 内部会忽略）
  }
  dragSegId.value = null; dragDX.value = 0; dropIndex.value = -1;
}
function dropLineX() {
  if (dropIndex.value < 0 || !dragSegId.value) return -1;
  const without = segments.value.filter((s) => s.id !== dragSegId.value);
  let acc = 0;
  for (let i = 0; i < dropIndex.value && i < without.length; i++) acc += segDur(without[i]);
  return acc * pxPerMs.value;
}

// ---------- 8. 编辑操作 ----------
function splitAtPlayhead() {
  if (!segments.value.length) return;
  const { i, sourceMs } = outputToSource(playheadMs.value);
  const seg = segments.value[i];
  if (!seg) return;
  const local = sourceMs - seg.startMs;
  if (local < MIN_SEG_MS || segDur(seg) - local < MIN_SEG_MS) {
    ElMessage.warning(t('editor.splitShort'));
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
  if (!seg) { ElMessage.warning(t('editor.inspector.empty')); return; }
  if (segments.value.length <= 1) { ElMessage.warning(t('editor.atLeastOne')); return; }
  const at = segments.value.findIndex((s) => s.id === seg.id);
  mutate(() => { segments.value.splice(at, 1); });
  selectedId.value = segments.value[Math.min(at, segments.value.length - 1)]?.id ?? null;
  resyncAfterStructureChange();
}
async function resetAll() {
  try {
    await ElMessageBox.confirm(t('editor.resetConfirm'), t('editor.reset'), {
      type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; }
  const pre = snapshot();
  segments.value = [{ id: nextSegId++, startMs: 0, endMs: srcDurationMs.value }];
  selectedId.value = segments.value[0].id;
  undoStack.length = 0; redoStack.length = 0; dirty.value = false;
  commitPre(pre);
  resyncAfterStructureChange();
}

// 检查器入/出点（失焦提交、非法回退）
const inStr = ref(''); const outStr = ref('');
watch(selectedSeg, (seg) => {
  inStr.value = seg ? fmtMs(seg.startMs) : '';
  outStr.value = seg ? fmtMs(seg.endMs) : '';
});
function commitInspector(field) {
  const seg = selectedSeg.value;
  if (!seg) return;
  const raw = field === 'in' ? inStr.value : outStr.value;
  const parsed = parseMs(raw);
  if (parsed === null || parsed < 0 || parsed > srcDurationMs.value) {
    ElMessage.warning(t('editor.inspector.invalidTime'));
    if (field === 'in') inStr.value = fmtMs(seg.startMs); else outStr.value = fmtMs(seg.endMs);
    return;
  }
  const other = field === 'in' ? seg.endMs : seg.startMs;
  const ok = field === 'in' ? (parsed <= other - MIN_SEG_MS) : (parsed >= other + MIN_SEG_MS);
  if (!ok) {
    ElMessage.warning(t('editor.inspector.badRange'));
    if (field === 'in') inStr.value = fmtMs(seg.startMs); else outStr.value = fmtMs(seg.endMs);
    return;
  }
  mutate(() => { if (field === 'in') seg.startMs = parsed; else seg.endMs = parsed; });
  inStr.value = fmtMs(seg.startMs); outStr.value = fmtMs(seg.endMs);
  resyncAfterStructureChange();
}

// ---------- 9. 导出流程 ----------
const exportVisible = ref(false);
// 导出分辨率档位：与后端 EDIT_RESOLUTIONS、合成分辨率（COMPOSE_RESOLUTIONS）同源同 casing
const EXPORT_RESOLUTIONS = ['480p', '720p', '768p', '1080p', '2K', '4K'];
const EXPORT_RES_KEY = 'aidrama:editResolution';
// 记忆用户上次所选档（localStorage 校验白名单，防手改脏值；默认 720p = 历史行为）
const exportRes = ref((() => {
  try {
    const v = localStorage.getItem(EXPORT_RES_KEY);
    if (EXPORT_RESOLUTIONS.includes(v)) return v;
  } catch { /* 隐私模式等 localStorage 不可用 */ }
  return '720p';
})());
const estimate = ref(null);
const estimating = ref(false);
const exportDone = ref(null);  // 成功面板 { video_url, duration, resolution, segments_count }

// 本编辑器的在途导出 Job：ref_id 对上（分镜源还须 meta.editSource='segment'，防与同号成片 Job 混淆）
const isOwnExport = (j) => j.type === 'video_edit' && String(j.ref_id) === refKey
  && (!isSegSource || j.meta?.editSource === 'segment')
  && (j.status === 'pending' || j.status === 'running');
const exporting = computed(() => jobs.items.some(isOwnExport));
const exportProgress = computed(() => jobs.items.find(isOwnExport));
const exportDisabled = computed(() => !source.value?.can_edit || exporting.value || totalMs.value <= 0);

watch([exportVisible, exportRes, totalMs], ([vis]) => {
  if (!vis || !source.value) return;
  estimate.value = null;
  estimating.value = true;
  videoApi.editEstimate(jobId, exportRes.value, Math.round(totalMs.value / 1000))
    .then((d) => { estimate.value = d; })
    .catch(() => { estimate.value = null; })
    .finally(() => { estimating.value = false; });
}, { immediate: true });

async function openExport() {
  if (exportDisabled.value) return;
  exportVisible.value = true;
}
async function confirmExport() {
  exportVisible.value = false;
  const res = exportRes.value;
  try { localStorage.setItem(EXPORT_RES_KEY, res); } catch { /* localStorage 不可用则不记忆 */ }
  const n = segments.value.length;
  const secs = Math.round(totalMs.value / 1000);
  const job = await runJob({
    modelType: null,
    estimateFor: () => videoApi.editEstimate(jobId, res, secs),
    createFor: () => videoApi.exportEdit(jobId, {
      resolution: res,
      segments: segments.value.map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) })),
    }),
    title: t('editor.export.confirmTitle'),
    desc: t('editor.export.confirmDesc', { n, res }),
    confirmText: t('editor.export.confirm'),
    onDone: onExportDone,
  });
  if (job) jobs.ensurePolling();
}
function onExportDone(j) {
  if (j.status === 'succeeded') {
    exportDone.value = j.result?.edit || null;
    // 分镜源导出带 segment 全量行，分镜页免二次拉取直接补位
    try {
      window.opener?.postMessage({
        type: 'aieditor:exported', job_id: j.id, source_job_id: source.value?.job_id,
        kind: source.value?.kind, segment_id: j.result?.edit?.segment_id || source.value?.segment_id || null,
        segment: j.result?.segment || null,
      }, window.location.origin);
    } catch { /* ignore */ }
  }
}
function closeExportDone() { exportDone.value = null; }

// ---------- 10. 快捷键 / 全屏 / 生命周期 ----------
const isFs = ref(false);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
function onFsChange() { isFs.value = !!document.fullscreenElement; }

function isTypingTarget(e) {
  const el = e.target;
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}
function onKeydown(e) {
  if (isTypingTarget(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { redo(); } else { undo(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); stepFrame(e.shiftKey ? -1000 : -FRAME_MS); break;
    case 'ArrowRight': e.preventDefault(); stepFrame(e.shiftKey ? 1000 : FRAME_MS); break;
    case 'Home': e.preventDefault(); seekOutput(0); break;
    case 'End': e.preventDefault(); seekOutput(totalMs.value); break;
    case 's': case 'S': e.preventDefault(); splitAtPlayhead(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
    case 'Escape': selectedId.value = null; break;
    default: break;
  }
}
function onBeforeUnload(e) {
  if (dirty.value) { e.preventDefault(); e.returnValue = ''; }
}

// 返回：window.open 打开的窗口直接关闭；被拦截（直接输 URL 进入）则退回项目工作台
function goBack() {
  window.close();
  setTimeout(() => {
    const pid = source.value?.project_id;
    if (pid) router.push({ path: `/projects/${pid}` });
    else router.push({ path: '/projects' });
  }, 160);
}

let ro = null;
onMounted(async () => {
  document.addEventListener('fullscreenchange', onFsChange);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  rafId = requestAnimationFrame(tick);

  // 独立窗口独立 Pinia：自起任务列表同步（track/ensurePolling 驱动轮询）
  const fetchJobs = jobs.fetchAll();

  try {
    const data = await videoApi.editSource(jobId);
    source.value = data;
    segments.value = [{ id: nextSegId++, startMs: 0, endMs: srcDurationMs.value }];
    selectedId.value = segments.value[0].id;
    // 挂回在途导出（上次关窗后仍在跑的任务），完成时同一回调收尾
    await fetchJobs;
    const running = jobs.items.find(isOwnExport);
    if (running) { jobs.registerOnDone(running.id, onExportDone); jobs.ensurePolling(); }
  } catch (err) {
    loadError.value = err?.message || t('editor.loadFail');
  } finally {
    loading.value = false;
  }

  await nextTick();
  if (laneWrapRef.value) {
    // 打开即与页面等宽：同步实测一次（不等 RO 首帧回填），消掉初始 800 假宽
    const el = laneWrapRef.value;
    const cs = getComputedStyle(el);
    laneW.value = Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
    let roFirst = true;
    ro = new ResizeObserver((ents) => {
      const prev = pxPerMs.value;
      laneW.value = ents[0]?.contentRect?.width || laneW.value;
      if (roFirst) { roFirst = false; return; } // 首帧只校准，保持「打开即等宽」
      fitOpen.value = false;                    // 之后窗口变化恢复最小密度下限（长视频可出横向滚动）
      if (pxPerMs.value !== prev) syncScrollAfterScale(prev);
    });
    ro.observe(el);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFsChange);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', onBeforeUnload);
  cancelAnimationFrame(rafId);
  unbindWinPointer();
  ro?.disconnect?.();
  jobs.stopPolling(); // 独立窗口的轮询随窗口关闭
});
</script>

<template>
  <div class="ve" v-loading="loading">
    <!-- 加载失败：整页错误态 -->
    <div v-if="loadError" class="ve-error">
      <el-icon :size="40"><WarningFilled /></el-icon>
      <div class="ve-error-title">{{ loadError }}</div>
      <el-button @click="goBack">{{ t('editor.back') }}</el-button>
    </div>

    <template v-else-if="source">
      <!-- 顶栏 -->
      <header class="ve-top">
        <button class="ve-icon-btn" :title="t('editor.back')" @click="goBack"><el-icon><ArrowLeft /></el-icon></button>
        <div class="ve-top-title">
          <span class="ve-top-name">{{ source.segment_title || source.episode_title || t('editor.title') }}</span>
          <span v-if="kindBadge" class="ve-chip">{{ t(kindBadge) }}</span>
          <span class="ve-chip dim">{{ fmtMs(totalMs) }}</span>
        </div>
        <div class="ve-top-actions">
          <button class="ve-icon-btn" :disabled="!canUndo" :title="t('editor.undo')" @click="undo()"><el-icon><RefreshLeft /></el-icon></button>
          <button class="ve-icon-btn" :disabled="!canRedo" :title="t('editor.redo')" @click="redo()"><el-icon><RefreshRight /></el-icon></button>
          <button class="ve-icon-btn" :title="t('editor.reset')" @click="resetAll"><el-icon><Refresh /></el-icon></button>
          <button class="ve-icon-btn" :title="t('editor.fullscreen')" @click="toggleFullscreen">
            <el-icon><component :is="isFs ? 'Close' : 'FullScreen'" /></el-icon>
          </button>
          <el-button type="primary" class="ve-export-btn" :disabled="exportDisabled" @click="openExport">
            <el-icon><Download /></el-icon>{{ exporting ? t('editor.export.runningShort') : t('editor.export.button') }}
          </el-button>
        </div>
      </header>

      <!-- 只读横幅 -->
      <div v-if="!source.can_edit" class="ve-readonly">{{ t('editor.readonlyBanner') }}</div>

      <!-- 主体：播放器 + 检查器 -->
      <main class="ve-main">
        <section class="ve-player">
          <video
            ref="videoRef"
            class="ve-video"
            :src="source.video_url"
            :style="{ aspectRatio: `${source.width} / ${source.height}` }"
            preload="auto"
            playsinline
            @click="togglePlay"
            @ended="onVideoEnded"
          />
          <div class="ve-player-bar">
            <button class="ve-icon-btn" :title="isPlaying ? t('editor.pause') : t('editor.play')" @click="togglePlay">
              <el-icon><component :is="isPlaying ? 'VideoPause' : 'VideoPlay'" /></el-icon>
            </button>
            <button class="ve-icon-btn" :title="t('editor.prevFrame')" @click="stepFrame(-FRAME_MS)"><el-icon><DArrowLeft /></el-icon></button>
            <button class="ve-icon-btn" :title="t('editor.nextFrame')" @click="stepFrame(FRAME_MS)"><el-icon><DArrowRight /></el-icon></button>
            <span class="ve-time">{{ fmtMs(playheadMs) }} <em>/ {{ fmtMs(totalMs) }}</em></span>
            <span class="ve-flex-fill" />
            <button class="ve-icon-btn" :title="t('editor.split')" @click="splitAtPlayhead"><el-icon><Scissor /></el-icon></button>
            <button class="ve-icon-btn" :disabled="!selectedSeg" :title="t('editor.deleteSeg')" @click="deleteSelected"><el-icon><Delete /></el-icon></button>
          </div>
          <!-- 导出进行中：行内进度 -->
          <div v-if="exporting && exportProgress" class="ve-exporting">
            <el-progress :percentage="exportProgress.progress || 0" :stroke-width="8" />
            <span>{{ exportProgress.stage || t('editor.export.running') }}</span>
          </div>
        </section>

        <!-- 检查器 -->
        <aside v-if="selectedSeg" class="ve-inspector">
          <div class="ve-inspector-title">{{ t('editor.inspector.segN', { n: segments.findIndex((s) => s.id === selectedSeg.id) + 1 }) }}</div>
          <label class="ve-field">
            <span>{{ t('editor.inspector.inPoint') }}</span>
            <input v-model="inStr" class="ve-input" spellcheck="false" @blur="commitInspector('in')" @keydown.enter.prevent="commitInspector('in')">
          </label>
          <label class="ve-field">
            <span>{{ t('editor.inspector.outPoint') }}</span>
            <input v-model="outStr" class="ve-input" spellcheck="false" @blur="commitInspector('out')" @keydown.enter.prevent="commitInspector('out')">
          </label>
          <div class="ve-inspector-row">
            <span>{{ t('editor.inspector.duration') }}</span><b>{{ fmtMs(selectedSeg.endMs - selectedSeg.startMs) }}</b>
          </div>
          <div class="ve-inspector-row">
            <span>{{ t('editor.totalDuration') }}</span><b>{{ fmtMs(totalMs) }}</b>
          </div>
          <el-button class="ve-inspector-del" plain type="danger" :disabled="segments.length <= 1" @click="deleteSelected">
            <el-icon><Delete /></el-icon>{{ t('editor.inspector.delete') }}
          </el-button>
          <div class="ve-shortcut">{{ t('editor.shortcutHint') }}</div>
        </aside>
      </main>

      <!-- 时间线 -->
      <footer class="ve-bottom">
        <div ref="laneWrapRef" class="ve-lane-wrap">
          <div class="ve-lane-content" :style="{ width: contentW + 'px' }">
            <!-- 标尺（拖拽 seek） -->
            <div class="ve-ruler" @pointerdown="onRulerDown">
              <template v-for="ms in rulerTicks" :key="ms">
                <span class="ve-tick" :style="{ left: ms * pxPerMs + 'px' }"><i /><em>{{ fmtRuler(ms) }}</em></span>
              </template>
            </div>
            <!-- 段块轨道 -->
            <div class="ve-lane" @pointerdown.self="onRulerDown($event)">
              <div
                v-for="(seg, i) in segments"
                :key="seg.id"
                class="ve-seg"
                :class="{ selected: seg.id === selectedId, dragging: seg.id === dragSegId }"
                :style="{ left: offsetsMs[i] * pxPerMs + 'px', width: segDur(seg) * pxPerMs + 'px', transform: seg.id === dragSegId ? `translateX(${dragDX}px)` : '' }"
                @pointerdown="onSegDown($event, seg)"
              >
                <img v-for="th in segThumbs(seg)" :key="th.key" class="ve-thumb" :src="thumbMap[th.key] || undefined" :style="{ left: th.left + 'px', width: th.w + 'px' }">
                <span class="ve-seg-label">{{ i + 1 }} · {{ fmtMs(segDur(seg)) }}</span>
                <span class="ve-handle left" @pointerdown="onHandleDown($event, seg, 'trimL')"><i /></span>
                <span class="ve-handle right" @pointerdown="onHandleDown($event, seg, 'trimR')"><i /></span>
              </div>
              <!-- 插入指示线 -->
              <div v-if="dropLineX() >= 0" class="ve-dropline" :style="{ left: dropLineX() + 'px' }" />
            </div>
            <!-- 播放头 -->
            <div class="ve-playhead" :style="{ left: playheadX + 'px' }" @pointerdown="onRulerDown">
              <span class="ve-playhead-knob" />
            </div>
          </div>
        </div>
      </footer>
    </template>

    <!-- 隐藏的缩略图采样视频 -->
    <video v-show="false" ref="thumbVideoRef" class="ve-thumb-video" :src="source?.video_url" muted preload="auto" playsinline />

    <!-- 导出小弹窗 -->
    <el-dialog v-model="exportVisible" class="ve-export-dialog" width="min(480px, 94vw)" append-to-body>
      <template #header>{{ t('editor.export.title') }}</template>
      <div class="ve-export-body">
        <div class="ve-export-row">{{ t('editor.export.desc', { n: segments.length }) }}</div>
        <div v-if="source?.write_back" class="ve-export-row warn">{{ t('editor.export.writeBackHint') }}</div>
        <div class="ve-export-row">
          <span>{{ t('editor.export.resolution') }}</span>
          <el-radio-group v-model="exportRes" class="ve-export-res">
            <el-radio-button v-for="r in EXPORT_RESOLUTIONS" :key="r" :value="r">{{ r }}</el-radio-button>
          </el-radio-group>
        </div>
        <div v-if="exportRes === '2K' || exportRes === '4K'" class="ve-export-row warn">{{ t('editor.export.resolutionHint') }}</div>
        <div class="ve-export-row">
          <span>{{ t('editor.export.minutes') }}</span>
          <b>{{ t('editor.export.minutesVal', { m: Math.max(1, Math.ceil(totalMs / 60000)) }) }}</b>
        </div>
        <div class="ve-export-row cost">
          <span>{{ t('editor.export.estimate') }}</span>
          <b>{{ estimating ? t('editor.export.estimating') : (estimate ? t('editor.export.credits', { n: estimate.discountedCredits ?? estimate.credits }) : '—') }}</b>
        </div>
      </div>
      <template #footer>
        <el-button @click="exportVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :disabled="!estimate" @click="confirmExport">{{ t('editor.export.confirm') }}</el-button>
      </template>
    </el-dialog>

    <!-- 导出成功面板 -->
    <el-dialog :model-value="!!exportDone" class="ve-done-dialog" width="min(420px, 94vw)" append-to-body @close="closeExportDone">
      <template #header>{{ t('editor.export.done') }}</template>
      <div v-if="exportDone" class="ve-done-body">
        <div class="ve-done-meta">
          <span>{{ exportDone.resolution }}</span>
          <span>{{ fmtMs((exportDone.duration || 0) * 1000) }}</span>
          <span>{{ t('editor.export.segCount', { n: exportDone.segments_count || segments.length }) }}</span>
        </div>
        <p class="ve-done-tip">{{ t(source?.write_back ? 'editor.export.doneTipSegment' : 'editor.export.doneTip') }}</p>
      </div>
      <template #footer>
        <el-button @click="closeExportDone">{{ t('editor.export.close') }}</el-button>
        <el-button v-if="exportDone?.video_url" type="primary" tag="a" :href="exportDone.video_url" :download="`edit_${exportDone.source_job_id || jobId}.mp4`">
          <el-icon><Download /></el-icon>{{ t('editor.export.download') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 独立窗口必须自挂确认弹层 -->
    <GenConfirmDialog />
  </div>
</template>

<style scoped>
/* ============================================================
   本页恒暗（放映室）：在线剪辑器独立全屏窗口，不随深浅主题切换。
   表面色收敛为局部 --ve-* 变量（此处一处处定义、全页引用），
   品牌/语义色仍走全局 --ad-*，金色体系渗入剪辑器。
   ============================================================ */
.ve {
  /* 本页恒暗表面（不随主题） */
  --ve-bg: #0d1117;
  --ve-panel: #131a26;
  --ve-panel-2: #171f2e;
  --ve-seg: #1e293b;
  --ve-border: rgba(255, 255, 255, .07);
  --ve-border-strong: rgba(255, 255, 255, .14);
  --ve-text: #e6e8ee;
  --ve-text-soft: #d3d9e6;
  --ve-text-muted: #97a0b5;
  --ve-text-faint: #7c879e;
  /* 品牌金：跟随全局品牌色（深浅主题都取当帧值） */
  --ve-gold: var(--ad-brand);
  height: 100dvh; display: flex; flex-direction: column; background: var(--ve-bg); color: var(--ve-text); overflow: hidden;
}
.ve-error { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
.ve-error-title { font-size: 15px; color: var(--ve-text-muted); }

/* 顶栏 */
.ve-top { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--ve-panel); border-bottom: 1px solid var(--ve-border); flex-wrap: wrap; }
.ve-top-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ve-top-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42vw; }
.ve-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--ad-brand-soft); color: var(--ve-gold); border: 1px solid color-mix(in srgb, var(--ad-brand) 45%, transparent); white-space: nowrap; }
.ve-chip.dim { background: rgba(255,255,255,.06); color: var(--ve-text-muted); border-color: var(--ve-border-strong); }
.ve-top-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.ve-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--ve-text-soft); cursor: pointer; }
.ve-icon-btn:hover:not(:disabled) { background: rgba(255,255,255,.09); }
.ve-icon-btn:disabled { opacity: .35; cursor: not-allowed; }
.ve-export-btn { margin-left: 4px; }

.ve-readonly { padding: 7px 14px; font-size: 12.5px; background: rgba(251,191,36,0.14); color: var(--ad-warning); border-bottom: 1px solid color-mix(in srgb, var(--ad-warning) 30%, transparent); }

/* 主体 */
.ve-main { flex: 1; display: flex; min-height: 0; }
.ve-player { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 14px; position: relative; }
.ve-video { max-width: 100%; max-height: calc(100% - 56px); height: auto; border-radius: 10px; background: #000; box-shadow: 0 8px 30px rgba(0,0,0,.5); cursor: pointer; }
.ve-player-bar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 10px; background: var(--ve-panel-2); border: 1px solid var(--ve-border); }
.ve-time { font-family: var(--ad-font-mono); font-size: 12.5px; color: var(--ve-text-soft); }
.ve-time em { font-style: normal; color: var(--ve-text-faint); }
.ve-flex-fill { flex: 1; }
.ve-exporting { position: absolute; right: 16px; bottom: 14px; width: min(300px, 60%); display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ve-gold); background: color-mix(in srgb, var(--ve-panel) 92%, transparent); border: 1px solid color-mix(in srgb, var(--ad-brand) 40%, transparent); border-radius: 10px; padding: 10px 12px; }

/* 检查器 */
.ve-inspector { width: 264px; flex-shrink: 0; background: var(--ve-panel); border-left: 1px solid var(--ve-border); padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.ve-inspector-title { font-weight: 600; font-size: 13.5px; color: var(--ve-gold); }
.ve-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ve-text-muted); }
.ve-input { background: var(--ve-bg); border: 1px solid var(--ve-border-strong); border-radius: 8px; color: var(--ve-text); padding: 7px 10px; font-family: var(--ad-font-mono); font-size: 13px; outline: none; }
.ve-input:focus { border-color: var(--ad-brand); }
.ve-inspector-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ve-text-muted); }
.ve-inspector-row b { color: var(--ve-text); font-family: var(--ad-font-mono); font-weight: 500; }
.ve-inspector-del { width: 100%; }
.ve-shortcut { margin-top: auto; font-size: 11.5px; line-height: 1.7; color: var(--ve-text-faint); }

/* 时间线 */
.ve-bottom { border-top: 1px solid var(--ve-border); background: var(--ve-panel); }
.ve-lane-wrap { overflow-x: auto; overflow-y: hidden; padding: 0 14px; }
.ve-lane-content { position: relative; height: 104px; }
.ve-ruler { position: absolute; top: 0; left: 0; right: 0; height: 26px; cursor: pointer; touch-action: none; }
.ve-tick { position: absolute; top: 0; height: 100%; }
.ve-tick i { position: absolute; left: 0; top: 0; width: 1px; height: 8px; background: rgba(255,255,255,.35); }
.ve-tick em { position: absolute; left: 3px; top: 8px; font-style: normal; font-size: 10px; color: var(--ve-text-faint); white-space: nowrap; }
.ve-lane { position: absolute; top: 30px; left: 0; right: 0; height: 66px; touch-action: none; }
.ve-seg { position: absolute; top: 0; height: 56px; border-radius: 8px; overflow: hidden; background: var(--ve-seg); border: 1.5px solid var(--ve-border-strong); cursor: grab; user-select: none; }
.ve-seg:hover { border-color: color-mix(in srgb, var(--ad-brand) 70%, transparent); }
.ve-seg.selected { border-color: var(--ad-brand); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ad-brand) 35%, transparent); }
.ve-seg.dragging { opacity: .85; z-index: 5; cursor: grabbing; box-shadow: 0 10px 24px rgba(0,0,0,.55); }
.ve-thumb { position: absolute; top: 0; height: 100%; object-fit: cover; pointer-events: none; background: var(--ve-seg); }
.ve-seg-label { position: absolute; left: 6px; bottom: 4px; font-size: 10px; font-family: var(--ad-font-mono); color: var(--ve-text); background: rgba(0,0,0,.55); border-radius: 4px; padding: 1px 5px; pointer-events: none; white-space: nowrap; }
.ve-handle { position: absolute; top: 0; width: 12px; height: 100%; cursor: ew-resize; z-index: 2; }
.ve-handle.left { left: 0; } .ve-handle.right { right: 0; }
.ve-handle i { position: absolute; top: 50%; transform: translateY(-50%); width: 3px; height: 20px; border-radius: 2px; background: rgba(255,255,255,.55); left: 4px; }
.ve-handle.right i { left: auto; right: 4px; }
.ve-handle:hover i { background: var(--ad-brand); }
.ve-dropline { position: absolute; top: 0; height: 100%; width: 2px; background: var(--ad-brand); box-shadow: 0 0 8px color-mix(in srgb, var(--ad-brand) 90%, transparent); border-radius: 1px; pointer-events: none; }
.ve-playhead { position: absolute; top: 0; height: 100%; width: 0; z-index: 6; pointer-events: none; border-left: 1.5px solid #f43f5e; }
.ve-playhead-knob { position: absolute; top: 18px; left: -6px; width: 11px; height: 11px; border-radius: 3px; background: #f43f5e; pointer-events: auto; cursor: ew-resize; }
.ve-thumb-video { position: absolute; width: 2px; height: 2px; opacity: 0; pointer-events: none; }

/* 移动端：主体纵向、检查器收窄、快捷键提示隐藏 */
@media (max-width: 768px) {
  .ve-top-name { max-width: 34vw; }
  .ve-main { flex-direction: column; }
  .ve-inspector { width: auto; border-left: none; border-top: 1px solid var(--ve-border); flex-direction: row; align-items: center; gap: 10px; padding: 10px 14px; overflow-x: auto; overflow-y: hidden; }
  .ve-inspector-title { white-space: nowrap; }
  .ve-field { flex-direction: row; align-items: center; gap: 6px; white-space: nowrap; }
  .ve-input { width: 108px; }
  .ve-inspector-row, .ve-shortcut { display: none; }
  .ve-inspector-del { width: auto; flex-shrink: 0; }
  .ve-video { max-height: calc(100% - 104px); }
  .ve-lane-content { height: 92px; }
  .ve-lane { top: 26px; height: 60px; }
  .ve-seg { height: 52px; }
}
</style>

<!-- teleport 到 body 的弹层：scoped 样式挂不上，须放非 scoped 块（挂自定义根类） -->
<style lang="scss">
.ve-export-dialog .el-dialog__body { padding-top: 6px; }
.ve-export-dialog .ve-export-res { flex-wrap: wrap; } /* 六档按钮窄屏折行 */
.ve-export-body { display: flex; flex-direction: column; gap: 14px; }
.ve-export-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13.5px; color: var(--ad-text-soft); flex-wrap: wrap; }
.ve-export-row b { color: var(--ad-text-strong); }
.ve-export-row.cost b { color: var(--ad-brand); font-size: 15px; }
.ve-export-row.warn { font-size: 12.5px; color: var(--ad-warning); background: rgba(251,191,36,0.14); border: 1px solid color-mix(in srgb, var(--ad-warning) 30%, transparent); border-radius: 8px; padding: 6px 10px; }
.ve-done-dialog .ve-done-body { display: flex; flex-direction: column; gap: 10px; }
.ve-done-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.ve-done-meta span { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--ad-brand-soft); color: var(--ad-brand); }
.ve-done-tip { font-size: 13px; color: var(--ad-text-soft); margin: 0; line-height: 1.6; }
</style>
