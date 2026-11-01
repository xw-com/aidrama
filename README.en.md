**🌐 Language**: [简体中文](README.md) | **English** | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI Short Drama Production Platform

> 🌐 **Live demo**: <https://aiwork.xw.com> 　·　📮 Contact us: **kevin@xw.com**

A complete AI short drama creation system: **import script → extract characters/scenes/props → generate storyboards → generate storyboard videos → compose the full episode**.
The server runs on **Node.js + MySQL (with SQLite fallback)**, and the frontend ships as two **Vue 3 + Element Plus** clients: **Web (client, including the admin dashboard client/admin and the desktop shell client/desktop) + mobile (uniapp, App/mini-program shell/H5)**, communicating over a REST API. Accounts are handled by **built-in local sign-up/login** (username/email/phone number + password), with no dependency on any third-party account service.

---

## 🌐 Online Demo & Community

- **Demo URL**: <https://aiwork.xw.com>
- **User manual**: [PC](docs/pc-user-manual.md) · [Mobile](docs/mobile-user-manual.md)
- **Issues / partnership**: <kevin@xw.com>

---

## ✨ Features

| Module | Description |
|---|---|
| 👤 User system | **Local sign-up / login** (username/email/phone number + password, with a click-based text CAPTCHA required at sign-up) + **team-shared projects** (invites/permissions) |
| 📖 Script outline | Paste or upload a `.txt` file to import a script, **AI splits it into episodes**, editable episode by episode |
| 🎭 Asset library | **AI extracts characters / scenes / props**; generate asset images one by one or in batch |
| 🎬 Episode videos | **AI generates storyboard scripts** (segment script + narration + voice config + duration) |
| ✂️ Storyboard editor | Assets on the left, storyboard script in the middle, video preview on the right, episode timeline at the bottom |
| 🎞️ Video generation | For each segment: (optional TTS) → video clip; after generation the first frame is extracted automatically as the preview cover |
| 🧩 Compose full episode | ffmpeg concatenates the selected segments into a complete episode mp4 |
| 🔧 Model configuration | **Configured entirely in the admin dashboard** (four types: text/image/video/voice; enable/disable / import / export) |
| 💰 Credit billing | Every step that calls an LLM/media model has a price; **credits are deducted per use** |
| 💳 Top-up | Preset packages + **WeChat Pay (V3 · Native QR / JSAPI)**, credits deducted per use |
| 🎨 Theme | Light / dark / auto (follows system) |

### Pricing (editable, defaults shown)
| Feature | Unit | Credits |
|---|---|---|
| Script splitting | per 1,000 characters | 10 |
| Asset extraction | per episode | 20 |
| Asset image generation | per image | 5 |
| **Storyboard script generation** | **per 100 characters** | **2** |
| **Storyboard video generation** | **per second** | **11** |
| Narration voiceover (TTS) | per 100 characters | 3 |
| Video composition | per episode | 30 |

---

## 📂 Directory Structure

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize server
│  ├─ src/
│  │  ├─ db/models/        # Database table models + associations
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST routes (projects/assets/storyboard/video/credits/recharge/showcase/orders/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Pricing + default model provider catalog + initial admin
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus web client
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Admin dashboard (separate entry /admin, separate login and token)
│  ├─ admin.html           # Admin dashboard entry HTML
│  └─ desktop/             # Electron desktop shell (Windows/macOS, see client/desktop/README.md)
├─ uniapp/            # Mobile (uni-app: App / mini-program shell / H5)
└─ deploy/            # Production deployment: nginx.conf / PM2 / systemd / backup / DEPLOY.md runbook
```

---

## 🚀 Quick Start

### 1. Start the server

```bash
cd server
cp .env.example .env          # DB_DIALECT=sqlite by default — runs with zero configuration
npm install
npm run dev                   # http://localhost:3000 — automatically creates tables + seeds
```

- **SQLite (works out of the box, recommended for trying it locally)**: `DB_DIALECT=sqlite`, data stored in `server/data/aidrama.db`
- **MySQL**: set `DB_DIALECT=mysql` and fill in `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **The initial admin account is created automatically on first run** (a note is printed to the console):
  - Default account **`admin / admin123`**, used to log into the admin dashboard at `/admin`
  - Override with the environment variables `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; skipped automatically if an admin already exists
  - ⚠️ Change the default password immediately before going live (`node scripts/setAdminPassword.js`, or see the admin dashboard section below)

### 2. Start the client

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Open <http://localhost:5173>: if you don't have an account, click "Sign up" (username + password, plus a click-based CAPTCHA; signing up logs you in right away and grants 66 trial credits); if you already have an account, just log in (username / email / phone number all work).

> The client ships with a proxy configured: `/api` and `/files` are forwarded automatically to `http://localhost:3000`.

---

## 🛠 Using the Admin Dashboard (client/admin)

The admin dashboard has a **separate entry point, separate login, and separate token** (a JWT with the `admt_` prefix, fully isolated from front-end user sessions):

- **Entry**: <http://localhost:5173/admin> (in production: `https://your-domain.com/admin`)
- **Login**: account + password + click-based text CAPTCHA. On first run, use the initial admin **`admin / admin123`**;
- **Password change**: the dashboard has no change-password page yet; reset it with the server-side script:
  ```bash
  cd server
  node scripts/setAdminPassword.js <username or email> <new password>
  ```
  (`adminAuth` login accepts a username / email / phone number as the account)

### Feature Modules

| Module | Purpose |
|---|---|
| **Model configuration** | **LLM integration for four types: text / image / video / TTS** (see the next section; must be configured before going live) |
| Model providers | Provider and model catalog (the preset source when adding a configuration; mainstream providers are seeded) |
| Art styles / character options / voice library | Creative asset dictionaries (the options offered in the front end are configured here) |
| Pricing | Credit unit price for each AI step (see the table above) |
| User management | Look up users, **ban/unban**, **reset passwords** (the unified entry point for forgotten passwords), adjust credits, **one-click login to the user front end** (login-as, for troubleshooting on a user's behalf) |
| Payments | WeChat top-up order lookup / reconciliation |
| Showcase moderation | Publish / unpublish works in the Showcase Center |
| Task management / video generation management | Retry/cleanup for async tasks and the video generation queue |
| Maintenance | Maintenance mode toggle (503 + estimated recovery time), data maintenance |
| Login logs | Site-wide login records (method / IP / UA) |

---

## 🔌 Configuring LLM / Media Models (Making the AI Features Actually Work)

All AI capabilities are **configuration-driven**, and **everything is maintained centrally on the "Model Configuration" page of the admin dashboard** (`.env` no longer provides any default LLM configuration). When nothing is configured: text features show a prompt before being called; image/video/TTS return a "not configured" error right away.

Configuration steps:

1. Log into the admin dashboard at `/admin` → **Model Configuration** → Add new;
2. Choose the type (text / image / video / TTS) and protocol, then fill in:
   - **Base URL** (e.g. `https://api.openai.com/v1`)
   - **API Key** (stored server-side only, never sent down to the frontend)
   - **Model name** (e.g. `gpt-4o-mini`, `dall-e-3`)
   - Enabled state and the credit price for that configuration;
3. Once saved, it is available in the front end immediately (multiple entries per type are allowed and can be toggled on/off); the "Model Configuration" page supports **importing / exporting JSON** for bulk migration.

Supported protocols:

- **Text / image / TTS**: OpenAI-compatible (`/chat/completions`, `/images/generations`, `/audio/speech`) or custom endpoints (`api_style=custom`)
- **Video**: configure an async task endpoint (submit → poll → video URL); requires a real video generation provider (the local ffmpeg "image-to-video" option has been discontinued)

> Users can also add **private models** under "Personal settings → My models" (bring your own key; calls don't cost credits), without affecting the global configuration.
> ffmpeg must be installed locally (macOS: `brew install ffmpeg`). Concatenating video segments into a composition depends on it.

---

## 🚢 Production Deployment

The full runbook is in **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (nginx go-live checklist, PM2/systemd single instance, backup & restore, WeChat Pay go-live, compliance to-dos). Minimum environment requirements:

```bash
NODE_ENV=production            # If unset, the JWT development fallback secret takes effect — a security risk
JWT_SECRET=<long random string used to sign local session tokens>      # This system signs/verifies user sessions itself (axt_)
ADMIN_JWT_SECRET=<separate signing secret for the admin dashboard>
FILE_SIGN_SECRET=<anti-hotlink signing secret for media>   # Must match the secure_link secret in deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay additionally requires the five `WECHAT_PAY_*` settings (merchant ID, AppID, APIv3 key, certificate serial number, merchant private key) — see `deploy/DEPLOY.md` ⑦.

---

## 🔑 Login & Account System (Local, No External Dependencies)

The account system is **built into this system**: registration / login / password change / session refresh all go through this server's `/api/auth/*`, with no dependency on any third-party account service:

- **Sign-up**: username (2–64 characters: letters, digits, `_.-`) + password (≥6 characters) + email (optional), and a click-based text CAPTCHA must be passed (challenges served as SVG by the backend, `/api/captcha/*`); a successful sign-up logs you in and grants 66 trial credits;
- **Login**: username / email / phone number (any one) + password; the CAPTCHA is "verified only when provided" (the frontend sends it by default);
- **Tokens**: JWTs signed by this server (`axt_` prefix, access + refresh, refresh tokens do not rotate); the frontend renews silently via `/api/auth/oauth/refresh`; admin tokens are separate (`admt_` prefix);
- **Forgot password**: self-hosted instances have no SMS/email channel and offer no self-service reset — it is done by an admin under **Admin dashboard → User Management → Reset password**;
- **Banning**: once banned, all tokens already issued to that user become invalid on the next request (the server re-checks user status on every request);
- **Third-party login (optional)**: Apple / Google one-tap login still works in the mobile App — the server exchanges it for a local session using its own credentials (`POST /api/auth/oauth/:provider`), returning the same local `axt_` session; the Web client needs no callback registration at all.

Related `.env`: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (see the comments in `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native QR / JSAPI)

Real WeChat Pay, **configuration-driven and disabled by default** (leave `WECHAT_PAY_*` empty in `.env` and it stays disabled; the frontend automatically hides the top-up entry). `WECHAT_APP_ID` is kept only as a fallback value for the payment AppID.

Enable Native/JSAPI payments on the [WeChat Pay Merchant Platform](https://pay.weixin.qq.com/), obtain your merchant ID and APIv3 key, and download the merchant API certificate (`apiclient_key.pem` + certificate serial number). **The merchant ID and AppID must be bound to each other in the merchant platform** (otherwise placing orders fails with `APPID_MCHID_NOT_MATCH`). Configuration:
```bash
WECHAT_PAY_METHOD=native       # native=QR code | jsapi=payment inside WeChat (PC goes through the H5 cashier)
WECHAT_PAY_APP_ID=             # AppID bound to the merchant ID (falls back to WECHAT_APP_ID if left empty)
WECHAT_PAY_MCH_ID=<your merchant ID>
WECHAT_PAY_API_V3_KEY=         # 32-character APIv3 key
WECHAT_PAY_SERIAL_NO=          # Merchant API certificate serial number
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # On-disk path to apiclient_key.pem (alternative to the line below)
WECHAT_PAY_PRIVATE_KEY=        # Or inline the PEM text directly
WECHAT_PAY_NOTIFY_URL=         # Defaults to ${PUBLIC_BASE_URL}/api/recharge/wechat/notify when empty
```
- Flow: pick "WeChat Pay" in the Credit Center → backend places a unified order (Native returns `code_url` rendered as a QR code / JSAPI invokes the payment) → user pays → WeChat calls back `/api/recharge/wechat/notify` asynchronously (AES-256-GCM decryption and verification, idempotent crediting).
- The callback must be a **publicly reachable HTTPS URL** (a tunnel can be used during development).

> Go-live steps (binding the AppID in the merchant platform, placing the certificate on the server, regressing against a one-cent real order) are in **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ WeChat Pay go-live steps**.
> Database: the payment order transaction ID is written to `recharge_orders.transaction_id`, added idempotently by `ensureColumns` at startup, so existing databases are unaffected.

---

## 🧪 End-to-End Verification Steps

0. Admin dashboard `/admin` (admin/admin123) → **Model Configuration** → configure all four types: text/image/video/TTS (otherwise the AI steps are unavailable)
1. Sign up / log in on the front end → create a project → paste/upload a script under "Script Outline" → **AI script splitting** (costs credits)
2. "Asset library" → **AI asset extraction** → **generate asset images** for characters/scenes
3. "Episode videos" → **generate script** → enter the **storyboard editor**
4. Select a segment in the editor → **Generate now** (video clip, with the first frame extracted automatically as the preview cover)
5. **Compose full episode** (ffmpeg concatenates the complete episode mp4)
6. Check your transaction history and top up in the "Credit Center"; change pricing / ban users / reset passwords / view login logs in the admin dashboard; switch between light/dark/auto themes

---

## 📡 Main APIs (`/api` prefix, JWT auth, uniform `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Local sign-up (requires CAPTCHA ticket) / login (public, rate-limited)
POST /auth/password                                            # Change password (authenticated)
POST /auth/oauth/refresh                                       # Silent renewal (refresh_token exchanged for a new access_token, public)
POST /auth/oauth/:provider                                     # Third-party login exchanged for a local session (apple/google/weixin/huawei, optional)
GET /auth/me   POST /auth/sync                                 # User profile
POST /captcha/challenge | /captcha/verify                      # Click-based text CAPTCHA
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Async task center (frontend polls)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Read side of global config + import/export (maintained in the admin dashboard)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # WeChat Pay callback (no auth required, signature-verified + idempotent)
GET /showcase/*                                                # Showcase Center (publish / browse / make-your-own)
GET /market/*                                                  # Order-taking Center (task orders / escrow / acceptance)
GET /pricing
```
Every AI endpoint has a matching `…/estimate` endpoint for estimating credits; admin endpoints (`/admin/*`: users/payments/tasks/logs/maintenance, etc.) use the separate admin dashboard token (`admt_`).

---

## 🛠 Tech Stack

**Server**: Express · Sequelize (dual dialect: mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (desktop shell: Electron + electron-updater)
**Mobile**: uni-app (App / mini-program shell / H5)

## 📝 Notes

- This project delivers an "end-to-end functional" foundation: all APIs and pages genuinely work and run; the UI replicates the structure and states of the reference designs.
- External providers (image/video/TTS) require real keys configured in the **admin dashboard** before real assets can be produced end to end; ffmpeg is used only for concatenating/composing video segments.
- After modifying Sequelize models under SQLite, delete `server/data/*.db` and reinitialize (migrations are recommended in production).

---

## 📄 License

This project is open sourced under [AGPL-3.0](LICENSE).

- ✅ **Personal study, research, and non-commercial use**: free; if you offer it as a network service after modification, you must comply with the AGPL-3.0 open-source obligations
- 💼 **Commercial deployment / SaaS / on-premise delivery**: a commercial license is required (which waives the AGPL-3.0 open-source obligations). For commercial licensing, contact: <kevin@xw.com>

---

## 📮 Contact Us

- 📧 Email: <kevin@xw.com>
- 🌐 Online demo: <https://aiwork.xw.com>
- 💬 WeChat group "星网AI剧场开源交流" (XW AI Drama Open-Source Community):

  ![XW AI Drama open-source community WeChat group QR code](docs/wechat-group-qr.jpg)
