<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { logApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';

const { t } = useI18n();

const PAGE_SIZE = 20;

const loading = ref(false);
const dates = ref([]);
const totalBytes = ref(0);
const totalCount = ref(0);
const selectedDate = ref('');
const filterType = ref('');
const types = ref([]);
const files = ref([]);
const fileTotal = ref(0);
const page = ref(1);

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref(null);

// ---- 留档详情里的媒体 URL 点击预览 ----
// 槽位键（ref_image_N/ref_audio_N/ref_video_N）按键名归类（URL 无扩展名也能预览）；
// 其余按扩展名归类；历史留档中的 data: base64 大段收敛成短标签（点击仍可预览）。
const MEDIA_KIND_BY_EXT = {
  image: /\.(jpe?g|png|webp|gif|bmp|avif)([?#][^\s"\\]*)?$/i,
  video: /\.(mp4|webm|mov|m4v|avi|mkv|flv)([?#][^\s"\\]*)?$/i,
  audio: /\.(mp3|wav|m4a|aac|flac|ogg|opus)([?#][^\s"\\]*)?$/i,
};
const SLOT_VALUE_RE = /"(ref_(image|audio|video)_\d+)"\s*:\s*"((?:https?:\/\/|\/files\/|data:)[^"\\]*)"/g;
const DATA_URL_RE = /data:(image|audio|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{8,}/gi;
const WEB_URL_RE = /(https?:\/\/|\/files\/)[^\s"\\]+/gi;

function kindByExt(url) {
  for (const [kind, re] of Object.entries(MEDIA_KIND_BY_EXT)) {
    if (re.test(url.split('#')[0])) return kind;
  }
  return '';
}

function mediaLabel(url) {
  if (!url.startsWith('data:')) return url;
  const comma = url.indexOf(',');
  const bytes = Math.round((url.length - comma - 1) * 3 / 4); // base64 → 原始字节数
  return `${url.slice(0, comma)}（${fmtSize(bytes)}）`;
}

// 把序列化后的留档 JSON 切成 text/media 片段，仅 media 片段可点击预览
const detailSegments = computed(() => {
  // 属性值里的 \n（如 prompt/messages content）转成真实换行再渲染；复制走原始 stringify 不受影响
  const text = JSON.stringify(detail.value?.content ?? '', null, 2).replace(/\\n/g, '\n');
  const spans = []; // { start, end, kind, url, key }，先占位后合并，重叠以先登记者为准
  const overlaps = (s, e) => spans.some((sp) => s < sp.end && sp.start < e);
  for (const m of text.matchAll(SLOT_VALUE_RE)) {
    const start = m.index + m[0].length - m[3].length - 1; // 定位到值本体（去掉收尾引号）
    spans.push({ start, end: start + m[3].length, kind: m[2], url: m[3], key: m[1] });
  }
  for (const m of text.matchAll(DATA_URL_RE)) {
    if (!overlaps(m.index, m.index + m[0].length)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind: m[1].toLowerCase(), url: m[0], key: '' });
    }
  }
  for (const m of text.matchAll(WEB_URL_RE)) {
    const kind = kindByExt(m[0]);
    if (kind && !overlaps(m.index, m.index + m[0].length)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind, url: m[0], key: '' });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const segments = [];
  let pos = 0;
  for (const sp of spans) {
    if (sp.start > pos) segments.push({ type: 'text', text: text.slice(pos, sp.start) });
    segments.push({ type: sp.kind, url: sp.url, key: sp.key, label: mediaLabel(sp.url) });
    pos = sp.end;
  }
  if (pos < text.length) segments.push({ type: 'text', text: text.slice(pos) });
  return segments;
});

const imageViewer = ref({ open: false, index: 0 });
const mediaPreview = ref({ open: false, kind: '', url: '', key: '' });
// 本份留档里的全部图片 URL：点任一张即可左右切换预览
const imageMediaUrls = computed(() => detailSegments.value.filter((s) => s.type === 'image').map((s) => s.url));

function openMedia(seg) {
  if (seg.type === 'image') {
    const idx = detailSegments.value.filter((s) => s.type === 'image').indexOf(seg);
    imageViewer.value = { open: true, index: Math.max(0, idx) };
  } else {
    mediaPreview.value = { open: true, kind: seg.type, url: seg.url, key: seg.key || '' };
  }
}

const mediaIcon = (kind) => ({ image: 'Picture', audio: 'Headset', video: 'VideoPlay' }[kind] || 'Picture');
const mediaTitle = computed(() => {
  const { kind, key } = mediaPreview.value;
  const base = kind === 'audio' ? t('logAdmin.audioPreview') : t('logAdmin.videoPreview');
  return key ? `${base} · ${key}` : base;
});

async function loadDates(keepSelection = true) {
  loading.value = true;
  try {
    const data = await logApi.dates();
    dates.value = data.list;
    totalBytes.value = data.totalBytes;
    totalCount.value = data.totalCount;
    if (!keepSelection || !dates.value.some((d) => d.date === selectedDate.value)) {
      selectedDate.value = dates.value[0]?.date || '';
    }
  } finally {
    loading.value = false;
  }
}

async function loadFiles() {
  if (!selectedDate.value) {
    files.value = [];
    fileTotal.value = 0;
    types.value = [];
    return;
  }
  loading.value = true;
  try {
    const data = await logApi.files({
      date: selectedDate.value,
      type: filterType.value || undefined,
      page: page.value,
      size: PAGE_SIZE,
    });
    files.value = data.list;
    fileTotal.value = data.total;
    types.value = data.types || [];
  } finally {
    loading.value = false;
  }
}

// 切日期重置筛选与页码；切类型仅重置页码
watch(selectedDate, () => {
  filterType.value = '';
  page.value = 1;
  loadFiles();
});
watch(filterType, () => {
  page.value = 1;
  loadFiles();
});
onMounted(loadDates);

async function viewFile(row) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await logApi.detail({ date: selectedDate.value, name: row.name });
  } finally {
    detailLoading.value = false;
  }
}

async function removeFile(row) {
  await ElMessageBox.confirm(t('logAdmin.deleteFileConfirm'), t('common.tip'), { type: 'warning' });
  try {
    await logApi.removeFile({ date: selectedDate.value, name: row.name });
    ElMessage.success(t('logAdmin.deleted'));
    // 当前页删空且不在首页时回退一页，避免停留在空页
    if (files.value.length === 1 && page.value > 1) page.value -= 1;
    await Promise.all([loadFiles(), loadDates()]);
  } catch (e) { /* 拦截器已提示 */ }
}

async function removeDay() {
  const d = dates.value.find((x) => x.date === selectedDate.value);
  await ElMessageBox.confirm(
    t('logAdmin.deleteDayConfirm', { count: d?.count ?? 0, size: fmtSize(d?.sizeBytes ?? 0) }),
    t('common.tip'),
    { type: 'warning' },
  );
  try {
    await logApi.removeDay(selectedDate.value);
    ElMessage.success(t('logAdmin.deleted'));
    await loadDates(false);
    page.value = 1;
    filterType.value = '';
    await loadFiles();
  } catch (e) { /* 拦截器已提示 */ }
}

async function copyDetail() {
  const text = JSON.stringify(detail.value?.content, null, 2);
  await navigator.clipboard.writeText(text);
  ElMessage.success(t('logAdmin.copied'));
}

// '082726.142' → '08:27:26.142'
function fmtTime(tm) {
  if (!tm) return '—';
  return `${tm.slice(0, 2)}:${tm.slice(2, 4)}:${tm.slice(4)}`;
}

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// type=file 名中的提交类型段（text/stream/video/image/image_edit…），image 系独占 success 绿与视频/文本区分
const typeTag = (ty) => ({ text: 'info', video: 'primary', image: 'success', image_edit: 'success' }[ty] || 'warning');
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="ad-page-head ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg ad-title">{{ t('logAdmin.title') }}</div>
          <div class="ad-sub">
            {{ t('logAdmin.subtitle') }}
            <template v-if="totalCount"> · {{ t('logAdmin.statLine', { count: totalCount, size: fmtSize(totalBytes) }) }}</template>
          </div>
        </div>
        <el-button @click="loadDates()">
          <el-icon><Refresh /></el-icon> {{ t('logAdmin.refresh') }}
        </el-button>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <div class="ad-card" style="padding: 16px 20px;">
        <div class="ad-flex-between" style="flex-wrap: wrap; gap: 12px; margin-bottom: 12px;">
          <div class="ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
            <el-select v-model="selectedDate" :placeholder="t('logAdmin.selectDate')" style="width: 260px;" :disabled="!dates.length">
              <el-option v-for="d in dates" :key="d.date" :value="d.date" :label="`${d.date}（${d.count} · ${fmtSize(d.sizeBytes)}）`" />
            </el-select>
            <el-select v-model="filterType" :placeholder="t('logAdmin.allTypes')" style="width: 140px;" :disabled="!selectedDate" clearable>
              <el-option v-for="ty in types" :key="ty" :value="ty" :label="ty" />
            </el-select>
            <el-tag v-if="selectedDate" type="info" effect="plain">{{ t('logAdmin.fileCount', { count: fileTotal }) }}</el-tag>
          </div>
          <el-button v-if="selectedDate" type="danger" plain size="small" @click="removeDay">
            <el-icon><Delete /></el-icon> {{ t('logAdmin.deleteDay') }}
          </el-button>
        </div>

        <div class="log-table-wrap">
          <el-table :data="files" size="small">
            <el-table-column :label="t('logAdmin.colTime')" width="130">
              <template #default="{ row }"><span class="ad-mono tnum">{{ fmtTime(row.time) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('logAdmin.colType')" width="100">
              <template #default="{ row }">
                <el-tag :type="typeTag(row.type)" size="small" effect="plain">{{ row.type || '—' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('logAdmin.colUser')" width="90">
              <template #default="{ row }">{{ row.userId ? `u${row.userId}` : '—' }}</template>
            </el-table-column>
            <el-table-column :label="t('logAdmin.colMode')" prop="mode" width="100" />
            <el-table-column :label="t('logAdmin.colSize')" width="100">
              <template #default="{ row }">{{ fmtSize(row.sizeBytes) }}</template>
            </el-table-column>
            <el-table-column :label="t('logAdmin.colName')" min-width="200" show-overflow-tooltip>
              <template #default="{ row }"><span class="log-name ad-mono">{{ row.name }}</span></template>
            </el-table-column>
            <el-table-column :label="t('logAdmin.colActions')" width="168" fixed="right">
              <template #default="{ row }">
                <div class="log-actions">
                  <el-button size="small" type="primary" plain @click="viewFile(row)">
                    <el-icon><View /></el-icon> {{ t('logAdmin.view') }}
                  </el-button>
                  <el-button size="small" type="danger" plain @click="removeFile(row)">
                    <el-icon><Delete /></el-icon> {{ t('common.delete') }}
                  </el-button>
                </div>
              </template>
            </el-table-column>
            <template #empty>
              <span class="ad-muted">{{ selectedDate ? t('logAdmin.empty') : t('logAdmin.noLogs') }}</span>
            </template>
          </el-table>
        </div>

        <div v-if="fileTotal > PAGE_SIZE" class="log-pager">
          <el-pagination
            background layout="prev, pager, next, total" :pager-count="5"
            :total="fileTotal" :page-size="PAGE_SIZE" v-model:current-page="page"
            @current-change="loadFiles"
          />
        </div>
      </div>

      <!-- 留档详情 -->
      <el-dialog v-model="detailVisible" :title="t('logAdmin.detailTitle')" width="min(860px, 94vw)" top="6vh">
        <div v-loading="detailLoading">
          <template v-if="detail">
            <div class="log-detail-meta ad-muted">
              {{ detail.date }} / {{ detail.name }} · {{ fmtSize(detail.sizeBytes) }}
            </div>
            <pre class="log-pre"><template v-for="(seg, i) in detailSegments" :key="i"><span v-if="seg.type === 'text'">{{ seg.text }}</span><a
              v-else
              class="log-media"
              :data-kind="seg.type"
              @click="openMedia(seg)"
            ><el-icon :size="13"><component :is="mediaIcon(seg.type)" /></el-icon><span class="log-media-label">{{ seg.label }}</span></a></template></pre>
          </template>
        </div>
        <template #footer>
          <el-button @click="detailVisible = false">{{ t('common.close') }}</el-button>
          <el-button type="primary" class="btn-ink" :disabled="!detail" @click="copyDetail">
            <el-icon><DocumentCopy /></el-icon> {{ t('logAdmin.copy') }}
          </el-button>
        </template>
      </el-dialog>

      <!-- 媒体预览：图片走全屏查看器（可左右切换本份留档的其余图片） -->
      <el-image-viewer
        v-if="imageViewer.open"
        :url-list="imageMediaUrls"
        :initial-index="imageViewer.index"
        hide-on-click-modal
        teleported
        @close="imageViewer.open = false"
      />

      <!-- 媒体预览：音频/视频（destroy-on-close 关窗即停播） -->
      <el-dialog v-model="mediaPreview.open" :title="mediaTitle" width="min(960px, 94vw)" align-center destroy-on-close>
        <video
          v-if="mediaPreview.kind === 'video'"
          :src="mediaPreview.url"
          controls autoplay playsinline
          style="display: block; width: 100%; max-height: 70vh; background: #000; border-radius: 8px;"
        ></video>
        <audio
          v-else-if="mediaPreview.kind === 'audio'"
          :src="mediaPreview.url"
          controls autoplay
          style="display: block; width: 100%;"
        ></audio>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.log-table-wrap { overflow-x: auto; }
.log-pager { display: flex; justify-content: flex-end; margin-top: 12px; }
.log-name { font-size: 12px; }
/* 操作列两枚按钮固定同一行（flex 消除换行，间距沿用 el-button 相邻 12px） */
.log-actions { display: flex; align-items: center; white-space: nowrap; }
.log-detail-meta { margin-bottom: 8px; font-size: 12px; word-break: break-all; }
.log-pre {
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border-radius: var(--ad-radius-sm);
  background: var(--el-fill-color-light);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
/* 留档 JSON 里的媒体 URL：可点击预览（图标区分图/音/视） */
.log-media {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}
.log-media:hover { color: var(--el-color-primary-light-3); }
.log-media .el-icon { vertical-align: -2px; margin-right: 3px; }
</style>
