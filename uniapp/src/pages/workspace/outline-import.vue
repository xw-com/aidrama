<script setup>
/**
 * 导入剧本独立页（原大纲页「导入弹层」AdSheet 迁出，参照 pages/workspace/char-create 页面模式）：
 * 大段粘贴（20 万字上限）或上传 txt/md/pdf → POST /projects/:pid/script/import（async=1 任务模式）。
 * POST 立即返回 { job }，pollJob 轮询拿真实进度；大纲页经 outline:importing/-progress/-imported/-failed
 * 四个事件锁屏/显进度/解锁重拉。上传路径选中文件即关窗，导入与轮询在页面出栈后的闭包里继续。
 */
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { scriptApi } from '../../api';
import { useThemeStore } from '../../stores/theme';
import { toast } from '../../utils/ui';
import { pollJob } from '../../utils/job';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';
// #ifdef APP-HARMONY
// 鸿蒙端 JS 层没有 chooseFile/chooseMessageFile（后者是微信专属），文件选择走 UTS 桥
import { pickDocument } from '../../uni_modules/aidrama-document-picker';
// #endif

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();

let pid = null; // 项目 id（/pages/workspace/outline-import?pid=xxx）
const importText = ref('');
const importBusy = ref(false);
const importProgress = ref(-1); // -1=未知（POST 未返回前），0-100 任务真实进度

onLoad((q) => { pid = q?.pid || null; });

function cancel() {
  uni.navigateBack();
}

function done() {
  toast(t('outline.imported'), 'success');
  uni.$emit('outline:imported'); // 通知大纲页解锁并重拉
  uni.navigateBack();
}

/**
 * 任务模式导入共用流程。
 * background=true（上传路径）：选中文件立即关窗，导入/轮询在页面出栈后的闭包里继续
 *（uni.uploadFile 与 setTimeout 均为应用级，不随页面销毁）；完成时大纲页已在前台，$emit 能收到。
 * 失败：任务级失败（pollJob reject，http 层未提示）这里 toast；HTTP 层失败 http 层已提示，不重复。
 */
async function runImportJob(promise, { background }) {
  uni.$emit('outline:importing');
  if (background) uni.navigateBack();
  importBusy.value = true;
  importProgress.value = -1;
  try {
    const { job } = await promise;
    await pollJob(job.id, {
      onProgress: (j) => {
        importProgress.value = j.progress ?? -1;
        uni.$emit('outline:import-progress', { progress: j.progress ?? -1, stage: j.stage || '' });
      },
    });
    if (background) {
      toast(t('outline.imported'), 'success');
      uni.$emit('outline:imported');
    } else {
      done();
    }
  } catch (e) {
    if (e && e.job) toast(e.message || t('errors.requestFailed'), 'error');
    uni.$emit('outline:import-failed');
  }
  finally { importBusy.value = false; }
}

function doImport() {
  if (!importText.value.trim()) { toast(t('outline.importContentRequired'), 'error'); return; }
  runImportJob(scriptApi.importText(pid, importText.value, true), { background: false });
}

function chooseFile() {
  // #ifdef H5
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.pdf';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    runImportJob(scriptApi.importFile(pid, file, true), { background: true });
  };
  input.click();
  // #endif
  // #ifdef APP-HARMONY
  pickDocument(
    ['.txt', '.md', '.pdf'],
    (path) => { runImportJob(scriptApi.importFile(pid, path, true), { background: true }); },
    (msg) => { toast(msg, 'error'); },
  );
  // #endif
  // #ifdef MP-WEIXIN
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    extension: ['.txt', '.md', '.pdf'],
    success: (res) => {
      const f = res.tempFiles && res.tempFiles[0];
      if (!f) return;
      runImportJob(scriptApi.importFile(pid, f.path, true), { background: true });
    },
  });
  // #endif
}
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('outline.importDialogTitle')" />

    <view class="oi-body">
      <!-- textarea 固定高内部滚动，勿加 auto-height：H5 大文本聚焦会重排闪烁 -->
      <textarea
        v-model="importText"
        class="oi-input oi-area"
        :placeholder="t('outline.importDialogPlaceholder')"
        :maxlength="200000"
      />
      <!-- 文本导入进度（上传路径的进度显示在大纲页遮罩上） -->
      <view v-if="importBusy && importProgress >= 0" class="oi-prog">{{ importProgress }}%</view>
    </view>

    <!-- 底部操作条：上传 / 取消 / 导入 -->
    <view class="oi-foot">
      <view class="mbtn ghost sm" @tap="chooseFile">
        <m-icon name="upload" :size="13" />
        <text>{{ t('outline.uploadTxt') }}</text>
      </view>
      <view class="mbtn ghost sm" @tap="cancel">{{ t('common.cancel') }}</view>
      <view class="mbtn sm" :class="{ dis: importBusy }" @tap="doImport">{{ t('outline.importBtn') }}</view>
    </view>

    <AdDialog />
  </view>
</template>

<style scoped>
.oi-body { padding: 12px 18px 110px; }
.oi-input {
  width: auto; min-height: 42px; padding: 10px 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 14px;
}
.oi-area { height: 50vh; line-height: 1.75; }
.oi-prog { margin-top: 10px; text-align: center; font-size: 12px; color: var(--ad-text-mut); }
.oi-foot {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 80;
  display: flex; gap: 8px; align-items: center;
  padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); background: var(--ad-ink);
}
.oi-foot .mbtn { height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; }
.oi-foot .mbtn.sm { height: 44px; flex: 1; }
.dis { opacity: 0.6; } /* 导入中置灰（文本导入路径） */
</style>
