# AIDrama 生产部署 Runbook

从零把 AIDrama 上到一台公网服务器的完整清单。前置阅读：`deploy/nginx.conf`（反代/静态/防盗链方案，含逐块注释）。

---

## ① 服务器要求与目录规划

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 22.04+（nginx 1.24、MySQL 8、Node ≥ 18） |
| 配置 | 4C8G 起步（视频合成 ffmpeg 吃 CPU/内存；`max_memory_restart` 设 1G） |
| 磁盘 | 系统盘 + 数据盘挂 `/usr/share/nginx/xworld-gz/`（生成图片/视频增长快，按量预估） |
| 依赖 | `node`、`nginx`、`mysql-server`、`ffmpeg`（PATH 可找到，或配 `FFMPEG_PATH`）、`pm2` 或 systemd、`mysqldump`、`logrotate` |
| 网络 | 80/443 公网入；微信支付回调必须公网 HTTPS 可达 |

目录规划（本文与 `nginx.conf`、`backup.sh`、`logrotate-aidrama` 统一按此路径书写，实际不同请全局替换）：

```
/usr/share/nginx/xworld-gz/AIDrama/     # 项目根（svn checkout / export 到这里）
├─ server/                              # 服务端（进程 cwd；.env 在 server/.env）
│  ├─ data/                             # 生成图片/视频/SQLite（nginx /files 直读，磁盘大头）
│  ├─ skills/                           # 风格技能包（nginx /skills 直读）
│  ├─ logs/                             # AI 提交留档 JSON（按日期目录）
│  └─ cert/                             # 微信支付商户证书（只放服务器本地，见⑧）
├─ client/dist/                         # 前端构建产物（nginx root）
├─ deploy/                              # 本文与运维文件
├─ /var/backups/aidrama/                # 数据库备份（backup.sh 输出）
└─ /etc/logrotate.d/aidrama             # 日志轮转配置（见⑥）
```

上线顺序概览：装依赖 → 配 `server/.env` → 建库授权 → 启动进程（④）→ 配 nginx（③）→ 签证书开 HTTPS → 微信支付回归（⑦）。

---

## ② 关键环境变量清单（以代码现状为准）

全部配置在 `server/.env`（dotenv 从进程 cwd 读，PM2/systemd 的 WorkingDirectory 必须指到 `server/`）。完整模板见 `server/.env.example`。

### 必须（缺了起不来或裸奔）

| 变量 | 说明 |
|---|---|
| `NODE_ENV=production` | **必须显式设 production**。`JWT_SECRET` 只在 production 下强制校验；不设则开发兜底密钥（`dev-insecure-secret-change-me`）生效，任何人可本地签发有效令牌冒充任意用户。production 且 `JWT_SECRET` 留空会直接拒绝启动 |
| `JWT_SECRET` | 本系统自签/校验用户会话令牌（`axt_` JWT）的 HS256 密钥，长随机串 |
| `FILE_SIGN_SECRET` | `/files` 视频/音频 secure_link 时效签名密钥，**必须与 nginx.conf 里的 `REPLACE_WITH_FILE_SIGN_SECRET` 一致**。留空 = 出口不签名，nginx 防盗链块无法上线 |
| `PUBLIC_BASE_URL` | 对外基础地址（如 `https://your-domain.com`）：微信支付回调、分享链接都从它派生 |
| `CLIENT_ORIGIN` | CORS 允许的前端地址（逗号分隔多个） |

### 数据库

| 变量 | 说明 |
|---|---|
| `DB_DIALECT` | 生产建议 `mysql`；`sqlite` 仅小规模可用（备份走 `sqlite3 .backup`） |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | mysql 模式必填；建库：`CREATE DATABASE aidrama DEFAULT CHARACTER SET utf8mb4;` |
| `DB_STORAGE` | sqlite 模式的库文件路径 |

### 账号体系（本地注册/登录）

| 变量 | 说明 |
|---|---|
| `ADMIN_JWT_SECRET` | 管理台独立令牌密钥（留空回退 `JWT_SECRET`，生产建议独立随机长钥） |
| `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` | 首次启动 seed 的初始管理员（默认 `admin` / `admin123`，已有管理员时跳过）。**上线后立即用 `node scripts/setAdminPassword.js` 改密** |
| `CAPTCHA_TICKET_SECRET` | 点选验证码 ticket 签名密钥（留空复用 `JWT_SECRET`） |

> 注册/登录/改密全部走本服务端 `/api/auth/*`；LLM 等业务配置在管理后台维护，`.env` 不含任何模型密钥。

### App 端第三方一键登录（可选；申请与部署详见 docs/Apple登录申请与部署.md、docs/Google登录申请与部署.md）

| 变量 | 说明 |
|---|---|
| `APPLE_BUNDLE_ID` | iOS App 的 Bundle ID（与 HBuilderX 打包面板、Apple Developer Identifiers 三处一致）；留空=Apple 登录未启用（换取返回 503） |
| `GOOGLE_CLIENT_IDS` | 允许的 Google OAuth 客户端 ID（逗号分隔，Android 客户端必配）；留空=Google 登录未启用 |
| `APP_TOKEN_TTL` / `APP_REFRESH_TTL` | 第三方登录会话时长（默认 7d / 30d；refresh 不轮换） |

### 微信支付（见⑦详述）

`WECHAT_PAY_METHOD`（`native`/`jsapi`）、`WECHAT_PAY_APP_ID`、`WECHAT_PAY_MCH_ID`、`WECHAT_PAY_API_V3_KEY`、`WECHAT_PAY_SERIAL_NO`、`WECHAT_PAY_PRIVATE_KEY_PATH`（或内联 `WECHAT_PAY_PRIVATE_KEY`，二选一）、`WECHAT_PAY_NOTIFY_URL`（留空取 `${PUBLIC_BASE_URL}/api/recharge/wechat/notify`）、JSAPI 另需 `WECHAT_PAY_APP_SECRET`；小程序壳充值另需 `WECHAT_MINI_APP_ID` / `WECHAT_MINI_APP_SECRET`。

### 常用可选

`PORT`（默认 3000）、`UPLOAD_DIR`/`OUTPUT_DIR`（生成产物目录）、`FFMPEG_PATH`、`STATIC_IMAGE_VERSION`（风格图缓存破除，+1 递增）、`ASR_LANGUAGE`（字幕语音识别语种）。文本/图像/视频/TTS 模型接入**全部在管理后台「模型配置」维护**（`.env` 无默认模型配置）。

> 可选调优：`AIGC_LABEL`（AIGC 显式标识总开关，默认开，'0'/'false' 关）、`AI_RATE_LIMIT_PER_MIN`（AI 生成入口每用户每分钟上限，默认 30）。此外各路由内置进程内滑动窗口（注册/登录 10 次/分/IP、管理台登录 10 次/分、验证码 120 次/分、客户端日志 30 次/分/IP），无需环境变量。

---

## ③ nginx 上线 checklist（对照 `deploy/nginx.conf`）

- [ ] 全局替换部署路径：`/usr/share/nginx/xworld-gz/AIDrama`（root/alias 三处：client/dist、server/data、server/skills）与 `server_name your-domain.com`；
- [ ] **防盗链密钥**：`cp deploy/nginx.secrets.example.conf deploy/nginx.secrets.conf` 并填入与后端 `FILE_SIGN_SECRET` 完全一致的密钥（该文件已 svn:ignore，不入版本库；nginx.conf 通过 include 引用变量 `$file_sign_secret`）；扩展名清单改动须同步 `server/src/utils/mediaSign.js` 的 `MEDIA_EXT_RE`；
- [ ] **上线顺序**：先给后端配 `FILE_SIGN_SECRET` 并重启（出口开始带签名），再启用 secure_link 正则块——顺序反了存量媒体链接全部 403；
- [ ] `client_max_body_size 220m`（Express `express.json({ limit: '8mb' })` 只约束 JSON；视频素材上传走同前缀流式 200MB，调小会全部 413）；
- [ ] HTTPS：80 端口 server 的 `location /` 301 跳转段按文件内注释取消注释；文件尾部注释掉的 443 server 块复制启用，证书路径按实际填写（certbot：`/etc/letsencrypt/live/<域名>/fullchain.pem` + `privkey.pem`）；80 端口保留 `/.well-known/acme-challenge/` 供续期；
- [ ] `/pay.html` 收银台代理块不要删：否则被 SPA 回退吞掉，微信 JSAPI 支付目录校验失败；
- [ ] `/MP_verify_*.txt`：公众号网页授权域名验证文件放 `nginx` 同级约定目录（见配置注释），不配报 10003；
- [ ] `nginx -t` 通过后 reload；验证：`curl -I https://your-domain.com/api/pricing`（应 200）。

---

## ④ 进程管理（PM2 / systemd 二选一）

**必须单实例**：服务端有 4 个常驻扫描线程（视频生成结果轮询、缩略图补齐、维护播报、访问日志聚合）+ 进程内 job 队列 + 内存滑动窗口限频，全部单进程假设。**cluster 多实例会重复执行任务、重复扣费**。

### 方案 A：PM2（`deploy/ecosystem.config.js`，fork 单实例）

```bash
cd /usr/share/nginx/xworld-gz/AIDrama
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup      # 开机自启
pm2 logs aidrama             # 实时日志（stdout，logger 全打这里）
pm2 restart aidrama          # 重启（重启自愈：有厂商任务的 job 挂恢复钩子续查，无任务的退款失败）
pm2 monit                    # 内存观察（超 1G 自动重启）
```

### 方案 B：systemd（`deploy/aidrama.service`）

```bash
sudo cp deploy/aidrama.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aidrama
systemctl status aidrama
journalctl -u aidrama -f
```

发版流程（两方案通用）：`svn update` → `cd client && npm ci && npm run build` → `pm2 restart aidrama`（或 `systemctl restart aidrama`）→ 冒烟（登录/任务中心轮询/放一个视频）。

---

## ⑤ 备份与恢复（`deploy/backup.sh`）

每日全量：MySQL `mysqldump --single-transaction`（不锁表）/ SQLite `sqlite3 .backup`（在线热备）→ gzip 落 `/var/backups/aidrama/`，保留 14 天。DB 配置直接读 `server/.env`，不重复维护。

```bash
# 手动跑一次验证
sudo /usr/share/nginx/xworld-gz/AIDrama/deploy/backup.sh

# cron（crontab -e，root 或对 /var/backups/aidrama 有写权限的用户）
15 3 * * * /usr/share/nginx/xworld-gz/AIDrama/deploy/backup.sh >> /var/log/aidrama-backup.log 2>&1
```

建议对 `/var/backups/aidrama` 再做异地/对象存储二次备份（rsync/ossutil，超出本文范围）。

**恢复步骤**（MySQL）：

```bash
gunzip /var/backups/aidrama/aidrama-20260919_031500.sql.gz
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS aidrama_restore DEFAULT CHARACTER SET utf8mb4;"
mysql -u root -p aidrama_restore < aidrama-20260919_031500.sql
# 核对无误后切库：停服务 → 改 server/.env 的 DB_NAME → 起服务；
# 或直接在原库导入覆盖（先备份当前库）
```

**恢复步骤**（SQLite）：`.db.gz` 解压后即 SQLite 库文件快照——停服务 → `gunzip` 后直接替换 `server/data/aidrama.db`（保留出问题当天的坏库做排查）→ 起服务。`server/data/`（uploads/outputs 生成产物）不在数据库备份内，需另行按目录同步备份。

---

## ⑥ 日志轮转安装

```bash
sudo cp deploy/logrotate-aidrama /etc/logrotate.d/aidrama
sudo logrotate -d /etc/logrotate.d/aidrama   # 演练验证（-d 只读不写）
```

按日轮转、保留 14 份、gzip 压缩、`copytruncate`（无需通知进程）。注意区分两类日志：

- **进程 stdout**（业务日志、morgan 访问日志）：PM2 在 `~/.pm2/logs/`、systemd 在 journald（`journalctl --vacuum-time=14d` 控制体积）；logrotate 覆盖 PM2 路径；
- **AI 提交/返回留档 JSON**：`server/logs/<YYYY-MM-DD>/` 按日期目录由代码自管理，不轮转，磁盘告警时按目录手工归档/删除。

---

## ⑦ 微信支付上线步骤

前置：`deploy/nginx.conf` 已上线、HTTPS 可用、`PUBLIC_BASE_URL` 正确。

1. **商户平台绑定 AppID**（pay.weixin.qq.com → 产品中心 → AppID 账号管理）：把与商户号配套的公众号/小程序/开放平台 AppID 绑定到该商户号。**不绑定必报 `APPID_MCHID_NOT_MATCH`（400）**——这是历史上踩过的坑，appid 与 mchid 必须是绑定关系而非仅仅真实存在；
2. **证书落服务器本地**：`apiclient_key.pem`（商户 API 私钥）+ API 证书序列号（`WECHAT_PAY_SERIAL_NO`）放 `server/cert/`，`.env` 配 `WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem`（相对 `server/` 目录）；权限 600、属主与运行进程用户一致；**不要提交进 SVN（见⑧）**；也可用 `WECHAT_PAY_PRIVATE_KEY` 内联 PEM（不推荐，泄露面大）；
3. **APIv3 密钥**：商户平台 API 安全里设置 32 位 `WECHAT_PAY_API_V3_KEY`，与 `.env` 一致——回调解密全靠它；
4. **回调地址**：`WECHAT_PAY_NOTIFY_URL` 留空即取 `${PUBLIC_BASE_URL}/api/recharge/wechat/notify`，必须是公网 HTTPS；native 模式下 `WECHAT_PAY_METHOD=native`；公众号内支付改 `jsapi` 并配 `WECHAT_PAY_APP_SECRET`（网页授权换 openid，须与支付 AppID 同主体）；PC 上 jsapi 模式走 H5 收银台页（`/pay.html`，nginx 已显式代理给 Node）；
5. **回调验签（已实现）**：`server/src/services/wechat/platformCert.service.js` 自动拉取 `/v3/certificates` 平台证书（内存缓存+12h 刷新+serial 轮换强刷），`verifyNotifySignature` 按平台公钥做 SHA256withRSA 严格验签；证书拉取失败时降级为仅 AES-256-GCM 解密兜底（每小时最多告警一次），`WECHAT_PAY_VERIFY_STRICT=1` 可改 fail-closed。相关 env：`WECHAT_PAY_CERT_REFRESH_HOURS`(默认12)、`WECHAT_PAY_CERT_FORCE_REFRESH_MIN_SEC`(默认10)、`WECHAT_PAY_VERIFY_MAX_SKEW_SEC`(默认300,防重放)、`WECHAT_PAY_VERIFY_STRICT`；上线观察 `GET /admin/payments/pay-config` 的 `platform_cert` 快照（loaded=true、last_error=null）。
6. **一分钱真实订单回归**（上线必做，模拟支付通道已不存在）：
   - 充值页选最低档（或临时配 0.01 元档位）→ 微信扫码/拉起支付 → 完成付款；
   - 核对：①订单状态变已支付；②积分到账、`credit_transactions` 有流水；③服务端日志有回调处理记录（重复回调只入账一次——幂等）；
   - **admin 后台原路退款**（支付管理）→ 用户积分相应扣减、微信侧退款到账 → 再对账一遍；
   - 回归完成后删除测试档位。

---

## ⑧ SVN 注意

- **`server/cert/`（微信支付商户私钥/证书）已移出版本库**，只在服务器本地存在。新机器部署时手工放置，切勿 `svn add` 回去；`svnaddsrcall.sh` 之类批量加脚本执行前先确认忽略规则仍生效；
- 同理不入库的：`server/.env`（生产密钥）、`server/data/`（用户生成数据）、`client/desktop/release/`（安装包产物）；
- 发版用 `svn update` / `svn export` 拉代码，构建产物（`client/dist`）可构建后不入库，按团队现状定。

---

## ⑨ AIGC 标识开关与合规提醒

- **AIGC 内容标识（已实现）**：《人工智能生成合成内容标识办法》要求 AI 生成内容带显式+隐式标识。现状：成片合成（`video.routes.js` 合成出口）与 AI 封面（`cover.service.js`）自动烧录右下角「AI生成/AI-generated」角标，视频并写 `-metadata comment="AI-generated content"` 隐式标识；`AIGC_LABEL=0` 可关闭（不建议）。分镜图/资产图等中间素材刻意不打标（会传导污染后续生成）。展示中心/分享播放页前端亦有「内容由 AI 生成」标识。**仍待办**：正式对外前确认法务定稿的隐私政策/用户协议文案（当前为占位模板）、ICP 备案号、算法备案；
- **ICP 备案**：域名须完成 ICP 备案并在网站页脚展示备案号（前端全局页脚配置位按团队现状接入）;
- **算法备案**：生成式 AI 服务按《生成式人工智能服务管理暂行办法》完成算法备案/登记后再公开运营，属待办；
- 其他：用户协议与隐私政策上线、日志中的 API Key 已做脱敏（首末 4 位）但留档 JSON 属敏感数据，仅 admin 可访问。
