<script setup>
/**
 * 创作台 · 成片页签。当前集成片卡片网格（合成/字幕版/剪辑版）+ 字幕两段式 + 预览/下载/删除。
 * 合成与分享入口在 Ribbon；字幕提取、剪辑、下载、删除在成片卡内。
 * 网格口径同分镜卡：多列自适应，列宽按项目画幅等面积缩放，缩略图比例跟项目画幅走。
 */
import { inject, ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { videoApi, modelApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import LazyVideo from '../../components/LazyVideo.vue';
import VideoPreview from '../../components/VideoPreview.vue';
import SubtitleEditorDialog from '../../components/SubtitleEditorDialog.vue';
import EmptyState from '../../components/EmptyState.vue';

const { t } = useI18n();
const ctx = inject('studio');
const { st, curEpisode, composeJob, canVideo, filmsOf, actCompose } = ctx;
const { runJob } = useCostAction();

// ---------- 成片行整理：派生（字幕版/剪辑版）先于其源，孤儿殿后（同 EpisodeList 口径） ----------
const rows = computed(() => {
  const list = filmsOf(st.curEid);
  const composes = list.filter((v) => v.kind === 'compose');
  const derived = list.filter((v) => v.kind !== 'compose');
  const childrenOf = {};
  for (const d of derived) {
    const k = String(d.source_job_id ?? '');
    (childrenOf[k] = childrenOf[k] || []).push(d);
  }
  const out = [];
  const pushed = new Set(); // 已入列行（按 job_id）：孤儿轮递归会与「子行已按孤儿先入列」重合，判重防同一行二次入列（曾致草稿卡渲染两次）
  const pushSubtree = (v) => {
    if (pushed.has(String(v.job_id))) return;
    pushed.add(String(v.job_id));
    for (const c of (childrenOf[String(v.job_id)] || [])) pushSubtree(c); // 先派生后自身
    out.push(v);
  };
  for (const c of composes) pushSubtree(c);
  for (const d of derived) pushSubtree(d); // 孤儿（含其下游）殿后；已被上游子树收编的自动跳过
  return out;
});

const isDraft = (v) => v.kind === 'subtitle' && !v.video_url;
// 成片卡按项目画幅渲染：缩略图比例跟项目走（contain 完整不裁切），列宽按 √画幅比缩放使各画幅面积相当
// 以竖屏 9:16、列宽 188px 为面积基准（与分镜卡同口径）：横屏 16:9 → 334px，方图 1:1 → 251px
const mediaAspect = computed(() => String(st.project?.aspect_ratio || '9:16').replace(':', ' / '));
const flColMin = computed(() => {
  const [w, h] = String(st.project?.aspect_ratio || '9:16').split(':').map(Number);
  const r = w > 0 && h > 0 ? w / h : 9 / 16;
  return Math.round(Math.min(400, Math.max(140, 188 * (4 / 3) * Math.sqrt(r))));
});
const badgeOf = (v) => {
  if (v.kind === 'subtitle') return isDraft(v) ? t('episode.videos.draftBadge') : t('episode.videos.subtitleBadge');
  if (v.kind === 'edit') return t('episode.videos.editBadge');
  return '';
};
// 徽章图标（与 badgeOf 同口径；均在 icons.js 登记）
const badgeIconOf = (v) => {
  if (v.kind === 'subtitle') return isDraft(v) ? 'EditPen' : 'Headset';
  if (v.kind === 'edit') return 'Scissor';
  return '';
};
// 该成片的字幕任务进行中（严格按 type + ref_id 整卡匹配，避免 job id 与其他表 id 撞号误判）
const subtitleBusy = (v) => !!ctx.jobs.items.find(
  (x) => x.type === 'video_subtitle' && String(x.ref_id) === String(v.job_id) && (x.status === 'pending' || x.status === 'running'),
);

// ---------- 合成全集进行中：成片面板顶部横幅（composeJob 由 ctx 解构，模板直接判空） ----------

// ---------- 切集：成片列表优雅回顶（与分镜面板同口径：分集内容更换从头看；不在顶部则 smooth 滑回，已在顶部不动） ----------
watch(() => st.curEid, () => {
  const el = document.querySelector('.fl');
  if (el && el.scrollTop > 0) el.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------- 任务面板跳转聚焦：滚动到目标成片行并高亮（信号来自 StudioView.gotoTask） ----------
const focusFilmJobId = ref(null);
watch(() => st.focus, async (f) => {
  if (!f?.filmJobId) return;
  if (!rows.value.some((v) => String(v.job_id) === String(f.filmJobId))) return;
  await nextTick();
  const el = document.querySelector(`.fl [data-film-job="${f.filmJobId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focusFilmJobId.value = f.filmJobId;
  setTimeout(() => { if (String(focusFilmJobId.value) === String(f.filmJobId)) focusFilmJobId.value = null; }, 3900);
});

// ---------- 字幕（ASR 两段式） ----------
const asrReady = ref(false);
onMounted(() => {
  modelApi.list('asr', { enabledOnly: true })
    .then((list) => { asrReady.value = (list || []).length > 0; })
    .catch(() => { asrReady.value = false; });
});
async function addSubtitle(v) {
  if (!asrReady.value) return ElMessage.warning(t('episode.videos.asrNotConfigured'));
  await runJob({
    modelType: 'asr',
    estimateFor: (sel) => videoApi.subtitleEstimate(v.job_id, sel),
    createFor: (sel) => videoApi.addSubtitle(v.job_id, sel),
    title: t('episode.videos.subtitleTitle'), desc: t('episode.videos.subtitleDesc'), confirmText: t('episode.videos.subtitleConfirm'),
    onDone: (j) => { if (j.status === 'succeeded') ctx.loadFilms(); },
  });
}

// 字幕编辑器（草稿校对 + 合并烧录在组件内完成）
const subtitleEditor = ref(null);
const subtitleEditorVisible = ref(false);
function sourceVideoUrlOf(v) {
  const src = st.films.find((c) => c.kind !== 'subtitle' && String(c.job_id) === String(v.source_job_id));
  return src?.video_url || '';
}
function openSubtitleEditor(v) {
  subtitleEditor.value = { jobId: v.job_id, videoUrl: sourceVideoUrlOf(v) };
  subtitleEditorVisible.value = true;
}

// ---------- 在线剪辑 / 预览 / 下载 / 删除 ----------
function openVideoEditor(v) {
  if (!v?.job_id) return;
  window.open(`/editor/video/${v.job_id}`, `aieditor_${v.job_id}`)?.focus();
}
function onEditorMessage(e) {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type === 'aieditor:exported') ctx.loadFilms();
}
onMounted(() => window.addEventListener('message', onEditorMessage));
onUnmounted(() => window.removeEventListener('message', onEditorMessage));

const previewVideo = ref(null);
const previewVisible = ref(false);
function openPreview(v) {
  previewVideo.value = v;
  previewVisible.value = true;
}

// ---------- 审阅（预览窗口按钮直达；已审成片卡叠「已审」角标） ----------
// 已审态再点 = 取消审阅；新合成/导出的成片从「未审」开始，每条记录独立审阅
const reviewBusy = ref(false);
async function toggleReview(v) {
  if (!v?.video_url || !canVideo.value || reviewBusy.value) return;
  reviewBusy.value = true;
  try {
    const res = await videoApi.reviewFilm(v.id, !v.reviewed_at);
    v.reviewed_at = res.reviewed_at; // 成片行与预览引用同一对象，改一处两处同步
    ElMessage.success(t(res.reviewed_at ? 'episode.videos.reviewDone' : 'episode.videos.reviewUndone'));
  } catch { /* http 层已提示 */ } finally {
    reviewBusy.value = false;
  }
}
function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fileExt(v) {
  const m = String(v.video_url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return (m ? m[1] : 'mp4').toLowerCase();
}
function downloadName(v) {
  const title = curEpisode.value?.title || '';
  return `${t('script.episodeTitleShort', { idx: curEpisode.value?.idx || '' })}${title ? '-' + title : ''}.${fileExt(v)}`;
}
async function deleteFilm(v) {
  if (!v?.id) return;
  try {
    await ElMessageBox.confirm(t('episode.videos.deleteConfirm'), t('episode.videos.delete'), {
      type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'),
    });
  } catch { return; }
  try {
    await videoApi.deleteFilm(v.id);
    ElMessage.success(t('episode.videos.deleted'));
    if (previewVisible.value) previewVisible.value = false;
    await ctx.loadFilms();
  } catch { /* http 层已提示 */ }
}
</script>

<template>
  <div class="fl">
    <!-- 合成全集进行中：顶部进度横幅 -->
    <div v-if="composeJob" class="fl-banner">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span class="fl-banner-label">{{ t('studio.film.composing') }}</span>
      <el-progress class="fl-banner-bar" :percentage="composeJob.progress || 0" :show-text="false" :stroke-width="6" />
      <span class="fl-banner-pct">{{ composeJob.progress || 0 }}%</span>
    </div>

    <!-- 空状态：先去生成视频 -->
    <EmptyState
      v-if="!rows.length"
      icon-component="VideoPlay"
      :title="t('studio.film.emptyTitle')"
      :description="t('studio.film.emptyDesc')"
      :action-label="canVideo && st.segments.some((s) => s.video_url) ? t('storyboard.composeAll') : ''"
      :disabled="!!composeJob"
      @action="actCompose()"
    />

    <template v-else>
      <div class="fl-summary">
        <span class="fl-ep"><el-icon><VideoPlay /></el-icon>{{ t('script.episodeTitleShort', { idx: curEpisode?.idx ?? '?' }) }}<template v-if="curEpisode?.title"> · {{ curEpisode.title }}</template></span>
        <span class="ad-sub ad-muted">{{ t('studio.film.summary', { count: rows.filter((v) => !!v.video_url).length }) }}</span>
      </div>

      <div class="fl-list" :style="{ '--fl-col-min': `${flColMin}px`, '--fl-ar': mediaAspect }">
        <div
          v-for="v in rows"
          :key="v.id"
          class="ad-card fl-card"
          :class="{ 'fl-focus': focusFilmJobId != null && String(focusFilmJobId) === String(v.job_id) }"
          :data-film-job="v.job_id"
        >
          <div class="fl-media" @click="v.video_url && openPreview(v)">
            <!-- 成片封面（第一帧 480P webp）优先：一张小图替代 video 元素，网格首屏不再拉成片元数据；旧数据无封面回退视频预览 -->
            <img v-if="v.cover_url" class="fl-cover" :src="v.cover_url" alt="" loading="lazy" />
            <LazyVideo v-else-if="v.video_url" :src="v.video_url" />
            <div v-else class="fl-media-draft">
              <el-icon><Headset /></el-icon>
            </div>
            <!-- 版本徽章 + 已审角标（左上纵向堆叠） -->
            <div class="fl-badges">
              <span v-if="badgeOf(v)" class="fl-badge"><el-icon><component :is="badgeIconOf(v)" /></el-icon>{{ badgeOf(v) }}</span>
              <span v-if="v.reviewed_at" class="fl-reviewed"><el-icon><Check /></el-icon>{{ t('episode.videos.reviewed') }}</span>
            </div>
            <span v-if="v.resolution" class="fl-res">{{ v.resolution }}</span>
            <!-- 删除成片小按钮（分辨率签下方，卡片直达） -->
            <button
              v-if="canVideo"
              class="fl-del"
              type="button"
              :title="t('common.delete')"
              @click.stop="deleteFilm(v)"
            ><el-icon><Delete /></el-icon></button>
            <span v-if="v.video_url" class="fl-play"><el-icon><VideoPlay /></el-icon></span>
          </div>
          <div class="fl-info">
            <div class="fl-time">{{ formatTime(v.created_at) }}</div>
            <div class="fl-ops">
              <el-button v-if="isDraft(v)" size="small" class="btn-ink" @click="openSubtitleEditor(v)">
                <el-icon><EditPen /></el-icon> {{ t('episode.videos.editSubtitle') }}
              </el-button>
              <template v-else-if="v.video_url">
                <el-button size="small" @click="openPreview(v)"><el-icon><View /></el-icon> {{ t('common.preview') }}</el-button>
                <el-button
                  v-if="v.kind === 'compose'"
                  size="small"
                  :disabled="!asrReady || subtitleBusy(v)"
                  :loading="subtitleBusy(v)"
                  @click="addSubtitle(v)"
                ><el-icon><Headset /></el-icon> {{ t('episode.videos.addSubtitle') }}</el-button>
                <el-button size="small" :disabled="!canVideo" @click="openVideoEditor(v)"><el-icon><Scissor /></el-icon> {{ t('episode.videos.editVideo') }}</el-button>
                <a class="fl-dl" :href="v.video_url" :download="downloadName(v)">
                  <el-button size="small"><el-icon><Download /></el-icon> {{ t('episode.videos.downloadVideo') }}</el-button>
                </a>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 大窗口预览（全屏铺满 + 视频贴边 + 打开即播） -->
    <el-dialog v-model="previewVisible" class="fl-preview-dialog" width="100%" top="0" :show-close="true" append-to-body destroy-on-close>
      <template #header>
        <div class="preview-head">
          <el-icon><Film /></el-icon>
          <span>{{ t('episode.videos.preview') }}</span>
          <span class="preview-time">{{ formatTime(previewVideo?.created_at) }}</span>
          <!-- 审阅按钮：未审点按标记已审；已审再点取消审阅（需成片管理权限） -->
          <el-button
            v-if="previewVideo?.video_url"
            class="preview-review"
            :class="{ done: !!previewVideo.reviewed_at }"
            size="small"
            round
            :disabled="!canVideo"
            :loading="reviewBusy"
            :title="previewVideo.reviewed_at ? t('episode.videos.unreview') : t('episode.videos.review')"
            @click="toggleReview(previewVideo)"
          >
            <template v-if="!reviewBusy && previewVideo.reviewed_at"><el-icon><Check /></el-icon>&nbsp;{{ t('episode.videos.reviewed') }}</template>
            <template v-else>{{ t('episode.videos.review') }}</template>
          </el-button>
        </div>
      </template>
      <div v-if="previewVideo" class="preview-body" :style="{ '--pv-ar': mediaAspect }">
        <VideoPreview :src="previewVideo.video_url" autoplay />
      </div>
    </el-dialog>

    <!-- 字幕编辑器 -->
    <SubtitleEditorDialog
      v-if="subtitleEditor"
      v-model="subtitleEditorVisible"
      :job-id="subtitleEditor.jobId"
      :video-url="subtitleEditor.videoUrl"
      :project-id="st.project?.id"
      :aspect-ratio="st.project?.aspect_ratio || '9:16'"
      :subtitle="st.project?.settings?.subtitle || null"
      :readonly="!canVideo"
      @done="ctx.loadFilms()"
    />
  </div>
</template>

<style scoped>
.fl { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; gap: 12px; }
.fl-summary { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.fl-ep { display: inline-flex; align-items: center; gap: 6px; font-family: var(--ad-font-display); font-weight: 700; font-size: 16px; color: var(--ad-text-strong); }
.fl-ep .el-icon { color: var(--ad-brand); font-size: 15px; }

/* 合成进度横幅（与分镜面板 sb-banner 同风格） */
.fl-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; border-radius: var(--ad-radius-md);
  background: var(--ad-brand-soft); border: 1px solid color-mix(in srgb, var(--ad-brand) 30%, transparent);
  flex: 0 0 auto;
}
.fl-banner-label { font-size: 13px; font-weight: 700; color: var(--ad-brand); white-space: nowrap; }
.fl-banner-bar { flex: 1; }
.fl-banner-pct { font-size: 12px; color: var(--ad-brand); font-family: var(--ad-font-mono); font-variant-numeric: tabular-nums; }

/* 网格自然撑开，随外层 .fl 滚动（勿设 flex/min-height，否则高度被压成一屏、后排卡片被裁）
   最小列宽走 --fl-col-min（脚本按项目画幅计算，与分镜卡同口径：竖屏 9:16=188px 基准，横屏 16:9=334px，等面积），
   画幅比例走 --fl-ar 由 .fl-list 注入 */
.fl-list {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--fl-col-min, 251px), 1fr)); gap: 12px;
  align-content: start;
}
.fl-card {
  padding: 0; overflow: hidden; display: flex; flex-direction: column;
  transition: transform .18s, box-shadow .18s, border-color .18s;
}
.fl-card:hover { transform: translateY(-2px); box-shadow: var(--ad-shadow-hover); border-color: color-mix(in srgb, var(--ad-brand) 35%, transparent); }
/* 任务面板跳转定位高亮：紫红加粗描边（1px 边框 + 1px 外环叠加）+ 缩放脉冲；
   0%/100% 帧与静态环一致，动画起止无跳变。总时长 1.65s × 2 ≈ 3.3s，与上方 setTimeout 3900 对应 */
.fl-card.fl-focus {
  border-color: var(--ad-focus-jump);
  box-shadow: 0 0 0 1px var(--ad-focus-jump), 0 0 14px color-mix(in srgb, var(--ad-focus-jump) 28%, transparent);
  animation: flFocusGlow 1.65s ease-in-out 2;
}
@keyframes flFocusGlow {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 1px var(--ad-focus-jump), 0 0 14px color-mix(in srgb, var(--ad-focus-jump) 28%, transparent);
  }
  50% {
    transform: scale(1.03); /* 卡片同分镜卡口径，scale 略大无碍（窄卡不会顶出横向滚动条） */
    box-shadow: 0 0 0 2px var(--ad-focus-jump), 0 0 0 7px color-mix(in srgb, var(--ad-focus-jump) 30%, transparent),
                0 0 22px color-mix(in srgb, var(--ad-focus-jump) 40%, transparent);
  }
}
/* 缩略图比例跟项目画幅走（--fl-ar 由 .fl-list 注入；缺省按竖屏 9:16） */
.fl-media { position: relative; aspect-ratio: var(--fl-ar, 9 / 16); background: #000; cursor: pointer; }
.fl-media :deep(.lazy-video video) { object-fit: contain; }
/* 封面图与视频预览同口径：媒体盒已按项目画幅定形，contain 恰好铺满不裁切 */
.fl-cover { width: 100%; height: 100%; object-fit: contain; display: block; }
/* 版本徽章 + 已审角标（叠图左上，纵向堆叠容器；给右侧分辨率签让位） */
.fl-badges {
  position: absolute; top: 8px; left: 8px;
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  max-width: calc(100% - 68px);
}
.fl-badge {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 100%;
  padding: 2px 9px; border-radius: var(--ad-radius-pill);
  background: rgba(0, 0, 0, .62); color: var(--ad-brand);
  font-size: 11px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fl-badge .el-icon { font-size: 12px; }
/* 已审角标（绿底白字示「通过」语义；与分镜卡 sb-reviewed 同款） */
.fl-reviewed {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 8px; border-radius: var(--ad-radius-pill);
  background: color-mix(in srgb, var(--ad-success) 82%, #000); color: #fff;
  font-size: 11px; font-weight: 700;
}
.fl-reviewed .el-icon { font-size: 11px; }
/* 分辨率签叠图右上 */
.fl-res {
  position: absolute; top: 8px; right: 8px;
  padding: 2px 7px; border-radius: var(--ad-radius-pill);
  background: rgba(0, 0, 0, .62); color: rgba(255, 255, 255, .92);
  font-size: 11px; font-family: var(--ad-font-mono);
}
.fl-play {
  position: absolute; inset: 0; margin: auto;
  width: 44px; height: 44px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .55); color: #fff; font-size: 22px;
  opacity: 0; transition: opacity .18s; pointer-events: none;
}
.fl-media:hover .fl-play { opacity: 1; }
.fl-media-draft {
  width: 100%; height: 100%; display: flex; flex-direction: column; gap: 6px;
  align-items: center; justify-content: center;
  background: var(--ad-bg-soft); color: var(--ad-brand); font-size: 12px;
}
.fl-media-draft .el-icon { font-size: 24px; }
.fl-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 9px 12px 12px; }
.fl-time { font-size: 12px; color: var(--ad-text-muted); font-variant-numeric: tabular-nums; }
.fl-ops { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: auto; }
.fl-ops .el-button { flex: 1 1 auto; } /* 文案按钮撑满卡片宽，窄卡自然换行成两行 */
.fl-ops .el-button + .el-button { margin-left: 0; }
.fl-dl { display: block; flex: 1 1 auto; }
.fl-dl .el-button { width: 100%; }
/* 删除成片小按钮（分辨率签下方，卡片直达） */
.fl-del {
  position: absolute; top: 36px; right: 8px;
  width: 24px; height: 24px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, .35); background: rgba(0, 0, 0, .55); color: #fff;
  font-size: 13px; cursor: pointer;
  transition: background .15s, border-color .15s;
}
.fl-del:hover { background: var(--ad-danger); border-color: var(--ad-danger); }
.fl-del:disabled { opacity: .45; cursor: not-allowed; }

/* 大窗口预览头部（窗口本体样式见文末非 scoped 块） */
.preview-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--ad-text); }
.preview-head .el-icon { color: var(--ad-brand); }
.preview-time { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--ad-text-muted); font-variant-numeric: tabular-nums; }
/* 审阅按钮（时间右侧、贴头部最右；弹窗 teleport 到 body，slot 内容仍带 data-v，scoped 可达） */
.preview-review.done { color: var(--ad-success); border-color: color-mix(in srgb, var(--ad-success) 55%, transparent); background: color-mix(in srgb, var(--ad-success) 14%, transparent); }
.preview-body { width: 100%; }

@media (max-width: 900px) {
  .fl { padding: 10px; }
  /* 窄屏列宽整体 ×0.8：竖屏 150px（与分镜卡同口径），横屏等比缩小，画幅间仍等面积 */
  .fl-list { grid-template-columns: repeat(auto-fill, minmax(calc(var(--fl-col-min, 251px) * 0.8), 1fr)); }
}
</style>

<!-- 预览弹窗 append-to-body teleport 到 body，scoped 样式够不到，须非 scoped 块（同 sb-preview-dialog 惯例） -->
<style>
/* 成片预览窗口：全屏铺满（100vw × 100vh），视频贴边。
   头部改为浮层（不占布局高度）→ 视频区撑满整窗高度 */
.fl-preview-dialog {
  height: 100vh;
  margin-bottom: 0;   /* EP 默认 bottom 50px，全屏会顶出滚动条 */
  padding: 0;         /* 去掉对话框自身 16px 内边距，视频贴边 */
  border-radius: 0 !important; /* 全局 .el-dialog 圆角带 !important，此处须同级才能归零（真全屏直角） */
  background: #000;   /* 视频撑满整窗，露底即黑 */
  display: flex; flex-direction: column;
}
.fl-preview-dialog .el-dialog__header {
  position: absolute; top: 0; left: 0; right: 0; z-index: 10;
  padding: 12px 64px 18px 16px; /* 右侧留出关闭按钮位 */
  background: linear-gradient(rgba(0, 0, 0, .62), transparent);
}
/* 头部文字浮在视频上，固定白色保证可读（高特异性压过 scoped 同名规则） */
.fl-preview-dialog .el-dialog__header .preview-head { color: #fff; }
.fl-preview-dialog .el-dialog__header .preview-head .el-icon { color: var(--ad-brand); }
.fl-preview-dialog .el-dialog__header .preview-head .preview-time { color: rgba(255, 255, 255, .75); }
/* max-height:none 顶掉 theme.scss 全局 body 上限（100dvh-240px），全屏时视频区才能真正撑满 */
.fl-preview-dialog .el-dialog__body { flex: 1; min-height: 0; max-height: none; display: flex; flex-direction: column; }
.fl-preview-dialog .el-dialog__body .preview-body { flex: 1; min-height: 0; display: flex; justify-content: center; }
/* 视频区按项目画幅 contain 适配：高恒撑满，宽=高×画幅（超宽时被 max-width 钳制，比例经 aspect-ratio 传导保持） */
.fl-preview-dialog .el-dialog__body .preview-body .vp { height: 100%; max-height: 100%; width: auto; max-width: 100%; aspect-ratio: var(--pv-ar, 9 / 16); border-radius: 0; }
/* 关闭按钮：金色圆形高亮（EP 默认为右上角透明小叉） */
.fl-preview-dialog .el-dialog__headerbtn {
  top: 10px; right: 12px; width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--ad-brand);
  font-size: 20px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .5);
  transition: transform .15s, background .15s;
}
.fl-preview-dialog .el-dialog__headerbtn .el-dialog__close { color: #10131a; font-weight: 700; }
.fl-preview-dialog .el-dialog__headerbtn:hover { background: color-mix(in srgb, var(--ad-brand) 82%, #fff); transform: scale(1.08); }
.fl-preview-dialog .el-dialog__headerbtn:hover .el-dialog__close { color: #10131a; }
</style>
