<script setup>
/**
 * 全屏视频播放弹层（miniclient 约定：页面不内嵌 video 预览，统一全屏弹层可关）。
 * 布局：顶部项目统一 AdNavbar（back 只关层不退页，见 ad-navbar 的 autoBack）+ 下方视频子窗口（flex:1），
 * 两者不重叠——App 端 video 是原生浮层，改流内上下结构后不会再盖住顶栏。
 * 根节点挂 ad-page + theme.rootCls（主题令牌进弹层子树，浅色下整层暖纸色），视频底色随 --ad-ink。
 * 关闭时暂停播放；uni.createVideoContext 跨端可用。
 * 全屏走 uni 内置控制条的全屏按钮（与展示中心播放页 detail.vue 完全同款）：
 * H5 端 uni 对整个容器（含自绘控制条）requestFullscreen，无元素全屏能力时
 * （iOS/X5）退化为 uni-video-type-fullscreen CSS 全屏——两种形态控制条都在、
 * 再点同一按钮即可退出。勿再改成对裸 <video> 做 DOM 原生全屏：裸元素无控制条、
 * 弹层顶栏也在全屏元素外，会"进得去出不来"。
 * iOS App 端例外：系统全屏由原生播放器自绘，会在刘海里画一个「退出全屏」箭头
 * （原生层最高，无开关可隐藏，全屏后 cover-view 也盖不住，只能不走系统全屏）——
 * 故 iOS 隐藏原生全屏钮，顶栏右槽给展开钮进入弹层内自绘全屏：藏顶栏、画面撑满，
 * 退出用 video 内 cover-view 小圆钮（非系统全屏时 cover-view 可覆盖原生 video 层）。
 * Android/鸿蒙/H5 仍走原全屏链路（与 detail.vue 同款）。
 * iOS App 端原生 video 层还会吞掉 touch 事件（安卓会转发给页面、iOS 不转发，官方已知差异）：
 * swipeable 竖滑切镜手势在 iOS 收不到，故 iOS 额外在画面左右缘给 cover-view 阶跃钮
 * （← 上一镜 / → 下一镜）点按兜底，复用同一对 prev/next 事件。
 * swipeable：竖滑切镜手势开关（上滑 next / 下滑 prev），切到哪条由调用方接事件决定。
 * 跟手拖动 → 松手判定 → 整屏滑出后在画面外换源、再从对侧滑入（抖音式）；
 * hasPrev/hasNext 为 false 的方向给橡皮筋阻尼并回弹，不发事件。
 * 换 src 后自动续播（autoplay 只在首挂载生效）。
 * 注意：App 端 video 是原生浮层，CSS transform 可能带不动画面（H5/小程序同层渲染无此问题）。
 */
import { ref, watch, computed, nextTick, getCurrentInstance, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { toAbsolute } from '../../utils/media';
import { statusBarHeight } from '../../utils/system';
import { useThemeStore } from '../../stores/theme';
import { useHarmonyVideoOrientation } from '../../composables/useHarmonyVideoOrientation';
import AdNavbar from '../ad-navbar/ad-navbar.vue';

// 鸿蒙端全屏方向纠正（非鸿蒙为空实现，见 composable 注释）
const hvo = useHarmonyVideoOrientation();
const { t } = useI18n();
// 主题令牌进弹层子树（AdNavbar / 审阅钮吃 --ad-*；浅色下整层切暖纸色）
const themeStore = useThemeStore();

const props = defineProps({
  show: { type: Boolean, default: false },
  url: { type: String, default: '' },
  poster: { type: String, default: '' },
  title: { type: String, default: '' },
  aspect: { type: String, default: '9:16' },
  // 竖滑切镜开关（分镜预览用）：开启后上滑/下滑向外抛 next/prev，由调用方决定切到哪条
  swipeable: { type: Boolean, default: false },
  // 两个方向还有没有内容（控制边缘橡皮筋回弹，false 的方向拖动有阻尼且不触发切换）
  hasPrev: { type: Boolean, default: true },
  hasNext: { type: Boolean, default: true },
  // 审阅开关（分镜/成片预览用）：开启后顶栏右侧出「审阅/已审」钮，点按向外抛 review（携带取反后的布尔），
  // 已审态由调用方经 reviewed 传入；reviewing 为请求进行中
  reviewable: { type: Boolean, default: false },
  reviewed: { type: Boolean, default: false },
  reviewing: { type: Boolean, default: false },
  // 删除开关（分镜预览用）：开启后顶栏左侧（返回键旁）出「删除视频」钮，点按向外抛 delete；
  // 确认弹窗、落库与删除后切镜都由调用方处理；deleting 为请求进行中（防连点）
  deletable: { type: Boolean, default: false },
  deleting: { type: Boolean, default: false },
});
const emit = defineEmits(['update:show', 'close', 'prev', 'next', 'review', 'delete']);
// 出口统一转绝对地址（toAbsolute 幂等，调用方已拼好的绝对地址原样通过）
const src = computed(() => toAbsolute(props.url));
const posterSrc = computed(() => toAbsolute(props.poster));
// 横屏画幅（16:9）全屏时逆时针转 90°（home 键在右）；竖屏/方形保持正向
const direction = computed(() => (props.aspect === '16:9' ? 90 : 0));
const vid = 'vpp-video';
const instance = getCurrentInstance();

// iOS App 端不走系统全屏（原因见文件头注释）：iOS 只判一次、非响应式
let isIOSApp = false;
/* #ifdef APP-PLUS */
isIOSApp = uni.getSystemInfoSync().platform === 'ios';
/* #endif */
// iOS 自绘全屏态：顶栏藏起、画面撑满，cover-view 小圆钮退出
const iosFull = ref(false);

// video 延迟挂载开关：App 端 video 是原生层，弹层刚挂载、布局（导航栏状态栏占位等）未稳时
// 创建会按首帧 rect 定位，布局落定后不重同步，顶栏与画面间留一条底色缝——
// 等布局稳定再挂 video，原生层一次定位到位（H5/小程序同层渲染无此问题，延迟无感）
const videoReady = ref(false);
let videoTimer = null;

watch(() => props.show, (v) => {
  if (videoTimer) { clearTimeout(videoTimer); videoTimer = null; }
  videoReady.value = false;
  if (!v) {
    iosFull.value = false; // 自绘全屏态随弹层一起复位
    try { uni.createVideoContext(vid, instance).pause(); } catch (e) { /* ignore */ }
    hvo.restore(); // 兜底：即使没收到退出全屏事件，关闭弹层也恢复竖屏
    // 复位切镜手势/动画状态（可能在动画中途被关掉）
    clearAnimTimers();
    dragOn = false;
    swipeStart = null;
    stageAnim.value = false;
    stageJump.value = false;
    dragOffset.value = '0px';
    return;
  }
  // App/鸿蒙端 video 是原生层：布局未稳时创建会按首帧 rect 定位、布局落定后不重同步，
  // 顶栏与画面间留一条底色缝——等布局稳定再挂 video，原生层一次定位到位。
  // H5/小程序同层渲染跟随 DOM 无此问题，立即挂载不延迟起播。
  /* #ifdef APP-PLUS || APP-HARMONY */
  nextTick(() => {
    videoTimer = setTimeout(() => { videoTimer = null; videoReady.value = true; }, 60);
  });
  /* #endif */
  /* #ifndef APP-PLUS || APP-HARMONY */
  videoReady.value = true;
  /* #endif */
});

// 切换 src（上下滑切镜）后自动续播：autoplay 只在首挂载生效，换源要手动 play
watch(() => props.url, (nv, ov) => {
  if (!props.show || !nv || nv === ov) return;
  nextTick(() => { try { uni.createVideoContext(vid, instance).play(); } catch (e) { /* ignore */ } });
});

// ===== 竖滑切镜：跟手拖动 → 松手判定 → 滑出/滑入补间 =====
// 跟手阶段无 transition 实时跟随；松手后 260ms 滑出屏幕，在画面外换 src（next/prev），
// 瞬移到对侧（transition 强制关）再 260ms 滑回原位。首/末镜越界拖动给 0.3 倍橡皮筋阻尼。
const dragOffset = ref('0px'); // 画面实时位移（px 或百分比字符串）
const stageAnim = ref(false);  // 松手后的补间中（transition 开）
const stageJump = ref(false);  // 换源瞬移帧（transition 强制关）
let swipeStart = null;         // { x, y, time }
let dragOn = false;            // 已进入竖滑跟手（横滑/点按不进入）
let animTimer = null;
function clearAnimTimers() {
  if (animTimer) { clearTimeout(animTimer); animTimer = null; }
}
function onTouchStart(e) {
  if (!props.swipeable || stageAnim.value) { swipeStart = null; return; }
  clearAnimTimers(); // 兜底：正常时该阶段无挂起定时器
  const t = e.touches && e.touches[0];
  swipeStart = t ? { x: t.clientX, y: t.clientY, time: Date.now() } : null;
  dragOn = false;
}
function onTouchMove(e) {
  if (!props.swipeable || !swipeStart || stageAnim.value) return;
  const t = e.touches && e.touches[0];
  if (!t) return;
  const dy = t.clientY - swipeStart.y;
  const dx = t.clientX - swipeStart.x;
  if (!dragOn) {
    // 斜着走或横向拖（拖进度条/进度手势）不进入跟手
    if (Math.abs(dy) <= 10 || Math.abs(dy) <= Math.abs(dx)) return;
    dragOn = true;
  }
  const edge = (dy > 0 && !props.hasPrev) || (dy < 0 && !props.hasNext);
  dragOffset.value = (edge ? dy * 0.3 : dy).toFixed(1) + 'px';
}
function onTouchEnd(e) {
  const start = swipeStart;
  swipeStart = null;
  if (!props.swipeable || !start || stageAnim.value || !dragOn) return;
  dragOn = false;
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) { // 异常事件：停在跟手位置也要弹回原位
    stageAnim.value = true;
    dragOffset.value = '0px';
    animTimer = setTimeout(() => { stageAnim.value = false; animTimer = null; }, 260);
    return;
  }
  const dy = t.clientY - start.y;
  const dt = Date.now() - start.time;
  const dir = dy < 0 ? 1 : -1; // 上滑 → 下一镜(+1)，下滑 → 上一镜(-1)
  const towardVoid = (dir > 0 && !props.hasNext) || (dir < 0 && !props.hasPrev);
  // 判定：滑距够远，或快速轻扫；越界方向一律回弹
  const commit = !towardVoid && (Math.abs(dy) >= 60 || (Math.abs(dy) >= 30 && dt < 250));
  stageAnim.value = true;
  if (!commit) {
    dragOffset.value = '0px';
    animTimer = setTimeout(() => { stageAnim.value = false; animTimer = null; }, 260);
    return;
  }
  dragOffset.value = dir > 0 ? '-100%' : '100%'; // 顺着拖动方向滑出屏幕
  animTimer = setTimeout(() => {
    animTimer = null;
    emit(dir > 0 ? 'next' : 'prev');
    stageJump.value = true;                      // 画面外瞬移到对侧
    dragOffset.value = dir > 0 ? '100%' : '-100%';
    animTimer = setTimeout(() => {
      animTimer = null;
      stageJump.value = false;
      dragOffset.value = '0px';                  // 从对侧滑入
      animTimer = setTimeout(() => { stageAnim.value = false; animTimer = null; }, 280);
    }, 50);
  }, 260);
}
function onTouchCancel() {
  // 手势被系统打断：停在哪都弹回原位
  const start = swipeStart;
  swipeStart = null;
  dragOn = false;
  if (!start || stageAnim.value) return;
  stageAnim.value = true;
  dragOffset.value = '0px';
  animTimer = setTimeout(() => { stageAnim.value = false; animTimer = null; }, 260);
}
onUnmounted(clearAnimTimers);
onUnmounted(() => { if (videoTimer) clearTimeout(videoTimer); });

// 鸿蒙端全屏方向纠正已抽到 useHarmonyVideoOrientation（showcase/detail 内联播放器同样要用）
function onFullscreenChange(e) {
  hvo.onFullscreenChange(e, props.aspect);
}

/* #ifdef H5 */
// 系统返回手势/浏览器返回键：弹层开着时只关弹层、不退页。
// 打开时压一条历史记录，popstate 时消费它来关层；UI 关闭时把压入的记录退掉。
let historyPushed = false;
function onWinPopState() {
  if (props.show) {
    historyPushed = false; // 该条历史已被浏览器消费，UI 关闭路径无需再退
    close();
  }
}
watch(() => props.show, (v, ov) => {
  if (v && !ov) {
    history.pushState({ vppGuard: true }, '');
    historyPushed = true;
    window.addEventListener('popstate', onWinPopState);
  } else if (!v && ov) {
    window.removeEventListener('popstate', onWinPopState);
    if (historyPushed) {
      historyPushed = false;
      history.back();
    }
  }
});
onUnmounted(() => {
  window.removeEventListener('popstate', onWinPopState);
  if (historyPushed) history.back();
});
/* #endif */

function close() {
  emit('update:show', false);
  emit('close');
}
// 审阅按钮：已审态点按 = 取消审阅（取反抛给调用方落库）
function toggleReview() {
  if (props.reviewing) return;
  emit('review', !props.reviewed);
}
// 删除按钮：deleting 期间防连点，确认与切镜由调用方处理
function requestDelete() {
  if (props.deleting) return;
  emit('delete');
}
// iOS 竖滑兜底钮（原生 video 层吞 touch，见文件头注释）：350ms 节流防连点一次跳两镜
let iosStepLock = null;
function iosStep(dir) {
  if (iosStepLock) return;
  if (dir < 0 ? !props.hasPrev : !props.hasNext) return; // 与手势同规则：尽头方向不发事件
  iosStepLock = setTimeout(() => { iosStepLock = null; }, 350);
  emit(dir < 0 ? 'prev' : 'next');
}
onUnmounted(() => { if (iosStepLock) { clearTimeout(iosStepLock); iosStepLock = null; } });
</script>

<template>
  <view v-if="show" class="vpp ad-page" :class="themeStore.rootCls" @touchmove.stop.prevent>
    <!-- 正常标题栏：项目统一 AdNavbar（状态栏占位/胶囊让位/衬线居中标题全自带）；
         back 在弹层里语义是关层而非退页，关掉 autoBack。
         iOS 自绘全屏态下整条藏起（v-show），画面撑满弹层 -->
    <AdNavbar v-show="!iosFull" :title="title" :auto-back="false" @back="close">
      <template #left>
        <!-- 删除钮（deletable 开启才渲染，返回键旁的左上角位）：点按向外抛 delete -->
        <view v-if="deletable" class="vpp-del" :class="{ dis: deleting }" @tap.stop="requestDelete">
          <m-icon name="trash" :size="11" />
          <text>{{ t('common.delete') }}</text>
        </view>
      </template>
      <template #right>
        <!-- iOS 自绘全屏入口：系统全屏会在刘海里画退出箭头且无法隐藏，iOS 不提供 -->
        <view v-if="isIOSApp" class="vpp-expand" @tap.stop="iosFull = true">
          <m-icon name="expand" :size="15" />
        </view>
        <!-- 审阅钮（reviewable 开启才渲染）：未审点按标记已审，已审再点取消 -->
        <view
          v-if="reviewable"
          class="vpp-review"
          :class="{ done: reviewed, dis: reviewing }"
          @tap.stop="toggleReview"
        >
          <m-icon v-if="!reviewing" name="check" :size="11" :color="reviewed ? '#0a0a0f' : ''" :sw="3" />
          <text>{{ reviewing ? '…' : (reviewed ? t('episode.videos.reviewed') : t('episode.videos.review')) }}</text>
        </view>
      </template>
    </AdNavbar>
    <!-- 视频子窗口：标题栏下方独立区域；切镜手势只绑在这层，标题栏不参与 -->
    <view
      class="vpp-stage"
      :class="{ 'vpp-stage-anim': stageAnim, 'vpp-stage-jump': stageJump }"
      :style="dragOffset === '0px' ? {} : { transform: 'translateY(' + dragOffset + ')' }"
      @touchstart="onTouchStart"
      @touchmove.stop.prevent="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
    >
      <video
        v-if="videoReady"
        :id="vid"
        class="vpp-video"
        :src="src"
        :poster="posterSrc"
        controls
        autoplay
        object-fit="contain"
        show-center-play-btn
        play-strategy="0"
        :enable-progress-gesture="true"
        :direction="direction"
        :show-fullscreen-btn="!isIOSApp"
        @fullscreenchange="onFullscreenChange"
      >
        <!-- iOS 自绘全屏的退出钮：DOM 会被原生 video 层盖住，必须用 cover-view；
             top 用状态栏高度避开刘海（系统全屏的箭头正是栽在这里）。
             仅非系统全屏态下存在——此时 cover-view 覆盖 video 是 App 端官方能力。
             圆底与字形拆成平级两层、@tap 只挂「直接文本」的那层：原生 cover-view 嵌套子层
             的点按在 iOS 大多不响应（实测嵌套后 ✕/▲▼ 基本点不到），最简单层结构才可靠；
             字形层透明、相对圆心上移——原生文字顶对齐（line-height/flex 居中不生效），
             顶对齐字形 ink 高约半个字号，上移后正好落进圆底圆心 -->
        <cover-view v-if="isIOSApp && iosFull" class="vpp-full-exit-bg" :style="{ top: (statusBarHeight() + 30) + 'px' }" />
        <cover-view v-if="isIOSApp && iosFull" class="vpp-full-exit" :style="{ top: (statusBarHeight() + 38) + 'px' }" @tap="iosFull = false">✕</cover-view>
        <!-- iOS 原生 video 层吞 touch（安卓转发、iOS 不转发），竖滑切镜手势在 iOS 收不到——
             左右缘 cover-view 阶跃钮兜底，走同一对 prev/next 事件；层拆分原因同上 -->
        <cover-view v-if="swipeable && isIOSApp" class="vpp-shot-btn-bg vpp-shot-prev-bg" />
        <cover-view v-if="swipeable && isIOSApp" class="vpp-shot-btn vpp-shot-prev" @tap="iosStep(-1)">←</cover-view>
        <cover-view v-if="swipeable && isIOSApp" class="vpp-shot-btn-bg vpp-shot-next-bg" />
        <cover-view v-if="swipeable && isIOSApp" class="vpp-shot-btn vpp-shot-next" @tap="iosStep(1)">→</cover-view>
      </video>
    </view>
  </view>
</template>

<style scoped>
.vpp {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 900;
  background: var(--ad-ink); /* 主题底色：深色放映厅黑 / 浅色暖纸色，切镜滑出同色无缝 */
  display: flex; flex-direction: column;
  padding-bottom: 0; /* 覆盖 ad-page 的页尾呼吸空间，全屏弹层用不上 */
}
.vpp-video { width: 100%; height: 100%; }
/* 切镜舞台 = 标题栏下方的视频子窗口：跟手/滑出滑入都作用在这层，标题栏留在外面不跟着动。
   弹层同底色，滑出一个子窗口高在视觉上等同滑出整屏。
   注意：基类不挂 will-change、dragOffset=0 时模板也不写 transform——App 端原生 video 层
   遇到带 transform/will-change 的祖先会按错误参考系定位（实测画面整体偏下一次状态栏高），
   只有切镜补间/瞬移阶段才临时挂（跟手阶段 App 端原生层本就带不动，H5/小程序无碍） */
.vpp-stage { flex: 1 1 0; min-height: 0; width: 100%; }
.vpp-stage-anim { transition: transform 0.26s cubic-bezier(0.22, 0.61, 0.36, 1); will-change: transform; }
.vpp-stage-jump { transition: none !important; will-change: transform; }
/* 审阅钮（导航栏右插槽）：未审 inset 底+描边随主题，已审绿底深字；reviewing 时置灰。
   flex:none+nowrap：右槽放不下时按钮不许被压窄/折行（iOS 端同槽还有全屏钮），由槽自适应加宽 */
.vpp-review {
  display: flex; align-items: center; gap: 4px; flex: none;
  padding: 0 12px; height: 30px; border-radius: 15px; white-space: nowrap;
  background: var(--ad-inset); border: 1px solid var(--ad-line-strong);
  color: var(--ad-text);
}
.vpp-review text { font-size: 12px; font-weight: 600; white-space: nowrap; }
.vpp-review.done { background: var(--ad-success); border-color: var(--ad-success); }
.vpp-review.done text { color: #0a0a0f; }
.vpp-review.dis { opacity: 0.5; }
/* 删除钮（导航栏左槽，返回键旁）：布局与右槽审阅钮同款，字形红色警示；deleting 时置灰。
   左边距让开返回键（同右槽全屏钮 margin-right 的让位做法） */
.vpp-del {
  display: flex; align-items: center; gap: 4px; flex: none;
  margin-left: 8px;
  padding: 0 12px; height: 30px; border-radius: 15px; white-space: nowrap;
  background: var(--ad-inset); border: 1px solid var(--ad-line-strong);
  color: var(--ad-danger);
}
.vpp-del text { font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--ad-danger); }
.vpp-del.dis { opacity: 0.5; }
/* iOS 自绘全屏入口（顶栏右槽）：与审阅钮同高的描边小圆钮；
   flex:none 防右槽紧张时被压缩成椭圆（iOS 端与审阅钮并排会超右槽定宽） */
.vpp-expand {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 30px; height: 30px; border-radius: 15px; margin-right: 8px;
  background: var(--ad-inset); border: 1px solid var(--ad-line-strong);
  color: var(--ad-text);
}
/* iOS 自绘全屏退出钮（video 内 cover-view）：圆底与字形两层平级叠放——原生 cover-view
   嵌套子层的点按事件在 iOS 大多不响应（见模板注释），只有「直接文本+自身 @tap」可靠。
   垂直居中不靠原生（line-height/flex 均不生效、文字顶对齐）：字形层透明盒相对圆底
   上移半个 ink 高（≈字号/2），顶对齐字形正好落进圆心；透明盒也吃点（原生按矩形命中） */
.vpp-full-exit-bg {
  position: absolute; right: 12px;
  width: 32px; height: 32px; border-radius: 16px;
  background-color: rgba(15, 15, 20, 0.5);
}
.vpp-full-exit {
  position: absolute; right: 12px;
  width: 32px; height: 32px;
  color: #ffffff; font-size: 15px; text-align: center;
}
/* iOS 竖滑切镜兜底钮（原生层吞 touch，见文件头注释）：左右缘半透明圆钮，← 上一镜 / → 下一镜。
   层拆分与居中原理同 vpp-full-exit：字形层 top:50% 再上移 7px（字号 14 的 ink 半高） */
.vpp-shot-btn-bg {
  position: absolute; top: 50%; margin-top: -18px;
  width: 36px; height: 36px; border-radius: 18px;
  background-color: rgba(15, 15, 20, 0.5);
}
.vpp-shot-prev-bg { left: 12px; }
.vpp-shot-next-bg { right: 12px; }
.vpp-shot-btn {
  position: absolute; top: 50%;
  width: 36px; height: 36px;
  color: #ffffff; font-size: 14px; text-align: center;
}
.vpp-shot-prev { left: 12px; margin-top: -7px; }
.vpp-shot-next { right: 12px; margin-top: -7px; }
</style>
