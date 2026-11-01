<script setup>
import { ref, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { memberApi, invitationApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { PERM_KEYS, PERM_LABEL_KEYS } from '../utils/perms';

/**
 * 成员管理（owner 专属）：邀请（邮箱/手机号精确查找）+ 成员权限行内勾选 + 待处理邀请撤销。
 * 权限改动即时保存（勾选即 PUT），失败回读对齐服务端；默认全不勾＝只读。
 */
const props = defineProps({
  projectId: { type: [Number, String], default: null },
});
const emit = defineEmits(['changed']);
const model = defineModel({ type: Boolean, default: false });

const { t } = useI18n();

const perms = PERM_KEYS.map((key) => ({ key, labelKey: PERM_LABEL_KEYS[key] }));

// —— 数据 ——
const loading = ref(false);
const owner = ref(null);
const members = ref([]);
const invites = ref([]);
const myUserId = ref(null); // 从 /auth/me 惰性取（标记「我」；owner 不会出现在成员表里）

async function loadAll() {
  loading.value = true;
  try {
    const [data, pendings] = await Promise.all([
      memberApi.members(props.projectId),
      memberApi.pendingInvites(props.projectId),
    ]);
    owner.value = data.owner;
    members.value = data.members || [];
    invites.value = pendings || [];
    myUserId.value = useAuthStore().user?.id ?? null;
  } catch (err) {
    ElMessage.error(err?.message || t('errors.requestFailed'));
  } finally {
    loading.value = false;
  }
}

watch(model, (visible) => { if (visible && props.projectId) loadAll(); });

// —— 邀请表单 ——
const inviteForm = reactive({ identifier: '', permissions: [] });
const lookupHit = ref(null); // { id, display_name, email, phone }
const lookupLoading = ref(false);
const inviting = ref(false);

async function lookup() {
  const identifier = inviteForm.identifier.trim();
  if (!identifier) return;
  lookupHit.value = null;
  lookupLoading.value = true;
  try {
    lookupHit.value = await memberApi.lookup(identifier);
  } catch (err) {
    ElMessage.error(err?.message || t('errors.requestFailed'));
  } finally {
    lookupLoading.value = false;
  }
}

async function invite() {
  if (!lookupHit.value) return;
  inviting.value = true;
  try {
    await memberApi.invite(props.projectId, inviteForm.identifier.trim(), inviteForm.permissions);
    ElMessage.success(t('team.manager.invited'));
    inviteForm.identifier = '';
    inviteForm.permissions = [];
    lookupHit.value = null;
    await loadAll();
    emit('changed');
  } catch (err) {
    // 重复邀请/已是成员等业务错误：提示并刷新（可能他人已操作）
    ElMessage.error(err?.message || t('errors.requestFailed'));
    await loadAll();
  } finally {
    inviting.value = false;
  }
}

// —— 成员权限（勾选即存） ——
const savingPerm = ref(0); // 正在保存的成员 id

async function onPermChange(member) {
  savingPerm.value = member.id;
  try {
    await memberApi.updatePermissions(props.projectId, member.id, member.permissions);
    ElMessage.success(t('team.manager.permSaved'));
    emit('changed');
  } catch (err) {
    ElMessage.error(err?.message || t('errors.requestFailed'));
    await loadAll(); // 回读对齐服务端
  } finally {
    savingPerm.value = 0;
  }
}

async function removeMember(member) {
  try {
    await ElMessageBox.confirm(
      t('team.manager.removeConfirm', { name: member.display_name || member.nickname || `#${member.id}` }),
      t('common.tip'),
      { type: 'warning' },
    );
  } catch { return; } // 用户取消
  try {
    await memberApi.removeMember(props.projectId, member.id);
    ElMessage.success(t('team.manager.removed'));
    await loadAll();
    emit('changed');
  } catch (err) {
    ElMessage.error(err?.message || t('errors.requestFailed'));
  }
}

// —— 待处理邀请 ——
async function revokeInvite(inv) {
  try {
    await invitationApi.revoke(inv.id);
    ElMessage.success(t('team.manager.revoked'));
    await loadAll();
  } catch (err) {
    ElMessage.error(err?.message || t('errors.requestFailed'));
    await loadAll();
  }
}
</script>

<template>
  <el-dialog v-model="model" :title="t('team.manager.title')" width="min(760px, 94vw)" append-to-body destroy-on-close class="member-dialog">
    <div v-loading="loading" class="mm-wrap">
      <!-- 邀请 -->
      <section class="mm-section">
        <h4 class="mm-title">{{ t('team.manager.inviteTitle') }}</h4>
        <div class="mm-invite-row">
          <el-input
            v-model="inviteForm.identifier"
            :placeholder="t('team.manager.identifierPlaceholder')"
            clearable
            @keyup.enter="lookup"
          />
          <el-button :loading="lookupLoading" @click="lookup">{{ t('team.manager.lookup') }}</el-button>
        </div>
        <div v-if="lookupHit" class="mm-hit">
          <el-icon><CircleCheckFilled /></el-icon>
          <span class="mm-hit-name">{{ lookupHit.display_name || lookupHit.nickname }}</span>
          <span class="mm-hit-contact">{{ lookupHit.email }}{{ lookupHit.email && lookupHit.phone ? ' · ' : '' }}{{ lookupHit.phone }}</span>
          <el-button type="primary" class="btn-ink" :loading="inviting" @click="invite">{{ t('team.manager.inviteBtn') }}</el-button>
        </div>
        <div class="mm-perms">
          <div class="mm-perms-label">{{ t('team.manager.invitePerms') }}</div>
          <el-checkbox-group v-model="inviteForm.permissions">
            <el-checkbox v-for="p in perms" :key="p.key" :value="p.key">{{ t(p.labelKey) }}</el-checkbox>
          </el-checkbox-group>
          <div class="mm-hint">{{ t('team.manager.defaultReadonly') }}</div>
        </div>
      </section>

      <!-- 成员表 -->
      <section class="mm-section">
        <h4 class="mm-title">{{ t('team.manager.membersTitle') }}（{{ members.length + 1 }}）</h4>
        <div v-if="owner" class="mm-owner-row">
          <el-avatar :size="30" class="mm-avatar">{{ (owner.display_name || 'U').slice(0, 1).toUpperCase() }}</el-avatar>
          <span class="mm-name">{{ owner.display_name || owner.nickname }}</span>
          <span v-if="owner.id === myUserId" class="mm-me">{{ t('team.manager.meTag') }}</span>
          <el-tag size="small" type="warning" effect="plain">{{ t('team.manager.ownerTag') }}</el-tag>
          <span class="mm-owner-perms">{{ t('team.manager.ownerAllPerms') }}</span>
        </div>
        <div v-for="m in members" :key="m.id" class="mm-member-row">
          <div class="mm-member-head">
            <el-avatar :size="30" class="mm-avatar">{{ (m.display_name || 'U').slice(0, 1).toUpperCase() }}</el-avatar>
            <span class="mm-name">{{ m.display_name || m.nickname }}</span>
            <span class="mm-contact">{{ m.email }}{{ m.email && m.phone ? ' · ' : '' }}{{ m.phone }}</span>
            <span v-if="m.id === myUserId" class="mm-me">{{ t('team.manager.meTag') }}</span>
            <span class="mm-joined">{{ t('team.manager.joinedAt') }} {{ new Date(m.joined_at).toLocaleDateString() }}</span>
            <el-button size="small" text type="danger" @click="removeMember(m)">{{ t('team.manager.remove') }}</el-button>
          </div>
          <el-checkbox-group :model-value="m.permissions" :disabled="savingPerm === m.id" class="mm-perms-group" @update:model-value="(v) => { m.permissions = v; onPermChange(m); }">
            <el-checkbox v-for="p in perms" :key="p.key" :value="p.key">{{ t(p.labelKey) }}</el-checkbox>
          </el-checkbox-group>
        </div>
        <div v-if="members.length === 0 && !loading" class="mm-hint">{{ t('team.manager.noMembers') }}</div>
      </section>

      <!-- 待处理邀请 -->
      <section v-if="invites.length" class="mm-section">
        <h4 class="mm-title">{{ t('team.manager.pendingTitle') }}（{{ invites.length }}）</h4>
        <div v-for="inv in invites" :key="inv.id" class="mm-invite-item">
          <span class="mm-name">{{ inv.invitee?.display_name || inv.invitee?.nickname }}</span>
          <span class="mm-contact">{{ inv.invitee?.email }}{{ inv.invitee?.email && inv.invitee?.phone ? ' · ' : '' }}{{ inv.invitee?.phone }}</span>
          <el-tag v-if="inv.expired" size="small" type="danger" effect="plain">{{ t('team.manager.expired') }}</el-tag>
          <span class="mm-joined">{{ new Date(inv.expires_at).toLocaleDateString() }}</span>
          <el-button size="small" text @click="revokeInvite(inv)">{{ t('team.manager.revoke') }}</el-button>
        </div>
      </section>
    </div>
    <template #footer>
      <el-button @click="model = false">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mm-wrap { display: flex; flex-direction: column; gap: 20px; }
.mm-section { display: flex; flex-direction: column; gap: 10px; }
.mm-title { margin: 0; font-size: 14px; font-weight: 700; color: var(--ad-text); }
.mm-invite-row { display: flex; gap: 8px; }
.mm-invite-row .el-input { flex: 1; }
.mm-hit { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--ad-radius-sm); background: var(--ad-bg-soft); }
.mm-hit .el-icon { color: var(--ad-success, #22c55e); }
.mm-hit-name { font-weight: 600; color: var(--ad-text); }
.mm-hit-contact { flex: 1; font-size: 12px; color: var(--ad-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-perms-label { font-size: 12px; color: var(--ad-text-muted); }
.mm-hint { font-size: 12px; color: var(--ad-text-muted); }
.mm-owner-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); }
.mm-owner-perms { margin-left: auto; font-size: 12px; color: var(--ad-text-muted); }
.mm-member-row { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm); }
.mm-member-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mm-avatar { background: var(--ad-brand); color: var(--ad-brand-contrast); font-weight: 700; flex-shrink: 0; }
.mm-name { font-weight: 600; font-size: 13px; color: var(--ad-text); }
.mm-contact { font-size: 12px; color: var(--ad-text-muted); }
.mm-me { font-size: 11px; color: var(--ad-brand); border: 1px solid var(--ad-brand); border-radius: var(--ad-radius-pill); padding: 0 6px; line-height: 18px; }
.mm-joined { margin-left: auto; font-size: 12px; color: var(--ad-text-muted); }
.mm-invite-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--ad-radius-sm); background: var(--ad-bg-soft); }
.mm-perms-group { display: flex; flex-wrap: wrap; column-gap: 4px; }
@media (max-width: 768px) {
  .mm-joined { display: none; }
}
</style>
