/**
 * HTTP 层（uni.request 版）：完整移植 client/src/api/http.js 的拦截语义 ——
 * - 统一 envelope { code, message, data }，code===0 → data
 * - 401：refresh_token 单飞静默续期（直连 /auth/refresh，平台 JWT 不轮换）+ 原请求重试一次，失败 bailSession
 * - 402：积分不足确认框 → 充值页（全局单例不叠框）
 * - 503 维护模式：专用提示 30s 限频，错误对象带 e.maintenance
 * - 隐私门禁：App 端同意《用户协议》《隐私政策》前所有请求挂起不发（utils/privacy）
 * - config._silent：只 reject 不弹提示
 * - 错误对象统一 Error + .status
 */
import i18n from '../i18n';
import { API_BASE, API_ORIGIN } from './config';
import { getItem, setItem, removeItem, KEYS } from '../utils/storage';
import { toast, confirm } from '../utils/ui';
import { isIosApp } from '../utils/system';
import { waitPrivacyAgreed } from '../utils/privacy';
import { directRefresh } from './xworld';
import { useAuthStore } from '../stores/auth';

const t = (k, p) => i18n.global.t(k, p);

/**
 * App 首启隐私门禁（合规不变式：同意《用户协议》《隐私政策》前不发任何网络请求）。
 * 未同意时所有出网请求挂起在 waitPrivacyAgreed()（不发包），同意后统一放行；
 * H5/小程序/鸿蒙端 waitPrivacyAgreed 立即 resolve，零开销。
 */
function privacyGate() {
  return waitPrivacyAgreed();
}

/** iOS App 端复制网页版地址（App Store 3.1.1：iOS 禁应用内充值，引导网页版） */
function copyWebOrigin() {
  uni.setClipboardData({
    data: API_ORIGIN,
    success: () => toast(t('credits.ios.copied'), { icon: 'none' }),
  });
}

export function buildUrl(url, params) {
  const base = /^https?:\/\//.test(url) ? url : API_BASE + url;
  if (!params) return base;
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  if (!qs) return base;
  return base + (base.includes('?') ? '&' : '?') + qs;
}

/** 登录会话作废：清令牌 + 清 pinia + 回登录页（单飞：并发 401 只处理一次，避免 reLaunch 风暴堵死路由） */
let lastBailAt = 0;
export function bailSession() {
  const now = Date.now();
  if (now - lastBailAt < 3000) return; // 时间窗内的后续 401 直接忽略（仅首个触发 toast + 跳转）
  lastBailAt = now;
  toast(t('errors.loginExpired'));
  removeItem(KEYS.token);
  removeItem(KEYS.refresh);
  try {
    useAuthStore()._clearLocal();
  } catch (e) {
    /* pinia 未装载（启动期）时忽略 */
  }
  // 鸿蒙端：reLaunch 视图切换不绘制（生命周期跑、屏幕不翻页），用 redirectTo；
  // 并发 401 已由上方时间窗单飞兜住
  uni.redirectTo({ url: '/pages/login/index' });
}

// ===== 静默刷新（单飞） =====
// 本地第三方登录（Apple/Google）的 axt_ 会话走本系统刷新端点；必须绕过 http.request 的
// 401 重试层（原生 uni.request 直调），否则刷新自身 401 会重入 doRefresh 单飞 Promise 死等。
// 刻意与 xworld.js 的 xpost 同构：成功信封 { code:0, data } / 失败 Error+.status
function appTokenRefresh(refreshToken) {
  return new Promise((resolve, reject) => {
    uni.request({
      url: API_BASE + '/auth/oauth/refresh',
      method: 'POST',
      timeout: 15000,
      header: { 'Content-Type': 'application/json' },
      data: { refresh_token: refreshToken },
      success: (res) => {
        const body = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.code === 0) resolve(body.data);
        else reject(Object.assign(new Error(body?.message || `HTTP ${res.statusCode}`), { status: res.statusCode }));
      },
      fail: (e) => reject(Object.assign(new Error(e?.errMsg || 'network error'), { status: 0 })),
    });
  });
}

let refreshingPromise = null;
function doRefresh() {
  if (refreshingPromise) return refreshingPromise;
  const refreshToken = getItem(KEYS.refresh);
  if (!refreshToken) return Promise.resolve(null);
  // 令牌前缀即模式标志（docs/xworld-direct-auth-api.md §8.2）：
  // axt_ = 本地第三方登录（Apple/Google，走 AIDrama /auth/oauth/refresh）；其余 = xworld 平台 JWT
  const refreshing = refreshToken.startsWith('axt_')
    ? appTokenRefresh(refreshToken)
    : directRefresh(refreshToken);
  refreshingPromise = refreshing
    .then((data) => {
      // 两套 refresh 都不轮换：响应仅含新 access_token（原 refresh 继续用，勿清）
      if (data && data.access_token) {
        setItem(KEYS.token, data.access_token);
        return data.access_token;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      refreshingPromise = null;
    });
  return refreshingPromise;
}

// ===== 维护模式 503：专用提示 + 30 秒限频 =====
const MAINTENANCE_TOAST_INTERVAL = 30000;
let lastMaintenanceToastAt = 0;
const isMaintenancePayload = (status, body) =>
  status === 503 && body && typeof body === 'object' && body.data?.maintenance === true;

function notifyMaintenance(info, message) {
  const now = Date.now();
  if (now - lastMaintenanceToastAt < MAINTENANCE_TOAST_INTERVAL) return;
  lastMaintenanceToastAt = now;
  let text = message || t('maintenance.notice');
  if (info?.expectedEndAt) {
    text += `（${t('maintenance.toastExpected', { time: new Date(info.expectedEndAt).toLocaleString() })}）`;
  }
  toast(text, { duration: 8000 });
}

function maintenanceError(body) {
  const e = new Error(body?.message || t('maintenance.notice'));
  e.maintenance = true;
  e.maintenanceInfo = body?.data || null;
  return e;
}

// ===== 402 积分不足：确认框 → 充值页（全局单例）；iOS App 端改引导网页版充值（App Store 3.1.1） =====
let rechargePrompting = false;
function promptRecharge(msg) {
  if (rechargePrompting) return;
  /* #ifdef APP-PLUS */
  if (isIosApp()) {
    rechargePrompting = true;
    confirm({
      title: t('credits.ios.title'),
      content: t('credits.ios.desc'),
      confirmText: t('credits.ios.copy'),
    }).then((ok) => {
      if (ok) copyWebOrigin();
    }).finally(() => {
      rechargePrompting = false;
    });
    return;
  }
  /* #endif */
  rechargePrompting = true;
  confirm({
    title: t('common.tip'),
    content: msg,
    confirmText: t('credits.rechargeNow'),
  }).then((ok) => {
    if (ok) uni.navigateTo({ url: '/pages/credits/index' });
  }).finally(() => {
    rechargePrompting = false;
  });
}

function bizError(msg, status) {
  return Object.assign(new Error(msg), { status });
}

/** 统一响应消化（业务 envelope / 各状态码）——request 与 upload 共用 */
async function consume(status, body, silent, retryFn) {
  if (status === 503 && isMaintenancePayload(status, body)) {
    if (!silent) notifyMaintenance(body.data, body.message);
    throw maintenanceError(body);
  }
  const ok = status >= 200 && status < 300;
  if (ok && (body === null || typeof body !== 'object' || !('code' in body))) return body;
  if (ok && body.code === 0) return body.data;
  if (ok && body.code === 503 && body.data?.maintenance) {
    if (!silent) notifyMaintenance(body.data, body.message);
    throw maintenanceError(body);
  }
  const msg = (body && body.message) || t('errors.requestFailed');
  const code = ok ? body.code : status;
  if (code === 401) {
    if (retryFn) {
      const retried = await retryFn();
      if (retried) return retried;
    }
    bailSession();
    throw bizError(t('errors.loginExpired'), 401);
  }
  if (code === 402) {
    if (!silent) promptRecharge(msg); // 积分不足：引导前往积分中心充值
    throw bizError(msg, 402);
  }
  if (!silent) toast(msg);
  throw bizError(msg, code);
}

function baseHeader(extra) {
  const header = { ...(extra || {}) };
  const token = getItem(KEYS.token);
  if (token) header.Authorization = `Bearer ${token}`;
  header['Accept-Language'] = i18n.global.locale.value;
  return header;
}

export function request(opts) {
  const { method = 'GET', url, data, params, silent = false, timeout = 320000, header } = opts;
  return privacyGate().then(() => new Promise((resolve, reject) => {
    uni.request({
      url: buildUrl(url, params),
      method,
      data,
      header: baseHeader(header),
      timeout,
      success: async (res) => {
        try {
          const out = await consume(res.statusCode, res.data, silent, async () => {
            if (opts._retried) return null;
            opts._retried = true;
            const nt = await doRefresh();
            if (!nt) return null;
            return request(opts);
          });
          resolve(out);
        } catch (e) {
          reject(e);
        }
      },
      fail: (e) => {
        const msg = e?.errMsg || t('errors.networkError');
        if (!silent) toast(msg);
        reject(bizError(msg, 0));
      },
    });
  }));
}

/** 文件上传（uni.uploadFile，替代 FormData）：filePath 为 uni 临时路径 */
export function upload(url, filePath, opts = {}) {
  const { silent = false, name = 'file', formData, timeout = 320000, header } = opts;
  return privacyGate().then(() => new Promise((resolve, reject) => {
    uni.uploadFile({
      url: buildUrl(url),
      filePath,
      name,
      formData,
      header: baseHeader(header),
      timeout,
      success: async (res) => {
        let body = res.data;
        try {
          body = typeof body === 'string' ? JSON.parse(body) : body;
        } catch (e) {
          /* 保留原文 */
        }
        try {
          const out = await consume(res.statusCode, body, silent, async () => {
            if (opts._retried) return null;
            opts._retried = true;
            const nt = await doRefresh();
            if (!nt) return null;
            return upload(url, filePath, opts);
          });
          resolve(out);
        } catch (e) {
          reject(e);
        }
      },
      fail: (e) => {
        const msg = e?.errMsg || t('errors.networkError');
        if (!silent) toast(msg);
        reject(bizError(msg, 0));
      },
    });
  }));
}

/** 下载到临时文件（导出 txt 等）：返回 tempFilePath */
export function download(url, params) {
  return privacyGate().then(() => new Promise((resolve, reject) => {
    uni.downloadFile({
      url: buildUrl(url, params),
      header: baseHeader(),
      success: (res) => {
        if (res.statusCode === 200) resolve(res.tempFilePath);
        else reject(bizError(t('errors.requestFailedStatus', { status: res.statusCode }), res.statusCode));
      },
      fail: (e) => reject(bizError(e?.errMsg || t('errors.networkError'), 0)),
    });
  }));
}

/** client 风格的门面对象：http.get('/x', { params, _silent }) */
export const http = {
  get: (url, cfg) => request({ method: 'GET', url, params: cfg?.params, silent: cfg?._silent }),
  post: (url, data, cfg) => request({ method: 'POST', url, data, silent: cfg?._silent }),
  put: (url, data, cfg) => request({ method: 'PUT', url, data, silent: cfg?._silent }),
  delete: (url, cfg) => request({ method: 'DELETE', url, params: cfg?.params, silent: cfg?._silent }),
  // 门面必须带 upload/download：此前漏掉导致所有 http.upload(...) 抛 "not a function"，
  // 被页面空 catch 吞掉 → 三端上传全部「没有反应、抓包无请求」
  upload,
  download,
};

export default http;
