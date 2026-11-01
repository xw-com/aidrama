# 🎬 星网 XW.COM · AI 短剧制作平台

一套 AI 短剧创作系统：**导入剧本 → 提取角色/场景/道具 → 生成分镜 → 生成分镜视频 → 合成全集**。
服务端 **Node.js + MySQL（/ SQLite 回退）**，前端 **Vue 3 + Element Plus** 两端：**Web（client，含桌面壳 client/desktop）+ 移动端（uniapp，App/小程序壳/H5）**，通过 REST API 通讯。登录统一走 **xworld 账号中心（OAuth2 授权码 + PKCE）**。

---

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 👤 用户系统 | **xworld OAuth2 登录**（授权码 + PKCE，JWT 令牌）+ 点选文字验证码；**团队共享项目**（邀请/权限）|
| 📖 剧本大纲 | 粘贴或上传 `.txt` 导入剧本，**AI 拆分为多集**，可逐集编辑 |
| 🎭 资产库 | **AI 提取角色 / 场景 / 道具**，逐个或批量生成资产图 |
| 🎬 分集视频 | **AI 生成分镜脚本**（片段脚本 + 旁白 + 语音配置 + 时长）|
| ✂️ 分镜编辑器 | 左侧资产、中间分镜脚本、右侧视频预览、底部片段时间轴 |
| 🎞️ 视频生成 | 每个片段：（可选 TTS）→ 视频片段，生成后自动抽取首帧为预览封面 |
| 🧩 合成全集 | ffmpeg 拼接选中片段，输出整集 mp4 |
| 🔧 大模型配置 | 文本/图像/视频/语音四类配置 **可编辑 / 可导入 / 可导出** |
| 💰 积分计费 | 每个调用大模型/媒体的环节都有定价，**按量扣减积分** |
| 💳 充值 | 预设套餐 + **微信支付（V3 · Native 扫码 / JSAPI）**，按量扣减积分 |
| 🎨 主题 | 浅色 / 深色 / 自动跟随系统 |

### 定价（可编辑，默认值）
| 功能 | 单位 | 积分 |
|---|---|---|
| 剧本拆分 | 每千字 | 10 |
| 资产提取 | 每集 | 20 |
| 资产图生成 | 每张 | 5 |
| **分镜脚本生成** | **每 100 字** | **2** |
| **分镜视频生成** | **每秒** | **11** |
| 旁白配音(TTS) | 每 100 字 | 3 |
| 视频合成 | 每集 | 30 |

---

## 📂 目录结构

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize 服务端
│  ├─ src/
│  │  ├─ db/models/        # 数据表模型 + 关联
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST 路由（项目/资产/分镜/视频/积分/充值/展示/接单/admin…）
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # 定价 + 默认模型厂商目录
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus Web 端
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ admin.html           # 管理后台独立入口（/admin）
│  └─ desktop/             # Electron 桌面壳（Windows/macOS，见 client/desktop/README.md）
├─ uniapp/            # 移动端（uni-app：App / 小程序壳 / H5）
└─ deploy/            # 生产部署：nginx.conf / PM2 / systemd / backup / DEPLOY.md runbook
```

---

## 🚀 快速开始

### 1. 启动服务端

```bash
cd server
cp .env.example .env          # 默认 DB_DIALECT=sqlite，零配置即可运行
npm install
npm run dev                   # http://localhost:3000 ，自动建表 + seed
```

- **SQLite（开箱即用，推荐本地体验）**：`DB_DIALECT=sqlite`，数据存于 `server/data/aidrama.db`
- **MySQL**：设 `DB_DIALECT=mysql` 并填 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`

### 2. 启动客户端

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

打开 http://localhost:5173 ，通过 xworld 账号登录即可。

> 客户端已配置代理，`/api` 与 `/files` 自动转发到 `http://localhost:3000`。

## 🚢 生产部署

完整 runbook 见 **[deploy/DEPLOY.md](deploy/DEPLOY.md)**（nginx 上线 checklist、PM2/systemd 单实例、备份恢复、微信支付上线、合规待办）。最低环境要求：

```bash
NODE_ENV=production            # 不设则 JWT 开发兜底密钥生效，安全隐患
JWT_SECRET=<与 xworld 共享的验签密钥>
FILE_SIGN_SECRET=<媒体防盗链签名密钥>   # 须与 deploy/nginx.conf 中 secure_link 密钥一致
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

微信支付另需 `WECHAT_PAY_*` 五件套（商户号、AppID、APIv3 密钥、证书序列号、商户私钥），见 `deploy/DEPLOY.md` ⑦。

---

## 🔌 配置大模型 / 媒体（让 AI 功能真正生效）

系统所有 AI 能力都**配置驱动**。未配置时：
- 文本（剧本拆分/资产提取/分镜生成）→ 调用前会在「大模型配置」页提示配置；
- 图像 / 视频 / TTS → 需在「大模型配置」配置真实 provider；**视频生成不再提供本地 ffmpeg 兜底**（关键帧现由生成视频的首帧自动抽取），**合成始终用本地 ffmpeg**。

两种配置方式（任选其一）：

**A. 用 `.env` 预置（首次启动自动写入默认配置）**
```bash
DEFAULT_TEXT_BASE_URL=https://api.openai.com/v1
DEFAULT_TEXT_API_KEY=sk-xxx
DEFAULT_TEXT_MODEL=gpt-4o-mini
DEFAULT_IMAGE_BASE_URL=...   DEFAULT_IMAGE_API_KEY=...   DEFAULT_IMAGE_MODEL=dall-e-3
```

**B. 在客户端「大模型配置」页增删改，并支持导入/导出 JSON**

支持的协议：
- **文本/图像/TTS**：OpenAI 兼容（`/chat/completions`、`/images/generations`、`/audio/speech`）或自定义端点（`api_style=custom`）
- **视频**：配置异步任务端点（提交→轮询→视频 URL）；需真实视频生成 provider（本地 ffmpeg「图生视频」已停用）

> 需要本地安装 `ffmpeg`（macOS：`brew install ffmpeg`）。视频片段拼接合成依赖它。

---

## 💚 微信支付（V3 · Native 扫码 / JSAPI）

真实微信支付，**配置驱动、默认关闭**（`.env` 中 `WECHAT_PAY_*` 留空即未启用，前端自动隐藏充值入口）。登录已统一走 xworld 账号中心（见下一节），`WECHAT_APP_ID` 仅作为支付 AppID 的回退值保留。

在 [微信商户平台](https://pay.weixin.qq.com/) 开通 Native/JSAPI 支付，拿到商户号、APIv3 密钥，并下载商户 API 证书（`apiclient_key.pem` + 证书序列号）。**商户号与 AppID 必须在商户平台完成绑定**（否则下单报 `APPID_MCHID_NOT_MATCH`）。配置：
```bash
WECHAT_PAY_METHOD=native       # native=扫码 | jsapi=公众号内支付（PC 走 H5 收银台）
WECHAT_PAY_APP_ID=             # 与商户号绑定的 AppID（留空则回退 WECHAT_APP_ID）
WECHAT_PAY_MCH_ID=<你的商户号>
WECHAT_PAY_API_V3_KEY=         # 32 位 APIv3 密钥
WECHAT_PAY_SERIAL_NO=          # 商户 API 证书序列号
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # apiclient_key.pem 的磁盘路径（与下一行二选一）
WECHAT_PAY_PRIVATE_KEY=        # 或直接内联 PEM 文本
WECHAT_PAY_NOTIFY_URL=         # 留空则取 ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- 流程：积分中心选「微信支付」→ 后端统一下单（Native 返回 `code_url` 渲染二维码 / JSAPI 拉起支付）→ 用户付款 → 微信异步回调 `/api/recharge/wechat/notify`（AES-256-GCM 解密校验、幂等入账）。
- 回调必须为**公网可达的 HTTPS 地址**（开发期可用内网穿透）。

> 上线步骤（商户平台绑 AppID、证书落服务器本地、一分钱真实订单回归）见 **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ 微信支付上线步骤**。
> 数据库：支付订单流水号写入 `recharge_orders.transaction_id`，由启动时的 `ensureColumns` 幂等补齐，不影响旧库。

---

## 🔑 登录：xworld 账号中心（OAuth2 授权码 + PKCE）

两端登录统一走 xworld 授权服务器（auth.example.com），本系统不再维护自有注册/登录：

- 流程：前端发起授权码 + PKCE → xworld 授权页登录 → 回调前端 → 换取 `xwat_` 不透明令牌；
- 令牌代理：Web 端的换码/刷新/吊销走本服务端 `/api/oauth/token|refresh|revoke`（机密客户端，`XWORLD_OAUTH2_CLIENT_SECRET` 只存在服务端，绝不下发前端；refresh 轮换后须同步落盘）；
- 鉴权：服务端用 `JWT_SECRET`（与 xworld 共享的 HS256 密钥）本地验签平台 JWT；`xwat_` 令牌则回源 `XWORLD_API_BASE` 校验 userinfo（结果带内存缓存）。**生产必须配真实 `JWT_SECRET`**；
- 验证码：登录/发送验证码前需过点选文字验证码（后端 SVG 出题，`/api/captcha/*`）；
- 桌面壳（client/desktop）回调地址为 `app://xw-client/oauth/callback`，须在 xworld 侧登记，服务端白名单由 `XWORLD_OAUTH2_DESKTOP_ORIGINS` 控制。

相关 `.env`：`XWORLD_API_BASE`、`XWORLD_OAUTH2_CLIENT_ID`、`XWORLD_OAUTH2_CLIENT_SECRET`、`XWORLD_OAUTH2_DESKTOP_ORIGINS`、`JWT_SECRET`、`ADMIN_JWT_SECRET`（管理台独立入口 `/admin`，手机号+密码+验证码登录）。

---

## 🧪 端到端验证步骤

1. 登录 → 新建项目 → 「剧本大纲」粘贴/上传剧本 → **AI 拆分剧本**（扣积分）
2. 「资产库」→ **AI 提取资产** → 对角色/场景**生成资产图**
3. 「分集视频」→ **生成脚本** → 进入**分镜编辑器**
4. 编辑器内选中片段 → **立即生成**（视频片段，并自动抽取首帧为预览封面）
5. **合成全集**（ffmpeg 拼接出整集 mp4）
6. 在「积分中心」查看流水、充值；在「大模型配置」导入导出；切换浅色/深色/自动主题

---

## 📡 主要 API（`/api` 前缀，JWT 鉴权，统一 `{code,message,data}`）

```
GET /auth/me   POST /auth/sync                                # 用户档案（登录态由 xworld 令牌建立）
POST /captcha/challenge | /captcha/verify                      # 点选文字验证码
POST /oauth/token | /oauth/refresh | /oauth/revoke             # xworld 令牌代理（公开，限频）
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # 异步任务中心（前端轮询）
GET/POST/PUT/DELETE /model-configs     POST /model-configs/import  GET /model-configs/export
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # 微信支付回调（无需鉴权，验签+幂等）
GET /showcase/*                                                # 展示中心（发布/浏览/做同款）
GET /market/*                                                  # 接单中心（任务单/托管/验收）
GET /pricing
```
每个 AI 接口都有对应的 `…/estimate` 接口用于预估积分；管理接口（`/admin/*`：用户/支付/任务/日志/维护等）走独立管理台令牌。

---

## 🛠 技术栈

**服务端**：Express · Sequelize（mysql/sqlite 双 dialect）· JWT · multer · axios · fluent-ffmpeg · sharp
**Web 端**：Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios（桌面壳：Electron + electron-updater）
**移动端**：uni-app（App / 小程序壳 / H5）

## 📝 说明

- 本项目交付"功能端到端可用"基座：所有 API 与页面均真实工作、可运行；UI 复刻参考图结构与状态。
- 外部 provider（图像/视频/TTS）需配置真实 key 后端到端出真实素材；ffmpeg 仅用于视频片段拼接合成。
- 修改 Sequelize 模型后，SQLite 下请删除 `server/data/*.db` 重新初始化（生产建议用迁移）。
