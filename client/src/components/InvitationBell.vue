<script setup>
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useInvitationsStore } from '../stores/invitations';

/**
 * 顶栏邀请铃铛：角标 = 待处理邀请数（invitations store 30s 轮询），
 * 点击本窗口跳转邀请中心独立页；其它窗口/标签页处理完邀请会 postMessage 回来即时刷新角标。
 */
const { t } = useI18n();
const router = useRouter();
const store = useInvitationsStore();

function openCenter() {
  router.push({ name: 'invitations' });
}

// 邀请中心窗口接受/拒绝后立即刷新角标（不等 30s 轮询）
function onMessage(e) {
  if (e.origin === window.location.origin && e.data?.type === 'invitations:changed') {
    void store.fetchAll();
  }
}

onMounted(() => window.addEventListener('message', onMessage));
onUnmounted(() => window.removeEventListener('message', onMessage));
</script>

<template>
  <button class="invite-bell" :title="t('team.invite.title')" @click="openCenter">
    <el-badge :value="store.pendingCount" :hidden="store.pendingCount === 0" :max="99">
      <el-icon :size="18"><Bell /></el-icon>
    </el-badge>
  </button>
</template>

<style scoped>
.invite-bell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--ad-border);
  background: var(--ad-bg-elevated);
  border-radius: var(--ad-radius-sm);
  color: var(--ad-text-soft);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.invite-bell:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
</style>
