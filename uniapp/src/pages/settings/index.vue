<script setup>
/**
 * 个人设置（client SettingsView 移植）：
 * 外观主题（深色/浅色/跟随系统）+ 语言偏好（9 语）+ 账户资料/昵称
 * + 修改密码（折叠）+ 关于。
 */
import { ref, reactive, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { useLocaleStore } from '../../stores/locale';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { toast, toastError, confirm } from '../../utils/ui';
import { getCacheSize, clearCache } from '../../utils/storage';
import { getAppVersion, checkAppUpdate, promptAppUpdate } from '../../utils/appUpdate';
import { isIosApp } from '../../utils/system';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const localeStore = useLocaleStore();
const themeStore = useThemeStore();

// 外观三档：dark / light / system（system 由 store 监听 uni.onThemeChange 或 matchMedia）
const themeOptions = [
  { value: 'dark', labelKey: 'theme.dark' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'system', labelKey: 'theme.auto' },
];

// 积分展示：去浮点噪声，最多 2 位小数 + 千分位
const creditsText = computed(() => {
  const v = Number(auth.credits) || 0;
  return (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
});

// 语言：自绘网格点选（原生 picker 的 change 在 App/鸿蒙端有跨桥回传不稳、
// 滚动未停点确定返回旧值的坑，故与主题三档一样走 @tap，点选即生效）
async function onLangTap(value) {
  if (value === localeStore.locale) return;
  try {
    await localeStore.setLocale(value);
  } catch (e) {
    console.error('[settings] 切换语言失败:', e);
    toastError(e); // 失败原因多来自 http 层，统一错误文案兜底（原硬编码中文违反 i18n）
  }
}

// 昵称（本地镜像 + sync 上报）
const nicknameInput = ref(auth.user?.nickname || '');
const nickLoading = ref(false);
async function onSaveNickname() {
  const v = (nicknameInput.value || '').trim();
  if (!v) { toast(t('settings.nicknamePlaceholder'), 'error'); return; }
  nickLoading.value = true;
  try {
    await auth.updateNickname(v);
    toast(t('settings.nicknameSaved'), 'success');
  } catch { /* http 层已提示 */ } finally {
    nickLoading.value = false;
  }
}

// 修改密码（折叠表单；手工校验替代 el-form rules）
const pwdOpen = ref(false);
const pwdLoading = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });
function validatePwd() {
  if (!pwdForm.oldPassword) return t('validation.passwordRequired');
  if (!pwdForm.newPassword) return t('validation.passwordRequired');
  if (pwdForm.newPassword.length < 6) return t('validation.passwordLen');
  if (!pwdForm.confirm) return t('validation.confirmRequired');
  if (pwdForm.confirm !== pwdForm.newPassword) return t('validation.passwordMismatch');
  return '';
}
async function onChangePassword() {
  const err = validatePwd();
  if (err) { toast(err, 'error'); return; }
  pwdLoading.value = true;
  try {
    await auth.changePassword({ oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword });
    toast(t('changePassword.success'), 'success');
    pwdForm.oldPassword = pwdForm.newPassword = pwdForm.confirm = '';
    pwdOpen.value = false;
  } catch (e) {
    toastError(e); // 直连 xworld 路径不经 http 拦截层，需就地提示（401 当前密码错误 / 422 校验失败等）
  }
  finally { pwdLoading.value = false; }
}

// 清空缓存：估算大小每次进页刷新；登录态与语言/主题偏好保留（见 storage.js PRESERVE_KEYS）
const cacheText = ref('');
function refreshCacheSize() {
  const b = getCacheSize();
  cacheText.value = b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;
}
onShow(refreshCacheSize);

async function onClearCache() {
  const ok = await confirm({
    title: t('settings.clearCache'),
    content: t('settings.clearCacheConfirm'),
  });
  if (!ok) return;
  clearCache();
  refreshCacheSize();
  toast(t('settings.cacheCleared'), 'success');
}

// ===== 关于：真实版本号（App 端）+ 检查更新 + 协议入口 =====
const appVersion = ref('');
/* #ifdef APP-PLUS */
getAppVersion().then((v) => { appVersion.value = v; });
/* #endif */

function goAgreement(type) {
  uni.navigateTo({ url: `/pages/agreement/index?type=${type}` });
}

/** 手动检查更新：失败/无更新有提示；Android 有更新弹对话框跳下载页，iOS 提示去 App Store */
async function onCheckUpdate() {
  const data = await checkAppUpdate({ silent: false });
  if (!data) return; // 非 App 端为 null（入口仅在 App 端渲染）；失败已提示
  if (!data.hasUpdate) { toast(t('app.update.latest')); return; }
  /* #ifdef APP-PLUS */
  if (data.platform === 'ios' || isIosApp()) {
    toast(t('app.update.iosTip'), { icon: 'none' });
    return;
  }
  promptAppUpdate(data);
  /* #endif */
}
</script>

<template>
  <view class="ad-page" :class="themeStore.rootCls">
    <AdNavbar :title="t('settings.title')" />

    <!-- 账户资料 -->
    <view class="card st-profile">
      <view class="st-avatar">{{ (auth.displayName || 'U').slice(0, 1).toUpperCase() }}</view>
      <view class="st-pinfo">
        <text class="st-name">{{ auth.displayName }}</text>
        <text class="st-mail">{{ auth.user?.email || t('settings.emailUnset') }}</text>
        <view class="st-chips">
          <text class="chip sm" :class="auth.user?.role === 'admin' ? 'gold' : 'glass'">{{ auth.user?.role === 'admin' ? t('settings.roleAdmin') : t('settings.roleUser') }}</text>
          <text class="chip warn sm mono">{{ creditsText }} {{ t('settings.creditsUnit') }}</text>
        </view>
      </view>
    </view>

    <!-- 昵称 -->
    <view class="sect-title">{{ t('settings.accountTitle') }}</view>
    <view class="card st-block">
      <text class="st-lab">{{ t('settings.nicknameLabel') }}</text>
      <view class="st-nickrow">
        <input
          v-model="nicknameInput"
          class="st-input"
          :placeholder="t('settings.nicknamePlaceholder')"
          maxlength="32"
        />
        <view class="mbtn sm" :class="{ dis: nickLoading }" @tap="onSaveNickname">{{ t('settings.nicknameSave') }}</view>
      </view>

      <!-- 修改密码（折叠） -->
      <view class="st-pwdhead" @tap="pwdOpen = !pwdOpen">
        <m-icon name="set" :size="16" />
        <text class="st-pwdtitle">{{ t('changePassword.title') }}</text>
        <text class="st-caret" :class="{ open: pwdOpen }">▾</text>
      </view>
      <view v-if="pwdOpen" class="st-pwdform">
        <view class="ad-field">
          <text class="st-flab">{{ t('changePassword.oldPassword') }}</text>
          <input v-model="pwdForm.oldPassword" class="st-input" password :placeholder="t('validation.passwordRequired')" />
        </view>
        <view class="ad-field">
          <text class="st-flab">{{ t('changePassword.newPassword') }}</text>
          <input v-model="pwdForm.newPassword" class="st-input" password :placeholder="t('validation.passwordLen')" />
        </view>
        <view class="ad-field">
          <text class="st-flab">{{ t('field.confirmPassword') }}</text>
          <input v-model="pwdForm.confirm" class="st-input" password :placeholder="t('validation.confirmRequired')" />
        </view>
        <view class="mbtn sm st-pwdsub" :class="{ dis: pwdLoading }" @tap="onChangePassword">{{ t('changePassword.submit') }}</view>
      </view>
    </view>

    <!-- 偏好：主题 + 语言 -->
    <view class="sect-title">{{ t('settings.prefTitle') }}</view>
    <view class="card st-block">
      <text class="st-lab">{{ t('theme.title') }}</text>
      <view class="st-seg">
        <view
          v-for="opt in themeOptions"
          :key="opt.value"
          class="st-segopt"
          :class="{ on: themeStore.mode === opt.value }"
          @tap="themeStore.setMode(opt.value)"
        >{{ t(opt.labelKey) }}</view>
      </view>
      <text class="st-hint">{{ t('theme.sub') }}</text>

      <text class="st-lab">{{ t('settings.languageTitle') }}</text>
      <view class="st-langgrid">
        <view
          v-for="lang in localeStore.languages"
          :key="lang.value"
          class="st-segopt st-lang"
          :class="{ on: localeStore.locale === lang.value }"
          @tap="onLangTap(lang.value)"
        >{{ lang.label }}</view>
      </view>
      <text class="st-hint">{{ t('settings.languageSub') }}</text>
    </view>


    <!-- 清空缓存 -->
    <view class="card st-linkrow" @tap="onClearCache">
      <view class="st-row-l">
        <text class="st-rowname">{{ t('settings.clearCache') }}</text>
        <text class="st-rowhint">{{ t('settings.clearCacheSub') }}</text>
      </view>
      <text class="st-cachesize">{{ cacheText }}</text>
    </view>

    <!-- 关于：版本（App 端）+ 检查更新（App 端）+ 协议入口 -->
    <view class="sect-title">{{ t('settings.aboutTitle') }}</view>
    <view class="card st-about">
      <text class="st-aboutl">{{ t('settings.aboutL1') }}</text>
      <text class="st-aboutl sub">{{ t('settings.aboutL2') }}</text>
      <!-- #ifdef APP-PLUS -->
      <view class="st-linkrow st-aboutrow" @tap="onCheckUpdate">
        <view class="st-row-l">
          <text class="st-rowname">{{ t('settings.checkUpdate') }}</text>
        </view>
        <text class="st-caret open">▸</text>
      </view>
      <view class="st-linkrow st-aboutrow">
        <view class="st-row-l">
          <text class="st-rowname">{{ t('settings.version') }}</text>
        </view>
        <text class="st-cachesize mono">{{ appVersion }}</text>
      </view>
      <!-- #endif -->
      <view class="st-linkrow st-aboutrow" @tap="goAgreement('terms')">
        <view class="st-row-l">
          <text class="st-rowname">{{ t('agreement.termsTitle') }}</text>
        </view>
        <text class="st-caret open">▸</text>
      </view>
      <view class="st-linkrow st-aboutrow" @tap="goAgreement('privacy')">
        <view class="st-row-l">
          <text class="st-rowname">{{ t('agreement.privacyTitle') }}</text>
        </view>
        <text class="st-caret open">▸</text>
      </view>
    </view>
    <view style="height: 30px" />
    <AdDialog />
  </view>
</template>

<style scoped>
.st-profile { display: flex; align-items: center; gap: 14px; padding: 18px 16px; }
.st-avatar {
  width: 56px; height: 56px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 800; color: #0a0a0f;
  background: linear-gradient(135deg, #f2d489, #e0b64e 45%, #b3871f);
}
.st-pinfo { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.st-name { font-size: 17px; font-weight: 700; color: var(--ad-text); }
.st-mail { font-size: 12px; color: var(--ad-text-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-chips { display: flex; gap: 6px; margin-top: 2px; }

.sect-title { font-family: var(--ad-font-serif); font-size: 15px; font-weight: 700; color: var(--ad-text); margin: 20px 12px 12px; }
.st-block { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
/* 外观三档分段选择器（选中态风格同 .pchip.on） */
.st-seg { display: flex; gap: 7px; }
.st-segopt {
  flex: 1; height: 38px; display: flex; align-items: center; justify-content: center;
  border-radius: 11px; font-size: 13px; font-weight: 600; line-height: 1;
  background: var(--ad-inset, #0d0d14); border: 1px solid var(--ad-line, #26262f);
  color: var(--ad-text-soft, #b3afa3);
}
.st-segopt.on {
  background: var(--ad-brand-soft, rgba(224, 182, 78, 0.13));
  border-color: rgba(224, 182, 78, 0.35);
  color: var(--ad-brand, #e0b64e);
}
.st-hint { font-size: 11px; line-height: 1.6; color: var(--ad-text-mut); margin-top: -4px; }
.st-lab { font-size: 12px; color: var(--ad-text-mut); }
.st-nickrow { display: flex; gap: 10px; }
.st-nickrow .st-input { flex: 1; }
.st-input {
  height: 42px; padding: 0 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  color: var(--ad-text); font-size: 14px;
}
.dis { opacity: 0.6; }

.st-pwdhead { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--ad-line); color: var(--ad-text-soft); }
.st-pwdtitle { font-size: 13px; font-weight: 600; color: var(--ad-text-soft); }
.st-caret { margin-left: auto; color: var(--ad-text-mut); font-size: 12px; transition: transform 0.2s; }
.st-caret.open { transform: rotate(0deg); color: var(--ad-brand); }
.st-pwdform { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
.ad-field { display: flex; flex-direction: column; gap: 6px; }
.st-flab { font-size: 12px; color: var(--ad-text-mut); }
.st-pwdsub { align-self: flex-start; min-width: 120px; display: flex; align-items: center; justify-content: center; }

.st-row-l { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.st-rowname { font-size: 14px; font-weight: 600; color: var(--ad-text); }
.st-rowhint { font-size: 11px; color: var(--ad-text-mut); }
/* 语言网格：复用 .st-segopt 外观，固定三列换行排布 */
.st-langgrid { display: flex; flex-wrap: wrap; gap: 7px; }
.st-lang { flex: 0 0 calc((100% - 14px) / 3); }

.st-linkrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; }
.st-linkrow .st-caret { margin-left: 0; }
.st-cachesize { font-size: 12px; font-weight: 600; color: var(--ad-text-mut); font-variant-numeric: tabular-nums; flex-shrink: 0; }

.st-about { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.st-aboutl { font-size: 13px; line-height: 1.7; color: var(--ad-text); }
.st-aboutl.sub { font-size: 12px; color: var(--ad-text-mut); }
/* 关于区行入口（检查更新/版本/协议）：与上方文案用细线分隔 */
.st-aboutrow { margin-top: 4px; padding: 12px 0 2px; border-top: 1px solid var(--ad-line); }
</style>
