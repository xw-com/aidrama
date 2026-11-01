import { defineStore } from 'pinia';
import { invitationApi } from '../api';

const INVITE_POLL = 60000; // 系统无站内信/WebSocket，邀请中心用 60s 轮询兜底

/**
 * 我的邀请 store：维护待处理项目邀请列表（顶栏铃铛角标 + 邀请中心数据源）。
 * 与 jobs store 不同：挂载期间持续轮询（邀请何时到来不可预知，不能以「有活跃任务才轮询」收敛）。
 */
export const useInvitationsStore = defineStore('invitations', {
  state: () => ({
    items: [],
    polling: false,
    _timer: null,
    _visHandler: null,
    _inflight: null,
  }),
  getters: {
    pendingCount: (s) => s.items.length,
  },
  actions: {
    // 单飞：上一轮未回包时复用同一 Promise——轮询/可见性回补/跨窗口通知叠加时只发一个请求，
    // 后端慢时也不会堆积请求挤占浏览器同源连接池（否则会拖住整页其它请求）
    async fetchAll() {
      if (this._inflight) return this._inflight;
      const p = (async () => {
        try {
          this.items = await invitationApi.list();
        } catch { /* 静默：轮询失败不打扰 */ }
        finally { if (this._inflight === p) this._inflight = null; }
      })();
      this._inflight = p;
      return p;
    },
    /** 处理完一条邀请（接受/拒绝）后本地剔除，无需等下轮轮询 */
    remove(id) {
      this.items = this.items.filter((i) => i.id !== id);
    },
    ensurePolling() {
      if (this.polling) return;
      this.polling = true;
      void this.fetchAll();
      this._timer = setInterval(() => {
        if (document.hidden) return; // 页面在后台：暂停轮询，回前台立即补拉
        void this.fetchAll();
      }, INVITE_POLL);
      this._visHandler = () => {
        if (!document.hidden && this.polling) void this.fetchAll();
      };
      document.addEventListener('visibilitychange', this._visHandler);
    },
    stopPolling() {
      this.polling = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._visHandler) { document.removeEventListener('visibilitychange', this._visHandler); this._visHandler = null; }
    },
  },
});
