import axios from 'axios';
import { ElMessage, ElMessageBox } from 'element-plus';
import router from '../router';
import i18n from '../i18n';
import { refreshAccessToken as oauthRefresh } from './oauth.js';
import { useAuthStore } from '../stores/auth';
import { isAdminArea, tokenKey, CLIENT_TOKEN_KEY, CLIENT_REFRESH_KEY, ADMIN_TOKEN_KEY } from '../utils/authContext';

const baseURL = import.meta.env.VITE_API_BASE || '/api';

export const http = axios.create({
  baseURL,
  timeout: 320000,
});

// 请求拦截：附带 token 与语言偏好
http.interceptors.request.use((config) => {
  const token = localStorage.getItem(tokenKey());
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['Accept-Language'] = i18n.global.locale.value;
  return config;
});

// 静默刷新 access_token（单飞：并发 401 只刷新一次，其余请求排队等待结果）
// OAuth2 刷新令牌轮换：每次返回全新 access + refresh，旧 refresh 立即失效
let refreshingPromise = null;
function refreshAccessToken() {
  // 管理端令牌不可刷新（无 refresh 机制，到期重新登录）：401 直接走 bailSession
  if (isAdminArea()) return Promise.resolve(null);
  if (refreshingPromise) return refreshingPromise;
  const refreshToken = localStorage.getItem(CLIENT_REFRESH_KEY);
  if (!refreshToken) return Promise.resolve(null);
  refreshingPromise = oauthRefresh(refreshToken)
    .then((data) => {
      if (data && data.access_token) {
        localStorage.setItem(CLIENT_TOKEN_KEY, data.access_token);
        // 轮换出的新 refresh_token 一并落盘（旧 refresh 已作废，继续用会触发重用检测、整族吊销）
        if (data.refresh_token) localStorage.setItem(CLIENT_REFRESH_KEY, data.refresh_token);
        return data.access_token;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => { refreshingPromise = null; });
  return refreshingPromise;
}

function bailSession() {
  ElMessage.error(i18n.global.t('errors.loginExpired'));
  // 管理后台区：只清管理端令牌并整页跳回管理登录页——不碰前台令牌键（两端同浏览器并存），
  // 也不走前台 router/pinia（本区并未安装它们）
  if (isAdminArea()) {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    window.location.assign('/admin/login');
    return;
  }
  localStorage.removeItem(CLIENT_TOKEN_KEY);
  localStorage.removeItem(CLIENT_REFRESH_KEY);
  // 同步清 pinia 会话（token 仍真会让 guest 路由守卫把 /login 弹回 /home，
  // 且 jobs 2s 轮询继续 401 → 反复 bailSession，永不清醒）
  try { useAuthStore()._clearLocal(); } catch { /* pinia 未装载（启动期）时忽略 */ }
  router.push('/login');
}

// ===== 维护模式 503：专门提示 + 30 秒限频 =====
// jobs store 每 2 秒轮询 /api/jobs，维护期间会连续收到 503，不做限频会刷屏
const MAINTENANCE_TOAST_INTERVAL = 30000;
let lastMaintenanceToastAt = 0;

// 服务端维护响应特征：HTTP 503 且响应体 data.maintenance === true
const isMaintenancePayload = (status, body) =>
  status === 503 && body && typeof body === 'object' && body.data?.maintenance === true;

function notifyMaintenance(info, message) {
  const now = Date.now();
  if (now - lastMaintenanceToastAt < MAINTENANCE_TOAST_INTERVAL) return;
  lastMaintenanceToastAt = now;
  let text = message || i18n.global.t('maintenance.notice');
  if (info?.expectedEndAt) {
    text += `（${i18n.global.t('maintenance.toastExpected', { time: new Date(info.expectedEndAt).toLocaleString() })}）`;
  }
  ElMessage({ message: text, type: 'warning', duration: 8000, showClose: true });
}

// 维护期专用错误对象：调用方（如 auth store 的 fetchMe）据 e.maintenance 区分处理
function maintenanceError(body) {
  const e = new Error(body?.message || i18n.global.t('maintenance.notice'));
  e.maintenance = true;
  e.maintenanceInfo = body?.data || null;
  return e;
}

// ===== 402 积分不足：确认框带「立即充值」按钮，跳转积分中心 =====
// 全局只弹一个（连续多个 402 请求不叠框）
let rechargePrompting = false;
function promptRecharge(msg) {
  if (rechargePrompting) return;
  rechargePrompting = true;
  ElMessageBox.confirm(msg, i18n.global.t('common.tip'), {
    confirmButtonText: i18n.global.t('credits.rechargeNow'),
    cancelButtonText: i18n.global.t('common.cancel'),
    type: 'warning',
  })
    .then(() => {
      // 管理台无 /credits 路由：新开前台积分中心（充值在前台完成）
      if (isAdminArea()) window.open('/credits', '_blank');
      else router.push('/credits');
    })
    .catch(() => {})
    .finally(() => { rechargePrompting = false; });
}

// 响应拦截：统一处理 { code, message, data }
http.interceptors.response.use(
  (resp) => {
    const body = resp.data;
    // 非业务 JSON（如直接下载）直接返回
    if (body === null || typeof body !== 'object' || !('code' in body)) return body;
    if (body.code === 0) return body.data;
    // 维护 503（防御性兜底：正常情况下 fail(code>=400) 走 HTTP 503 进错误分支）
    if (body.code === 503 && body.data?.maintenance) {
      if (!resp.config?._silent) notifyMaintenance(body.data, body.message);
      return Promise.reject(maintenanceError(body));
    }
    // 业务错误（config._silent=true 时只 reject 不弹提示，供需要自行渲染错误态的页面使用）
    const msg = body.message || i18n.global.t('errors.requestFailed');
    if (body.code === 401) {
      if (!resp.config?._noBail) bailSession(); // _noBail：公开页静默档案拉取，不弹登录过期
      return Promise.reject(Object.assign(new Error(msg), { status: 401 }));
    }
    if (body.code === 402) {
      if (!resp.config?._silent) promptRecharge(msg);
      return Promise.reject(Object.assign(new Error(msg), { status: 402 }));
    }
    if (!resp.config?._silent) ElMessage.error(msg);
    // 附带 code 供调用方按状态分流（如工作区 403/404 引导回项目列表）
    return Promise.reject(Object.assign(new Error(msg), { status: body.code }));
  },
  async (err) => {
    const status = err.response?.status;
    const data = err.response?.data;
    // 维护 503（主检测点）：专门提示 + 限频，不走普通报错分支
    if (isMaintenancePayload(status, data)) {
      if (!err.config?._silent) notifyMaintenance(data.data, data.message);
      return Promise.reject(maintenanceError(data));
    }
    const orig = err.config;
    // 401：先尝试用 refresh_token 静默续期并重试一次
    if (status === 401 && orig && !orig._retried) {
      orig._retried = true;
      try {
        const newToken = await refreshAccessToken();
        if (newToken) {
          orig.headers.Authorization = `Bearer ${newToken}`;
          return http(orig);
        }
      } catch { /* fallthrough to bail */ }
      if (!orig?._noBail) bailSession(); // _noBail：公开页静默档案拉取，不弹登录过期
      return Promise.reject(new Error(i18n.global.t('errors.loginExpired')));
    }
    const msg = (data && (data.message || (typeof data === 'object' ? JSON.stringify(data) : data))) || err.message || i18n.global.t('errors.networkError');
    if (status === 401) {
      if (!orig?._noBail) bailSession();
    } else if (status === 402) {
      if (!err.config?._silent) promptRecharge(msg);
    } else if (!err.config?._silent) {
      ElMessage.error(msg);
    }
    return Promise.reject(Object.assign(new Error(msg), { status }));
  }
);

export default http;
