**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | **繁體中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI 短劇製作平台

> 🌐 **線上展示**：<https://aiwork.xw.com> 　·　📮 聯絡我們：**kevin@xw.com**

一套 AI 短劇創作系統：**匯入劇本 → 擷取角色/場景/道具 → 產生分鏡 → 產生分鏡影片 → 合成整集**。
伺服器端為 **Node.js + MySQL（/ SQLite 回退）**，前端為 **Vue 3 + Element Plus** 兩端：**Web（client，含管理後台 client/admin 與桌面殼 client/desktop）+ 行動端（uniapp，App/小程式殼/H5）**，透過 REST API 通訊。帳號系統為**內建本地註冊/登入**（使用者名稱/電子郵件/手機號碼 + 密碼），不依賴任何第三方帳號中心。

---

## 🌐 線上展示 & 交流

- **展示網址**：<https://aiwork.xw.com>
- **問題回報 / 合作**：<kevin@xw.com>

---

## ✨ 功能

| 模組 | 說明 |
|---|---|
| 👤 使用者系統 | **本地註冊 / 登入**（使用者名稱/電子郵件/手機號碼 + 密碼，註冊需點選文字驗證碼）+ **團隊共享專案**（邀請/權限）|
| 📖 劇本大綱 | 貼上或上傳 `.txt` 匯入劇本，**AI 拆分為多集**，可逐集編輯 |
| 🎭 資產庫 | **AI 擷取角色 / 場景 / 道具**，逐一或批次產生資產圖 |
| 🎬 分集影片 | **AI 產生分鏡腳本**（片段腳本 + 旁白 + 語音設定 + 時長）|
| ✂️ 分鏡編輯器 | 左側資產、中間分鏡腳本、右側影片預覽、底部片段時間軸 |
| 🎞️ 影片生成 | 每個片段：（可選 TTS）→ 影片片段，生成後自動擷取首影格作為預覽封面 |
| 🧩 合成整集 | ffmpeg 串接選取的片段，輸出整集 mp4 |
| 🔧 大模型設定 | **全部在管理後台設定**（文本/圖像/影片/語音四類，可啟停 / 可匯入 / 可匯出）|
| 💰 點數計費 | 每個呼叫大模型/媒體的環節都有定價，**依用量扣減點數** |
| 💳 儲值 | 預設方案 + **微信支付（V3 · Native 掃碼 / JSAPI）**，依用量扣減點數 |
| 🎨 主題 | 淺色 / 深色 / 自動跟隨系統 |

### 定價（可編輯，預設值）
| 功能 | 單位 | 點數 |
|---|---|---|
| 劇本拆分 | 每千字 | 10 |
| 資產擷取 | 每集 | 20 |
| 資產圖生成 | 每張 | 5 |
| **分鏡腳本生成** | **每 100 字** | **2** |
| **分鏡影片生成** | **每秒** | **11** |
| 旁白配音(TTS) | 每 100 字 | 3 |
| 影片合成 | 每集 | 30 |

---

## 📂 目錄結構

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize 伺服器端
│  ├─ src/
│  │  ├─ db/models/        # 資料表模型 + 關聯
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST 路由（專案/資產/分鏡/影片/點數/儲值/展示/接案/admin…）
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # 定價 + 預設模型供應商目錄 + 初始管理員
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus Web 端
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # 管理後台（獨立入口 /admin，獨立登入與權杖）
│  ├─ admin.html           # 管理後台入口 HTML
│  └─ desktop/             # Electron 桌面殼（Windows/macOS，見 client/desktop/README.md）
├─ uniapp/            # 行動端（uni-app：App / 小程式殼 / H5）
└─ deploy/            # 正式環境部署：nginx.conf / PM2 / systemd / backup / DEPLOY.md runbook
```

---

## 🚀 快速開始

### 1. 啟動伺服器端

```bash
cd server
cp .env.example .env          # 預設 DB_DIALECT=sqlite，零設定即可執行
npm install
npm run dev                   # http://localhost:3000 ，自動建立資料表 + seed
```

- **SQLite（開箱即用，建議本機體驗）**：`DB_DIALECT=sqlite`，資料存於 `server/data/aidrama.db`
- **MySQL**：設 `DB_DIALECT=mysql` 並填 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **首次執行自動建立初始管理員**（主控台會印出提示）：
  - 預設帳號 **`admin / admin123`**，用於登入管理後台 `/admin`
  - 可用環境變數 `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` 覆蓋；已有管理員時自動跳過
  - ⚠️ 上線前請立即修改預設密碼（`node scripts/setAdminPassword.js`，或見下文管理後台一節）

### 2. 啟動用戶端

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

開啟 <http://localhost:5173> ：沒有帳號就點「註冊」（使用者名稱 + 密碼，過一道點選驗證碼，註冊成功即登入並贈送 66 點體驗點數）；已有帳號直接登入（使用者名稱 / 電子郵件 / 手機號碼皆可）。

> 用戶端已設定代理，`/api` 與 `/files` 會自動轉發到 `http://localhost:3000`。

---

## 🛠 管理後台（client/admin）使用

管理後台是**獨立入口、獨立登入、獨立權杖**（`admt_` 前綴 JWT，與前台使用者工作階段互不相通）：

- **入口**：<http://localhost:5173/admin>（正式環境為 `https://你的網域/admin`）
- **登入**：帳號 + 密碼 + 點選文字驗證碼。首次執行用初始管理員 **`admin / admin123`**；
- **改密**：管理台內暫無改密頁，用伺服器端指令稿重設：
  ```bash
  cd server
  node scripts/setAdminPassword.js <使用者名稱或電子郵件> <新密碼>
  ```
  （`adminAuth` 登入支援 使用者名稱 / 電子郵件 / 手機號碼任一作為帳號）

### 功能模組

| 模組 | 用途 |
|---|---|
| **模型設定** | **文本 / 圖像 / 影片 / TTS 四類 LLM 接入**（見下一節，上線前必配）|
| 模型供應商 | 供應商與模型目錄（新增設定時的預設來源，seed 已內建主流供應商）|
| 美術風格 / 角色選項 / 聲音庫 | 創作素材字典（前台可選項由此設定）|
| 定價 | 各 AI 環節點數單價（見上表）|
| 使用者管理 | 查詢使用者、**封鎖/解封**、**重設密碼**（忘記密碼的統一入口）、調整點數、**一鍵登入使用者前端**（login-as，代使用者排查問題）|
| 付款 | 微信儲值訂單查詢 / 對帳 |
| 展示審核 | 展示中心作品上/下架 |
| 任務管理 / 影片生成管理 | 非同步任務與影片生成佇列的重試/清理 |
| 維護 | 維護模式開關（503 + 預估恢復時間）、資料維護 |
| 登入日誌 | 全站登入紀錄（方式 / IP / UA）|

---

## 🔌 設定大模型 / 媒體（讓 AI 功能真正生效）

所有 AI 能力都**由設定驅動**，且 **統一在管理後台「模型設定」頁維護**（`.env` 不再提供任何預設 LLM 設定）。未設定時：文本類功能會在呼叫前提示；圖像/影片/TTS 會直接回報「未設定」。

設定步驟：

1. 登入管理後台 `/admin` → **模型設定** → 新增；
2. 選擇類型（文本 / 圖像 / 影片 / TTS）與協定，填寫：
   - **Base URL**（如 `https://api.openai.com/v1`）
   - **API Key**（僅存伺服器端，不下發前端）
   - **模型名稱**（如 `gpt-4o-mini`、`dall-e-3`）
   - 啟用狀態與該設定的點數定價；
3. 儲存後前台立即可用（同一類型可配多條並啟停切換）；「大模型設定」頁支援**匯入 / 匯出 JSON**，便於批次遷移。

支援的協定：

- **文本 / 圖像 / TTS**：OpenAI 相容（`/chat/completions`、`/images/generations`、`/audio/speech`）或自訂端點（`api_style=custom`）
- **影片**：設定非同步任務端點（提交→輪詢→影片 URL）；需真實影片生成 provider（本機 ffmpeg「圖生影片」已停用）

> 使用者側還可以在「個人設定 → 我的模型」新增**私有模型**（自帶 Key，呼叫不計點數），不影響全域設定。
> 需在本機安裝 `ffmpeg`（macOS：`brew install ffmpeg`）。影片片段串接合成依賴它。

---

## 🚢 正式環境部署

完整 runbook 見 **[deploy/DEPLOY.md](deploy/DEPLOY.md)**（nginx 上線 checklist、PM2/systemd 單一實例、備份還原、微信支付上線、合規待辦）。最低環境需求：

```bash
NODE_ENV=production            # 不設則 JWT 開發兜底金鑰生效，安全疑慮
JWT_SECRET=<本地工作階段權杖簽章金鑰，隨機長字串>      # 本系統自簽/校驗使用者工作階段（axt_）
ADMIN_JWT_SECRET=<管理台獨立簽章金鑰>
FILE_SIGN_SECRET=<媒體防盜連簽章金鑰>   # 須與 deploy/nginx.conf 中 secure_link 金鑰一致
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

微信支付另需 `WECHAT_PAY_*` 五件套（商戶號、AppID、APIv3 金鑰、憑證序號、商戶私鑰），見 `deploy/DEPLOY.md` ⑦。

---

## 🔑 登入與帳號系統（本地，無外部依賴）

帳號系統為**本系統內建**：註冊 / 登入 / 改密 / 工作階段更新全部走本伺服器端 `/api/auth/*`，不依賴任何第三方帳號中心：

- **註冊**：使用者名稱（2-64 位字母、數字、`_.-`）+ 密碼（≥6 位）+ 電子郵件（選填），需過點選文字驗證碼（後端 SVG 出題，`/api/captcha/*`）；註冊成功即登入，並贈送 66 點體驗點數；
- **登入**：使用者名稱 / 電子郵件 / 手機號碼任一 + 密碼；驗證碼「提供才校驗」（前端預設會帶上）；
- **權杖**：伺服器端自簽 JWT（`axt_` 前綴，access + refresh，refresh 不輪替），前端靜默續期走 `/api/auth/oauth/refresh`；管理台權杖獨立（`admt_` 前綴）；
- **忘記密碼**：自部署實例無簡訊/郵件通道，不提供自助重設——由管理員在 **管理後台「使用者管理」→ 重設密碼** 完成；
- **封鎖**：封鎖後該使用者所有已簽發權杖在下次請求即失效（伺服器端每請求重查使用者狀態）；
- **第三方登入（可選）**：行動 App 的 Apple / Google 一鍵登入仍可用——伺服器端持密代理兌換（`POST /api/auth/oauth/:provider`），換回同樣的本地 `axt_` 工作階段；Web 端無需任何回呼登記。

相關 `.env`：`JWT_SECRET`、`ADMIN_JWT_SECRET`、`CAPTCHA_TICKET_SECRET`、`ADMIN_INIT_USERNAME`、`ADMIN_INIT_PASSWORD`（均見 `server/.env.example` 註解）。

---

## 💚 微信支付（V3 · Native 掃碼 / JSAPI）

真實微信支付，**由設定驅動、預設關閉**（`.env` 中 `WECHAT_PAY_*` 留空即未啟用，前端自動隱藏儲值入口）。`WECHAT_APP_ID` 僅作為支付 AppID 的回退值保留。

在 [微信商戶平台](https://pay.weixin.qq.com/) 開通 Native/JSAPI 支付，取得商戶號、APIv3 金鑰，並下載商戶 API 憑證（`apiclient_key.pem` + 憑證序號）。**商戶號與 AppID 必須在商戶平台完成綁定**（否則下單回報 `APPID_MCHID_NOT_MATCH`）。設定：
```bash
WECHAT_PAY_METHOD=native       # native=掃碼 | jsapi=公眾號內支付（PC 走 H5 收銀台）
WECHAT_PAY_APP_ID=             # 與商戶號綁定的 AppID（留空則回退 WECHAT_APP_ID）
WECHAT_PAY_MCH_ID=<你的商戶號>
WECHAT_PAY_API_V3_KEY=         # 32 位 APIv3 金鑰
WECHAT_PAY_SERIAL_NO=          # 商戶 API 憑證序號
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # apiclient_key.pem 的磁碟路徑（與下一行二選一）
WECHAT_PAY_PRIVATE_KEY=        # 或直接內嵌 PEM 文字
WECHAT_PAY_NOTIFY_URL=         # 留空則取 ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- 流程：點數中心選「微信支付」→ 後端統一下單（Native 回傳 `code_url` 渲染 QR Code / JSAPI 拉起支付）→ 使用者付款 → 微信非同步回呼 `/api/recharge/wechat/notify`（AES-256-GCM 解密驗證、冪等入帳）。
- 回呼必須為**公開可連線的 HTTPS 網址**（開發期可用內網穿透）。

> 上線步驟（商戶平台綁 AppID、憑證放伺服器本機、一毛錢真實訂單回歸）見 **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ 微信支付上線步驟**。
> 資料庫：支付訂單流水號寫入 `recharge_orders.transaction_id`，由啟動時的 `ensureColumns` 冪等補齊，不影響舊庫。

---

## 🧪 端對端驗證步驟

0. 管理後台 `/admin`（admin/admin123）→ **模型設定** → 配好文本/圖像/影片/TTS 四類（否則 AI 環節不可用）
1. 前台註冊/登入 → 新增專案 → 「劇本大綱」貼上/上傳劇本 → **AI 拆分劇本**（扣點數）
2. 「資產庫」→ **AI 擷取資產** → 對角色/場景**產生資產圖**
3. 「分集影片」→ **產生腳本** → 進入**分鏡編輯器**
4. 編輯器內選取片段 → **立即生成**（影片片段，並自動擷取首影格作為預覽封面）
5. **合成整集**（ffmpeg 串接出整集 mp4）
6. 在「點數中心」檢視流水、儲值；在管理台改定價 / 封鎖 / 重設密碼 / 看登入日誌；切換淺色/深色/自動主題

---

## 📡 主要 API（`/api` 前綴，JWT 驗證，統一 `{code,message,data}`）

```
POST /auth/register | /auth/login                              # 本地註冊（需驗證碼 ticket）/ 登入（公開，限頻）
POST /auth/password                                            # 修改密碼（登入狀態）
POST /auth/oauth/refresh                                       # 靜默續期（refresh_token 換發新 access_token，公開）
POST /auth/oauth/:provider                                     # 第三方登入兌換本地工作階段（apple/google/weixin/huawei，可選）
GET /auth/me   POST /auth/sync                                 # 使用者資料
POST /captcha/challenge | /captcha/verify                      # 點選文字驗證碼
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # 非同步任務中心（前端輪詢）
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # 全域設定讀取側 + 匯入匯出（管理台維護）
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # 微信支付回呼（無需驗證，驗簽+冪等）
GET /showcase/*                                                # 展示中心（發布/瀏覽/做同款）
GET /market/*                                                  # 接案中心（任務單/託管/驗收）
GET /pricing
```
每個 AI 介面都有對應的 `…/estimate` 介面用於預估點數；管理介面（`/admin/*`：使用者/付款/任務/日誌/維護等）走獨立管理台權杖（`admt_`）。

---

## 🛠 技術棧

**伺服器端**：Express · Sequelize（mysql/sqlite 雙 dialect）· JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web 端**：Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios（桌面殼：Electron + electron-updater）
**行動端**：uni-app（App / 小程式殼 / H5）

## 📝 說明

- 本專案交付「功能端到端可用」基座：所有 API 與頁面均真實運作、可執行；UI 依參考圖還原結構與狀態。
- 外部 provider（圖像/影片/TTS）需在**管理後台**設定真實 key 後端到端出真實素材；ffmpeg 僅用於影片片段串接合成。
- 修改 Sequelize 模型後，SQLite 下請刪除 `server/data/*.db` 重新初始化（正式環境建議用遷移）。

---

## 📄 開源授權條款

本專案基於 [AGPL-3.0](LICENSE) 開源。

- ✅ **個人學習、研究、非商業使用**：免費，且修改後對外提供網路服務需遵守 AGPL-3.0 開源義務
- 💼 **商業部署 / SaaS 服務 / 私有化交付**：需購買商業授權（可豁免 AGPL-3.0 開源義務），商業授權請聯絡：<kevin@xw.com>

---

## 📮 聯絡我們

- 📧 電子郵件：<kevin@xw.com>
- 🌐 線上展示：<https://aiwork.xw.com>
- 💬 微信交流群「星网AI剧场开源交流」（繁體：星網AI劇場開源交流）：

  ![星网AI剧场开源交流微信群 QR Code](docs/wechat-group-qr.jpg)
