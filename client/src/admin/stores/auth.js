import { defineStore } from 'pinia';
import { authApi } from '../../api';
import { adminAuthApi } from '../api';
import { ADMIN_TOKEN_KEY } from '../../utils/authContext';

// 管理后台会话 store：令牌独立存 aidrama-admin-token，与前台会话（aidrama-token）互不干扰，
// 同一浏览器可同时登录两端。管理令牌为本地签发的 admt_ JWT，无刷新机制，到期重新登录；
// 登出为纯客户端丢弃（无状态 JWT，服务端封禁检查每请求兜底）。
export const useAdminAuthStore = defineStore('admin-auth', {
  state: () => ({
    token: localStorage.getItem(ADMIN_TOKEN_KEY) || '',
    user: null,
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    // 展示名：优先昵称，本地账号多为 username
    displayName: (s) => s.user?.nickname || s.user?.username || s.user?.email || '',
  },
  actions: {
    setToken(token) {
      this.token = token;
      if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
      else localStorage.removeItem(ADMIN_TOKEN_KEY);
    },
    // 管理台登录：手机号 + 密码 + 验证码 ticket → admt_ 管理令牌
    async login(payload) {
      const data = await adminAuthApi.login(payload);
      this.setToken(data.token);
      this.user = data.user;
      return data.user;
    },
    // 刷新页面后的档案补拉：/auth/me 对 admt_ 令牌同样可达（resolveUserByToken 分支）
    async fetchMe() {
      if (!this.token) return null;
      try {
        const user = await authApi.me({ _noBail: true });
        this.user = user;
        return user;
      } catch {
        // 令牌失效/过期：清会话，路由守卫会导向登录页
        this.setToken('');
        this.user = null;
        return null;
      }
    },
    logout() {
      this.setToken('');
      this.user = null;
      // 整页跳转：清掉布局内已启动的轮询等运行态，回管理登录页
      window.location.assign('/admin/login');
    },
  },
});
