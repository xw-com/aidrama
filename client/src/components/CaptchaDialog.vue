<script setup>
// 点选文字验证码弹窗：登录/发送验证码前的人机校验
// 打开即向本系统后端取题（SVG dataURL，按 locale 选字符池），按提示顺序点击图中文字，
// 校验通过后 emit('success', ticket) —— 页面携带 ticket 再发起登录/发码请求（captcha_ticket）。
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { captchaApi } from '../api';

const open = defineModel({ type: Boolean, default: false });
const emit = defineEmits(['success']);
const { t } = useI18n();

const loading = ref(false);
const verifying = ref(false);
const challenge = ref(null); // { id, image, tipChars, width, height }
const points = ref([]);      // 已点击点（题目 viewBox 坐标，按点击顺序）

// 打开弹窗即拉新题（每题一次性消费，重开必然换题）
watch(open, (v) => { if (v) loadChallenge(); });

async function loadChallenge() {
  loading.value = true;
  points.value = [];
  try {
    challenge.value = await captchaApi.challenge();
  } catch {
    challenge.value = null; // 拦截器已弹错误提示；置空展示空态，用户可点「换一张」重试
  } finally {
    loading.value = false;
  }

}

// 点击图片：换算为题目 viewBox 坐标（弹窗 94vw 自适应，图片可能被缩放）
function onImageClick(e) {
  if (!challenge.value || verifying.value || loading.value) return;
  if (points.value.length >= challenge.value.tipChars.length) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const { width, height } = challenge.value;
  points.value.push({
    x: ((e.clientX - rect.left) / rect.width) * width,
    y: ((e.clientY - rect.top) / rect.height) * height,
  });
}

// 点击已选序号：截断该点及其后的点（改选）
function onMarkerClick(i) {
  if (verifying.value) return;
  points.value = points.value.slice(0, i);
}

async function onConfirm() {
  if (!challenge.value || points.value.length !== challenge.value.tipChars.length || verifying.value) return;
  verifying.value = true;
  try {
    const { ticket } = await captchaApi.verify({ id: challenge.value.id, points: points.value });
    ElMessage.success(t('captcha.passed'));
    open.value = false;
    emit('success', ticket);
  } catch {
    // 拦截器已提示失败原因；换新题重来
    loadChallenge();
  } finally {
    verifying.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="t('captcha.title')"
    width="min(400px, 94vw)"
    align-center
    append-to-body
    :close-on-click-modal="false"
    class="captcha-dialog"
  >
    <div v-loading="loading" class="captcha-body">
      <template v-if="challenge">
        <div class="captcha-tip">
          <span class="tip-label">{{ t('captcha.tipOrder') }}</span>
          <span v-for="(ch, i) in challenge.tipChars" :key="i" class="tip-chip">
            <i class="tip-index">{{ i + 1 }}</i>{{ ch }}
          </span>
        </div>
        <div class="captcha-image" role="button" :aria-label="t('captcha.tipOrder')" @click="onImageClick">
          <img :src="challenge.image" :alt="t('captcha.title')" draggable="false" />
          <span
            v-for="(p, i) in points"
            :key="i"
            class="click-marker"
            :style="{ left: `${(p.x / challenge.width) * 100}%`, top: `${(p.y / challenge.height) * 100}%` }"
            @click.stop="onMarkerClick(i)"
          >{{ i + 1 }}</span>
        </div>
        <div class="captcha-tools">
          <el-button link size="small" :disabled="verifying || !points.length" @click="points = []">{{ t('captcha.clear') }}</el-button>
          <el-button link size="small" :disabled="verifying" @click="loadChallenge">{{ t('captcha.refresh') }}</el-button>
        </div>
      </template>
      <div v-else class="captcha-empty">
        <el-button link type="primary" @click="loadChallenge">{{ t('captcha.refresh') }}</el-button>
      </div>
    </div>
    <template #footer>
      <el-button @click="open = false">{{ t('captcha.cancel') }}</el-button>
      <el-button
        type="primary"
        :loading="verifying"
        :disabled="!challenge || points.length !== challenge.tipChars.length"
        @click="onConfirm"
      >{{ t('captcha.confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<style>
/* el-dialog teleport 到 body，scoped 样式够不到 —— 按项目约定放非 scoped 块挂自定义根类 */
.captcha-dialog .captcha-body { min-height: 246px; }
.captcha-dialog .captcha-empty { min-height: 246px; display: flex; align-items: center; justify-content: center; }
.captcha-dialog .captcha-tip { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 14px; color: var(--ad-text); flex-wrap: wrap; }
.captcha-dialog .tip-label { color: var(--ad-text-soft); }
.captcha-dialog .tip-chip {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border: 1px solid var(--ad-border, #e5e7eb); border-radius: 8px;
  font-size: 20px; font-weight: 700;
  background: var(--ad-bg-soft, #f8fafc);
}
.captcha-dialog .tip-index {
  position: absolute; top: -6px; left: -6px;
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  font-size: 10px; font-style: normal;
  display: inline-flex; align-items: center; justify-content: center;
}
.captcha-dialog .captcha-image { position: relative; user-select: none; cursor: crosshair; border-radius: 8px; overflow: hidden; border: 1px solid var(--ad-border, #e5e7eb); }
.captcha-dialog .captcha-image img { display: block; width: 100%; height: auto; pointer-events: none; }
.captcha-dialog .click-marker {
  position: absolute; transform: translate(-50%, -50%);
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--ad-brand); color: var(--ad-brand-contrast); font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: var(--ad-shadow-lg);
}
.captcha-dialog .captcha-tools { display: flex; justify-content: flex-end; gap: 4px; margin-top: 8px; }
</style>
