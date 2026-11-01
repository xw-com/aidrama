import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { jobApi } from '../api';
import { useAuthStore } from './auth';
import { taskName } from '../utils/task';
import i18n from '../i18n';

const POLL_INTERVAL = 2000;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

// 各任务类型的归属 ID 字段：activeOf 第二参的语义由调用方决定（剧集 id/分镜 id/资产 id/项目 id），
// 必须按 type 限定匹配字段——ref_id/episode_id/project_id 来自三张独立自增表，ID 空间重叠，
// 三字段一律 OR 会在跨表撞 id 时误报（A 项目批量任务 project_id=12 会被 B 项目 id=12 的剧集
// 分镜页命中，批量按钮误显示"正在生成"）。字段依据后端 createJob 的实际存储与各调用点传参。
const ACTIVE_FIELDS = {
  storyboard_script: ['episode_id'],
  segment_video_batch: ['episode_id'],
  segment_video_batch_concurrent: ['episode_id'],
  video_synthesis: ['episode_id'],
  segment_generate: ['ref_id'],
  segment_video: ['ref_id'],
  segment_erase_subtitle: ['ref_id'],
  segment_prompt: ['ref_id'],
  episode_detail: ['ref_id'],
  script_outline: ['ref_id'],
  episode_split: ['ref_id'],
  asset_image: ['ref_id'],
  asset_prompt: ['ref_id'],
  asset_extract: ['project_id'], // 全项目版存 project_id；单集版 refId=episode.id 但 project_id 同样在，统一按项目匹配
};

/**
 * 任务中心 store：维护当前用户近期任务列表，并在有活跃任务时轮询同步状态。
 * 检测到 pending/running → succeeded/failed/cancelled 跃迁时：
 *  - 触发该任务注册的 onDone 回调（各视图用来重载数据/跳转）
 *  - 弹出全局 toast（成功/失败）
 *  - 按结果更新积分
 */
export const useJobsStore = defineStore('jobs', {
  state: () => ({
    items: [],
    polling: false,
    _timer: null,
    _visHandler: null,
    _inflight: null, // 未回包的 /jobs 请求（单飞：防慢后端时 2s 轮询叠请求拖垮整页）
    _callbacks: {}, // jobId -> Array<(job) => void>（同一 job 可注册多个完成回调）
  }),
  getters: {
    active: (s) => s.items.filter((j) => j.status === 'pending' || j.status === 'running'),
    activeCount() { return this.active.length; },
    // 按 (type, refId) 查找活跃任务，供行内进度查找；匹配字段按 type 收窄（见 ACTIVE_FIELDS），
    // 未登记的 type 退回旧三字段 OR 以保兼容
    activeOf: (s) => (type, refId) => {
      if (refId == null) return undefined;
      const fields = ACTIVE_FIELDS[type];
      return s.items.find((j) => (j.status === 'pending' || j.status === 'running')
        && j.type === type
        && (fields ? fields.some((f) => j[f] === refId)
          : (j.ref_id === refId || j.episode_id === refId || j.project_id === refId)));
    },
  },
  actions: {
    // 单飞：上一轮未回包时复用同一 Promise。2s 轮询若不设闸，后端一慢请求就会越叠越多，
    // 挤占浏览器同源连接池，把整页其它请求（数据/素材）全卡住
    async fetchAll() {
      if (this._inflight) return this._inflight;
      const p = (async () => {
        try {
          const list = await jobApi.list({ limit: 50 });
          this._merge(list);
          // 自愈：任一次成功拉取发现活跃任务就拉起轮询。挂载竞态（fetchAll 未回包时
          // ensurePolling 已被 activeCount===0 拦下）或启动期后端不可达导致轮询没起，
          // 都在这里被兜住——否则重启恢复的任务完成时无人感知，角标冻结、回调永不触发
          this.ensurePolling();
        } catch { /* 静默 */ }
        finally { if (this._inflight === p) this._inflight = null; }
      })();
      this._inflight = p;
      return p;
    },
    /** 用新列表合并并检测状态跃迁 */
    _merge(list) {
      const prevById = {};
      this.items.forEach((j) => { prevById[j.id] = j.status; });
      list.forEach((j) => {
        const prev = prevById[j.id];
        if (prev && !TERMINAL.includes(prev) && TERMINAL.includes(j.status)) {
          this._onTransition(j);
        }
      });
      // 合并而非整表覆盖：仍在等待终态的任务若未被本次列表包含（轮询竞态：track 前已发出的
      // 旧请求晚到、活跃任务被挤出 limit 等），保留在 items 里——否则跃迁检测不到，
      // 完成回调（awaitDone/行内进度）会永久卡死。终态任务以列表为准，可正常被挤出。
      const kept = this.items.filter((j) => !TERMINAL.includes(j.status) && !list.some((x) => x.id === j.id));
      this.items = list.concat(kept);
    },
    _onTransition(job) {
      const label = taskName(job, i18n.global.t('task.defaultLabel'));
      try {
        if (job.status === 'succeeded') {
          ElMessage.success(i18n.global.t('task.toastDone', { label }));
          const auth = useAuthStore();
          if (job.result?.balance !== undefined) auth.credits = job.result.balance;
        } else if (job.status === 'failed') {
          ElMessage.error(i18n.global.t('task.toastFailed', { label, error: job.error || i18n.global.t('task.unknownError') }));
          useAuthStore().refreshCredits();
        }
      } catch { /* ignore */ }
      // 支持同一 job 多个完成回调（onDone + awaitDone 等可并存）
      const arr = this._callbacks[job.id];
      if (arr) {
        delete this._callbacks[job.id];
        arr.forEach((cb) => { try { cb(job); } catch { /* ignore */ } });
      }
    },
    ensurePolling() {
      if (this.polling) return;
      if (this.activeCount === 0) return;
      this.polling = true;
      this._timer = setInterval(async () => {
        if (document.hidden) return; // 页面在后台：暂停轮询（回前台由 visibilitychange 立即补拉）
        await this.fetchAll();
        if (this.activeCount === 0) this.stopPolling();
      }, POLL_INTERVAL);
      // 回到前台立刻补拉一次：后台期间完成的任务在补拉时仍能检测到跃迁（merge 对比旧状态）
      this._visHandler = () => {
        if (!document.hidden && this.polling) this.fetchAll();
      };
      document.addEventListener('visibilitychange', this._visHandler);
    },
    stopPolling() {
      this.polling = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._visHandler) { document.removeEventListener('visibilitychange', this._visHandler); this._visHandler = null; }
    },
    /** 注册某任务完成回调（一次性；同一 job 可注册多个），返回取消注册函数 */
    registerOnDone(jobId, cb) {
      if (!this._callbacks[jobId]) this._callbacks[jobId] = [];
      this._callbacks[jobId].push(cb);
      return () => {
        const arr = this._callbacks[jobId];
        if (arr) this._callbacks[jobId] = arr.filter((c) => c !== cb);
      };
    },
    /** 等待某任务到达终态并 resolve 该 job；复用既有轮询驱动，不新增定时器 */
    awaitDone(jobId) {
      const cur = this.items.find((j) => j.id === jobId);
      if (cur && TERMINAL.includes(cur.status)) return Promise.resolve(cur);
      return new Promise((resolve) => this.registerOnDone(jobId, resolve));
    },
    /** 新建任务后立即塞入列表（响应式），并启动轮询 */
    track(job) {
      if (!job) return;
      const i = this.items.findIndex((x) => x.id === job.id);
      if (i > -1) this.items[i] = job; else this.items.unshift(job);
      this.ensurePolling();
    },
    async cancel(jobId) {
      await jobApi.cancel(jobId);
      await this.fetchAll();
    },
    // 批量删除历史任务（仅 succeeded/failed），回参 { deleted }；fetchAll 让被删行立即退出轮询列表
    async cleanup(params) {
      const r = await jobApi.cleanup(params);
      await this.fetchAll();
      return r;
    },
  },
});
