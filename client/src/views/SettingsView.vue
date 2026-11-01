<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useThemeStore } from '../stores/theme';
import { useLocaleStore } from '../stores/locale';
import { useAuthStore } from '../stores/auth';
import { modelApi } from '../api';
import PrivateModelDialog from '../components/PrivateModelDialog.vue';

const theme = useThemeStore();
const auth = useAuthStore();
const locale = useLocaleStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const themeOptions = [
  { value: 'light', labelKey: 'theme.light', descKey: 'theme.lightDesc', icon: 'Sunny' },
  { value: 'dark', labelKey: 'theme.dark', descKey: 'theme.darkDesc', icon: 'Moon' },
  { value: 'auto', labelKey: 'theme.auto', descKey: 'theme.autoDesc', icon: 'Monitor' },
];

const currentTheme = computed(() => theme.mode);
const currentLocale = computed(() => locale.locale);

// 积分展示：去浮点噪声（如 89108.00000000036），最多 2 位小数 + 千分位
const creditsText = computed(() => {
  const v = Number(auth.credits) || 0;
  return (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
});

// 修改密码（走 xworld /users/me/password）
const pwdRef = ref();
const pwdLoading = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });
const pwdOpen = ref(false); // 修改密码默认折叠，点击展开

// 修改昵称（仅本地镜像）
const nicknameInput = ref(auth.user?.nickname || '');
const nickLoading = ref(false);
async function onSaveNickname() {
  const v = (nicknameInput.value || '').trim();
  if (!v) { ElMessage.warning(t('settings.nicknamePlaceholder')); return; }
  nickLoading.value = true;
  try {
    await auth.updateNickname(v);
    ElMessage.success(t('settings.nicknameSaved'));
  } finally {
    nickLoading.value = false;
  }
}
const pwdRules = {
  oldPassword: [{ required: true, message: t('validation.passwordRequired'), trigger: 'blur' }],
  newPassword: [{ required: true, message: t('validation.passwordRequired'), trigger: 'blur' }, { min: 6, message: t('validation.passwordLen'), trigger: 'blur' }],
  confirm: [{ required: true, message: t('validation.confirmRequired'), trigger: 'blur' }, { validator: (r, v, cb) => v === pwdForm.newPassword ? cb() : cb(new Error(t('validation.passwordMismatch'))), trigger: 'blur' }],
};
async function onChangePassword() {
  await pwdRef.value.validate();
  pwdLoading.value = true;
  try {
    await auth.changePassword({ oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword });
    ElMessage.success(t('changePassword.success'));
    pwdForm.oldPassword = pwdForm.newPassword = pwdForm.confirm = '';
  } finally {
    pwdLoading.value = false;
  }
}

// ============ 私有模型（自带 Key，调用不计积分，模型列表置顶） ============
const myModels = ref([]);
const myLoading = ref(false);
const pmDialogRef = ref();

async function loadMyModels() {
  myLoading.value = true;
  try {
    myModels.value = (await modelApi.myList()) || [];
  } finally {
    myLoading.value = false;
  }
}

function pmTypeLabel(ty) {
  return t(`settings.privateModels.types.${ty}.label`);
}

// 视频行角标：输入上限/全局并发（NULL=不限不下发；与 admin 管理页同口径）
function inputLimitsChip(c) {
  const parts = [];
  if (c.max_input_images != null || c.max_input_audios != null || c.max_input_videos != null) {
    parts.push(t('model.inputLimits.chipLimits', { v: `${c.max_input_images ?? '∞'}/${c.max_input_audios ?? '∞'}/${c.max_input_videos ?? '∞'}` }));
  }
  if (c.max_concurrency != null) parts.push(t('model.inputLimits.chipConc', { v: c.max_concurrency }));
  return parts.join(' · ');
}

async function onToggleMyModel(row) {
  await modelApi.myUpdate(row.id, { enabled: !!row.enabled });
}

async function removeMyModel(row) {
  await ElMessageBox.confirm(t('settings.privateModels.deleteConfirm', { name: row.name }), t('common.tip'), { type: 'warning' });
  await modelApi.myRemove(row.id);
  ElMessage.success(t('common.deleteSuccess'));
  loadMyModels();
}

onMounted(() => {
  loadMyModels();
  // 从「生成确认」的「使用自己的模型」入口跳转过来：带类型参数直接弹出新增弹窗（自动选中对应类型）。
  // 打开后即清掉 query，避免刷新/回退时重复弹
  const ty = route.query.addPrivateModel;
  if (typeof ty === 'string' && ty) {
    pmDialogRef.value?.open(null, ty);
    router.replace({ query: { ...route.query, addPrivateModel: undefined } });
  }
});
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('settings.title') }}</div>
      </div>
      <div class="ad-rule st-rule" />

      <!-- 偏好：主题 + 语言（紧凑合并） -->
      <div class="ad-card block">
        <div class="block-head">
          <div>
            <div class="ad-title"><el-icon><Brush /></el-icon> {{ t('settings.prefTitle') }}</div>
            <div class="ad-sub">{{ t('settings.prefSub') }}</div>
          </div>
        </div>
        <div class="pref-rows">
          <div class="pref-row">
            <div class="pref-label">
              <el-icon><Monitor /></el-icon>
              <div>
                <div class="pref-name">{{ t('theme.title') }}</div>
                <div class="pref-hint">{{ t('theme.sub') }}</div>
              </div>
            </div>
            <el-radio-group :model-value="currentTheme" @update:model-value="(v) => theme.setMode(v)">
              <el-radio-button v-for="o in themeOptions" :key="o.value" :value="o.value">
                <el-icon class="pref-btn-icon"><component :is="o.icon" /></el-icon>{{ t(o.labelKey) }}
              </el-radio-button>
            </el-radio-group>
          </div>
          <div class="pref-row">
            <div class="pref-label">
              <el-icon><Comment /></el-icon>
              <div>
                <div class="pref-name">{{ t('settings.languageTitle') }}</div>
                <div class="pref-hint">{{ t('settings.languageSub') }}</div>
              </div>
            </div>
            <el-select size="large" :model-value="currentLocale" @update:model-value="(v) => locale.setLocale(v)" style="width: 200px;">
              <el-option v-for="lang in locale.languages" :key="lang.value" :label="lang.label" :value="lang.value" />
            </el-select>
          </div>
        </div>
      </div>

      <!-- 账户 -->
      <div class="ad-card block">
        <div class="block-head">
          <div>
            <div class="ad-title"><el-icon><User /></el-icon> {{ t('settings.accountTitle') }}</div>
            <div class="ad-sub">{{ t('settings.accountSub') }}</div>
          </div>
        </div>
        <div class="account-grid">
          <!-- 左：资料 + 昵称 -->
          <div class="account-left">
            <div class="profile">
              <el-avatar :size="56" class="big-avatar">{{ (auth.displayName || 'U').slice(0, 1).toUpperCase() }}</el-avatar>
              <div>
                <div style="font-size:18px; font-weight:700; color: var(--ad-text);">{{ auth.displayName }}</div>
                <div class="ad-sub">{{ auth.user?.email || t('settings.emailUnset') }}</div>
                <div class="ad-flex-center ad-gap-sm" style="margin-top:6px;">
                  <span class="chip" :class="auth.user?.role === 'admin' ? 'chip-accent' : ''">{{ auth.user?.role === 'admin' ? t('settings.roleAdmin') : t('settings.roleUser') }}</span>
                  <span class="chip chip-warning">{{ creditsText }} {{ t('settings.creditsUnit') }}</span>
                </div>
              </div>
            </div>
            <div class="nick-row">
              <el-input size="large" v-model="nicknameInput" :placeholder="t('settings.nicknamePlaceholder')" maxlength="32" clearable>
                <template #prepend>{{ t('settings.nicknameLabel') }}</template>
              </el-input>
              <el-button type="primary" class="btn-ink" :loading="nickLoading" @click="onSaveNickname">{{ t('settings.nicknameSave') }}</el-button>
            </div>
          </div>
          <!-- 右：修改密码（默认折叠，点击展开） -->
          <div class="account-right">
            <div class="pwd-title" @click="pwdOpen = !pwdOpen">
              <el-icon><Lock /></el-icon>
              <span>{{ t('changePassword.title') }}</span>
              <el-icon class="pwd-caret"><component :is="pwdOpen ? 'ArrowUp' : 'ArrowDown'" /></el-icon>
            </div>
            <el-form v-if="pwdOpen" ref="pwdRef" :model="pwdForm" :rules="pwdRules" label-position="top" class="pwd-form">
              <el-form-item :label="t('changePassword.oldPassword')" prop="oldPassword">
                <el-input size="large" v-model="pwdForm.oldPassword" type="password" show-password :prefix-icon="'Lock'" />
              </el-form-item>
              <el-form-item :label="t('changePassword.newPassword')" prop="newPassword">
                <el-input size="large" v-model="pwdForm.newPassword" type="password" show-password :prefix-icon="'Lock'" />
              </el-form-item>
              <el-form-item :label="t('field.confirmPassword')" prop="confirm">
                <el-input size="large" v-model="pwdForm.confirm" type="password" show-password :prefix-icon="'Lock'" @keyup.enter="onChangePassword" />
              </el-form-item>
              <el-button type="primary" :loading="pwdLoading" @click="onChangePassword">{{ t('changePassword.submit') }}</el-button>
            </el-form>
          </div>
        </div>
      </div>

      <!-- 私有模型：自带 Key，调用不计积分，模型列表置顶 -->
      <div class="ad-card block" v-loading="myLoading">
        <div class="block-head">
          <div>
            <div class="ad-title"><el-icon><Key /></el-icon> {{ t('settings.privateModels.title') }}</div>
            <div class="ad-sub">{{ t('settings.privateModels.sub') }}</div>
          </div>
          <el-button type="primary" class="btn-ink" @click="pmDialogRef.open()"><el-icon><Plus /></el-icon> {{ t('settings.privateModels.add') }}</el-button>
        </div>
        <div v-if="myModels.length" class="pm-list">
          <div v-for="row in myModels" :key="row.id" class="pm-item">
            <div class="pm-main">
              <div class="ad-flex-center ad-gap-sm" style="flex-wrap: wrap;">
                <span class="ad-title">{{ row.name }}</span>
                <span class="chip chip-private">{{ pmTypeLabel(row.type) }}</span>
                <span class="chip" v-if="row.is_default">{{ t('model.chip.default') }}</span>
                <span class="chip" v-if="row.type === 'video' && inputLimitsChip(row)">{{ inputLimitsChip(row) }}</span>
                <span class="chip chip-success">{{ t('genConfirm.freeBadge') }}</span>
              </div>
              <div class="ad-sub" style="margin-top: 6px;">
                <span class="ad-muted">{{ t('settings.privateModels.vendor') }}</span>{{ row.provider }}
                <span class="ad-muted" style="margin-left:12px;">{{ t('settings.privateModels.model') }}</span>{{ row.model || '—' }}
                <span class="ad-muted" style="margin-left:12px;">{{ t('model.keyLabel') }}</span>{{ row.api_key_masked || '—' }}
              </div>
            </div>
            <div class="pm-ops">
              <el-switch v-model="row.enabled" :title="t('settings.privateModels.enabled')" @change="onToggleMyModel(row)" />
              <el-button size="small" text @click="pmDialogRef.open(row)">{{ t('common.edit') }}</el-button>
              <el-button size="small" text type="danger" @click="removeMyModel(row)">{{ t('common.delete') }}</el-button>
            </div>
          </div>
        </div>
        <div v-else-if="!myLoading" class="pm-empty">{{ t('settings.privateModels.empty') }}</div>
      </div>
      <PrivateModelDialog ref="pmDialogRef" @saved="loadMyModels" />

      
      <!-- 关于 -->
      <div class="ad-card block">
        <div class="block-head">
          <div>
            <div class="ad-title"><el-icon><InfoFilled /></el-icon> {{ t('settings.aboutTitle') }}</div>
          </div>
        </div>
        <div class="about">
          <p>{{ t('settings.aboutL1') }}</p>
          <p class="ad-sub">{{ t('settings.aboutL2') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st-rule { margin-bottom: 18px; }
.block { padding: var(--ad-sp-5) var(--ad-sp-6); margin-bottom: 18px; }
.block-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
/* 偏好（主题 + 语言）紧凑行 */
.pref-rows { display: flex; flex-direction: column; gap: 14px; }
.pref-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.pref-label { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pref-label > .el-icon { font-size: 20px; color: var(--ad-text-muted); }
.pref-name { font-weight: 700; color: var(--ad-text); }
.pref-hint { font-size: 12px; color: var(--ad-text-muted); }
.pref-btn-icon { margin-right: 4px; vertical-align: -2px; }
/* 账户区：左资料/昵称 + 右修改密码 并排 */
.account-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; }
.account-left { min-width: 0; }
.account-right { min-width: 0; }
.pwd-title { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; cursor: pointer; color: var(--ad-text-soft); font-weight: 600; font-size: 14px; user-select: none; }
.pwd-title:hover { color: var(--ad-primary); }
.pwd-caret { font-size: 12px; margin-left: auto; }
.pwd-form { margin-top: 0; }
.profile { display: flex; align-items: center; gap: 18px; }
.nick-row { display: flex; align-items: center; gap: 10px; margin-top: 18px; max-width: 420px; }
.big-avatar { background: var(--ad-primary); color: var(--ad-primary-contrast); font-size: 22px; font-weight: 700; }
/* 私有模型列表 */
.pm-list { display: flex; flex-direction: column; gap: 10px; }
.pm-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--ad-border); border-radius: var(--ad-radius-sm, 8px); background: var(--ad-bg-soft); flex-wrap: wrap; }
.pm-main { flex: 1; min-width: 240px; }
.pm-ops { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.chip-private { background: var(--ad-brand); color: var(--ad-brand-contrast, #221a04); }
.pm-empty { padding: 18px 0 6px; font-size: 13px; color: var(--ad-text-muted); text-align: center; }
.about p { margin: 4px 0; color: var(--ad-text); }
@media (max-width: 600px) { .pref-row { align-items: flex-start; flex-direction: column; } }
@media (max-width: 860px) { .account-grid { grid-template-columns: 1fr; gap: 20px; } }
</style>
