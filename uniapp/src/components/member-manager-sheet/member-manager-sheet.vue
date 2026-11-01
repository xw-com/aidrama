<script setup>
/**
 * 成员管理弹层（client MemberManagerDialog 移植，owner 专属）：
 * 邀请（邮箱/手机号精确查找）+ 成员权限 chip 勾选（勾选即存）+ 待处理邀请撤销。
 * props: projectId；emit changed。
 */
import { ref, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { memberApi, invitationApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { PERM_KEYS, PERM_LABEL_KEYS } from '../../utils/perms';
import { toast, confirm } from '../../utils/ui';
import { readClipboard } from '../../utils/clipboard';
import AdSheet from '../ad-sheet/ad-sheet.vue';

const props = defineProps({
  projectId: { type: [Number, String], default: null },
});
const emit = defineEmits(['changed']);
const show = defineModel('show', { type: Boolean, default: false });

const { t } = useI18n();
const auth = useAuthStore();

const perms = PERM_KEYS.map((key) => ({ key, labelKey: PERM_LABEL_KEYS[key] }));

// —— 数据 ——
const loading = ref(false);
const owner = ref(null);
const members = ref([]);
const invites = ref([]);
const myUserId = ref(null);

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
    myUserId.value = auth.user?.id ?? null;
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
  } finally {
    loading.value = false;
  }
}

watch(show, (visible) => { if (visible && props.projectId) loadAll(); });

// —— 邀请 ——
const identifier = ref('');
const lookupHit = ref(null);
const lookupLoading = ref(false);
const inviting = ref(false);
const invitePerms = ref([]);

async function lookup() {
  const v = identifier.value.trim();
  if (!v) {
    // 原先静默 return：空输入点查找毫无反馈，看起来像「没反应」
    toast(t('team.manager.inputRequired'), 'error');
    return;
  }
  lookupHit.value = null;
  lookupLoading.value = true;
  try {
    lookupHit.value = await memberApi.lookup(v);
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
  } finally {
    lookupLoading.value = false;
  }
}

// 鸿蒙端长按输入框唤起系统粘贴菜单会失焦、粘贴不可用 → 「粘贴」按钮直读剪贴板并顺带触发查找
// 注意：鸿蒙端 uni.getClipboardData 需要受限权限 ohos.permission.READ_PASTEBOARD（AGC 签名 Profile ACL + 弹窗授权），
// 未授权时 DCloud 实现直接 reject「getClipboardData:fail Permission denied」→ 这里不能笼统提示「请求失败」
async function pasteAndLookup() {
  let text = '';
  try {
    text = (await readClipboard()).trim();
  } catch (err) {
    toast(t('errors.clipboardRead'), 'error');
    return;
  }
  if (!text) {
    toast(t('team.manager.clipboardEmpty'), 'error');
    return;
  }
  identifier.value = text;
  lookup();
}

async function invite() {
  if (!lookupHit.value) return;
  inviting.value = true;
  try {
    await memberApi.invite(props.projectId, identifier.value.trim(), invitePerms.value);
    toast(t('team.manager.invited'), 'success');
    identifier.value = '';
    invitePerms.value = [];
    lookupHit.value = null;
    await loadAll();
    emit('changed');
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
    await loadAll();
  } finally {
    inviting.value = false;
  }
}

// —— 成员权限（勾选即存） ——
const savingPerm = ref(0);

function togglePerm(member, key) {
  const has = (member.permissions || []).includes(key);
  const next = has ? (member.permissions || []).filter((k) => k !== key) : [...(member.permissions || []), key];
  member.permissions = next;
  savePerm(member);
}
async function savePerm(member) {
  savingPerm.value = member.id;
  try {
    await memberApi.updatePermissions(props.projectId, member.id, member.permissions);
    toast(t('team.manager.permSaved'), 'success');
    emit('changed');
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
    await loadAll(); // 回读对齐服务端
  } finally {
    savingPerm.value = 0;
  }
}

async function removeMember(member) {
  const ok = await confirm({
    title: t('common.tip'),
    content: t('team.manager.removeConfirm', { name: member.display_name || member.nickname || `#${member.id}` }),
    danger: true,
  });
  if (!ok) return;
  try {
    await memberApi.removeMember(props.projectId, member.id);
    toast(t('team.manager.removed'), 'success');
    await loadAll();
    emit('changed');
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
  }
}

// —— 待处理邀请 ——
async function revokeInvite(inv) {
  try {
    await invitationApi.revoke(inv.id);
    toast(t('team.manager.revoked'), 'success');
    await loadAll();
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
    await loadAll();
  }
}

function fmtDate(s) {
  try { return new Date(s).toLocaleDateString(); } catch { return s || ''; }
}
</script>

<template>
  <AdSheet v-model:show="show" :title="t('team.manager.title')">
    <!-- 不再套 scroll-view：ash-body 本身可滚，此前双层滚动容器里长按粘贴菜单锚点/焦点异常
         （项目改名 AdDialog 同为 AdSheet，输入框无 scroll-view 包裹可正常长按粘贴） -->
      <view class="mm">
        <!-- 邀请 -->
        <view class="mm-sect">
          <text class="mm-title">{{ t('team.manager.inviteTitle') }}</text>
          <view class="mm-invrow">
            <input
              v-model="identifier"
              class="mm-input"
              confirm-type="search"
              :placeholder="t('team.manager.identifierPlaceholder')"
              @confirm="lookup"
            />
            <view class="mbtn ghost sm" @tap="pasteAndLookup">{{ t('team.manager.paste') }}</view>
            <view class="mbtn ghost sm" :class="{ dis: lookupLoading }" @tap="lookup">{{ t('team.manager.lookup') }}</view>
          </view>
          <view v-if="lookupHit" class="mm-hit">
            <view class="mm-hitinfo">
              <text class="mm-name">{{ lookupHit.display_name || lookupHit.nickname }}</text>
              <text class="mm-contact">{{ lookupHit.email }}{{ lookupHit.email && lookupHit.phone ? ' · ' : '' }}{{ lookupHit.phone }}</text>
            </view>
            <view class="mbtn sm" :class="{ dis: inviting }" @tap="invite">{{ t('team.manager.inviteBtn') }}</view>
          </view>
          <view class="mm-perms">
            <text class="mm-permslabel">{{ t('team.manager.invitePerms') }}</text>
            <view class="mm-permchips">
              <text
                v-for="p in perms"
                :key="p.key"
                class="pchip"
                :class="{ on: invitePerms.includes(p.key) }"
                @tap="invitePerms = invitePerms.includes(p.key) ? invitePerms.filter((k) => k !== p.key) : [...invitePerms, p.key]"
              >{{ t(p.labelKey) }}</text>
            </view>
            <text class="mm-hint">{{ t('team.manager.defaultReadonly') }}</text>
          </view>
        </view>

        <!-- 成员 -->
        <view class="mm-sect">
          <text class="mm-title">{{ t('team.manager.membersTitle') }}（{{ members.length + 1 }}）</text>
          <view v-if="owner" class="mm-ownerrow">
            <view class="mm-avatar">{{ (owner.display_name || 'U').slice(0, 1).toUpperCase() }}</view>
            <text class="mm-name">{{ owner.display_name || owner.nickname }}</text>
            <text v-if="owner.id === myUserId" class="mm-me">{{ t('team.manager.meTag') }}</text>
            <text class="chip warn sm">{{ t('team.manager.ownerTag') }}</text>
          </view>
          <view v-for="m in members" :key="m.id" class="mm-member">
            <view class="mm-memberhead">
              <view class="mm-avatar">{{ (m.display_name || 'U').slice(0, 1).toUpperCase() }}</view>
              <view class="mm-membertop">
                <view class="mm-nameline">
                  <text class="mm-name">{{ m.display_name || m.nickname }}</text>
                  <text v-if="m.id === myUserId" class="mm-me">{{ t('team.manager.meTag') }}</text>
                </view>
                <text class="mm-contact">{{ m.email }}{{ m.email && m.phone ? ' · ' : '' }}{{ m.phone }}</text>
              </view>
              <view class="mbtn danger sm" @tap="removeMember(m)">{{ t('team.manager.remove') }}</view>
            </view>
            <view class="mm-permchips">
              <text
                v-for="p in perms"
                :key="p.key"
                class="pchip"
                :class="{ on: (m.permissions || []).includes(p.key), dis: savingPerm === m.id }"
                @tap="savingPerm !== m.id && togglePerm(m, p.key)"
              >{{ t(p.labelKey) }}</text>
            </view>
          </view>
          <text v-if="members.length === 0 && !loading" class="mm-hint">{{ t('team.manager.noMembers') }}</text>
        </view>

        <!-- 待处理邀请 -->
        <view v-if="invites.length" class="mm-sect">
          <text class="mm-title">{{ t('team.manager.pendingTitle') }}（{{ invites.length }}）</text>
          <view v-for="inv in invites" :key="inv.id" class="mm-pending">
            <view class="mm-hitinfo">
              <text class="mm-name">{{ inv.invitee?.display_name || inv.invitee?.nickname }}</text>
              <text class="mm-contact">{{ inv.invitee?.email }}{{ inv.invitee?.email && inv.invitee?.phone ? ' · ' : '' }}{{ inv.invitee?.phone }} · {{ fmtDate(inv.expires_at) }}</text>
            </view>
            <view class="mbtn ghost sm" @tap="revokeInvite(inv)">{{ t('team.manager.revoke') }}</view>
          </view>
        </view>
      </view>
  </AdSheet>
</template>

<style scoped>
.mm { display: flex; flex-direction: column; gap: 20px; padding-bottom: 8px; }
.mm-sect { display: flex; flex-direction: column; gap: 10px; }
.mm-title { font-size: 14px; font-weight: 700; color: var(--ad-text); }
.mm-invrow { display: flex; gap: 8px; }
.mm-input {
  flex: 1; height: 40px; padding: 0 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 13px;
}
.mm-hit { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 11px; background: rgba(224, 182, 78, 0.08); border: 1px solid rgba(224, 182, 78, 0.3); }
.mm-hitinfo { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mm-name { font-weight: 600; font-size: 13px; color: var(--ad-text); }
.mm-contact { font-size: 11px; color: var(--ad-text-mut); }
.mm-perms { display: flex; flex-direction: column; gap: 8px; }
.mm-permslabel { font-size: 12px; color: var(--ad-text-mut); }
.mm-permchips { display: flex; flex-wrap: wrap; gap: 8px; }
.mm-hint { font-size: 11px; color: var(--ad-text-mut); }
.mm-ownerrow { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--ad-line); border-radius: 11px; }
.mm-member { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--ad-line); border-radius: 11px; }
.mm-memberhead { display: flex; align-items: center; gap: 10px; }
.mm-membertop { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mm-nameline { display: flex; align-items: center; gap: 6px; }
.mm-avatar {
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: #0a0a0f;
  background: linear-gradient(135deg, #f2d489, #e0b64e);
}
.mm-me { font-size: 10px; color: var(--ad-brand); border: 1px solid var(--ad-brand); border-radius: 999px; padding: 0 6px; line-height: 16px; }
.mm-pending { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 11px; background: var(--ad-inset); }
.dis { opacity: 0.6; }
</style>
