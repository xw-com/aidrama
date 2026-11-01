/**
 * 任务轮询：/jobs/:id 拉状态直至终态（导入/拆分等 async=1 任务模式的配套）。
 * - onProgress(job) 每次拉到非终态任务时回调（progress 0-100、stage 服务端文案）
 * - succeeded → resolve(终态 job)；failed/cancelled → reject(Error(job.error)，带 .job）
 * - 网络抖动容忍 maxErrors 次连续失败；总超时 timeout 兜底防永久转圈
 */
import { jobApi } from '../api';

export function pollJob(jobId, { onProgress, interval = 1200, maxErrors = 6, timeout = 15 * 60 * 1000 } = {}) {
  let stopped = false;
  let errors = 0;
  const startedAt = Date.now();
  const p = new Promise((resolve, reject) => {
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > timeout) {
        stopped = true;
        reject(new Error('任务超时'));
        return;
      }
      try {
        const job = await jobApi.get(jobId);
        errors = 0;
        if (onProgress) onProgress(job);
        if (job.status === 'succeeded') { stopped = true; resolve(job); return; }
        if (job.status === 'failed' || job.status === 'cancelled') {
          stopped = true;
          reject(Object.assign(new Error(job.error || '任务失败'), { job }));
          return;
        }
      } catch (e) {
        errors += 1;
        if (errors >= maxErrors) { stopped = true; reject(e); return; }
      }
      setTimeout(tick, interval);
    };
    tick();
  });
  return p;
}
