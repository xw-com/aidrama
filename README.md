**🌐 Language**: **简体中文** | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI 短剧制作平台

> 🌐 **在线演示**：<https://aiwork.xw.com> 　·　📮 联系我们：**kevin@xw.com**

一套 AI 短剧创作系统：**导入剧本 → 提取角色/场景/道具 → 生成分镜 → 生成分镜视频 → 合成全集**。
服务端 **Node.js + MySQL（/ SQLite 回退）**，前端 **Vue 3 + Element Plus** 两端：**Web（client，含管理后台 client/admin 与桌面壳 client/desktop）+ 移动端（uniapp，App/小程序壳/H5）**，通过 REST API 通讯。账号体系为**内置本地注册/登录**（用户名/邮箱/手机号 + 密码），不依赖任何第三方账号中心。

---

## 🌐 在线演示 & 交流

- **演示地址**：<https://aiwork.xw.com>
- **用户手册**：[PC 端](docs/pc-user-manual.md)　·　[移动端](docs/mobile-user-manual.md)
- **问题反馈 / 合作**：<kevin@xw.com>

---

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 👤 用户系统 | **本地注册 / 登录**（用户名/邮箱/手机号 + 密码，注册需点选文字验证码）+ **团队共享项目**（邀请/权限）|
| 📖 剧本大纲 | 粘贴或上传 `.txt` 导入剧本，**AI 拆分为多集**，可逐集编辑 |
| 🎭 资产库 | **AI 提取角色 / 场景 / 道具**，逐个或批量生成资产图 |
| 🎬 分集视频 | **AI 生成分镜脚本**（片段脚本 + 旁白 + 语音配置 + 时长）|
| ✂️ 分镜编辑器 | 左侧资产、中间分镜脚本、右侧视频预览、底部片段时间轴 |
| 🎞️ 视频生成 | 每个片段：（可选 TTS）→ 视频片段，生成后自动抽取首帧为预览封面 |
| 🧩 合成全集 | ffmpeg 拼接选中片段，输出整集 mp4 |
| 🔧 大模型配置 | **全部在管理后台配置**（文本/图像/视频/语音四类，可启停 / 可导入 / 可导出）|
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
│  │  ├─ seeders/          # 定价 + 默认模型厂商目录 + 初始管理员
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus Web 端
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # 管理后台（独立入口 /admin，独立登录与令牌）
│  ├─ admin.html           # 管理后台入口 HTML
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
- **首次运行自动创建初始管理员**（控制台会打印提示）：
  - 默认账号 **`admin / admin123`**，用于登录管理后台 `/admin`
  - 可用环境变量 `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` 覆盖；已有管理员时自动跳过
  - ⚠️ 上线前请立即修改默认密码（`node scripts/setAdminPassword.js`，或见下文管理后台一节）

### 2. 启动客户端

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

打开 <http://localhost:5173> ：没有账号就点「注册」（用户名 + 密码，过一道点选验证码，注册成功即登录并赠送 66 体验积分）；已有账号直接登录（用户名 / 邮箱 / 手机号均可）。

> 客户端已配置代理，`/api` 与 `/files` 自动转发到 `http://localhost:3000`。

---

## 🛠 管理后台（client/admin）使用

管理后台是**独立入口、独立登录、独立令牌**（`admt_` 前缀 JWT，与前台用户会话互不相通）：

- **入口**：<http://localhost:5173/admin>（生产环境为 `https://你的域名/admin`）
- **登录**：账号 + 密码 + 点选文字验证码。首次运行用初始管理员 **`admin / admin123`**；
- **改密**：管理台内暂无改密页，用服务端脚本重置：
  ```bash
  cd server
  node scripts/setAdminPassword.js <用户名或邮箱> <新密码>
  ```
  （`adminAuth` 登录支持 用户名 / 邮箱 / 手机号任一作为账号）

### 功能模块

| 模块 | 用途 |
|---|---|
| **模型配置** | **文本 / 图像 / 视频 / TTS 四类 LLM 接入**（见下一节，上线前必配）|
| 模型厂商 | 厂商与模型目录（新增配置时的预设来源，seed 已内置主流厂商）|
| 美术风格 / 角色选项 / 声音库 | 创作素材字典（前台可选项由此配置）|
| 定价 | 各 AI 环节积分单价（见上表）|
| 用户管理 | 查询用户、**封禁/解封**、**重置密码**（忘记密码的统一入口）、调整积分、**一键登录用户前端**（login-as，代用户排查问题）|
| 支付 | 微信充值订单查询 / 对账 |
| 展示审核 | 展示中心作品上/下架 |
| 任务管理 / 视频生成管理 | 异步任务与视频生成队列的重试/清理 |
| 维护 | 维护模式开关（503 + 预计恢复时间）、数据维护 |
| 登录日志 | 全站登录记录（方式 / IP / UA）|

---

## 🔌 配置大模型 / 媒体（让 AI 功能真正生效）

所有 AI 能力都**配置驱动**，且 **统一在管理后台「模型配置」页维护**（`.env` 不再提供任何默认 LLM 配置）。未配置时：文本类功能会在调用前提示；图像/视频/TTS 会直接报「未配置」。

配置步骤：

1. 登录管理后台 `/admin` → **模型配置** → 新增；
2. 选择类型（文本 / 图像 / 视频 / TTS）与协议，填写：
   - **Base URL**（如 `https://api.openai.com/v1`）
   - **API Key**（仅存服务端，不下发前端）
   - **模型名**（如 `gpt-4o-mini`、`dall-e-3`）
   - 启用状态与该配置的积分定价；
3. 保存后前台立即可用（同一类型可配多条并启停切换）；「大模型配置」页支持**导入 / 导出 JSON**，便于批量迁移。

支持的协议：

- **文本 / 图像 / TTS**：OpenAI 兼容（`/chat/completions`、`/images/generations`、`/audio/speech`）或自定义端点（`api_style=custom`）
- **视频**：配置异步任务端点（提交→轮询→视频 URL）；需真实视频生成 provider（本地 ffmpeg「图生视频」已停用）

> 用户侧还可以在「个人设置 → 我的模型」添加**私有模型**（自带 Key，调用不计积分），不影响全局配置。
> 需要本地安装 `ffmpeg`（macOS：`brew install ffmpeg`）。视频片段拼接合成依赖它。

---

## 🚢 生产部署

完整 runbook 见 **[deploy/DEPLOY.md](deploy/DEPLOY.md)**（nginx 上线 checklist、PM2/systemd 单实例、备份恢复、微信支付上线、合规待办）。最低环境要求：

```bash
NODE_ENV=production            # 不设则 JWT 开发兜底密钥生效，安全隐患
JWT_SECRET=<本地会话令牌签名密钥，随机长串>      # 本系统自签/校验用户会话（axt_）
ADMIN_JWT_SECRET=<管理台独立签名密钥>
FILE_SIGN_SECRET=<媒体防盗链签名密钥>   # 须与 deploy/nginx.conf 中 secure_link 密钥一致
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

微信支付另需 `WECHAT_PAY_*` 五件套（商户号、AppID、APIv3 密钥、证书序列号、商户私钥），见 `deploy/DEPLOY.md` ⑦。

---

## 🔑 登录与账号体系（本地，无外部依赖）

账号体系为**本系统内置**：注册 / 登录 / 改密 / 会话刷新全部走本服务端 `/api/auth/*`，不依赖任何第三方账号中心：

- **注册**：用户名（2-64 位字母、数字、`_.-`）+ 密码（≥6 位）+ 邮箱（选填），需过点选文字验证码（后端 SVG 出题，`/api/captcha/*`）；注册成功即登录，并赠送 66 体验积分；
- **登录**：用户名 / 邮箱 / 手机号任一 + 密码；验证码「提供才校验」（前端默认会带上）；
- **令牌**：服务端自签 JWT（`axt_` 前缀，access + refresh，refresh 不轮换），前端静默续期走 `/api/auth/oauth/refresh`；管理台令牌独立（`admt_` 前缀）；
- **忘记密码**：自部署实例无短信/邮件通道，不提供自助重置——由管理员在 **管理后台「用户管理」→ 重置密码** 完成；
- **封禁**：封禁后该用户所有已签发令牌在下次请求即失效（服务端每请求重查用户状态）；
- **第三方登录（可选）**：移动端 App 的 Apple / Google 一键登录仍可用——服务端持密代理换取（`POST /api/auth/oauth/:provider`），换回同样的本地 `axt_` 会话；Web 端无需任何回调登记。

相关 `.env`：`JWT_SECRET`、`ADMIN_JWT_SECRET`、`CAPTCHA_TICKET_SECRET`、`ADMIN_INIT_USERNAME`、`ADMIN_INIT_PASSWORD`（均见 `server/.env.example` 注释）。

---

## 💚 微信支付（V3 · Native 扫码 / JSAPI）

真实微信支付，**配置驱动、默认关闭**（`.env` 中 `WECHAT_PAY_*` 留空即未启用，前端自动隐藏充值入口）。`WECHAT_APP_ID` 仅作为支付 AppID 的回退值保留。

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

## 🧪 端到端验证步骤

0. 管理后台 `/admin`（admin/admin123）→ **模型配置** → 配好文本/图像/视频/TTS 四类（否则 AI 环节不可用）
1. 前台注册/登录 → 新建项目 → 「剧本大纲」粘贴/上传剧本 → **AI 拆分剧本**（扣积分）
2. 「资产库」→ **AI 提取资产** → 对角色/场景**生成资产图**
3. 「分集视频」→ **生成脚本** → 进入**分镜编辑器**
4. 编辑器内选中片段 → **立即生成**（视频片段，并自动抽取首帧为预览封面）
5. **合成全集**（ffmpeg 拼接出整集 mp4）
6. 在「积分中心」查看流水、充值；在管理台改定价 / 封禁 / 重置密码 / 看登录日志；切换浅色/深色/自动主题

---

## 📡 主要 API（`/api` 前缀，JWT 鉴权，统一 `{code,message,data}`）

```
POST /auth/register | /auth/login                              # 本地注册（需验证码 ticket）/ 登录（公开，限频）
POST /auth/password                                            # 修改密码（登录态）
POST /auth/oauth/refresh                                       # 静默续期（refresh_token 换新 access_token，公开）
POST /auth/oauth/:provider                                     # 第三方登录换取本地会话（apple/google/weixin/huawei，可选）
GET /auth/me   POST /auth/sync                                 # 用户档案
POST /captcha/challenge | /captcha/verify                      # 点选文字验证码
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # 异步任务中心（前端轮询）
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # 全局配置读侧 + 导入导出（管理台维护）
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # 微信支付回调（无需鉴权，验签+幂等）
GET /showcase/*                                                # 展示中心（发布/浏览/做同款）
GET /market/*                                                  # 接单中心（任务单/托管/验收）
GET /pricing
```
每个 AI 接口都有对应的 `…/estimate` 接口用于预估积分；管理接口（`/admin/*`：用户/支付/任务/日志/维护等）走独立管理台令牌（`admt_`）。

---

## 🛠 技术栈

**服务端**：Express · Sequelize（mysql/sqlite 双 dialect）· JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web 端**：Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios（桌面壳：Electron + electron-updater）
**移动端**：uni-app（App / 小程序壳 / H5）

## 📝 说明

- 本项目交付"功能端到端可用"基座：所有 API 与页面均真实工作、可运行；UI 复刻参考图结构与状态。
- 外部 provider（图像/视频/TTS）需在**管理后台**配置真实 key 后端到端出真实素材；ffmpeg 仅用于视频片段拼接合成。
- 修改 Sequelize 模型后，SQLite 下请删除 `server/data/*.db` 重新初始化（生产建议用迁移）。

---

## 📄 开源协议

本项目基于 [AGPL-3.0](LICENSE) 开源。

- ✅ **个人学习、研究、非商业使用**：免费，且修改后对外提供网络服务需遵守 AGPL-3.0 开源义务
- 💼 **商业部署 / SaaS 服务 / 私有化交付**：需购买商业授权（可豁免 AGPL-3.0 开源义务），商业授权请联系：<kevin@xw.com>

---

## 📮 联系我们

- 📧 邮箱：<kevin@xw.com>
- 🌐 在线演示：<https://aiwork.xw.com>
- 💬 微信交流群「星网AI剧场开源交流」：

  ![星网AI剧场开源交流微信群二维码](docs/wechat-group-qr.jpg)
