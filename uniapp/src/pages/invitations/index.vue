<script setup>
/**
 * 邀请中心（client InvitationsView 移植）：
 * 逐条接受/拒绝；接受后跳项目列表立即看到共享项目。
 * 30s 轮询由 invitations store 统一管理（App.vue 登录后开启），本页进场即拉最新。
 */
import { ref, onMounted } from 'vue';
import { onPullDownRefresh } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { useInvitationsStore } from '../../stores/invitations';
import { useThemeStore } from '../../stores/theme';
import { invitationApi } from '../../api';
import { PERM_LABEL_KEYS } from '../../utils/perms';
import { toast } from '../../utils/ui';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const store = useInvitationsStore();
const theme = useThemeStore();

const acting = ref(0); // 正在处理的邀请 id（防重复点击）

function label(perm) {
  const key = PERM_LABEL_KEYS[perm];
  return key ? t(key) : perm;
}
function fmtDate(s) {
  try { return new Date(s).toLocaleDateString(); } catch { return s || ''; }
}

async function accept(inv) {
  acting.value = inv.id;
  try {
    await invitationApi.accept(inv.id);
    store.remove(inv.id);
    toast(t('team.invite.accepted'), 'success');
    uni.redirectTo({ url: '/pages/projects/index' });
  } catch (err) {
    // 409 等竞态：刷新列表对齐服务端状态
    toast(err?.message || t('errors.requestFailed'), 'error');
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
    toast(t('team.invite.rejected'), 'success');
  } catch (err) {
    toast(err?.message || t('errors.requestFailed'), 'error');
    await store.fetchAll();
  } finally {
    acting.value = 0;
  }
}

onMounted(() => { store.fetchAll(); }); // 进场即拉最新（轮询由 App.vue 统一管理）
// 下拉刷新：重拉邀请列表
onPullDownRefresh(async () => {
  try { await store.fetchAll(); } finally { uni.stopPullDownRefresh(); }
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('team.invite.title')" />

    <view v-if="!store.items.length" class="ad-empty">
      <m-icon name="bell" :size="34" />
      <text class="et">{{ t('team.invite.empty') }}</text>
    </view>

    <view v-for="inv in store.items" :key="inv.id" class="card ivcard">
      <view class="ivhead">
        <text class="ivproj">{{ inv.project_name }}</text>
        <text class="ivdate mono">{{ fmtDate(inv.created_at) }}</text>
        <AdDialog />
      </view>
      <text class="ivby">{{ t('team.invite.inviter') }}：{{ inv.inviter_name }}</text>
      <view class="ivperms">
        <template v-if="inv.permissions && inv.permissions.length">
          <text v-for="p in inv.permissions" :key="p" class="chip glass sm">{{ label(p) }}</text>
        </template>
        <text v-else class="chip glass sm">{{ t('team.invite.readonly') }}</text>
      </view>
      <text class="ivexpire">{{ t('team.invite.expires') }}：{{ fmtDate(inv.expires_at) }}</text>
      <view class="ivacts">
        <view class="mbtn sm iv-acc" :class="{ dis: acting === inv.id }" @tap="accept(inv)">{{ t('team.invite.accept') }}</view>
        <view class="mbtn ghost sm" :class="{ dis: acting === inv.id }" @tap="reject(inv)">{{ t('team.invite.reject') }}</view>
      </view>
    </view>
    <view style="height: 30px" />
    <AdToast />
  </view>
</template>

<style scoped>
/* 空态图标随 m-icon 默认 currentColor 继承此处文字色 */
.ad-empty { color: var(--ad-text-mut); }
.ivcard { display: flex; flex-direction: column; gap: 8px; padding: 16px; }
.ivhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ivproj { font-size: 15px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ivdate { font-size: 11px; color: var(--ad-text-mut); flex-shrink: 0; }
.ivby { font-size: 12px; color: var(--ad-text-soft); }
.ivperms { display: flex; flex-wrap: wrap; gap: 6px; }
.ivexpire { font-size: 11px; color: var(--ad-text-mut); }
.ivacts { display: flex; gap: 8px; margin-top: 2px; }
.iv-acc { min-width: 88px; }
.dis { opacity: 0.6; }
</style>
