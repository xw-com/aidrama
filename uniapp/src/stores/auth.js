import { defineStore } from 'pinia';
import { authApi, creditApi } from '../api';
import { getItem, setItem, removeItem, KEYS } from '../utils/storage';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getItem(KEYS.token) || '',
    refreshToken: getItem(KEYS.refresh) || '',
    user: null,
    credits: null,
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    // 是否管理员（与 client 一致：admin 功能入口/接口均由服务端兜底把关）
    isAdmin: (s) => s.user?.role === 'admin',
    // 展示名：xworld 用户无用户名，优先取昵称 / 邮箱 / 手机号，避免显示内部占位账号
    displayName: (s) => s.user?.nickname || s.user?.email || s.user?.phone || '',
  },
  actions: {
    setToken(token) {
      this.token = token;
      if (token) setItem(KEYS.token, token);
      else removeItem(KEYS.token);
    },
    setRefreshToken(token) {
      this.refreshToken = token;
      if (token) setItem(KEYS.refresh, token);
      else removeItem(KEYS.refresh);
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
    // xworld 登录/注册成功后：存令牌 + 同步本地档案（取回积分）
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
      // 合并：xworld 身份档案 + 本系统业务字段（credits 等）
      this.user = { ...user, ...(local || {}) };
      this.credits = this.user.credits ?? null;
      return this.user;
    },
    // 直连登录/注册成功后建立本系统会话：归一账号中心档案字段（只透传展示字段，
    // 不带 xworld 侧 id/status，避免与本地档案混淆）+ 同步本地档案
    async applyAuthResult({ tokens, user }) {
      return this._applyAuth({
        tokens,
        user: {
          username: user.username,
          email: user.email,
          phone: user.phone,
          nickname: user.nickname || user.username || '',
          avatar: user.avatar_url || user.avatar || '',
        },
      });
    },
    // 账号密码登录（identity：手机号/邮箱/用户名）+ 验证码注册（成功即登录）
    async login(payload) {
      return this.applyAuthResult(await authApi.login(payload));
    },
    async register(payload) {
      return this.applyAuthResult(await authApi.register(payload));
    },
    // 第三方一键登录（微信/苹果/华为/Google）：服务端换取后返回直连同构 { user, tokens }
    async loginWithProvider(provider, payload) {
      return this.applyAuthResult(await authApi.oauthLogin(provider, payload));
    },
    // 发送验证码 / 忘记密码重置：纯透传，不影响会话状态
    sendCode(payload) { return authApi.sendCode(payload); },
    resetPassword(payload) { return authApi.resetPassword(payload); },
    changePassword(payload) { return authApi.changePassword(payload); },
    // 修改昵称（仅本地镜像：/auth/sync 会更新本地 User.nickname；xworld 侧档案下次同步可能覆盖）
    async updateNickname(nickname) {
      const local = await authApi.sync({ nickname });
      this.user = { ...(this.user || {}), ...(local || {}), nickname };
      return this.user;
    },
    async fetchMe() {
      if (!this.token) return null;
      try {
        const user = await authApi.me(); // 令牌过期时 http.js 会自动静默刷新并重试
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
      // 立即清除本地会话（同步）
      this._clearLocal();
      // best-effort 撤销账号中心会话（auth_sessions，平台 JWT 令牌即废）：
      // 用捕获到的令牌显式调用，避免本地已清除的竞态；失败不阻塞本地登出
      if (token) authApi.logout(token);
      // 鸿蒙端：reLaunch 视图切换不绘制（生命周期跑、屏幕不翻页），用 redirectTo
      uni.redirectTo({ url: '/pages/login/index' });
    },
  },
});
