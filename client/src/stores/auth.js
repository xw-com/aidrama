import { defineStore } from 'pinia';
import { authApi, creditApi } from '../api';
import { revokeToken, endSessionUrl } from '../api/oauth';

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
    // 展示名：xworld 用户无用户名，优先取昵称 / 邮箱 / 手机号，避免显示内部占位账号
    displayName: (s) => s.user?.nickname || s.user?.email || s.user?.phone || '',
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
    // xworld 登录/注册成功后：存令牌 + 同步本地档案（取回积分/会员）
    async _applyAuth({ tokens, user }) {
      this.setTokens(tokens.access_token, tokens.refresh_token);
      let local = null;
      try {
        local = await authApi.sync({
          email: user.email,
          phone: user.phone,
          nickname: user.nickname,
          avatar: user.avatar,
        });
      } catch {
        // 同步失败不阻塞：兜底用 /me 取本地档案
        try { local = await authApi.me(); } catch { local = null; }
      }
      // 合并：xworld 身份档案 + 本系统业务字段（credits/会员等）
      this.user = { ...user, ...(local || {}) };
      this.credits = this.user.credits ?? null;
      return this.user;
    },
    // OAuth2 回调成功后建立本系统会话：userinfo 档案映射 + 同步本地档案（取回积分/会员）
    async applyOauth({ tokens, user }) {
      return this._applyAuth({
        tokens,
        user: {
          email: user.email,
          phone: user.phone,
          nickname: user.nickname,
          avatar: user.avatar_url,
        },
      });
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
    // 修改昵称（仅本地镜像：/auth/sync 会更新本地 User.nickname；xworld 侧档案下次同步可能覆盖）
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
      const token = this.token;
      const refreshToken = this.refreshToken;
      // 立即清除本地会话（同步），保证路由守卫即时把已登出用户导向 /login
      this._clearLocal();
      // best-effort 吊销 xworld OAuth 令牌（RFC 7009，传 refresh 连同派生 access 一起吊销；
      // keepalive 保证下面的整页跳转不掐断请求），用捕获到的令牌显式调用，避免本地已清除的竞态
      if (refreshToken) revokeToken(refreshToken);
      else if (token) revokeToken(token);
      // 同时退出 OAuth2 登录连接：整页跳授权中心 /oauth/logout 清 SSO 会话 Cookie，
      // 成功后 302 回本站登录页（下次登录需重新输入凭据）
      window.location.assign(endSessionUrl());
    },
  },
});
