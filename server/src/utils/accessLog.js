import morgan from 'morgan';
import { logger } from './logger.js';

// 轮询类端点：任务进度/邀请中心这类前端周期性拉取的请求，成功时逐条打访问日志只会刷屏
// 控制台（如任务进行中每 2s 一条 /api/jobs?limit=50）。改为按分钟聚合，每 60s 汇总一条；
// 非 2xx/304 的异常轮询仍由 morgan 即时打印，便于排查。
const POLLING_PATHS = [
  /^\/api\/jobs\/?$/,         // 任务列表轮询 GET /api/jobs?limit=50
  /^\/api\/jobs\/[^/]+$/,     // 单任务进度轮询（批量生成等场景）
  /^\/api\/invitations\/?$/,  // 邀请中心轮询
];

// ⚠️ 不能用 req.path/req.url：Express 挂载式路由（app.use('/api', …) 逐层嵌套）会把
// req.url 剥短且终态 handler 不回卷，morgan 的 skip 在响应完成时才判定，届时看到的
// 可能是被剥剩的 '/?limit=50'。req.originalUrl 永不被改写，与 morgan :url token 同源。
const isPolling = (req) => {
  if (req.method !== 'GET') return false;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return POLLING_PATHS.some((re) => re.test(path));
};

export function accessLog() {
  const buckets = new Map(); // originalUrl -> Map(status -> count)
  const flush = () => {
    if (!buckets.size) return;
    const parts = [];
    for (const [url, statuses] of buckets) {
      const total = [...statuses.values()].reduce((a, b) => a + b, 0);
      const detail = [...statuses.entries()].map(([s, n]) => `${s}×${n}`).join('/');
      parts.push(`${url} ${total}次(${detail})`);
    }
    buckets.clear();
    logger.info('[轮询汇总] 近1分钟：', parts.join('；'));
  };
  const timer = setInterval(flush, 60_000);
  if (timer.unref) timer.unref();

  return [
    // 成功的轮询请求不进 morgan，改记入聚合桶
    (req, res, next) => {
      if (!isPolling(req)) return next();
      res.on('finish', () => {
        if (res.statusCode >= 400) return; // 异常轮询交给 morgan 即时打印
        const m = buckets.get(req.originalUrl) || new Map();
        m.set(res.statusCode, (m.get(res.statusCode) || 0) + 1);
        buckets.set(req.originalUrl, m);
      });
      next();
    },
    morgan('tiny', { skip: (req, res) => isPolling(req) && res.statusCode < 400 }),
  ];
}
