<script setup>
/**
 * 点选文字验证码弹窗：登录前的人机校验（client CaptchaDialog 移植）。
 * 打开即向本系统后端取题（SVG dataURL，按 locale 选字符池），按提示顺序点击图中文字，
 * 校验通过后 emit('success', ticket) —— 页面携带 ticket 再发起登录请求。
 * 坐标采集跨端差异：changedTouches/clientX（H5/App/mp 通用）+ selectorQuery 实测矩形换算 viewBox。
 */
import { ref, watch, getCurrentInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { captchaApi } from '../../api';

const props = defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue', 'success']);
const { t } = useI18n();
const instance = getCurrentInstance();

const loading = ref(false);
const verifying = ref(false);
const challenge = ref(null); // { id, image, tipChars, width, height }
const points = ref([]);      // 已点击点（题目 viewBox 坐标，按点击顺序）

// 打开弹窗即拉新题（每题一次性消费，重开必然换题）；
// immediate：页面侧用 v-if 挂载即弹（挂载时 modelValue 已为 true，需立即取题）
watch(() => props.modelValue, (v) => { if (v) loadChallenge(); }, { immediate: true });

function close() { emit('update:modelValue', false); }

async function loadChallenge() {
  loading.value = true;
  points.value = [];
  try {
    challenge.value = await captchaApi.challenge();
  } catch {
    challenge.value = null; // http 层已提示；置空展示空态，用户可点「换一张」重试
  } finally {
    loading.value = false;
  }
}

// 从事件提取视口坐标（H5 鼠标 / 触摸 changedTouches / 小程序 changedTouches 通用）
function ptOf(e) {
  const t0 = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
  if (t0 && typeof t0.clientX === 'number') return { x: t0.clientX, y: t0.clientY };
  if (typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY };
  return null;
}

// 一次物理点按在触摸环境下是一对「孪生事件」：touchend + 浏览器派生的合成 mousedown。
// 两个事件都记点会把一次点击变成两点（序号 1/2、3/4 重叠只见 2、4，且提前占满 4 个点后无法再点）。
// 各运行时的派生时序不一致（标准是先 touchend 后 mousedown，harmony 会颠倒成先 mousedown 后
// touchend，且给 mousedown 注入合成 changedTouches），不能靠事件类型或先后顺序判断，
// 改为按「间隔极短 + 坐标几乎不变」识别同一次点按，只记第一个到达的事件。
const TWIN_MS = 300;  // 孪生事件最大间隔：同一次点按的两个事件相差通常不足几帧
const TWIN_DIST = 20; // 孪生事件坐标偏移上限（css px，远小于图内相邻文字间距）
let lastTap = { at: 0, x: 0, y: 0 };

// 点击图片：换算为题目 viewBox 坐标（弹窗自适应缩放，图可能被缩放）
function onImageTap(e) {
  if (!challenge.value || verifying.value || loading.value) return;
  if (points.value.length >= challenge.value.tipChars.length) return;
  const pt = ptOf(e);
  if (!pt) return;
  const now = Date.now();
  if (now - lastTap.at < TWIN_MS && Math.abs(pt.x - lastTap.x) < TWIN_DIST && Math.abs(pt.y - lastTap.y) < TWIN_DIST) {
    return; // 同一次点按的孪生事件，不重复记点
  }
  lastTap = { at: now, x: pt.x, y: pt.y };
  uni.createSelectorQuery().in(instance)
    .select('.cap-img')
    .boundingClientRect((rect) => {
      if (!rect || !challenge.value) return;
      points.value.push({
        x: ((pt.x - rect.left) / rect.width) * challenge.value.width,
        y: ((pt.y - rect.top) / rect.height) * challenge.value.height,
      });
    })
    .exec();
}

// 点击已选序号：截断该点及其后的点（改选）。
// 触摸端（H5 手机浏览器）一次点按在 touchend 之后浏览器会派生合成 mousedown：
// 此时图上刚渲染出序号标记，合成事件命中的是标记而不是图片 → 不拦会把刚记录的点
// 立刻截掉，表现为「点了图中文字序号一闪就没了」（桌面鼠标无 touchend 无此问题，
// 鸿蒙 App 的 WebView 先 mousedown 后 touchend 也不触发）。沿用上方孪生判定：
// 紧随最近一次点按、坐标几乎不变的标记点击视作合成事件忽略；真正的改选点击放行，
// 且记入 lastTap——截断后该处标记消失，紧随的合成 mousedown 会落回图上，
// 靠这条记录被 onImageTap 的孪生判定拦住，避免把截掉的点又加回来。
function onMarkerClick(i, e) {
  if (verifying.value) return;
  const pt = ptOf(e);
  const now = Date.now();
  if (pt && now - lastTap.at < TWIN_MS && Math.abs(pt.x - lastTap.x) < TWIN_DIST && Math.abs(pt.y - lastTap.y) < TWIN_DIST) {
    return; // 同一次点按的孪生事件，不当作改选
  }
  if (pt) lastTap = { at: now, x: pt.x, y: pt.y };
  points.value = points.value.slice(0, i);
}

async function onConfirm() {
  if (!challenge.value || points.value.length !== challenge.value.tipChars.length || verifying.value) return;
  verifying.value = true;
  try {
    const { ticket } = await captchaApi.verify({ id: challenge.value.id, points: points.value });
    // 验证通过不打 toast，直接关窗（后续动作各自有提示）
    close();
    emit('success', ticket);
  } catch {
    // http 层已提示失败原因；换新题重来
    loadChallenge();
  } finally {
    verifying.value = false;
  }
}
</script>

<template>
  <view class="ad-mask" :class="{ on: modelValue }" @tap="close" @touchmove.stop.prevent="() => {}" />
  <view class="ad-sheet cap" :class="{ on: modelValue }" @touchmove.stop="() => {}">
    <view class="grab" @tap="close" />
    <view class="cap-title">{{ t('captcha.title') }}</view>

    <view class="cap-body">
      <template v-if="challenge">
        <view class="cap-tip">
          <text class="cap-tip-label">{{ t('captcha.tipOrder') }}</text>
          <view v-for="(ch, i) in challenge.tipChars" :key="i" class="cap-chip">
            <text class="cap-chip-idx">{{ i + 1 }}</text>
            <text>{{ ch }}</text>
          </view>
        </view>
        <view class="cap-imgwrap">
          <image
            class="cap-img"
            :src="challenge.image"
            mode="widthFix"
            @touchend="onImageTap"
            @mousedown="onImageTap"
          />
          <view
            v-for="(p, i) in points"
            :key="i"
            class="cap-marker"
            :style="{ left: `${(p.x / challenge.width) * 100}%`, top: `${(p.y / challenge.height) * 100}%` }"
            @touchend.stop="onMarkerClick(i, $event)"
            @mousedown.stop="onMarkerClick(i, $event)"
          >{{ i + 1 }}</view>
        </view>
        <view class="cap-tools">
          <text class="cap-tool" :class="{ dim: verifying || !points.length }" @tap="!verifying && (points = [])">{{ t('captcha.clear') }}</text>
          <text class="cap-tool" :class="{ dim: verifying }" @tap="!verifying && loadChallenge()">{{ t('captcha.refresh') }}</text>
        </view>
      </template>
      <view v-else class="cap-empty">
        <text class="cap-tool" @tap="loadChallenge">{{ t('captcha.refresh') }}</text>
      </view>
    </view>

    <view class="cap-foot">
      <view class="mbtn ghost" @tap="close">{{ t('captcha.cancel') }}</view>
      <view
        class="mbtn"
        :class="{ dis: verifying || !challenge || !challenge.tipChars || points.length !== challenge.tipChars.length }"
        @tap="onConfirm"
      >{{ t('captcha.confirm') }}</view>
    </view>
  </view>
</template>

<style scoped>
.cap { padding-bottom: calc(20px + env(safe-area-inset-bottom)); }
.cap-title { font-family: var(--ad-font-serif); font-weight: 900; font-size: 18px; color: var(--ad-text); padding-bottom: 12px; }
.cap-body { min-height: 240px; }
.cap-empty { min-height: 240px; display: flex; align-items: center; justify-content: center; }
.cap-tip { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.cap-tip-label { font-size: 14px; color: var(--ad-text-soft); }
.cap-chip {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border: 1px solid var(--ad-line); border-radius: 8px;
  font-size: 19px; font-weight: 700; color: var(--ad-text);
  background: var(--ad-inset);
}
.cap-chip-idx {
  position: absolute; top: -6px; left: -6px;
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  font-size: 10px; text-align: center; line-height: 15px;
}
.cap-imgwrap {
  position: relative; border-radius: 12px; overflow: hidden;
  border: 1px solid var(--ad-line); line-height: 0;
}
.cap-img { display: block; width: 100%; }
.cap-marker {
  position: absolute; transform: translate(-50%, -50%);
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--ad-brand); color: var(--ad-brand-contrast); font-size: 12px;
  text-align: center; line-height: 22px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
}
.cap-tools { display: flex; justify-content: flex-end; gap: 14px; margin-top: 10px; }
.cap-tool { font-size: 13px; color: var(--ad-brand); }
.cap-tool.dim { opacity: 0.45; }
.cap-foot { display: flex; gap: 10px; padding-top: 14px; }
.cap-foot .mbtn { flex: 1; }
</style>
