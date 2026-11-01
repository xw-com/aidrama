<script setup>
/**
 * 中央快门键弹出的创作面板：新建项目 / 新建剧本（AI 编剧）。
 * 面板由 ad-tabbar 内嵌，各 Tab 页无需重复接线。
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AdSheet from '../ad-sheet/ad-sheet.vue';
import { useAuthStore } from '../../stores/auth';
import { requireLogin } from '../../api';

const { t } = useI18n();
const auth = useAuthStore();
const show = ref(false);
const open = () => { show.value = true; };
defineExpose({ open });

const items = [
  { key: 'ai', icon: 'spark', mode: 'ai', needLogin: true },
  { key: 'project', icon: 'plus', mode: 'project', needLogin: true },
];
function pick(it) {
  show.value = false;
  const url = it.mode === 'project' ? '/pages/projects/edit' : '/pages/create/writer?new=1';
  if (it.needLogin && !auth.isLoggedIn) {
    requireLogin(url);
    return;
  }
  uni.navigateTo({ url });
}
</script>

<template>
  <AdSheet :show="show" @update:show="show = $event">
    <view class="csh">
      <view class="csh-title">{{ t('mobile.create.title') }}</view>
      <view class="csh-sub">{{ t('mobile.create.subtitle') }}</view>
    </view>
    <view class="csh-list">
      <view v-for="it in items" :key="it.key" class="csh-item" @tap="pick(it)">
        <view class="csh-ico"><m-icon :name="it.icon" :size="22" /></view>
        <view class="csh-main">
          <view class="csh-name">{{ t('mobile.create.' + it.key) }}</view>
          <view class="csh-desc">{{ t('mobile.create.' + it.key + 'Desc') }}</view>
        </view>
        <m-icon class="csh-arrow" name="right" :size="16" />
      </view>
    </view>
  </AdSheet>
</template>

<style scoped>
.csh { padding: 2px 0 14px; }
.csh-title {
  font-family: var(--ad-font-serif);
  font-weight: 900;
  font-size: 22px;
  color: var(--ad-text);
}
.csh-sub { margin-top: 4px; font-size: 12px; color: var(--ad-text-mut); }
.csh-list { display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px; }
.csh-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--ad-inset);
  border: 1px solid var(--ad-line);
  border-radius: 18px;
  transition: transform 0.16s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.csh-item:active { transform: scale(0.97); }
.csh-ico {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: rgba(224, 182, 78, 0.1);
  border: 1px solid rgba(224, 182, 78, 0.22);
  color: var(--ad-brand); /* m-icon 不传 color 时继承此处文字色 */
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.csh-arrow { color: var(--ad-text-mut); }
.csh-main { flex: 1; min-width: 0; }
.csh-name { font-weight: 700; font-size: 15px; color: var(--ad-text); }
.csh-desc { margin-top: 2px; font-size: 12px; color: var(--ad-text-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
