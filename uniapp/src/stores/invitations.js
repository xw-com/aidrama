import { defineStore } from 'pinia';
import { invitationApi } from '../api';

const INVITE_POLL = 60000; // 系统无站内信/WebSocket，邀请中心用 60s 轮询兜底

/**
 * 我的邀请 store：维护待处理项目邀请列表（顶栏铃铛角标 + 邀请中心数据源）。
 * 与 jobs store 不同：登录期间持续轮询（邀请何时到来不可预知，不能以「有活跃任务才轮询」收敛）。
 * 后台/前台切换由 App.vue onShow/onHide 驱动 pause()/resume()。
 */
export const useInvitationsStore = defineStore('invitations', {
  state: () => ({
    items: [],
    polling: false,
    _timer: null,
    _inflight: null,
    _epoch: 0, // 会话代际：reset() 自增，使登出/换号前已发出的在途回包作废
  }),
  getters: {
    pendingCount: (s) => s.items.length,
  },
  actions: {
    // 单飞：上一轮未回包时复用同一 Promise——轮询/回前台补拉叠加时只发一个请求
    async fetchAll() {
      if (this._inflight) return this._inflight;
      const epoch = this._epoch;
      const p = (async () => {
        try {
          const list = await invitationApi.list();
          // 会话已切换（登出/换号）时丢弃旧账号回包
          if (epoch === this._epoch) this.items = list;
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
      this._timer = setInterval(() => void this.fetchAll(), INVITE_POLL);
    },
    stopPolling() {
      this.polling = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },
    /** 会话切换（登出/换号/会话作废）：清列表、停轮询；epoch+1 作废在途回包（防旧账号邀请串到新账号角标） */
    reset() {
      this._epoch += 1;
      this.stopPolling();
      this._paused = false;
      this.items = [];
    },
    pause() {
      if (!this.polling) return;
      this._paused = true;
      this.stopPolling();
    },
    resume() {
      if (!this._paused) return;
      this._paused = false;
      this.ensurePolling(); // pause 已 stopPolling，此处 polling 恒 false，直接 ensurePolling 首拍即 fetchAll
    },
  },
});
