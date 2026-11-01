<script setup>
/**
 * 发布到展示中心独立页（原 episodes 页「发布展示中心」AdSheet 迁出，参照 char-create 页面模式）：
 * 简介 + 勾选可播分集（快照语义）+ 发布/更新/下架。owner 专属入口（episodes 页已按权限显隐）。
 * 入口：/pages/workspace/showcase-publish?pid=<projectId>；数据全部按 pid 现拉
 * （项目权限 + 展示状态 + 成片列表，三者并行），可播分集口径与批量下载/分享一致
 * （每集按展示序取首条有视频的成片：字幕版在前、草稿不算）。
 * 发布/下架成功后 uni.$emit('episodes:reload') 通知列表页重拉（含展示状态角标）再返回。
 */
import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { projectApi, videoApi, showcaseApi } from '../../api';
import { useThemeStore } from '../../stores/theme';
import { toast, confirm } from '../../utils/ui';
import { formatDuration } from '../../utils/format';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();

let pid = null;
const loading = ref(false);
const loadError = ref('');
const project = ref(null);
const episodes = ref([]);
const videosByEpisode = ref({});

// 展示状态（接口不可达时按未发布处理，发布接口幂等可重试）
const showcasePublishedId = ref(null);
const showcaseSavedDesc = ref('');
const showcaseSavedEpids = ref(null);
const showcaseDesc = ref('');
const showcaseSelected = ref([]); // 本次勾选要发布的分集 id（快照语义）
const publishing = ref(false);
const unpublishing = ref(false);

// 每集按展示序（字幕版在前）取首条有视频的：优先最新字幕版（草稿无 video_url 不算），
// 无字幕版/仅草稿时回退原片 —— 与分享播放页同口径
function epVideoRows(epId) {
  const rows = videosByEpisode.value[epId] || [];
  const composes = rows.filter((v) => v.kind === 'compose');
  const derived = rows.filter((v) => v.kind !== 'compose');
  const childrenOf = {};
  for (const d of derived) {
    const k = String(d.source_job_id ?? '');
    (childrenOf[k] = childrenOf[k] || []).push(d);
  }
  const out = [];
  const pushed = new Set(); // 已入列行（按 job_id）：孤儿轮递归会与「子行已按孤儿先入列」在孤儿轮内重合，判重防同一行二次入列（曾致草稿卡渲染两次）
  const pushSubtree = (v) => {
    if (pushed.has(String(v.id ?? v.job_id))) return;
    pushed.add(String(v.id ?? v.job_id));
    for (const c of (childrenOf[String(v.job_id)] || [])) pushSubtree(c); // 先派生后自身
    out.push(v);
  };
  for (const c of composes) pushSubtree(c);
  for (const d of derived) pushSubtree(d); // 已被上游子树收编的自动跳过
  return out;
}

const showcaseEpisodes = computed(() => episodes.value
  .slice()
  .sort((a, b) => a.idx - b.idx)
  .map((ep) => ({ ep, video: epVideoRows(ep.id).find((v) => !!v.video_url) }))
  .filter((x) => !!x.video));

// ---------- 数据初始化（onLoad 后异步拉取，表单不得在挂载帧同步回填） ----------
onLoad((q) => {
  pid = (q && (q.pid || q.id)) || null;
  init();
});

async function init() {
  loading.value = true;
  try {
    const [p, st, list] = await Promise.all([
      projectApi.get(pid),
      showcaseApi.status(pid).catch(() => null), // 尽力而为：拿不到按未发布处理
      videoApi.projectVideos(pid),
    ]);
    project.value = p;
    episodes.value = p.episodes || [];
    const map = {};
    (list || []).forEach((v) => {
      if (!map[v.episode_id]) map[v.episode_id] = [];
      map[v.episode_id].push(v);
    });
    videosByEpisode.value = map;
    // 带出已发布的简介与勾选（发布接口幂等：重复发布=更新简介与勾选分集）
    showcasePublishedId.value = st?.id || null;
    showcaseSavedDesc.value = st?.description || '';
    showcaseSavedEpids.value = Array.isArray(st?.episode_ids) ? st.episode_ids.map(Number) : null;
    showcaseDesc.value = showcaseSavedDesc.value;
    const all = showcaseEpisodes.value.map((x) => x.ep.id);
    const saved = Array.isArray(showcaseSavedEpids.value)
      ? [...new Set(showcaseSavedEpids.value.filter((id) => all.includes(Number(id))))]
      : null;
    showcaseSelected.value = saved && saved.length ? saved : all; // 勾选已全部失效时回退全选
  } catch (e) {
    loadError.value = t('common.error');
  } finally {
    loading.value = false;
  }
}

const showcaseAllChecked = computed(() => showcaseEpisodes.value.length > 0
  && showcaseSelected.value.length === showcaseEpisodes.value.length);
function toggleAllShowcase() {
  showcaseSelected.value = showcaseAllChecked.value ? [] : showcaseEpisodes.value.map((x) => x.ep.id);
}
function toggleShowcaseEp(id) {
  const arr = showcaseSelected.value;
  const i = arr.indexOf(id);
  if (i > -1) arr.splice(i, 1);
  else arr.push(id);
}

async function publishToShowcase() {
  if (!showcaseSelected.value.length) { toast(t('showcase.noSelection')); return; }
  publishing.value = true;
  try {
    const { id } = await showcaseApi.publish(pid, showcaseDesc.value.trim(), showcaseSelected.value);
    showcasePublishedId.value = id;
    showcaseSavedDesc.value = showcaseDesc.value.trim();
    showcaseSavedEpids.value = [...showcaseSelected.value];
    toast(t('showcase.published'), 'success');
    uni.$emit('episodes:reload'); // 列表页重拉（含展示状态角标）
    uni.navigateBack();
  } catch (e) { /* http 层已提示 */ } finally {
    publishing.value = false;
  }
}

// 取消发布（下架）：页内直接操作，不必去展示中心
async function unpublishToShowcase() {
  const okGo = await confirm({
    title: t('showcase.unpublish'),
    content: t('showcase.unpublishConfirm'),
    confirmText: t('common.confirm'),
    cancelText: t('common.cancel'),
  });
  if (!okGo) return;
  unpublishing.value = true;
  try {
    await showcaseApi.remove(showcasePublishedId.value);
    showcasePublishedId.value = null;
    showcaseSavedDesc.value = '';
    showcaseSavedEpids.value = null;
    toast(t('showcase.removed'), 'success');
    uni.$emit('episodes:reload');
    uni.navigateBack();
  } catch (e) { /* http 层已提示 */ } finally {
    unpublishing.value = false;
  }
}

function goShowcase() {
  uni.navigateTo({ url: '/pages/showcase/index' });
}
</script>

<template>
  <view class="ad-page sc-page" :class="theme.rootCls">
    <AdNavbar :title="t('showcase.publishTitle')" />

    <view class="sc-body">
      <view v-if="loading" class="sc-loading"><text>{{ t('common.loading') }}</text></view>
      <view v-else-if="loadError" class="sc-loading"><text>{{ loadError }}</text></view>

      <template v-else>
        <text class="sc-hint">{{ t('showcase.publishDesc') }}</text>
        <textarea
          v-model="showcaseDesc"
          class="ad-textarea"
          :maxlength="500"
          :placeholder="t('showcase.descriptionPlaceholder')"
          placeholder-class="ad-ph"
        />
        <view class="sc-head">
          <text class="sc-head-t">{{ t('showcase.selectEpisodes') }}</text>
          <view class="pchip" :class="{ on: showcaseAllChecked }" @tap="toggleAllShowcase">
            <text>{{ t('showcase.selectAll') }}（{{ showcaseSelected.length }}/{{ showcaseEpisodes.length }}）</text>
          </view>
        </view>
        <view class="sc-list">
          <view
            v-for="x in showcaseEpisodes"
            :key="x.ep.id"
            class="sc-item"
            :class="{ on: showcaseSelected.includes(x.ep.id) }"
            @tap="toggleShowcaseEp(x.ep.id)"
          >
            <text class="sc-item-t">{{ t('asset.episodeLabel', { idx: x.ep.idx, title: x.ep.title }) }}</text>
            <text class="sc-item-d">{{ formatDuration(x.video && x.video.duration) }}</text>
            <m-icon v-if="showcaseSelected.includes(x.ep.id)" name="check" :size="15" />
          </view>
          <view v-if="!showcaseEpisodes.length" class="sc-empty"><text>{{ t('common.noData') }}</text></view>
        </view>
      </template>
    </view>

    <!-- 底部动作条：查看展示 / 下架（已发布时）+ 发布|更新 -->
    <view class="sc-foot">
      <view v-if="showcasePublishedId" class="mbtn ghost sm" @tap="goShowcase"><text>{{ t('showcase.viewShowcase') }}</text></view>
      <view
        v-if="showcasePublishedId"
        class="mbtn danger sm"
        :class="{ dis: unpublishing }"
        @tap="!unpublishing && unpublishToShowcase()"
      ><text>{{ t('showcase.unpublish') }}</text></view>
      <view class="mbtn sm" :class="{ dis: publishing }" @tap="!publishing && publishToShowcase()">
        <text>{{ showcasePublishedId ? t('showcase.update') : t('showcase.publish') }}</text>
      </view>
    </view>

    <AdDialog />
  </view>
</template>

<style scoped>
.sc-body { padding: 14px 18px 110px; display: flex; flex-direction: column; }
.sc-loading { padding: 50px 0; text-align: center; font-size: 12.5px; color: var(--ad-text-mut); }
.sc-hint { font-size: 11.5px; line-height: 1.65; color: var(--ad-text-mut); margin-bottom: 10px; }
.sc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 14px 0 9px; }
.sc-head-t { font-size: 13px; font-weight: 600; color: var(--ad-text); }
.sc-list { max-height: none; overflow-y: visible; display: flex; flex-direction: column; gap: 8px; }
.sc-item {
  display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 13px;
  border-radius: 12px; background: var(--ad-elev); border: 1px solid var(--ad-line);
}
.sc-item.on { background: var(--ad-brand-soft); border-color: rgba(224, 182, 78, 0.4); color: var(--ad-brand); }
.sc-item-t { flex: 1; min-width: 0; font-size: 12.5px; color: var(--ad-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-item-d { flex: none; font-family: var(--ad-font-mono); font-size: 11px; color: var(--ad-text-mut); }
.sc-empty { padding: 26px 0; text-align: center; font-size: 12.5px; color: var(--ad-text-mut); }
.sc-foot {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 80;
  display: flex; flex-wrap: wrap; gap: 9px;
  padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
  background: var(--ad-ink);
}
.sc-foot .mbtn { height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; }
.sc-foot .mbtn.sm { flex: 1; }
</style>
