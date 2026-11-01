import { defineStore } from 'pinia';
import { authApi, creditApi } from '../api';

const TOKEN_KEY = 'aidrama-token';
const REFRESH_KEY = 'aidrama-refresh-token';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    refreshToken: localStorage.getItem(REFRESH_KEY) || '',
    user: null,
    credits: null,
    // 当前组织上下文（/auth/me 附带）：{ id, name, type, role, credits }
    // type='personal' 为个人空间（credits 恒 null，扣个人余额）；'enterprise' 为企业空间
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    // 是否管理员（侧栏 admin 专属页与路由守卫共用）
    isAdmin: (s) => s.user?.role === 'admin',
    // 展示名：优先取昵称 / 用户名 / 邮箱 / 手机号
    displayName: (s) => s.user?.nickname || s.user?.username || s.user?.email || s.user?.phone || '',
    // 当前是否企业池计费上下文（顶栏积分徽章/充值页据此显示池余额）
  },
  actions: {
    setToken(token) {
      this.token = token;
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    },
    setRefreshToken(token) {
      this.refreshToken = token;
      if (token) localStorage.setItem(REFRESH_KEY, token);
      else localStorage.removeItem(REFRESH_KEY);
    },
    setTokens(access, refresh) {
      this.setToken(access);
      if (refresh !== undefined) this.setRefreshToken(refresh);
    },
    _clearLocal() {
      this.setToken('');
      this.setRefreshToken('');
      this.user = null;
      this.credits = null;
    },
    // 本地登录/注册成功：响应即含本地档案与令牌，直接落会话
    async applyAuthResult({ user, tokens }) {
      this.setTokens(tokens.access_token, tokens.refresh_token);
      this.user = user;
      this.credits = user?.credits ?? null;
      return this.user;
    },
    async login(payload) {
      return this.applyAuthResult(await authApi.login(payload));
    },
    async register(payload) {
      return this.applyAuthResult(await authApi.register(payload));
    },
    changePassword(payload) { return authApi.changePassword(payload); },
    // 管理台「一键登录用户前端」：落地管理台代签的前台令牌（本地 JWT，无刷新令牌）。
    // 必须清掉旧会话的 refresh 令牌——它属于原登录身份，留着会让 401 静默刷新把会话换回原身份
    async applyAdminIssuedToken(token) {
      this.setToken(token);
      this.setRefreshToken('');
      this.user = null;
      this.credits = null;
      return this.fetchMe();
    },
    // 修改昵称（/auth/sync 更新本地档案）
    async updateNickname(nickname) {
      const local = await authApi.sync({ nickname });
      this.user = { ...(this.user || {}), ...(local || {}), nickname };
      return this.user;
    },
    // opts.silent：公开页（如展示中心）的档案补拉——令牌失效时不弹窗/跳登录，仅静默退回游客态
    async fetchMe(opts = {}) {
      if (!this.token) return null;
      try {
        const user = await authApi.me(opts.silent ? { _noBail: true } : undefined); // 令牌过期时 http.js 会自动静默刷新并重试
        this.user = user;
        this.credits = user.credits;
        return user;
      } catch (e) {
        // 维护期 503 不清会话：令牌仍有效，维护结束后刷新即可恢复，无需重新登录
        if (!e?.maintenance) this._clearLocal();
        return null;
      }
    },
    async refreshCredits() {
      try {
        const data = await creditApi.balance();
        this.credits = data.credits;
        return data.credits;
      } catch { return this.credits; }
    },
    logout() {
      // 立即清除本地会话（同步），保证路由守卫即时把已登出用户导向 /login。
      // axt_ 会话为无状态 JWT，无服务端会话可吊销；封禁由服务端每请求重查兜底。
      // 整页跳转：清掉布局内已启动的轮询等运行态
      this._clearLocal();
      window.location.assign('/login');
    },
  },
});
