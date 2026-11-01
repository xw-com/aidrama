import axios from 'axios';
import { ElMessage } from 'element-plus';
import i18n from '../i18n';

// xworld 账号服务（注册/登录/发码/重置/改密/登出/刷新）—— 前端直连
// 与本系统 /api 不同：xworld 原始响应为 { success, message, data }
const baseURL = import.meta.env.VITE_XWORLD_API_BASE || 'https://auth.example.com/api/v1';

export const xworld = axios.create({
  baseURL,
  timeout: 15000,
});

// 请求拦截：附带 access_token（用于 logout/change-password 等需鉴权接口）与语言偏好
xworld.interceptors.request.use((config) => {
  const token = localStorage.getItem('aidrama-token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['Accept-Language'] = i18n.global.locale.value;
  return config;
});

// 响应拦截：统一拆解 xworld 原始格式 { success, message, data }
// config._silent=true 时不弹错误提示（供令牌静默刷新使用）
xworld.interceptors.response.use(
  (resp) => {
    const body = resp.data;
    if (body === null || typeof body !== 'object') return body; // 非 JSON（如下载）直接返回
    if (body.success === true) return body.data; // 业务成功：返回 data
    // 业务失败
    if (!resp.config?._silent) ElMessage.error(body.message || i18n.global.t('errors.requestFailed'));
    return Promise.reject(new Error(body.message || 'xworld error'));
  },
  (err) => {
    const data = err.response?.data;
    const msg = (data && (data.message || (typeof data === 'object' ? JSON.stringify(data) : data))) || err.message || i18n.global.t('errors.networkError');
    // 不在此处强制跳转登录：xworld 令牌过期会随后在本系统 /api 请求（http.js）中触发统一处理
    if (!err.config?._silent) ElMessage.error(typeof msg === 'string' ? msg : i18n.global.t('errors.requestFailed'));
    return Promise.reject(new Error(typeof msg === 'string' ? msg : ''));
  }
);

export default xworld;
