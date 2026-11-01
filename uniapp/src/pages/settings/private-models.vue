<script setup>
/**
 * 私有模型列表（个人设置入口）：
 * 用户自带 API Key 的专属模型——调用不计积分、模型选择列表置顶。
 * 列表 + 新增/编辑入口（编辑走独立页面，避开弹层 input 初值坑）+ 启停开关。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { modelApi } from '../../api';
import { toast, toastError, confirm } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useThemeStore } from '../../stores/theme';
import { useBackGuard } from '../../composables/useBackGuard';

useBackGuard();

const { t } = useI18n();
const themeStore = useThemeStore();

const list = ref([]);
const loading = ref(false);
const loaded = ref(false);

async function load() {
  loading.value = true;
  try {
    list.value = (await modelApi.myList()) || [];
    loaded.value = true;
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}
onShow(load);

function typeLabel(ty) {
  return t(`settings.privateModels.types.${ty}.label`);
}

// 视频行角标：输入上限/全局并发（NULL=不限；与 admin 管理页同口径）
function inputLimitsChip(c) {
  const parts = [];
  if (c.max_input_images != null || c.max_input_audios != null || c.max_input_videos != null) {
    parts.push(t('model.inputLimits.chipLimits', { v: `${c.max_input_images ?? '∞'}/${c.max_input_audios ?? '∞'}/${c.max_input_videos ?? '∞'}` }));
  }
  if (c.max_concurrency != null) parts.push(t('model.inputLimits.chipConc', { v: c.max_concurrency }));
  return parts.join(' · ');
}

function openEdit(row) {
  const id = row?.id || '';
  uni.navigateTo({ url: `/pages/settings/private-model-edit${id ? `?id=${id}` : ''}` });
}

// 启停切换：disabled 的模型不进生成确认页。
// switch 只挂 :checked 单向绑定，@change 时 row.enabled 还是旧值，必须取 e.detail.value
async function onToggle(row, e) {
  const prev = !!row.enabled;
  const next = !!e?.detail?.value;
  if (next === prev) return;
  row.enabled = next; // 乐观更新（同时驱动 :checked 重渲染）
  try {
    await modelApi.myUpdate(row.id, { enabled: next });
  } catch (err) {
    row.enabled = prev;
    toastError(err);
  }
}

async function onRemove(row) {
  const ok = await confirm({
    title: t('settings.privateModels.delete'),
    content: t('settings.privateModels.deleteConfirm', { name: row.name }),
  });
  if (!ok) return;
  try {
    await modelApi.myRemove(row.id);
    toast(t('common.deleteSuccess'), 'success');
    load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <view class="ad-page" :class="themeStore.rootCls">
    <AdNavbar :title="t('settings.privateModels.title')" />

    <view class="card pm-head">
      <text class="pm-sub">{{ t('settings.privateModels.sub') }}</text>
      <view class="mbtn sm" :class="{ dis: loading }" @tap="openEdit(null)">
        <text class="pm-add-t">＋ {{ t('settings.privateModels.add') }}</text>
      </view>
    </view>

    <view v-if="list.length" class="pm-list">
      <view v-for="row in list" :key="row.id" class="card pm-item" @tap="openEdit(row)">
        <view class="pm-main">
          <view class="pm-titlerow">
            <text class="pm-name">{{ row.name }}</text>
            <text class="chip sm gold">{{ typeLabel(row.type) }}</text>
            <text v-if="row.is_default" class="chip sm glass">{{ t('genConfirm.defaultBadge') }}</text>
            <text v-if="row.type === 'video' && inputLimitsChip(row)" class="chip sm glass">{{ inputLimitsChip(row) }}</text>
            <text class="chip sm ok">{{ t('genConfirm.freeBadge') }}</text>
          </view>
          <text class="pm-meta">{{ row.provider }} · {{ row.model || '—' }} · {{ row.api_key_masked || '—' }}</text>
        </view>
        <view class="pm-ops" @tap.stop>
          <switch
            :checked="!!row.enabled"
            color="#e0b64e"
            style="transform: scale(0.72);"
            @change="onToggle(row, $event)"
          />
          <view class="pm-del" @tap="onRemove(row)">{{ t('common.delete') }}</view>
        </view>
      </view>
    </view>
    <view v-else-if="!loading && loaded" class="card pm-empty">
      <text class="pm-empty-t">{{ t('settings.privateModels.empty') }}</text>
    </view>

    <view style="height: 30px" />

    <AdDialog />
  </view>
</template>

<style scoped>
.pm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; }
.pm-sub { flex: 1; font-size: 12px; line-height: 1.6; color: var(--ad-text-mut); }
.pm-add-t { font-weight: 700; }

.pm-list { display: flex; flex-direction: column; gap: 10px;}
.pm-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; margin: 0 12px;}
.pm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.pm-titlerow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.pm-name { font-size: 15px; font-weight: 700; color: var(--ad-text); margin-right: 2px; }
.pm-meta { font-size: 12px; color: var(--ad-text-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-ops { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.pm-del { font-size: 12px; color: var(--ad-danger, #e5484d); padding: 6px 8px; }

.pm-empty { margin: 0 12px; padding: 26px 16px; display: flex; justify-content: center; }
.pm-empty-t { font-size: 13px; line-height: 1.7; color: var(--ad-text-mut); text-align: center; }
.dis { opacity: 0.45; }
</style>
