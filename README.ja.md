**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | **日本語** | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI ショートドラマ制作プラットフォーム

> 🌐 **オンラインデモ**：<https://aiwork.xw.com> 　·　📮 お問い合わせ：**kevin@xw.com**

AI ショートドラマ制作システム一式：**台本インポート → キャラクター/シーン/小道具の抽出 → 絵コン生成 → 絵コン動画の生成 → 全話の合成**。
サーバーは **Node.js + MySQL（/ SQLite フォールバック）**、フロントエンドは **Vue 3 + Element Plus** による 2 クライアント構成：**Web（client、管理画面 client/admin とデスクトップシェル client/desktop を含む）+ モバイル（uniapp、App/ミニプログラムシェル/H5）**、REST API で通信します。アカウント基盤は**内蔵のローカル登録/ログイン**（ユーザー名/メールアドレス/電話番号 + パスワード）で、サードパーティのアカウントセンターには依存しません。

---

## 🌐 オンラインデモ & コミュニティ

- **デモ URL**：<https://aiwork.xw.com>
- **ユーザーマニュアル**：[PC 版](docs/pc-user-manual.md)　·　[モバイル版](docs/mobile-user-manual.md)
- **不具合報告 / 提携**：<kevin@xw.com>

---

## ✨ 機能

| モジュール | 説明 |
|---|---|
| 👤 ユーザーシステム | **ローカル登録 / ログイン**（ユーザー名/メールアドレス/電話番号 + パスワード、登録時はクリック式文字認証キャプチャが必須）+ **チーム共有プロジェクト**（招待/権限）|
| 📖 台本アウトライン | 貼り付けまたは `.txt` アップロードで台本をインポートし、**AI が複数話に分割**。話ごとに編集可能 |
| 🎭 アセットライブラリ | **AI がキャラクター / シーン / 小道具を抽出**し、アセット画像を 1 件ずつまたは一括生成 |
| 🎬 各話動画 | **AI が絵コンスクリプトを生成**（セグメントスクリプト + ナレーション + 音声設定 + 長さ）|
| ✂️ 絵コンエディター | 左にアセット、中央に絵コンスクリプト、右に動画プレビュー、下部にセグメントタイムライン |
| 🎞️ 動画生成 | 各セグメント：（TTS は任意）→ 動画クリップ。生成後、最初のフレームを自動抽出してプレビュー用サムネイルに |
| 🧩 全話の合成 | ffmpeg で選択したセグメントを連結し、1 話まるごとの mp4 を出力 |
| 🔧 モデル設定 | **すべて管理画面で設定**（テキスト/画像/動画/音声の 4 種類。有効化・無効化 / インポート / エクスポート可）|
| 💰 クレジット課金 | 大規模モデル/メディアを呼び出す各ステップに価格設定があり、**従量制でクレジットを差し引きます** |
| 💳 チャージ | 事前定義プラン + **WeChat Pay（V3 · Native QR スキャン / JSAPI）**、従量制でクレジットを差し引き |
| 🎨 テーマ | ライト / ダーク / システムに自動追従 |

### 価格設定（編集可能、デフォルト値）
| 機能 | 単位 | クレジット |
|---|---|---|
| 台本分割 | 1,000 文字あたり | 10 |
| アセット抽出 | 各話あたり | 20 |
| アセット画像生成 | 1 枚あたり | 5 |
| **絵コンスクリプト生成** | **100 文字あたり** | **2** |
| **絵コン動画生成** | **1 秒あたり** | **11** |
| ナレーション音声(TTS) | 100 文字あたり | 3 |
| 動画合成 | 各話あたり | 30 |

---

## 📂 ディレクトリ構成

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize サーバー
│  ├─ src/
│  │  ├─ db/models/        # DB テーブルモデル + リレーション
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST ルート（プロジェクト/アセット/絵コン/動画/クレジット/チャージ/ショーケース/受注/admin…）
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # 価格設定 + デフォルトモデルベンダーカタログ + 初期管理者
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus Web 版
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # 管理画面（独立エントリ /admin、独立ログインとトークン）
│  ├─ admin.html           # 管理画面エントリ HTML
│  └─ desktop/             # Electron デスクトップシェル（Windows/macOS、詳細は client/desktop/README.md）
├─ uniapp/            # モバイル（uni-app：App / ミニプログラムシェル / H5）
└─ deploy/            # 本番デプロイ：nginx.conf / PM2 / systemd / backup / DEPLOY.md runbook
```

---

## 🚀 クイックスタート

### 1. サーバーを起動

```bash
cd server
cp .env.example .env          # デフォルトは DB_DIALECT=sqlite、設定不要でそのまま実行可能
npm install
npm run dev                   # http://localhost:3000 、テーブル自動作成 + seed
```

- **SQLite（そのまま動く、ローカル試用に推奨）**：`DB_DIALECT=sqlite`、データは `server/data/aidrama.db` に保存
- **MySQL**：`DB_DIALECT=mysql` を設定し、`DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` を記入
- **初回実行時に初期管理者を自動作成**（コンソールに通知が出力されます）：
  - デフォルトアカウント **`admin / admin123`**、管理画面 `/admin` のログイン用
  - 環境変数 `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` で上書き可能。既に管理者がいる場合は自動スキップ
  - ⚠️ 本番公開前に必ずデフォルトパスワードを変更してください（`node scripts/setAdminPassword.js`、または下記の管理画面の節を参照）

### 2. クライアントを起動

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

<http://localhost:5173> を開く：アカウントがなければ「登録」をクリック（ユーザー名 + パスワード、クリック式キャプチャを経由。登録が成功するとそのままログインし、お試しクレジット 66 を進呈）。既にある場合はそのままログイン（ユーザー名 / メールアドレス / 電話番号のいずれでも可）。

> クライアントにはプロキシが設定済みで、`/api` と `/files` は自動的に `http://localhost:3000` へ転送されます。

---

## 🛠 管理画面（client/admin）の使い方

管理画面は**独立エントリ・独立ログイン・独立トークン**（`admt_` プレフィックスの JWT。フロント側のユーザーセッションとは完全に分離）：

- **エントリ**：<http://localhost:5173/admin>（本番環境では `https://あなたのドメイン/admin`）
- **ログイン**：アカウント + パスワード + クリック式文字認証キャプチャ。初回実行時は初期管理者 **`admin / admin123`** を使用；
- **パスワード変更**：管理画面にはまだ変更ページがないため、サーバー側スクリプトでリセット：
  ```bash
  cd server
  node scripts/setAdminPassword.js <ユーザー名またはメールアドレス> <新しいパスワード>
  ```
  （`adminAuth` のログインはユーザー名 / メールアドレス / 電話番号のいずれかをアカウントとして利用可能）

### 機能モジュール

| モジュール | 用途 |
|---|---|
| **モデル設定** | **テキスト / 画像 / 動画 / TTS の 4 種類の LLM 連携**（次節参照。本番公開前に必須）|
| モデルベンダー | ベンダーとモデルのカタログ（新規設定時のプリセットソース。seed に主要ベンダーを内蔵）|
| アートスタイル / キャラクターオプション / ボイスライブラリ | 創作素材の辞書（フロントの選択肢はここで設定）|
| 価格設定 | 各 AI ステップのクレジット単価（上表参照）|
| ユーザー管理 | ユーザー検索、**BAN/解除**、**パスワードリセット**（パスワード忘れの統一窓口）、クレジット調整、**ワンクリックでユーザーフロントへログイン**（login-as。ユーザーに代わって調査）|
| 決済 | WeChat チャージ注文の照会 / 突合 |
| ショーケース審査 | ショーケース作品の公開/非公開 |
| タスク管理 / 動画生成管理 | 非同期タスクと動画生成キューの再試行/クリーンアップ |
| メンテナンス | メンテナンスモード切替（503 + 復帰見込み時刻）、データメンテナンス |
| ログインログ | サイト全体のログイン記録（方式 / IP / UA）|

---

## 🔌 大規模モデル / メディアの設定（AI 機能を実際に動かす）

すべての AI 機能は**設定駆動**で、**管理画面の「モデル設定」ページで一元管理**されます（`.env` はデフォルトの LLM 設定を提供しません）。未設定の場合：テキスト系機能は呼び出し前に通知を表示し、画像/動画/TTS は「未設定」エラーを即座に返します。

設定手順：

1. 管理画面 `/admin` にログイン → **モデル設定** → 新規追加；
2. 種類（テキスト / 画像 / 動画 / TTS）とプロトコルを選び、以下を入力：
   - **Base URL**（例：`https://api.openai.com/v1`）
   - **API Key**（サーバー側にのみ保存し、フロントエンドには送信しない）
   - **モデル名**（例：`gpt-4o-mini`、`dall-e-3`）
   - 有効状態とその設定のクレジット単価；
3. 保存後すぐにフロントで利用可能（同一種類で複数設定でき、有効/無効を切り替え可能）。「モデル設定」ページは **JSON のインポート / エクスポート**に対応し、一括移行に便利です。

対応プロトコル：

- **テキスト / 画像 / TTS**：OpenAI 互換（`/chat/completions`、`/images/generations`、`/audio/speech`）またはカスタムエンドポイント（`api_style=custom`）
- **動画**：非同期タスクのエンドポイントを設定（投入→ポーリング→動画 URL）。実際の動画生成 provider が必要（ローカル ffmpeg の「画像から動画」機能は廃止済み）

> ユーザー側でも「個人設定 → マイモデル」から**プライベートモデル**を追加できます（Key 持ち込み、呼び出しにクレジットは消費されません）。グローバル設定には影響しません。
> ffmpeg をローカルにインストールする必要があります（macOS：`brew install ffmpeg`）。動画セグメントの連結・合成はこれに依存します。

---

## 🚢 本番デプロイ

完全な runbook は **[deploy/DEPLOY.md](deploy/DEPLOY.md)** を参照（nginx 公開チェックリスト、PM2/systemd 単一インスタンス、バックアップとリストア、WeChat Pay 本番導入、コンプライアンス対応事項）。最低環境要件：

```bash
NODE_ENV=production            # 未設定の場合は JWT 開発用フォールバック鍵が有効になり、セキュリティリスク
JWT_SECRET=<ローカルセッショントークン署名用のランダムな長い文字列>      # 本システムがユーザーセッションを自己署名/検証（axt_）
ADMIN_JWT_SECRET=<管理画面用の独立署名鍵>
FILE_SIGN_SECRET=<メディアのホットリンク防止署名鍵>   # deploy/nginx.conf の secure_link 鍵と一致させる必要あり
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay には追加で `WECHAT_PAY_*` の 5 項目（マーチャント ID、AppID、APIv3 キー、証明書シリアル番号、マーチャント秘密鍵）が必要です。`deploy/DEPLOY.md` ⑦ を参照。

---

## 🔑 ログインとアカウント基盤（ローカル完結、外部依存なし）

アカウント基盤は**本システム内蔵**：登録 / ログイン / パスワード変更 / セッション更新はすべて本サーバーの `/api/auth/*` で処理され、サードパーティのアカウントセンターには依存しません：

- **登録**：ユーザー名（2-64 文字の英数字と `_.-`）+ パスワード（6 文字以上）+ メールアドレス（任意）。クリック式文字認証キャプチャが必要（バックエンドが SVG で出題、`/api/captcha/*`）。登録に成功するとそのままログインし、お試しクレジット 66 を進呈；
- **ログイン**：ユーザー名 / メールアドレス / 電話番号のいずれか + パスワード。キャプチャは「提供された場合のみ検証」（フロントはデフォルトで送信）；
- **トークン**：サーバー自己署名 JWT（`axt_` プレフィックス、access + refresh、refresh はローテーションせず）。フロントは `/api/auth/oauth/refresh` でサイレント更新。管理画面のトークンは独立（`admt_` プレフィックス）；
- **パスワードを忘れた場合**：自己ホスト環境には SMS/メール経路がないためセルフサービスリセットは提供されません。管理者が **管理画面「ユーザー管理」→ パスワードリセット** で対応；
- **BAN**：BAN 後はそのユーザーの発行済みトークンがすべて次のリクエストで無効化されます（サーバーはリクエストごとにユーザー状態を再確認）；
- **サードパーティログイン（任意）**：モバイル App の Apple / Google ワンタップログインは引き続き利用可能です。サーバーが秘密鍵を持って代理交換し（`POST /api/auth/oauth/:provider`）、同じローカル `axt_` セッションを返します。Web 版はコールバック登録が一切不要です。

関連する `.env`：`JWT_SECRET`、`ADMIN_JWT_SECRET`、`CAPTCHA_TICKET_SECRET`、`ADMIN_INIT_USERNAME`、`ADMIN_INIT_PASSWORD`（いずれも `server/.env.example` のコメントを参照）。

---

## 💚 WeChat Pay（V3 · Native QR スキャン / JSAPI）

実際の WeChat Pay。**設定駆動・デフォルト無効**（`.env` の `WECHAT_PAY_*` を空のままにすれば無効のまま、フロントはチャージ入口を自動的に非表示にします）。`WECHAT_APP_ID` は決済 AppID のフォールバック値としてのみ保持されます。

[WeChat Pay マーチャントプラットフォーム](https://pay.weixin.qq.com/) で Native/JSAPI 決済を有効化し、マーチャント ID と APIv3 キーを取得、マーチャント API 証明書（`apiclient_key.pem` + 証明書シリアル番号）をダウンロードしてください。**マーチャント ID と AppID はマーチャントプラットフォームで紐付けを完了させる必要があります**（未紐付けでは発注時に `APPID_MCHID_NOT_MATCH` となります）。設定：
```bash
WECHAT_PAY_METHOD=native       # native=QR スキャン | jsapi=公式アカウント内決済（PC は H5 キャッシャー経由）
WECHAT_PAY_APP_ID=             # マーチャント ID に紐付いた AppID（空の場合は WECHAT_APP_ID にフォールバック）
WECHAT_PAY_MCH_ID=<あなたのマーチャント ID>
WECHAT_PAY_API_V3_KEY=         # 32 文字の APIv3 キー
WECHAT_PAY_SERIAL_NO=          # マーチャント API 証明書シリアル番号
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # apiclient_key.pem のディスク上パス（次の行とどちらか一方）
WECHAT_PAY_PRIVATE_KEY=        # または PEM テキストを直接インライン指定
WECHAT_PAY_NOTIFY_URL=         # 空の場合は ${PUBLIC_BASE_URL}/api/recharge/wechat/notify を使用
```
- 流れ：クレジットセンターで「WeChat Pay」を選択 → バックエンドが統一発注（Native は `code_url` を返し QR コードを描画 / JSAPI は決済を起動）→ ユーザーが支払い → WeChat が `/api/recharge/wechat/notify` に非同期コールバック（AES-256-GCM 復号検証、冪等な計上）。
- コールバックは**公開アクセス可能な HTTPS URL** である必要があります（開発中はトンネル也可）。

> 公開手順（マーチャントプラットフォームでの AppID 紐付け、証明書のサーバー配置、1 銭の実注文でのリグレッション）は **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ WeChat Pay 公開手順** を参照。
> データベース：決済注文のトランザクション番号は `recharge_orders.transaction_id` に書き込まれ、起動時の `ensureColumns` により冪等に追加されるため、既存 DB には影響しません。

---

## 🧪 エンドツーエンド検証手順

0. 管理画面 `/admin`（admin/admin123）→ **モデル設定** → テキスト/画像/動画/TTS の 4 種類を設定（未設定だと AI ステップは利用不可）
1. フロントで登録/ログイン → プロジェクトを新規作成 → 「台本アウトライン」で台本を貼付/アップロード → **AI 台本分割**（クレジット消費）
2. 「アセットライブラリ」→ **AI アセット抽出** → キャラクター/シーンの**アセット画像を生成**
3. 「各話動画」→ **スクリプト生成** → **絵コンエディター**へ
4. エディターでセグメントを選択 → **今すぐ生成**（動画クリップ。最初のフレームを自動抽出してプレビュー用サムネイルに）
5. **全話を合成**（ffmpeg で 1 話まるごとの mp4 を連結出力）
6. 「クレジットセンター」で利用履歴の確認とチャージ。管理画面で価格変更 / BAN / パスワードリセット / ログインログ閲覧。ライト/ダーク/自動テーマの切替

---

## 📡 主な API（`/api` プレフィックス、JWT 認証、統一形式 `{code,message,data}`）

```
POST /auth/register | /auth/login                              # ローカル登録（キャプチャ ticket 必須）/ ログイン（公開、レート制限）
POST /auth/password                                            # パスワード変更（ログイン状態）
POST /auth/oauth/refresh                                       # サイレント更新（refresh_token から新 access_token へ、公開）
POST /auth/oauth/:provider                                     # サードパーティログインからローカルセッションへ交換（apple/google/weixin/huawei、任意）
GET /auth/me   POST /auth/sync                                 # ユーザープロフィール
POST /captcha/challenge | /captcha/verify                      # クリック式文字認証キャプチャ
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # 非同期タスクセンター（フロントがポーリング）
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # グローバル設定の読み取り側 + インポート/エクスポート（管理画面で管理）
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # WeChat Pay コールバック（認証不要、署名検証+冪等）
GET /showcase/*                                                # ショーケースセンター（公開/閲覧/似た作品を作成）
GET /market/*                                                  # 受注センター（タスクチケット/エスクロー/検収）
GET /pricing
```
各 AI エンドポイントにはクレジットを見積もる対応する `…/estimate` エンドポイントがあります。管理系エンドポイント（`/admin/*`：ユーザー/決済/タスク/ログ/メンテナンスなど）は独立した管理画面トークン（`admt_`）を使用します。

---

## 🛠 技術スタック

**サーバー**：Express · Sequelize（mysql/sqlite の 2 dialect）· JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web 版**：Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios（デスクトップシェル：Electron + electron-updater）
**モバイル**：uni-app（App / ミニプログラムシェル / H5）

## 📝 補足説明

- 本プロジェクトが提供するのは「機能がエンドツーエンドで動作する」基盤です。すべての API とページが実際に動作・実行可能で、UI はリファレンス画像の構造と状態を再現しています。
- 外部 provider（画像/動画/TTS）は管理画面で実際の key を設定して初めて、エンドツーエンドで実素材を生成できます。ffmpeg は動画セグメントの連結合成にのみ使用します。
- Sequelize モデル変更後、SQLite の場合は `server/data/*.db` を削除して再初期化してください（本番ではマイグレーションを推奨）。

---

## 📄 ライセンス

本プロジェクトは [AGPL-3.0](LICENSE) でオープンソースとして公開しています。

- ✅ **個人の学習・研究・非商用利用**：無料。改変後にネットワークサービスとして提供する場合は AGPL-3.0 のオープンソース義務に従う必要があります
- 💼 **商用デプロイ / SaaS 提供 / オンプレミス納品**：商用ライセンスの購入が必要です（AGPL-3.0 のオープンソース義務を免除できます）。商用ライセンスの連絡先：<kevin@xw.com>

---

## 📮 お問い合わせ

- 📧 メールアドレス：<kevin@xw.com>
- 🌐 オンラインデモ：<https://aiwork.xw.com>
- 💬 WeChat グループ「星网AI剧场开源交流」（オープンソース交流グループ）：

  ![星网AI剧场开源交流 WeChat グループ QR コード](docs/wechat-group-qr.jpg)
