<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { useInvitationsStore } from '../stores/invitations';
import { invitationApi } from '../api';
import { PERM_LABEL_KEYS } from '../utils/perms';
import EmptyState from '../components/EmptyState.vue';

/**
 * 邀请中心独立页（顶栏铃铛点击本窗口跳转）：
 * 逐条接受/拒绝；接受后跳项目列表立即看到共享项目；
 * 变更 postMessage 通知来源窗口（若有），其铃铛角标即时刷新（不等 30s 轮询）。
 */
const { t } = useI18n();
const router = useRouter();
const store = useInvitationsStore();

const acting = ref(0); // 正在处理的邀请 id（防重复点击）

function label(perm) {
  const key = PERM_LABEL_KEYS[perm];
  return key ? t(key) : perm;
}

function notifyOpener() {
  try {
    window.opener?.postMessage({ type: 'invitations:changed' }, window.location.origin);
  } catch { /* 不可用则由原窗口 30s 轮询兜底 */ }
}

async function accept(inv) {
  acting.value = inv.id;
  try {
    await invitationApi.accept(inv.id);
    store.remove(inv.id);
    notifyOpener();
    ElMessage.success(t('team.invite.accepted'));
    // 带时间戳 query：当前已在 /projects 时同路径 push 不重挂载，靠 query 变化触发列表重载
    router.push({ path: '/projects', query: { refresh: Date.now() } });
  } catch (err) {
    // 409 等竞态：刷新列表对齐服务端状态
    ElMessage.error(err?.message || t('errors.requestFailed'));
    await store.fetchAll();
  } finally {
    acting.value = 0;
  }
}

async function reject(inv) {
  acting.value = inv.id;
  try {
    await invitationApi.reject(inv.id);
    store.remove(inv.id);
    notifyOpener();
    ElMessage.success(t('team.invite.rejected'));
  } catch (err) {
    ElMessage.error(err?.message || t('errors.requestFailed'));
    await store.fetchAll();
  } finally {
    acting.value = 0;
  }
}

onMounted(() => {
  void store.fetchAll(); // 新窗口打开即拉最新（轮询由 DefaultLayout 统一管理）
  window.addEventListener('message', onMessage);
});
onUnmounted(() => window.removeEventListener('message', onMessage));

// 同名其他邀请窗口的变更也同步过来（多窗口并存时保持一致）
function onMessage(e) {
  if (e.origin === window.location.origin && e.data?.type === 'invitations:changed') {
    void store.fetchAll();
  }
}
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('team.invite.title') }}</div>
        <div class="ad-sub">{{ t('team.invite.subtitle') }}</div>
      </div>
      <div class="ad-rule iv-rule" />

      <EmptyState v-if="store.items.length === 0" icon-component="Bell" :title="t('team.invite.empty')" />
      <div v-else class="invite-grid ad-stagger">
        <div v-for="inv in store.items" :key="inv.id" class="invite-card">
          <div class="invite-head">
            <span class="invite-proj">{{ inv.project_name }}</span>
            <span class="invite-date">{{ new Date(inv.created_at).toLocaleDateString() }}</span>
          </div>
          <div class="invite-by">{{ t('team.invite.inviter') }}：{{ inv.inviter_name }}</div>
          <div v-if="inv.permissions && inv.permissions.length" class="invite-perms">
            <el-tag v-for="p in inv.permissions" :key="p" size="small" type="info">{{ label(p) }}</el-tag>
          </div>
          <el-tag v-else size="small" type="info">{{ t('team.invite.readonly') }}</el-tag>
          <div class="invite-expire">{{ t('team.invite.expires') }}：{{ new Date(inv.expires_at).toLocaleDateString() }}</div>
          <div class="invite-actions">
            <el-button size="small" type="primary" class="btn-ink" :loading="acting === inv.id" @click="accept(inv)">{{ t('team.invite.accept') }}</el-button>
            <el-button size="small" :disabled="acting === inv.id" @click="reject(inv)">{{ t('team.invite.reject') }}</el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.iv-rule { margin-bottom: 16px; }
.invite-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
@media (max-width: 768px) { .invite-grid { grid-template-columns: 1fr; } }
.invite-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: var(--ad-sp-5) var(--ad-sp-6);
  border: 1px solid var(--ad-border);
  border-radius: var(--ad-radius-md);
  background: var(--ad-bg-elevated);
}
.invite-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.invite-proj { font-size: 16px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.invite-date { font-size: 12px; color: var(--ad-text-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.invite-by { font-size: 13px; color: var(--ad-text-soft); }
.invite-perms { display: flex; flex-wrap: wrap; gap: 6px; }
.invite-expire { font-size: 12px; color: var(--ad-text-muted); }
.invite-actions { display: flex; gap: 8px; margin-top: 2px; }
</style>
