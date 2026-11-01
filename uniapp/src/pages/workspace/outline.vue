<script setup>
/**
 * 剧本大纲（client workspace/ScriptOutline 移植，移动端单列）：
 * 导入剧本（粘贴/上传）→ AI 解析/JS 本地拆分 → 分集列表 + 正文阅读/编辑 → 导出 txt。
 * 分集列表走后端分页（每页 15 条，滑动到底自动追加）；正文大字段选中/编辑时按需 GET /episodes/:eid 单条拉取。
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad, onShow, onUnload, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { scriptApi, projectApi } from '../../api';
import { can } from '../../utils/perms';
import { useThemeStore } from '../../stores/theme';
import { toast, confirm } from '../../utils/ui';
import { pollJob } from '../../utils/job';
import { copyText } from '../../utils/clipboard';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';
// #ifdef APP-HARMONY
// 鸿蒙无公共下载目录，文件导出走系统保存面板（DocumentViewPicker 安全组件，免权限）
import { saveDocument } from '../../uni_modules/aidrama-document-picker';
// #endif

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();

const projectId = ref(null);
const project = ref(null);
const episodes = ref([]);
const loading = ref(false);
const selectedId = ref(null);
const selectedContent = ref('');
const detailBusy = ref(false);

// ===== 分集列表后端分页（每页 15 条，滑动到底自动追加下一页） =====
const OL_PAGE_SIZE = 15;
const olPage = ref(1);
const olTotal = ref(0);
const olLoading = ref(false); // 追加翻页请求中的轻量态
const totalEpisodes = computed(() => olTotal.value);

// 编辑态
const editing = ref(false);
const editTitle = ref('');
const editContent = ref('');
const saving = ref(false);

// 字数兼容：lean 详情只给 content_length（整数），parse 结果自带 content 全文
const epLen = (ep) => (ep?.content_length != null ? ep.content_length : (ep?.content || '').length);
const epHasContent = (ep) => epLen(ep) > 0;
const selected = computed(() => episodes.value.find((e) => e.id === selectedId.value) || null);
const hasScript = computed(() => !!project.value?.has_script);
const canEdit = computed(() => can(project.value, 'script.edit'));

// 拉一页分集。opts.page 重拉指定页（默认第一页）；opts.append 滑动到底追加下一页；
// opts.find 按 episodeId 定位所在页（新建集接在末尾，跳转用）。
// 附带轻量 project（name/has_script + 权限），本页不再整包拉项目详情
let olSeq = 0; // 请求序号：快速翻页时旧响应不覆盖新页
async function loadOutline(opts = {}) {
  if (!projectId.value) return;
  const seq = ++olSeq;
  olLoading.value = true;
  if (!opts.append) loading.value = true;
  try {
    const resp = await projectApi.episodesPage(projectId.value, {
      page: opts.find ? undefined : (opts.page || (opts.append ? olPage.value + 1 : 1)),
      size: OL_PAGE_SIZE,
      find: opts.find,
    });
    if (seq !== olSeq) return; // 已有更新的翻页请求，丢弃本次响应
    project.value = { ...(project.value || {}), ...resp.project, my_role: resp.my_role, my_permissions: resp.my_permissions };
    episodes.value = opts.append ? episodes.value.concat(resp.rows || []) : (resp.rows || []);
    olPage.value = resp.page || 1;
    olTotal.value = resp.total || 0;
    if (episodes.value.length && !episodes.value.find((e) => e.id === selectedId.value)) {
      selectEp(episodes.value[0]);
    }
  } catch { /* http 层已提示 */ }
  finally { olLoading.value = false; loading.value = false; }
}

// 滑动到底自动翻页：追加下一页（请求中/已到末页时忽略）
function loadMoreEpisodes() {
  if (loading.value || olLoading.value) return;
  if (!olTotal.value || episodes.value.length >= olTotal.value) return;
  loadOutline({ append: true });
}

// 选中分集：弹窗查看/编辑，正文按需拉取
async function selectEp(ep) {
  selectedId.value = ep.id;
  editing.value = false;
  if (ep.content != null) {
    selectedContent.value = ep.content;
    return;
  }
  detailBusy.value = true;
  try {
    const full = await scriptApi.getEpisode(ep.id);
    selectedContent.value = full.content || '';
    if (ep.content_length == null) ep.content_length = (full.content || '').length;
  } catch { /* http 层已提示 */ }
  finally { detailBusy.value = false; }
}

function openEp(ep) {
  viewerShow.value = true;
  selectEp(ep);
}

// ===== 导入（独立页 pages/workspace/outline-import） =====
// 粘贴/上传统一入口迁出为独立页；导入页成功后 uni.$emit('outline:imported') 回传，这里重拉项目与大纲
function goImport() {
  uni.navigateTo({ url: `/pages/workspace/outline-import?pid=${projectId.value}` });
}

// JS 本地拆分（零积分；async=1 任务模式，轮询真实进度）
const jsParsing = ref(false);
const jsProgress = ref(-1); // -1=未知（不定进度动画），0-100 任务真实进度
const jsStage = ref('');
async function parseScriptJs() {
  if (jsParsing.value) return; // 拆分中禁止重复点击（dis 只是样式，view 无原生 disabled）
  jsParsing.value = true;
  jsProgress.value = -1;
  jsStage.value = '';
  try {
    const { job } = await scriptApi.parseJs(projectId.value, true);
    await pollJob(job.id, {
      onProgress: (j) => {
        jsProgress.value = j.progress ?? 0;
        jsStage.value = j.stage || '';
      },
    });
    toast(t('outline.parsed'), 'success');
    await loadOutline(); // 拆分结果走分页接口重拉第一页
  } catch (e) {
    // 任务级失败（pollJob reject，job.error 服务端已本地化）需显式 toast；HTTP 层失败 http 层已提示
    if (e && e.job) toast(e.message || t('errors.requestFailed'), 'error');
  } finally { jsParsing.value = false; }
}

// 遮罩展示内容：导入/拆分共用一块遮罩，谁在忙显示谁（progress -1 → 不定进度动画）
const busyInfo = computed(() => importing.value
  ? { label: t('outline.importing'), progress: importingProgress.value, stage: importingStage.value }
  : { label: t('outline.parsing'), progress: jsProgress.value, stage: jsStage.value });

// 非 H5 文件落地：App 用 plus.io 写公共下载目录（Android 文件管理器 Download 直接可见；
// iOS 落沙箱 Documents，manifest 开 UIFileSharingEnabled 后「文件」App 可见）。同名旧文件
// 先删再建，防旧文件更长时 write 只覆盖前段残留尾部。小程序沙箱写不了公共存储：写用户目录
// 后经确认弹窗的 confirm 回调（shareFileMessage 要求用户手势，直调会被拒）调 wx.shareFileMessage
// 转发到聊天，用户在聊天里打开文件即可另存。鸿蒙调系统保存面板（DocumentViewPicker 安全
// 组件，用户选位置免权限）。无分支命中的端返回 'failed' 由调用方兜底复制。
// 返回 'saved'（已落到用户可见处）/ 'ready'（文件已生成/面板取消，转发与否交用户）/ 'failed'
function saveScriptFile(filename, text) {
  return new Promise((resolve) => {
    /* #ifdef APP-PLUS */
    plus.io.resolveLocalFileSystemURL('_downloads/', (dir) => {
      const createFile = () => {
        dir.getFile(filename, { create: true }, (fe) => {
          fe.createWriter((w) => {
            w.onwrite = () => resolve('saved');
            w.onerror = () => resolve('failed');
            w.write(text);
          }, () => resolve('failed'));
        }, () => resolve('failed'));
      };
      dir.getFile(filename, { create: false }, (old) => old.remove(createFile, createFile), createFile);
    }, () => resolve('failed'));
    /* #endif */
    /* #ifdef MP-WEIXIN */
    try {
      const filePath = `${wx.env.USER_DATA_PATH}/${filename}`;
      uni.getFileSystemManager().writeFile({
        filePath,
        data: text,
        encoding: 'utf8',
        success: () => {
          // 基础库 < 2.16.1 无 shareFileMessage，直接走剪贴板兜底
          if (!wx.shareFileMessage) { resolve('failed'); return; }
          uni.showModal({
            title: t('outline.exportReadyTitle'),
            content: t('outline.exportReadyMsg'),
            confirmText: t('outline.exportShareBtn'),
            success: (r) => {
              if (!r.confirm) { resolve('ready'); return; } // 弹窗取消：文件已生成，不打扰
              wx.shareFileMessage({
                filePath,
                fileName: filename,
                success: () => resolve('ready'),
                fail: (e) => resolve(/cancel/i.test(e?.errMsg || '') ? 'ready' : 'failed'), // 分享面板取消不算失败
              });
            },
            fail: () => resolve('failed'),
          });
        },
        fail: () => resolve('failed'),
      });
    } catch { resolve('failed'); }
    /* #endif */
    /* #ifdef APP-HARMONY */
    // 系统保存面板：用户选位置（默认文件名 filename），取消面板不算失败不兜底
    saveDocument(
      filename,
      text,
      () => resolve('saved'),
      (msg) => resolve(/cancel/i.test(msg || '') ? 'ready' : 'failed'),
    );
    /* #endif */
    /* #ifndef APP-PLUS */
    /* #ifndef MP-WEIXIN */
    /* #ifndef APP-HARMONY */
    resolve('failed');
    /* #endif */
    /* #endif */
    /* #endif */
  });
}

// 导出剧本：H5 走 blob 下载；App 写公共下载目录；小程序生成文件转发到聊天；鸿蒙走系统保存
// 面板；无文件通道/失败时兜底复制全文（整包拉取分集列表，不依赖已加载页）
async function exportScript() {
  if (!olTotal.value) { toast(t('outline.noEpisodesToExport'), 'error'); return; }
  const projectName = project.value?.name || t('outline.scriptLabel');
  try {
    const all = await projectApi.episodesPage(projectId.value, { page: 1, size: 1000 });
    const full = await Promise.all((all.rows || []).map(async (e) => {
      if (e.content != null) return e;
      const ep = await scriptApi.getEpisode(e.id);
      return { ...e, content: ep.content || '', summary: ep.summary || '' };
    }));
    const body = full
      .map((e) => `${t('outline.episodeNo', { n: e.idx })}${e.title ? ` ${e.title}` : ''}\n\n${e.content || e.summary || ''}`)
      .join('\n\n');
    const text = `${projectName}\n${t('outline.totalEpisodesCount', { n: totalEpisodes.value })}\n\n${body}\n`;
    /* #ifdef H5 */
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName}-${t('outline.scriptLabel')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast(t('outline.exported'), 'success');
    /* #endif */
    /* #ifndef H5 */
    // 文件名含项目名，过滤路径非法字符（App 公共目录/小程序文件路径都不收 \ / 等符号）
    const filename = `${projectName}-${t('outline.scriptLabel')}.txt`.replace(/[\\/:*?"<>|]/g, '_');
    const st = await saveScriptFile(filename, text);
    if (st === 'saved') toast(t('outline.exportSavedFile'), 'success');
    else if (st === 'failed') {
      await copyText(text); // 文件落地失败/不支持端兜底：复制全文到剪贴板
      toast(t('outline.exportCopied'), 'success');
    }
    /* #endif */
  } catch (e) {
    toast(e?.message || t('errors.requestFailed'), 'error');
  }
}

// ===== 编辑（分集弹窗内） =====
const viewerShow = ref(false);
function startEdit() {
  editing.value = true;
  editTitle.value = selected.value?.title || '';
  editContent.value = selectedContent.value || '';
}
function cancelEdit() {
  editing.value = false;
}
async function saveEdit(ep) {
  saving.value = true;
  try {
    await scriptApi.updateEpisode(ep.id, { title: editTitle.value, content: editContent.value });
    ep.title = editTitle.value;
    ep.content = editContent.value;
    ep.content_length = editContent.value.length;
    selectedContent.value = editContent.value;
    editing.value = false;
    toast(t('outline.saved'), 'success');
  } catch { /* http 层已提示 */ }
  finally { saving.value = false; }
}

// 新增分集：创建后弹窗打开并直接进入编辑（新集接在末尾，按 find 直达所在页）
async function createEpisode() {
  try {
    const created = await scriptApi.createEpisode(projectId.value, {});
    toast(t('outline.episodeCreated'), 'success');
    await loadOutline({ find: created.id });
    selectedId.value = created.id;
    const fresh = episodes.value.find((e) => e.id === created.id);
    viewerShow.value = true;
    if (fresh) {
      await selectEp(fresh);
      startEdit();
    }
  } catch { /* http 层已提示 */ }
}

async function removeEpisode(ep) {
  const ok = await confirm({
    title: t('outline.deleteConfirmTitle'),
    content: t('outline.deleteConfirmMsg', { name: ep.title || `#${ep.idx}` }),
    danger: true,
  });
  if (!ok) return;
  try {
    await scriptApi.deleteEpisode(ep.id);
    if (selectedId.value === ep.id) { selectedId.value = null; selectedContent.value = ''; viewerShow.value = false; }
    editing.value = false;
    toast(t('outline.deleted'), 'success');
    await loadOutline({ page: olPage.value }); // 重拉当前页（删集后页数收缩时服务端收敛到最后一页）
  } catch { /* http 层已提示 */ }
}

function goNext() {
  if (!olTotal.value) { toast(t('outline.pleaseParseFirst'), 'error'); return; }
  uni.navigateTo({ url: `/pages/workspace/assets?pid=${projectId.value}` });
}

// ===== 导入进行中：整页锁定 + 状态遮罩（导入页发起导入时 emit，完成/失败回传解除） =====
const importing = ref(false);
const importingProgress = ref(-1); // -1=未知（不定进度动画），0-100 任务真实进度
const importingStage = ref('');
function onImported() {
  importing.value = false;
  loadOutline();
}

onLoad((q) => {
  projectId.value = q?.pid || null;
  // 导入页成功导入后回传：重拉项目与大纲（返回时 onShow 也会兜底重拉）
  uni.$on('outline:imported', onImported);
  uni.$on('outline:importing', () => {
    importing.value = true;
    importingProgress.value = -1; // 重置：新一轮导入
    importingStage.value = '';
  });
  uni.$on('outline:import-progress', (p) => {
    importingProgress.value = p?.progress ?? -1;
    importingStage.value = p?.stage || '';
  });
  uni.$on('outline:import-failed', () => { importing.value = false; });
});
onUnload(() => {
  uni.$off('outline:imported', onImported);
  uni.$off('outline:importing');
  uni.$off('outline:import-failed');
});
onShow(() => { loadOutline(); });
onReachBottom(() => { loadMoreEpisodes(); });
// 下拉刷新：重拉项目与大纲
onPullDownRefresh(async () => {
  try { await loadOutline(); } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('workspace.step.scriptOutline')">
      <template #right>
        <view v-if="canEdit" class="chip glass sm" @tap="createEpisode">
          <m-icon name="plus" :size="13" :sw="2" />
        </view>
      </template>
    </AdNavbar>

    <!-- 头部操作 -->
    <view class="olh">
      <text class="olh-title">{{ t('outline.totalEpisodesCount', { n: totalEpisodes }) }}</text>
      <text class="olh-sub">{{ hasScript ? t('outline.titleImported') : t('outline.titleNotImported') }}</text>
      <view class="olh-acts">
        <view v-if="canEdit && !hasScript" class="mbtn ghost sm" @tap="goImport">
          <m-icon name="import" :size="13" />
          <text>{{ t('outline.pasteScript') }}</text>
        </view>
        <template v-if="hasScript">
          <view v-if="canEdit" class="mbtn ghost sm" @tap="goImport">{{ t('outline.reimport') }}</view>
          <view v-if="!episodes.length && canEdit" class="mbtn sm" :class="{ dis: jsParsing }" @tap="parseScriptJs">{{ t('outline.jsParse') }}</view>
          <view v-if="episodes.length" class="mbtn ghost sm" @tap="exportScript">{{ t('outline.exportScript') }}</view>
        </template>
        <view v-else-if="canEdit" class="mbtn ghost sm" @tap="goImport">{{ t('outline.uploadScript') }}</view>
        <!-- 下一步（原列表底部按钮上移至此按钮组） -->
        <view v-if="hasScript || episodes.length" class="mbtn sm olnext" :class="{ dis: !olTotal }" @tap="goNext">
          <text>{{ t('outline.nextStep') }}</text>
          <text class="olnext-arr">▸</text>
        </view>
      </view>
    </view>

    <!-- 空态 -->
    <view v-if="!hasScript && !episodes.length" class="card olempty">
      <text class="olempty-emoji">📖</text>
      <text class="olempty-title">{{ t('outline.emptyTitle') }}</text>
      <text class="olempty-desc">{{ t('outline.emptyDesc') }}</text>
      <view v-if="canEdit" class="mbtn sm" @tap="goImport">{{ t('outline.startImport') }}</view>
      <view v-if="canEdit" class="mbtn soft sm" @tap="createEpisode">{{ t('outline.addEpisode') }}</view>
    </view>
    <view v-else-if="!episodes.length" class="card olguide">
      <text class="olguide-title">{{ t('outline.guideTitle') }}</text>
      <text class="olguide-sub">{{ t('outline.guideSub') }}</text>
    </view>

    <!-- 分集列表 -->
    <template v-if="hasScript || episodes.length">
      <view v-for="ep in episodes" :key="ep.id" class="card olep" :class="{ on: ep.id === selectedId }" @tap="openEp(ep)">
        <view class="olep-no mono">{{ ep.idx }}</view>
        <view class="olep-main">
          <text class="olep-title">{{ ep.title || t('script.untitledDraft') }}</text>
          <text class="olep-meta">{{ epLen(ep) }} {{ t('outline.charUnit') }}</text>
        </view>
        <text class="chip sm" :class="epHasContent(ep) ? 'ok' : 'warn'">{{ epHasContent(ep) ? t('outline.statusDone') : t('outline.statusPending') }}</text>
        <view v-if="canEdit" class="olep-del" @tap.stop="removeEpisode(ep)">
          <m-icon name="trash" :size="14" />
        </view>
      </view>
      <view v-if="!episodes.length" class="ad-empty"><text class="et">{{ t('outline.emptyListHint') }}</text></view>

      <!-- 滑动到底自动翻页：追加中 / 已全部加载（列表超过一页才提示） -->
      <view v-if="olTotal > OL_PAGE_SIZE" class="ol-more">
        <text v-if="olLoading">{{ t('common.loading') }}</text>
        <text v-else-if="episodes.length >= olTotal">{{ t('common.allLoaded') }}</text>
      </view>
    </template>

    <!-- 分集阅读/编辑弹层 -->
    <AdSheet v-model:show="viewerShow" :title="selected ? t('outline.episodeNo', { n: selected.idx }) : ''">
      <view v-if="selected" class="olview">
        <view class="olview-head">
          <view class="olview-tinfo">
            <text class="olview-title">{{ selected.title || t('script.untitledDraft') }}</text>
            <text class="olview-meta">
              {{ (editing ? editContent : (selectedContent || '')).length }} {{ t('outline.charUnit') }} ·
              {{ t('outline.aboutMinutes', { n: Math.max(1, Math.ceil((editing ? editContent : (selectedContent || '')).length / 300)) }) }}
            </text>
          </view>
          <view v-if="!editing && canEdit" class="mbtn sm" @tap="startEdit">{{ t('outline.modify') }}</view>
        </view>

        <!-- 编辑态（textarea 固定高内部滚动，勿加 auto-height：H5 大文本聚焦会重排闪烁） -->
        <template v-if="editing">
          <input v-model="editTitle" class="ol-input" :placeholder="t('outline.episodeTitlePlaceholder')" />
          <textarea
            v-model="editContent"
            class="ol-input ol-textarea"
            :placeholder="t('outline.episodeScriptPlaceholder')"
            :maxlength="100000"
            :disable-default-padding="true"
          />
          <view class="ol-editacts">
            <view class="mbtn ghost sm" @tap="cancelEdit">{{ t('common.cancel') }}</view>
            <view class="mbtn sm" :class="{ dis: saving }" @tap="saveEdit(selected)">{{ t('common.save') }}</view>
          </view>
        </template>

        <!-- 阅读态 -->
        <template v-else>
          <view v-if="detailBusy" class="ol-loading"><text>{{ t('common.loading') }}</text></view>
          <scroll-view v-else scroll-y class="olview-body">
            <text class="ol-content" user-select>{{ selectedContent || t('outline.emptyListHint') }}</text>
          </scroll-view>
          <view v-if="canEdit" class="olview-foot">
            <view class="mbtn danger sm" @tap="removeEpisode(selected)">
              <m-icon name="trash" :size="13" /> {{ t('common.delete') }}
            </view>
            <view class="mbtn ghost sm" @tap="viewerShow = false">{{ t('common.close') }}</view>
          </view>
        </template>
      </view>
    </AdSheet>

    <!-- 导入/拆分进行中：整页锁定遮罩。进度≥0 时显示真实百分比+服务端阶段文案，否则不定进度动画。
         z-index 795：压过抽屉基础档 750/760 与叠层档 780/790，保证整页不可操作 -->
    <view v-if="importing || jsParsing" class="olbusy" @tap.stop @touchmove.stop.prevent>
      <view class="olbusy-card">
        <view class="olbusy-spin" />
        <text class="olbusy-txt">{{ busyInfo.label }}</text>
        <view class="olbusy-bar">
          <view class="olbusy-bar-fill" :class="{ det: busyInfo.progress >= 0 }" :style="busyInfo.progress >= 0 ? { width: busyInfo.progress + '%' } : ''" />
        </view>
        <text v-if="busyInfo.progress >= 0 || busyInfo.stage" class="olbusy-sub">
          {{ (busyInfo.progress >= 0 ? busyInfo.progress + '% ' : '') + (busyInfo.stage || '') }}
        </text>
      </view>
    </view>

    <AdDialog />
  </view>
</template>

<style scoped>
.olh { padding: 2px 18px 14px; display: flex; flex-direction: column; gap: 6px; }
.olh-title { font-family: var(--ad-serif); font-size: 18px; font-weight: 800; color: var(--ad-text); }
.olh-sub { font-size: 12px; color: var(--ad-text-mut); }
.olh-acts { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; }
/* mbtn 禁用态：拆分中/不可下一步时置灰（页面内自定义，全局只有 .mbtn.disabled） */
.dis { opacity: 0.6; }

.olempty { padding: 34px 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.olempty-emoji { font-size: 40px; }
.olempty-title { font-family: var(--ad-serif); font-size: 16px; font-weight: 700; color: var(--ad-text); }
.olempty-desc { font-size: 12px; color: var(--ad-text-mut); line-height: 1.7; }
.olguide { padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; border-left: 3px solid var(--ad-brand); }
.olguide-title { font-size: 14px; font-weight: 700; color: var(--ad-text); }
.olguide-sub { font-size: 12px; color: var(--ad-text-soft); line-height: 1.6; }

.olep { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
.olep.on { border-color: rgba(224, 182, 78, 0.5); }
.olep-no {
  width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(45, 212, 191, 0.15); color: var(--ad-accent); font-size: 12px; font-weight: 700;
}
.olep-no.lg { width: 34px; height: 34px; font-size: 14px; }
.olep-main { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.olep-title { font-size: 14px; font-weight: 600; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.olep-meta { font-size: 11px; color: var(--ad-text-mut); }
/* 删除按钮：红描边圆形，明显可点 */
.olep-del {
  width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--ad-danger); color: var(--ad-danger);
}

/* 滑动到底自动翻页：底部状态行 */
.ol-more { padding: 10px 0 2px; text-align: center; font-size: 11.5px; color: var(--ad-text-mut); }

/* 分集弹层 */
.olview { display: flex; flex-direction: column; gap: 12px; padding-bottom: 4px; }
.olview-head { display: flex; align-items: center; gap: 10px; }
.olview-tinfo { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.olview-title { font-size: 16px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.olview-meta { font-size: 11px; color: var(--ad-text-mut); }
.olview-body {
  height: 46vh; box-sizing: border-box;
  padding: 4px 10px 4px 14px; border-left: 3px solid var(--ad-accent);
  background: linear-gradient(90deg, rgba(45, 212, 191, 0.06), transparent 60%);
  border-radius: 0 8px 8px 0;
}
.olview-foot { display: flex; justify-content: space-between; gap: 8px; }

.ol-input {
  width: auto; min-height: 42px; padding: 10px 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 14px;
}
.ol-textarea { height: 44vh; line-height: 1.75; }
.ol-editacts { display: flex; justify-content: flex-end; gap: 8px; }
.ol-loading { padding: 20px 0; text-align: center; font-size: 12px; color: var(--ad-text-mut); }
.ol-content { font-size: 15px; line-height: 1.8; color: var(--ad-text); white-space: pre-wrap; word-break: break-word; }
/* 导入/拆分进行中遮罩 */
.olbusy {
  position: fixed; left: 0; right: 0; top: 0; bottom: 0; z-index: 795;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-mask-bg);
}
.olbusy-card {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  min-width: 220px; padding: 26px 34px; border-radius: 16px;
  background: var(--ad-panel); border: 1px solid var(--ad-line-strong);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.olbusy-txt { font-size: 14px; color: var(--ad-text); }
.olbusy-spin {
  width: 34px; height: 34px; border-radius: 50%;
  border: 3px solid var(--ad-line); border-top-color: var(--ad-brand);
  animation: olbusy-rot 0.9s linear infinite;
}
@keyframes olbusy-rot { to { transform: rotate(360deg); } }
.olbusy-bar { width: 160px; height: 4px; border-radius: 2px; background: var(--ad-line); overflow: hidden; }
.olbusy-bar-fill {
  width: 40%; height: 100%; border-radius: 2px; background: var(--ad-brand);
  animation: olbusy-slide 1.2s ease-in-out infinite;
}
/* 真实进度模式：宽度绑定百分比，停用滑动动画改用过渡 */
.olbusy-bar-fill.det {
  width: 0%; animation: none; transition: width 0.3s;
}
.olbusy-sub { font-size: 11.5px; color: var(--ad-text-mut); text-align: center; }

/* 下一步（头部按钮组内）：主体样式走 mbtn sm，这里只补箭头 */
.olnext { gap: 4px; }
.olnext-arr { font-size: 12px; }
</style>
