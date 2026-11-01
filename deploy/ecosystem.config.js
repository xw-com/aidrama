// PM2 进程管理配置 · AIDrama 服务端
//
// ⚠️ 必须单实例 fork 模式（instances:1, exec_mode:'fork'），不要改成 cluster：
//   服务端有 4 个常驻扫描线程/定时器 + 进程内 job 队列（videoGenScanner、thumbnail
//   scanner、maintenance 播报、访问日志聚合、进程内 Job 运行器、验证码/限频的内存滑动
//   窗口），全部基于「单进程」假设。cluster 多实例会重复扫描、重复执行 job、重复扣费。
//
// 用法（在 AIDrama 根目录）：
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup      # 开机自启
//   pm2 logs aidrama             # 看日志（stdout/stderr 落 ~/.pm2/logs/）
//   pm2 restart aidrama          # 重启（重启自带僵尸任务恢复逻辑，见 job.service）

module.exports = {
  apps: [
    {
      name: 'aidrama',
      cwd: '/usr/share/nginx/xworld-gz/AIDrama/server', // 按实际部署路径调整；dotenv 从 cwd 读 server/.env
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1, // 单进程假设，见文件头注释，勿改 cluster
      env: {
        NODE_ENV: 'production',
      },
      // 崩溃循环防护：最多连续重启 10 次，每次间隔 5s
      max_restarts: 10,
      restart_delay: 5000,
      // 内存超限自动重启（视频合成/批量生成内存峰值较高，1G 起步可按观察调整）
      max_memory_restart: '1G',
      // 优雅停止：给进行中的 job 一点收尾时间（进程内运行器会在 SIGINT 后停止拉新任务）
      kill_timeout: 10000,
      time: true, // 日志行带时间戳
      merge_logs: true,
      autorestart: true,
      // 不用 watch 模式：改代码后手动 pm2 restart，避免扫描目录带来的意外重启
      watch: false,
    },
  ],
};
