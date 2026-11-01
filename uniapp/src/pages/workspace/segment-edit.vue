<script setup>
/**
 * 分镜编辑独立页（storyboard 页「编辑」navigateTo 进入，替代原 segment-edit-popup 全屏窗）：
 * 顶部自绘导航（返回钮 + 标题 + 保存，全局 navigationStyle=custom 故自管状态栏高度），
 * 主体可滚动表单；字段与保存 API 与原弹层一致（PUT /segments/:sid 部分更新）。
 * 数据传入：无单镜 GET 路由，走 EventChannel（storyboard 页 navigateTo success 时 emit
 * 'segment'）；通道未送达则表单空挂、返回即走不保存。保存后 uni.$emit('segment:updated')
 * 由 storyboard 页回填列表，navigateBack 返回。
 */
import { ref, reactive, computed, nextTick, getCurrentInstance } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { storyboardApi } from '../../api';
import { toast, confirm, selectSheet } from '../../utils/ui';
import { statusBarHeight } from '../../utils/system';
import { useThemeStore } from '../../stores/theme';
import { useBackGuard } from '../../composables/useBackGuard';
import { backToParent } from '../../utils/back';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

const { t } = useI18n();
const theme = useThemeStore();
const instance = getCurrentInstance();

let sid = null; // 分镜 id（/pages/workspace/segment-edit?sid=xxx&eid=xxx）

// 转场值域与 storyboard 页共用同一份（值语义由服务端/剧本生成侧约定）
const TRANSITION_VALUES = ['cut', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'circleclose', 'radial', 'pixelize'];
const normTrans = (v) => (!v || v === 'auto' ? 'cut' : v);
const TRANSITION_OPTIONS = computed(() => TRANSITION_VALUES.map((v) => ({ value: v, label: t('storyboard.transition.' + v) })));
const transLabel = computed(() => t('storyboard.transition.' + form.transition));

const saving = ref(false);
const form = reactive({ title: '', shot_no: '', scene_no: null, scene_script: '', video_prompt: '', duration: 5, transition: 'cut' });
const formObj = () => ({
  title: form.title, shot_no: form.shot_no, scene_no: form.scene_no,
  scene_script: form.scene_script, video_prompt: form.video_prompt,
  duration: form.duration, transition: form.transition,
});
let snapshot = '';
const dirty = computed(() => !!seg.value && JSON.stringify(formObj()) !== snapshot);

// 回填表单。关键平台坑：App/小程序端 uni-input 吃不到「挂载帧上的初始值」——
// 数据先到、表单带值首挂 → input 带初值挂载 → App 端初值不渲染。因此收到数据后
// 先空表单挂载、nextTick 后再回填：input 通过「挂载后的更新」拿值（与用户输入同路径）。
const seg = ref(null);
let loadedId = null;
function populate(s) {
  if (!s || s.id === loadedId) return;
  loadedId = s.id;
  seg.value = s;
  Object.assign(form, {
    title: s.title || '',
    shot_no: s.shot_no || '', scene_no: s.scene_no ?? null,
    scene_script: s.scene_script || '',
    video_prompt: s.video_prompt || '',
    duration: s.duration || 5, transition: normTrans(s.transition),
  });
  snapshot = JSON.stringify(formObj());
  saving.value = false;
}

onLoad((q) => {
  sid = q?.sid || null;
  // EventChannel：navigateTo success 时由打开方 emit('segment', s)；H5/App/小程序通用，
  // 未送达（深链直开/通道异常）时 seg 保持空——表单空挂、返回即走不保存
  const ch = instance?.proxy?.getOpenerEventChannel?.();
  ch?.on?.('segment', (s) => nextTick(() => populate(s)));
});

// 时长/转场下拉：主题化底部选择面板（selectSheet），弃用系统原生 picker
const DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
async function pickDuration() {
  const k = await selectSheet({ title: t('storyboard.fieldDurationSeconds'), items: DURATIONS.map((d) => ({ key: String(d), label: d + 's' })), current: String(form.duration) });
  if (k !== null) form.duration = Number(k);
}
async function pickTransition() {
  const k = await selectSheet({ title: t('storyboard.fieldTransition'), items: TRANSITION_OPTIONS.value.map((o) => ({ key: o.value, label: o.label })), current: normTrans(form.transition) });
  if (k !== null) form.transition = k;
}

async function requestClose() {
  if (!dirty.value) { backToParent(); return; }
  const ok = await confirm({ title: t('storyboard.editDiscardTitle'), content: t('storyboard.editDiscardConfirm') });
  if (ok) backToParent();
}
// 系统返回键（App/鸿蒙）：有未保存改动先弹确认丢弃，确认后程序化返回放行；
// 无改动/未载入数据走默认 backToParent。H5 uni-h5 不派发 onBackPress，浏览器返回直接离开
useBackGuard(() => {
  if (!dirty.value) return false;
  requestClose();
  return true;
});

async function save() {
  if (saving.value || !seg.value) return;
  saving.value = true;
  try {
    await storyboardApi.updateSegment(seg.value.id, formObj());
    uni.$emit('segment:updated', { id: seg.value.id, ...formObj() });
    toast(t('common.saveSuccess'), 'success');
    uni.navigateBack();
  } catch { /* http 层已提示 */ } finally { saving.value = false; }
}
</script>

<template>
  <view class="sep ad-page" :class="theme.rootCls">
    <view class="sep-head" :style="{ paddingTop: statusBarHeight() + 10 + 'px' }" @touchmove.stop.prevent="() => {}">
      <view class="sep-close" @tap="requestClose"><m-icon name="left" :size="20" color="#fff" /></view>
      <text class="sep-title">{{ t('common.edit') }}<template v-if="seg?.shot_no || seg?.idx"> · {{ seg.shot_no || seg.idx }}</template></text>
      <view class="sep-save" :class="{ dis: saving || !seg }" @tap="save">{{ t('common.save') }}</view>
    </view>
    <scroll-view scroll-y class="sep-body" :show-scrollbar="false">
      <view class="sep-form">
        <!-- 标题/分镜号输入框已按需求隐藏（App 端 input 初值不渲染的平台坑）；值仍在表单里随保存原样透传，镜头归属看顶栏「编辑 · 分镜号」 -->
        <view class="sep-grid">
          <view>
            <view class="ad-field-label">{{ t('storyboard.fieldDurationSeconds') }}</view>
            <view class="sep-input sep-picker" @tap="pickDuration">{{ form.duration }}s <text class="sep-caret">▸</text></view>
          </view>
          <view>
            <view class="ad-field-label">{{ t('storyboard.fieldTransition') }}</view>
            <view class="sep-input sep-picker" @tap="pickTransition">{{ transLabel }} <text class="sep-caret">▸</text></view>
          </view>
        </view>
        <text class="sep-tip">{{ t('storyboard.transitionTip') }}</text>
        <view class="ad-field-label">{{ t('storyboard.sceneScript') }}</view>
        <textarea v-model="form.scene_script" class="sep-input sep-area sm" :maxlength="5000" auto-height />
        <view class="ad-field-label">{{ t('storyboard.videoPrompt') }}</view>
        <textarea v-model="form.video_prompt" class="sep-input sep-area" :maxlength="10000" auto-height />
        <view class="sep-footpad" />
      </view>
    </scroll-view>

    <!-- selectSheet/confirm 主题化弹层宿主 -->
    <AdDialog />
  </view>
</template>

<style scoped>
.sep {
  height: 100vh;
  background: var(--ad-ink, #0a0a0f);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.sep-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.35), transparent);
  flex: 0 0 auto;
}
.sep-close {
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  display: flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
}
.sep-title {
  flex: 1; color: var(--ad-text, #f3f0e8); font-size: 15px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sep-save {
  flex: 0 0 auto; padding: 7px 18px; border-radius: 999px;
  background: var(--ad-brand, #e0b64e); color: #0a0a0f;
  font-size: 13px; font-weight: 700;
}
.sep-save.dis { opacity: 0.5; }
.sep-body { flex: 1; min-height: 0; }
.sep-form { padding: 14px 16px 24px; }
.sep-input {
  width: 100%; box-sizing: border-box;
  background: var(--ad-panel, #101018);
  border: 1px solid var(--ad-line, #26262f); border-radius: 12px;
  color: var(--ad-text, #f3f0e8); font-size: 14px;
  padding: 10px 12px; margin-bottom: 12px;
}
.sep-grid { display: flex; gap: 10px; }
.sep-grid > view { flex: 1; min-width: 0; }
.sep-picker { display: flex; align-items: center; justify-content: space-between; }
.sep-caret { color: var(--ad-text-mut, #7d7a70); font-size: 12px; }
.sep-tip { display: block; color: var(--ad-text-mut, #7d7a70); font-size: 11px; margin: -6px 0 12px; }
.sep-area { min-height: 96px; }
.sep-area.sm { min-height: 72px; }
.sep-footpad { height: 24px; }
</style>
