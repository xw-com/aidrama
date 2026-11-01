<script setup>
/**
 * 我的项目（Tab 2）：proposal「我的项目」—— ptop 标题 + pcard 列表（含步骤进度）。
 * 数据与 client ProjectsView 同口径：projectApi.list 全量 + 本地状态筛选。
 */
import { ref, computed, onMounted } from 'vue';
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { projectApi, artStyleApi, memberApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { useJobsStore } from '../../stores/jobs';
import { useInvitationsStore } from '../../stores/invitations';
import { useThemeStore } from '../../stores/theme';
import { toAbsolute, coverPalette } from '../../utils/media';
import { statusBarHeight, headerExtraRight } from '../../utils/system';
import { toast, toastError, confirm, actionSheet } from '../../utils/ui';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdTabbar from '../../components/ad-tabbar/ad-tabbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

const { t } = useI18n();
const auth = useAuthStore();
const jobs = useJobsStore();
const invitations = useInvitationsStore();
const theme = useThemeStore();

const list = ref([]);
const loading = ref(false);

const artStyles = ref([]);
const styleNameMap = computed(() => {
  const m = {};
  artStyles.value.forEach((s) => { m[s.key] = s.name; });
  return m;
});
const styleName = (key) => styleNameMap.value[key] || key;

const bellBadge = computed(() => jobs.activeCount + invitations.pendingCount);
const activeCount = computed(() => list.value.filter((p) => p.status !== 'done').length);
const subline = computed(() => t('mobile.projects.subtitle', { projects: activeCount.value, tasks: jobs.activeCount }));

const STATUS_PCT = { outline: 33, assets: 66, video: 90, done: 100 };
const STATUS_STEP = { outline: '1', assets: '2', video: '3', done: '3' };
const statusLabel = (code) => {
  if (!code) return '';
  return ({
    outline: t('project.status.outline'),
    assets: t('project.status.assets'),
    video: t('project.status.video'),
    done: t('project.status.done'),
  })[code] || code;
};
const pct = (p) => STATUS_PCT[p.status] ?? 33;

const coverSrc = (p) => {
  const c = p.cover_thumb || p.cover;
  return c ? toAbsolute(c) : '';
};

async function load() {
  loading.value = true;
  try {
    list.value = await projectApi.list();
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

function openProject(p) {
  const step = STATUS_STEP[p.status];
  uni.navigateTo({ url: step ? `/pages/workspace/index?id=${p.id}&step=${step}` : `/pages/workspace/index?id=${p.id}` });
}

function createProject() {
  uni.navigateTo({ url: '/pages/projects/edit' });
}

const isOwner = (p) => p.my_role === 'owner';

// 卡片「…」菜单：打开 / 编辑 / 删除（owner）或退出（成员）
async function more(p) {
  const isO = isOwner(p);
  const items = [
    { key: 'open', label: t('project.openProject') },
    { key: 'edit', label: t('project.editProject') },
    isO ? { key: 'delete', label: t('project.deleteProject') } : { key: 'leave', label: t('team.leave') },
  ];
  const act = await actionSheet(items);
  if (act === 'open') openProject(p);
  else if (act === 'edit') uni.navigateTo({ url: `/pages/projects/edit?id=${p.id}` });
  else if (act === 'delete' || act === 'leave') {
    const ok = await confirm({
      title: isO ? t('project.deleteProject') : t('team.leave'),
      content: isO ? t('project.deleteConfirm', { name: p.name }) : t('team.leaveConfirm', { name: p.name }),
      danger: true,
    });
    if (!ok) return;
    try {
      if (isO) await projectApi.remove(p.id);
      else await memberApi.leave(p.id);
      toast(isO ? t('common.deleteSuccess') : t('team.left'), 'success');
      load();
    } catch (e) { toastError(e); }
  }
}

function openTasks() {
  if (!auth.isLoggedIn) { uni.navigateTo({ url: '/pages/login/index' }); return; }
  uni.navigateTo({ url: '/pages/tasks/index' });
}

onMounted(async () => {
  if (!auth.isLoggedIn) {
    // 未登录：引导登录（展示中心游客可看，项目区需登录）。正常由 TabBar/入口确认框拦截，
    // 此处仅 deep-link 兜底；鸿蒙端导航不可包 setTimeout，直发
    // 鸿蒙端：reLaunch 不绘制，用 redirectTo
    uni.redirectTo({ url: '/pages/login/index' });
    return;
  }
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
  load();
});

// 回前台时刷新（任务完成 → 项目状态可能已推进）
onShow(() => { if (auth.isLoggedIn) jobs.fetchAll(); });
// 下拉刷新：重拉项目列表 + 任务状态
onPullDownRefresh(async () => {
  try {
    if (auth.isLoggedIn) jobs.fetchAll();
    await load();
  } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page with-tabbar" :class="theme.rootCls">
    <!-- 头部 -->
    <view class="ptop" :style="{ paddingTop: statusBarHeight() + 6 + 'px', paddingRight: 18 + headerExtraRight() + 'px' }">
      <view>
        <view class="ptitle">{{ t('project.title') }}</view>
        <view class="psub">{{ subline }}</view>
      </view>
      <view class="ptop-r">
        <view class="iconbtn" @tap="openTasks">
          <m-icon name="bell" :size="18" />
          <view v-if="bellBadge > 0" class="badge">{{ bellBadge > 99 ? '99+' : bellBadge }}</view>
        </view>
        <view class="iconbtn gold" @tap="createProject"><m-icon name="plus" :size="18" /></view>
      </view>
    </view>

    <!-- 项目卡列表 -->
    <view v-for="p in list" :key="p.id" class="card pcard" @tap="openProject(p)">
      <view class="art" :style="p.cover ? {} : { background: coverPalette(p.id) }">
        <view class="glow" />
        <image v-if="coverSrc(p)" :src="coverSrc(p)" mode="aspectFill" class="cimg" />
        <text v-else class="zi">{{ p.name[0] }}</text>
        <text class="pstat chip warn">{{ statusLabel(p.status) }}</text>
      </view>
      <view class="pbody">
        <view class="prow">
          <text class="pname">{{ p.name }}</text>
          <view class="pmore" @tap.stop="more(p)"><text class="pmore-t">⋯</text></view>
        </view>
        <view v-if="p.shared" class="pshared">{{ t('team.shared') }} · {{ p.owner_name }}</view>
        <view class="pmeta">{{ t('project.styleLabel') }} · {{ styleName(p.style) }} · {{ p.aspect_ratio }}</view>
        <view class="steps">
          <view v-for="(s, i) in 3" :key="i" class="stp" :class="{ on: pct(p) >= (i + 1) * 33 }" />
        </view>
        <view class="pfoot">
          <text class="pfoot-status">{{ pct(p) }}%</text>
          <view class="mbtn sm" @tap.stop="openProject(p)">{{ t('project.openProject') }}</view>
        </view>
      </view>
    </view>

    <view v-if="!list.length && !loading" class="ad-empty">
      <text>{{ t('project.empty') }}</text>
      <view class="mbtn sm" style="margin-top: 14px" @tap="createProject">{{ t('project.newProject') }}</view>
    </view>
    <view v-if="loading" class="ad-loading"><text>{{ t('common.loading') }}</text></view>

    <AdTabbar current="projects" />
  <AdDialog />
  </view>
</template>

<style scoped>
.ptop-r { display: flex; gap: 9px; align-items: center; }
.iconbtn.gold { border-color: rgba(224, 182, 78, 0.4); color: var(--ad-brand); }
.prow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pname { flex: 1; min-width: 0; font-weight: 800; font-size: 15px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pmore { flex: none; padding: 0 4px; }
.pmore-t { color: var(--ad-text-mut); font-size: 18px; font-weight: 700; line-height: 1; }
.pshared { margin-top: 3px; font-size: 11px; color: var(--ad-accent); }
.pmeta { margin-top: 4px; font-size: 12px; color: var(--ad-text-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.steps { display: flex; gap: 6px; margin-top: 12px; }
.stp { flex: 1; height: 3px; border-radius: 2px; background: var(--ad-line); }
.stp.on { background: linear-gradient(90deg, #f2d489, #e0b64e); }
.pfoot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.pfoot-status { font-size: 11px; color: var(--ad-text-mut); }
.ad-loading { padding: 24px 0; text-align: center; color: var(--ad-text-mut); font-size: 12px; }
.ad-empty { padding: 60px 30px; text-align: center; color: var(--ad-text-mut); font-size: 13px; display: flex; flex-direction: column; align-items: center; }
</style>
