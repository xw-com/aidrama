import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { config } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { detectLocale } from './middleware/detectLocale.js';
import routes from './routes/index.js';
import { ensureDirs } from './utils/fileUtil.js';
import { mediaSignMiddleware } from './utils/mediaSign.js';
import { accessLog } from './utils/accessLog.js';

export function createApp() {
  ensureDirs();
  const app = express();

  // 信任反向代理：生产为 nginx 单层反代，req.ip 取真实客户端 IP（限频/日志键依赖本值）。
  // ⚠️ 反代层数变化（如再加一层 CDN/网关）须同步改本值，否则 req.ip 回退为代理地址
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true, limit: '8mb' }));
  if (config.env !== 'test') app.use(...accessLog());

  // 解析客户端语言偏好（Accept-Language），供响应/错误消息本地化
  app.use(detectLocale);

  // 静态文件：/files/uploads|outputs/... → 让生成的图片/视频可被前端访问。
  // 只暴露这两个业务子目录——静态根曾挂整个 data/，aidrama.db、backups/ 整库转储
  // 与 outputs.zip 等大包全部可被未鉴权下载（库内含全员共享的厂商 API Key）。
  const dataRoot = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  app.use('/files/uploads', express.static(path.join(dataRoot, 'uploads'), { maxAge: '7d', fallthrough: true }));
  app.use('/files/outputs', express.static(path.join(dataRoot, 'outputs'), { maxAge: '7d', fallthrough: true }));

  // 静态文件：/skills/... → 暴露 skills 资源（如美术风格缩略图 art_skills/*/images/*）
  const skillsRoot = path.resolve(process.cwd(), 'skills');
  app.use('/skills', express.static(skillsRoot, { maxAge: '7d', fallthrough: true }));

  // H5 收银台（微信 JSAPI）：PC 端「收银台二维码」指向的单文件页，微信扫码在微信内打开后拉起支付
  // （html + 同源外链 css/js；helmet CSP 为 script-src 'self'，故不能用内联脚本）
  const publicRoot = path.resolve(process.cwd(), 'public');
  ['/pay.html', '/pay.css', '/pay.js'].forEach((f) => {
    app.get(f, (req, res) => {
      res.sendFile(path.join(publicRoot, f), (e) => { if (e && !res.headersSent) res.status(404).end('not found'); });
    });
  });

  // 健康检查
  app.get('/health', (req, res) => res.json({ code: 0, message: 'ok', data: { status: 'up', time: new Date().toISOString() } }));

  // 维护模式：不做全局拦截——读取类请求照常处理，仅「会产生任务」的请求在
  // job.service.createJob 入口拒绝非 admin（503 + maintenance 标记，前端有专门提示）。

  // /files 媒体防盗链：API 出口统一给视频/音频 URL 追加时效签名（nginx secure_link 校验），
  // 图片公开直读不受影响；未配置 FILE_SIGN_SECRET 时为直通（本地开发零影响）
  app.use(mediaSignMiddleware);

  // 业务路由
  app.use('/api', routes);

  // 404 + 错误处理
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
