<script setup>
// 用户管理 admin：用户列表/封禁/登录密码重置/一键登录用户前端 / 登录日志 / 登录配置（脱敏只读）
// 本视图仅挂载在管理后台（admin 入口），当前登录态取管理端 store
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { userAdminApi, paymentAdminApi } from '../api';
import { useAdminAuthStore } from '../admin/stores/auth';

const { t } = useI18n();
const auth = useAdminAuthStore();

const activeTab = ref('users');

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '-');

// ===== 用户列表 =====
const users = ref([]);
const usersTotal = ref(0);
const usersPage = ref(1);
const usersSize = 20;
const usersLoading = ref(false);
const userKeyword = ref('');
const userStatus = ref('');
const statusSavingId = ref(0);

async function loadUsers() {
  usersLoading.value = true;
  try {
    const params = { page: usersPage.value, size: usersSize };
    if (userKeyword.value.trim()) params.keyword = userKeyword.value.trim();
    if (userStatus.value) params.status = userStatus.value;
    const data = await userAdminApi.list(params);
    users.value = data.list || [];
    usersTotal.value = data.total || 0;
  } finally {
    usersLoading.value = false;
  }
}

function searchUsers() { usersPage.value = 1; loadUsers(); }

async function setStatus(row, status) {
  if (status === 'banned') {
    try {
      await ElMessageBox.confirm(
        t('userAdmin.ban.confirmText', { name: row.nickname || row.username || `#${row.id}` }),
        t('userAdmin.ban.ban'),
        { type: 'warning' },
      );
    } catch { return; }
  }
  statusSavingId.value = row.id;
  try {
    await userAdminApi.setStatus(row.id, status);
    ElMessage.success(t(status === 'banned' ? 'userAdmin.ban.done' : 'userAdmin.unban.done'));
    loadUsers();
  } finally {
    statusSavingId.value = 0;
  }
}

const roleTag = (r) => (r === 'admin' ? 'danger' : 'info');

// ===== 一键登录用户前端：签发该用户的短时效前台令牌，跳前台首页即以该用户身份进入 =====
const loginAsSavingId = ref(0);

async function loginAs(row) {
  const name = row.nickname || row.username || `#${row.id}`;
  try {
    await ElMessageBox.confirm(
      t('userAdmin.loginAs.confirmText', { name }),
      t('userAdmin.loginAs.title'),
      { type: 'warning' },
    );
  } catch { return; }
  loginAsSavingId.value = row.id;
  // 借确认点击的手势期同步开空白窗占位（await 后再 window.open 会被拦截），接口返回后再定向；
  // 占位被拦截（win 为 null）则回退整页跳转。管理台令牌独立存储，新窗口不影响 /admin 登录态。
  const win = window.open('about:blank', '_blank');
  try {
    const data = await userAdminApi.loginAs(row.id);
    ElMessage.success(t('userAdmin.loginAs.done'));
    // 前台路由守卫落地令牌后立即从地址栏剥离，再进展示中心首页
    const url = `/?login_token=${encodeURIComponent(data.token)}`;
    if (win && !win.closed) win.location.replace(url);
    else window.location.assign(url);
  } catch (e) {
    win?.close();
    throw e;
  } finally {
    loginAsSavingId.value = 0;
  }
}

// ===== 设置/重置登录密码（管理台密码登录用；xworld 晋级 admin 本地密码为随机占位） =====
const pwdVisible = ref(false);
const pwdSaving = ref(false);
const pwdForm = reactive({ user_id: null, name: '', password: '' });

function openPassword(row) {
  pwdForm.user_id = row.id;
  pwdForm.name = row.nickname || row.username || `#${row.id}`;
  pwdForm.password = '';
  pwdVisible.value = true;
}

async function submitPassword() {
  const pwd = String(pwdForm.password || '');
  if (pwd.length < 8 || pwd.length > 64) {
    ElMessage.warning(t('userAdmin.password.ph'));
    return;
  }
  pwdSaving.value = true;
  try {
    await userAdminApi.setPassword(pwdForm.user_id, pwd);
    ElMessage.success(t('userAdmin.password.done'));
    pwdVisible.value = false;
  } finally {
    pwdSaving.value = false;
  }
}

// ===== 积分调整（走 /admin/payments/adjust，落 type='adjust' 流水） =====
const adjustVisible = ref(false);
const adjustSaving = ref(false);
const adjustForm = reactive({ user_id: null, dir: 'add', amount: null, remark: '' });

function openAdjust(row) {
  adjustForm.user_id = row.id;
  adjustForm.dir = 'add';
  adjustForm.amount = null;
  adjustForm.remark = '';
  adjustVisible.value = true;
}

async function submitAdjust() {
  // 积分一位小数精度：支持 0.1 步进
  const n = Math.round((Number(adjustForm.amount) || 0) * 10) / 10;
  if (!adjustForm.user_id || !Number.isFinite(Number(adjustForm.amount)) || n <= 0 || !adjustForm.remark.trim()) {
    ElMessage.warning(t('paymentAdmin.adjust.fillAll'));
    return;
  }
  try {
    await ElMessageBox.confirm(
      t('paymentAdmin.adjust.confirmText', {
        dir: t(`paymentAdmin.adjust.dir_${adjustForm.dir}`),
        amount: n,
        user: adjustForm.user_id,
      }),
      t('paymentAdmin.adjust.title'),
      { type: 'warning' },
    );
  } catch { return; }
  adjustSaving.value = true;
  try {
    const data = await paymentAdminApi.adjust({
      user_id: adjustForm.user_id,
      amount: adjustForm.dir === 'add' ? n : -n,
      remark: adjustForm.remark.trim(),
    });
    ElMessage.success(t('paymentAdmin.adjust.done', { balance: data.credits }));
    adjustVisible.value = false;
    loadUsers();
  } finally {
    adjustSaving.value = false;
  }
}

// ===== 登录日志 =====
const logs = ref([]);
const logsTotal = ref(0);
const logsPage = ref(1);
const logsSize = 20;
const logsLoading = ref(false);
const logUserId = ref(null);
const logMethod = ref('');
const logRange = ref(null);

const methodTag = (m) => ({ xworld_sync: 'primary', admin_password: 'warning', weapp: 'success', weapp_exchange: 'success', login_as: 'danger', apple: 'success', google: 'primary' }[m] || 'info');

async function loadLogs() {
  logsLoading.value = true;
  try {
    const params = { page: logsPage.value, size: logsSize };
    if (logUserId.value) params.user_id = logUserId.value;
    if (logMethod.value) params.method = logMethod.value;
    if (logRange.value?.length === 2) {
      params.start = logRange.value[0];
      params.end = logRange.value[1];
    }
    const data = await userAdminApi.loginLogs(params);
    logs.value = data.list || [];
    logsTotal.value = data.total || 0;
  } finally {
    logsLoading.value = false;
  }
}

function searchLogs() { logsPage.value = 1; loadLogs(); }

// ===== 登录配置（脱敏只读） =====
const loginConfigLoading = ref(false);
const loginConfig = ref(null);

async function loadLoginConfig() {
  loginConfigLoading.value = true;
  try {
    loginConfig.value = await userAdminApi.loginConfig();
  } finally {
    loginConfigLoading.value = false;
  }
}

onMounted(() => {
  loadUsers();
  loadLogs();
  loadLoginConfig();
});
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head">
        <div class="ad-title-lg">{{ t('userAdmin.title') }}</div>
        <div class="ad-sub">{{ t('userAdmin.subtitle') }}</div>
      </div>
      <div class="ad-rule ua-rule" />

      <el-tabs v-model="activeTab">
        <!-- 用户列表 -->
        <el-tab-pane :label="t('userAdmin.tab.users')" name="users">
          <div class="ad-card ua-block">
            <div class="ua-filters">
              <el-input v-model="userKeyword" clearable :placeholder="t('userAdmin.f.keyword')" style="width: 240px;" @keyup.enter="searchUsers" @clear="searchUsers" />
              <el-select v-model="userStatus" clearable :placeholder="t('userAdmin.f.status')" style="width: 130px;" @change="searchUsers">
                <el-option value="active" :label="t('userAdmin.status.active')" />
                <el-option value="banned" :label="t('userAdmin.status.banned')" />
              </el-select>
              <el-button @click="searchUsers"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
            </div>
            <div class="ua-table-wrap" v-loading="usersLoading">
              <el-table :data="users" size="small">
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column prop="username" :label="t('userAdmin.c.username')" min-width="140" show-overflow-tooltip />
                <el-table-column prop="nickname" :label="t('userAdmin.c.nickname')" min-width="120" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.nickname || '-' }}</template>
                </el-table-column>
                <el-table-column prop="external_id" :label="t('userAdmin.c.externalId')" min-width="130" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.external_id || '-' }}</template>
                </el-table-column>
                <el-table-column prop="phone" :label="t('userAdmin.c.phone')" width="120" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.phone || '-' }}</template>
                </el-table-column>
                <el-table-column prop="credits" :label="t('userAdmin.c.credits')" width="80" />
                <el-table-column :label="t('userAdmin.c.role')" width="80">
                  <template #default="{ row }">
                    <el-tag :type="roleTag(row.role)" size="small" effect="plain">{{ t(`userAdmin.role.${row.role}`) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column :label="t('userAdmin.c.status')" width="90">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'banned' ? 'danger' : 'success'" size="small" effect="plain">
                      {{ t(row.status === 'banned' ? 'userAdmin.status.banned' : 'userAdmin.status.active') }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column :label="t('common.createdAt')" width="160">
                  <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
                </el-table-column>
                <el-table-column :label="t('common.actions')" width="300" fixed="right">
                  <template #default="{ row }">
                    <el-button size="small" text type="primary" :loading="adjustSaving && adjustForm.user_id === row.id" @click="openAdjust(row)">{{ t('paymentAdmin.adjust.button') }}</el-button>
                    <el-button size="small" text type="primary" @click="openPassword(row)">{{ t('userAdmin.password.btn') }}</el-button>
                    <el-button
                      size="small" text type="warning"
                      :disabled="row.status === 'banned' || !row.external_id"
                      :loading="loginAsSavingId === row.id"
                      @click="loginAs(row)"
                    >{{ t('userAdmin.loginAs.btn') }}</el-button>
                    <el-button
                      v-if="row.status !== 'banned'"
                      size="small" text type="danger"
                      :disabled="row.role === 'admin' || row.id === auth.user?.id"
                      :loading="statusSavingId === row.id"
                      @click="setStatus(row, 'banned')"
                    >{{ t('userAdmin.ban.ban') }}</el-button>
                    <el-button
                      v-else
                      size="small" text type="primary"
                      :disabled="row.role === 'admin' || row.id === auth.user?.id"
                      :loading="statusSavingId === row.id"
                      @click="setStatus(row, 'active')"
                    >{{ t('userAdmin.unban.unban') }}</el-button>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="ad-muted">{{ t('common.noData') }}</span>
                </template>
              </el-table>
            </div>
            <el-pagination
              layout="total, prev, pager, next" :total="usersTotal" :page-size="usersSize" :current-page="usersPage"
              @current-change="(p) => { usersPage = p; loadUsers(); }"
            />
          </div>
        </el-tab-pane>

        <!-- 登录日志 -->
        <el-tab-pane :label="t('userAdmin.tab.logs')" name="logs">
          <div class="ad-card ua-block">
            <div class="ua-filters">
              <el-input-number v-model="logUserId" :min="1" :controls="false" :placeholder="t('userAdmin.f.userId')" style="width: 120px;" @keyup.enter="searchLogs" @change="searchLogs" />
              <el-select v-model="logMethod" clearable :placeholder="t('userAdmin.f.method')" style="width: 160px;" @change="searchLogs">
                <el-option value="xworld_sync" :label="t('userAdmin.method.xworld_sync')" />
                <el-option value="admin_password" :label="t('userAdmin.method.admin_password')" />
                <el-option value="weapp" :label="t('userAdmin.method.weapp')" />
                <el-option value="weapp_exchange" :label="t('userAdmin.method.weapp_exchange')" />
                <el-option value="login_as" :label="t('userAdmin.method.login_as')" />
                <el-option value="apple" :label="t('userAdmin.method.apple')" />
                <el-option value="google" :label="t('userAdmin.method.google')" />
              </el-select>
              <el-date-picker v-model="logRange" type="daterange" value-format="YYYY-MM-DD" :start-placeholder="t('paymentAdmin.f.start')" :end-placeholder="t('paymentAdmin.f.end')" style="width: 260px;" @change="searchLogs" />
              <el-button @click="searchLogs"><el-icon><Search /></el-icon> {{ t('common.search') }}</el-button>
            </div>
            <div class="ua-table-wrap" v-loading="logsLoading">
              <el-table :data="logs" size="small">
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column :label="t('paymentAdmin.c.user')" min-width="120" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.user ? (row.user.nickname || row.user.username || `#${row.user.id}`) : `#${row.user_id}` }}</template>
                </el-table-column>
                <el-table-column :label="t('userAdmin.c.method')" width="140">
                  <template #default="{ row }">
                    <el-tag :type="methodTag(row.method)" size="small" effect="plain">{{ t(`userAdmin.method.${row.method}`) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="ip" label="IP" width="130" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.ip || '-' }}</template>
                </el-table-column>
                <el-table-column prop="user_agent" :label="t('userAdmin.c.userAgent')" min-width="200" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.user_agent || '-' }}</template>
                </el-table-column>
                <el-table-column :label="t('common.createdAt')" width="160">
                  <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
                </el-table-column>
                <template #empty>
                  <span class="ad-muted">{{ t('common.noData') }}</span>
                </template>
              </el-table>
            </div>
            <el-pagination
              layout="total, prev, pager, next" :total="logsTotal" :page-size="logsSize" :current-page="logsPage"
              @current-change="(p) => { logsPage = p; loadLogs(); }"
            />
          </div>
        </el-tab-pane>

        <!-- 登录配置 -->
        <el-tab-pane :label="t('userAdmin.tab.loginConfig')" name="loginConfig">
          <div class="ad-card ua-block" v-loading="loginConfigLoading">
            <el-alert type="warning" show-icon :closable="false" :title="t('userAdmin.loginConfig.hint')" style="margin-bottom: 14px;" />
            <el-descriptions v-if="loginConfig" :column="1" border style="max-width: 720px;">
              <el-descriptions-item :label="t('userAdmin.loginConfig.wechatLogin')">
                <el-tag :type="loginConfig.wechat_login_enabled ? 'success' : 'info'" size="small" effect="plain">
                  {{ loginConfig.wechat_login_enabled ? t('common.on') : t('common.off') }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('userAdmin.loginConfig.wechatAppId')">{{ loginConfig.wechat_app_id || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="t('userAdmin.loginConfig.wechatSecret')">
                <el-tag :type="loginConfig.wechat_secret_set ? 'success' : 'info'" size="small" effect="plain">
                  {{ loginConfig.wechat_secret_set ? t('common.set') : t('common.unset') }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item :label="t('userAdmin.loginConfig.jwtExpiry')">{{ loginConfig.jwt_expires_in }}</el-descriptions-item>
              <el-descriptions-item :label="t('userAdmin.loginConfig.adminTokenExpiry')">{{ loginConfig.admin_token_expires_in }}</el-descriptions-item>
            </el-descriptions>
          </div>
        </el-tab-pane>
      </el-tabs>

      <!-- 设置/重置登录密码弹窗（管理台密码登录用） -->
      <el-dialog v-model="pwdVisible" :title="t('userAdmin.password.title')" width="min(440px, 94vw)">
        <el-form label-position="top" @submit.prevent="submitPassword">
          <el-form-item :label="t('userAdmin.c.username')">
            <span class="ad-muted">{{ pwdForm.name }}</span>
          </el-form-item>
          <el-form-item :label="t('userAdmin.password.title')">
            <el-input v-model="pwdForm.password" type="password" show-password :placeholder="t('userAdmin.password.ph')" maxlength="64" autocomplete="new-password" @keyup.enter="submitPassword" />
            <div class="ad-muted" style="font-size: 12px; margin-top: 6px;">{{ t('userAdmin.password.tip') }}</div>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="pwdVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" :loading="pwdSaving" @click="submitPassword">{{ t('common.confirm') }}</el-button>
        </template>
      </el-dialog>

      <!-- 积分人工调整弹窗（预填当前用户） -->
      <el-dialog v-model="adjustVisible" :title="t('paymentAdmin.adjust.title')" width="min(420px, 94vw)">
        <el-form label-position="top">
          <el-form-item :label="t('paymentAdmin.f.userId')">
            <el-input-number v-model="adjustForm.user_id" :min="1" :precision="0" :controls="false" style="width: 100%;" />
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.type')">
            <el-radio-group v-model="adjustForm.dir">
              <el-radio-button value="add">{{ t('paymentAdmin.adjust.dir_add') }}</el-radio-button>
              <el-radio-button value="deduct">{{ t('paymentAdmin.adjust.dir_deduct') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.credits')">
            <el-input-number v-model="adjustForm.amount" :min="0.1" :max="10000000" :precision="1" :step="0.1" style="width: 100%;" controls-position="right" />
          </el-form-item>
          <el-form-item :label="t('paymentAdmin.c.remark')">
            <el-input v-model="adjustForm.remark" type="textarea" :rows="2" maxlength="200" show-word-limit />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="adjustVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" :loading="adjustSaving" @click="submitAdjust">{{ t('common.confirm') }}</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.ua-rule { margin-bottom: 16px; }
.ua-block { padding: var(--ad-sp-5) var(--ad-sp-6); }
.ua-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.ua-table-wrap { overflow-x: auto; }
</style>
