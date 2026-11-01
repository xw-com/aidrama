**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | **Tiếng Việt** | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Nền tảng sản xuất phim ngắn AI

> 🌐 **Demo trực tuyến**: <https://aiwork.xw.com> 　·　📮 Liên hệ: **kevin@xw.com**

Một hệ thống sáng tạo phim ngắn bằng AI: **nhập kịch bản → trích xuất nhân vật/bối cảnh/đạo cụ → tạo storyboard → tạo video từng phân cảnh → dựng hợp nhất toàn tập**.
Phía server là **Node.js + MySQL (hoặc SQLite fallback)**, frontend gồm hai phiên bản **Vue 3 + Element Plus**: **Web (client, bao gồm trang quản trị client/admin và vỏ desktop client/desktop) + di động (uniapp, vỏ App/Mini Program/H5)**, giao tiếp qua REST API. Hệ thống tài khoản là **đăng ký/đăng nhập cục bộ tích hợp sẵn** (tên người dùng/email/số điện thoại + mật khẩu), không phụ thuộc vào bất kỳ trung tâm tài khoản bên thứ ba nào.

---

## 🌐 Demo trực tuyến & cộng đồng

- **Địa chỉ demo**: <https://aiwork.xw.com>
- **Hướng dẫn sử dụng**: [PC](docs/pc-user-manual.md) · [Di động](docs/mobile-user-manual.md)
- **Báo lỗi / hợp tác**: <kevin@xw.com>

---

## ✨ Tính năng

| Mô-đun | Mô tả |
|---|---|
| 👤 Hệ thống người dùng | **Đăng ký / đăng nhập cục bộ** (tên người dùng/email/số điện thoại + mật khẩu, đăng ký yêu cầu captcha chọn chữ) + **dự án chia sẻ theo nhóm** (lời mời/phan quyền) |
| 📖 Dàn ý kịch bản | Dán hoặc tải lên `.txt` để nhập kịch bản, **AI tự tách thành nhiều tập**, có thể chỉnh sửa từng tập |
| 🎭 Thư viện tài nguyên | **AI trích xuất nhân vật / bối cảnh / đạo cụ**, tạo ảnh tài nguyên từng cái hoặc hàng loạt |
| 🎬 Video theo tập | **AI tạo kịch bản phân cảnh** (kịch bản từng đoạn + lời dẫn + cấu hình giọng đọc + thời lượng) |
| ✂️ Trình soạn storyboard | Bên trái là tài nguyên, giữa là kịch bản phân cảnh, phải là xem trước video, dưới là timeline của tập phim |
| 🎞️ Tạo video | Mỗi đoạn: (TTS tùy chọn) → đoạn video, sau khi tạo tự động trích khung hình đầu làm ảnh bìa xem trước |
| 🧩 Dựng hợp nhất toàn tập | ffmpeg nối các đoạn đã chọn, xuất ra mp4 của cả tập |
| 🔧 Cấu hình mô hình lớn | **Toàn bộ cấu hình tại trang quản trị** (4 loại: văn bản/hình ảnh/video/giọng nói, có thể bật/tắt / nhập / xuất) |
| 💰 Tính phí theo credit | Mọi bước gọi mô hình lớn/đều có định giá, **trừ credit theo lượng sử dụng** |
| 💳 Nạp tiền | Các gói cài sẵn + **WeChat Pay (V3 · Native quét mã / JSAPI)**, trừ credit theo lượng |
| 🎨 Chủ đề | Sáng / Tối / tự động theo hệ thống |

### Định giá (có thể chỉnh sửa, giá trị mặc định)
| Chức năng | Đơn vị | Credit |
|---|---|---|
| Tách kịch bản | mỗi 1.000 chữ | 10 |
| Trích xuất tài nguyên | mỗi tập | 20 |
| Tạo ảnh tài nguyên | mỗi ảnh | 5 |
| **Tạo kịch bản phân cảnh** | **mỗi 100 chữ** | **2** |
| **Tạo video phân cảnh** | **mỗi giây** | **11** |
| Lời dẫn (TTS) | mỗi 100 chữ | 3 |
| Dựng video | mỗi tập | 30 |

---

## 📂 Cấu trúc thư mục

```
AIDrama/
├─ server/            # Server Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # Model bảng dữ liệu + quan hệ
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # Route REST (dự án/tài nguyên/storyboard/video/credit/nạp tiền/trung tâm triển lãm/nhận đơn/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Định giá + danh mục nhà cung cấp mô hình mặc định + admin khởi tạo
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Web Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Trang quản trị (entry riêng /admin, đăng nhập và token riêng)
│  ├─ admin.html           # File HTML entry của trang quản trị
│  └─ desktop/             # Vỏ desktop Electron (Windows/macOS, xem client/desktop/README.md)
├─ uniapp/            # Di động (uni-app: App / vỏ Mini Program / H5)
└─ deploy/            # Triển khai production: nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Bắt đầu nhanh

### 1. Khởi động server

```bash
cd server
cp .env.example .env          # Mặc định DB_DIALECT=sqlite, chạy được ngay không cần cấu hình
npm install
npm run dev                   # http://localhost:3000 , tự tạo bảng + seed
```

- **SQLite (dùng được ngay, khuyên dùng để trải nghiệm cục bộ)**: `DB_DIALECT=sqlite`, dữ liệu lưu tại `server/data/aidrama.db`
- **MySQL**: đặt `DB_DIALECT=mysql` và điền `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **Lần chạy đầu tự tạo admin khởi tạo** (console sẽ in thông báo):
  - Tài khoản mặc định **`admin / admin123`**, dùng để đăng nhập trang quản trị `/admin`
  - Có thể ghi đè bằng biến môi trường `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; tự động bỏ qua nếu đã có admin
  - ⚠️ Trước khi lên production hãy đổi mật khẩu mặc định ngay (`node scripts/setAdminPassword.js`, hoặc xem mục trang quản trị bên dưới)

### 2. Khởi động client

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Mở <http://localhost:5173>: chưa có tài khoản thì bấm 「Đăng ký」 (tên người dùng + mật khẩu, qua một bước captcha chọn chữ, đăng ký thành công tức đăng nhập và được tặng 66 credit dùng thử); đã có tài khoản thì đăng nhập trực tiếp (tên người dùng / email / số điện thoại đều được).

> Client đã cấu hình proxy, `/api` và `/files` tự động chuyển tiếp đến `http://localhost:3000`.

---

## 🛠 Sử dụng trang quản trị (client/admin)

Trang quản trị là **entry riêng, đăng nhập riêng, token riêng** (JWT tiền tố `admt_`, hoàn toàn tách biệt với phiên người dùng phía frontend):

- **Entry**: <http://localhost:5173/admin> (ở môi trường production là `https://tên-miền-của-bạn/admin`)
- **Đăng nhập**: tài khoản + mật khẩu + captcha chọn chữ. Lần chạy đầu dùng admin khởi tạo **`admin / admin123`**;
- **Đổi mật khẩu**: trang quản trị hiện chưa có trang đổi mật khẩu, dùng script phía server để đặt lại:
  ```bash
  cd server
  node scripts/setAdminPassword.js <tên người dùng hoặc email> <mật khẩu mới>
  ```
  (Đăng nhập `adminAuth` cho phép dùng tên người dùng / email / số điện thoại làm tài khoản)

### Các mô-đun chức năng

| Mô-đun | Mục đích |
|---|---|
| **Cấu hình mô hình** | **Kết nối LLM cho 4 loại: văn bản / hình ảnh / video / TTS** (xem mục tiếp theo, bắt buộc cấu hình trước khi lên production) |
| Nhà cung cấp mô hình | Danh mục nhà cung cấp và mô hình (nguồn preset khi thêm cấu hình mới, seed đã sẵn các nhà cung cấp phổ biến) |
| Phong cách mỹ thuật / tùy chọn nhân vật / thư viện giọng đọc | Từ điển nguyên liệu sáng tác (các tùy chọn phía frontend được cấu hình từ đây) |
| Định giá | Đơn giá credit của từng bước AI (xem bảng ở trên) |
| Quản lý người dùng | Tra cứu người dùng, **cấm / gỡ cấm**, **đặt lại mật khẩu** (kênh thống nhất cho việc quên mật khẩu), điều chỉnh credit, **đăng nhập một nút vào frontend với tư cách người dùng** (login-as, để hỗ trợ người dùng gỡ lỗi) |
| Thanh toán | Tra cứu / đối chiếu đơn nạp tiền WeChat |
| Duyệt trung tâm triển lãm | Lên/xuống trang các tác phẩm ở trung tâm triển lãm |
| Quản lý tác vụ / quản lý tạo video | Thử lại / dọn dẹp hàng đợi tác vụ bất đồng bộ và tạo video |
| Bảo trì | Công tắc chế độ bảo trì (503 + thời gian khôi phục dự kiến), bảo trì dữ liệu |
| Nhật ký đăng nhập | Hồ sơ đăng nhập toàn hệ thống (phương thức / IP / UA) |

---

## 🔌 Cấu hình mô hình lớn / media (để tính năng AI thực sự hoạt động)

Tất cả khả năng AI đều do **cấu hình điều khiển**, và **được quản lý thống nhất tại trang「Cấu hình mô hình」của trang quản trị** (`.env` không còn cung cấp cấu hình LLM mặc định nào). Khi chưa cấu hình: các tính năng văn bản sẽ nhắc nhở trước khi gọi; hình ảnh/video/TTS sẽ báo thẳng「chưa cấu hình」.

Các bước cấu hình:

1. Đăng nhập trang quản trị `/admin` → **Cấu hình mô hình** → thêm mới;
2. Chọn loại (văn bản / hình ảnh / video / TTS) và giao thức, điền:
   - **Base URL** (ví dụ `https://api.openai.com/v1`)
   - **API Key** (chỉ lưu phía server, không gửi xuống frontend)
   - Tên mô hình (ví dụ `gpt-4o-mini`, `dall-e-3`)
   - Trạng thái bật và định giá credit của cấu hình đó;
3. Sau khi lưu, frontend dùng được ngay (cùng một loại có thể cấu hình nhiều mục và bật/tắt chuyển đổi); trang「Cấu hình mô hình」hỗ trợ **nhập / xuất JSON**, thuận tiện di chuyển hàng loạt.

Các giao thức được hỗ trợ:

- **Văn bản / hình ảnh / TTS**: tương thích OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) hoặc endpoint tùy chỉnh (`api_style=custom`)
- **Video**: cấu hình endpoint tác vụ bất đồng bộ (gửi → polling → URL video); cần provider tạo video thực sự (chức năng「ảnh thành video」ffmpeg cục bộ đã ngừng hoạt động)

> Phía người dùng còn có thể thêm **mô hình riêng tư** tại「Cài đặt cá nhân → Mô hình của tôi」(tự mang Key, gọi không trừ credit), không ảnh hưởng cấu hình toàn cục.
> Cần cài đặt `ffmpeg` cục bộ (macOS: `brew install ffmpeg`). Việc nối và dựng các đoạn video phụ thuộc vào nó.

---

## 🚢 Triển khai production

Runbook đầy đủ xem tại **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist lên production với nginx, PM2/systemd instance đơn lẻ, backup & khôi phục, đưa WeChat Pay vào hoạt động, việc tuân thủ còn tồn đọng). Yêu cầu môi trường tối thiểu:

```bash
NODE_ENV=production            # Nếu không đặt thì JWT dùng khóa fallback dành cho dev, tiềm ẩn rủi ro bảo mật
JWT_SECRET=<khóa ký token phiên cục bộ, chuỗi dài ngẫu nhiên>      # Hệ thống này tự ký/xác minh phiên người dùng (axt_)
ADMIN_JWT_SECRET=<khóa ký riêng của trang quản trị>
FILE_SIGN_SECRET=<khóa ký chống hotlink media>   # Phải khớp với khóa secure_link trong deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay còn cần bộ năm `WECHAT_PAY_*` (mã merchant, AppID, khóa APIv3, số serial chứng chỉ, khóa riêng merchant), xem `deploy/DEPLOY.md` ⑦.

---

## 🔑 Đăng nhập & hệ thống tài khoản (cục bộ, không phụ thuộc bên ngoài)

Hệ thống tài khoản là **tích hợp sẵn trong hệ thống này**: đăng ký / đăng nhập / đổi mật khẩu / làm mới phiên đều đi qua `/api/auth/*` của server này, không phụ thuộc trung tâm tài khoản bên thứ ba nào:

- **Đăng ký**: tên người dùng (2-64 ký tự chữ cái, chữ số, `_.-`) + mật khẩu (≥6 ký tự) + email (tùy chọn), phải qua captcha chọn chữ (backend ra đề bằng SVG, `/api/captcha/*`); đăng ký thành công tức đăng nhập, và được tặng 66 credit dùng thử;
- **Đăng nhập**: tên người dùng / email / số điện thoại bất kỳ + mật khẩu; captcha「kiểm tra chỉ khi có cung cấp」(mặc định frontend luôn gửi kèm);
- **Token**: server tự ký JWT (tiền tố `axt_`, access + refresh, refresh không xoay vòng), frontend gia hạn âm thầm qua `/api/auth/oauth/refresh`; token trang quản trị độc lập (tiền tố `admt_`);
- **Quên mật khẩu**: bản tự triển khai không có kênh SMS/email, không cung cấp tự đặt lại — do admin thực hiện tại **Trang quản trị「Quản lý người dùng」→ Đặt lại mật khẩu**;
- **Cấm**: sau khi bị cấm, mọi token đã cấp của người dùng đó sẽ vô hiệu ngay từ yêu cầu kế tiếp (server tra lại trạng thái người dùng ở mỗi yêu cầu);
- **Đăng nhập bên thứ ba (tùy chọn)**: đăng nhập một nút Apple / Google trên App di động vẫn hoạt động — server giữ khóa làm proxy trao đổi (`POST /api/auth/oauth/:provider`), đổi về cùng loại phiên cục bộ `axt_`; phía Web không cần đăng ký callback nào.

Các biến `.env` liên quan: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (xem chú thích trong `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native quét mã / JSAPI)

WeChat Pay thực sự, **do cấu hình điều khiển, mặc định tắt** (để trống `WECHAT_PAY_*` trong `.env` tức chưa kích hoạt, frontend tự ẩn cổng nạp tiền). `WECHAT_APP_ID` chỉ được giữ lại làm giá trị fallback cho AppID thanh toán.

Trên [WeChat Merchant Platform](https://pay.weixin.qq.com/) kích hoạt thanh toán Native/JSAPI, lấy mã merchant, khóa APIv3, và tải xuống chứng chỉ API merchant (`apiclient_key.pem` + số serial chứng chỉ). **Mã merchant và AppID phải được bind hoàn tất trên merchant platform** (nếu không, tạo đơn sẽ báo `APPID_MCHID_NOT_MATCH`). Cấu hình:
```bash
WECHAT_PAY_METHOD=native       # native=quét mã | jsapi=thanh toán trong Official Account (PC đi qua quầy H5)
WECHAT_PAY_APP_ID=             # AppID đã bind với mã merchant (để trống sẽ fallback về WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<mã merchant của bạn>
WECHAT_PAY_API_V3_KEY=         # Khóa APIv3 32 ký tự
WECHAT_PAY_SERIAL_NO=          # Số serial chứng chỉ API merchant
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Đường dẫn trên đĩa của apiclient_key.pem (chọn một trong hai với dòng dưới)
WECHAT_PAY_PRIVATE_KEY=        # Hoặc nhúng trực tiếp văn bản PEM
WECHAT_PAY_NOTIFY_URL=         # Để trống sẽ lấy ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Quy trình: tại trung tâm credit chọn「WeChat Pay」→ backend tạo đơn hợp nhất (Native trả về `code_url` để render mã QR / JSAPI kéo lên thanh toán) → người dùng thanh toán → WeChat callback bất đồng bộ `/api/recharge/wechat/notify` (giải mã & kiểm tra AES-256-GCM, ghi có theo kiểu idempotent).
- Callback phải là **địa chỉ HTTPS công khai có thể truy cập** (giai đoạn dev có thể dùng NAT tunneling).

> Các bước đưa vào hoạt động (bind AppID trên merchant platform, đưa chứng chỉ xuống máy chủ local, chạy lại một đơn thật trị giá một xu) xem **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Các bước đưa WeChat Pay vào hoạt động**.
> Cơ sở dữ liệu: số hóa đơn thanh toán được ghi vào `recharge_orders.transaction_id`, được `ensureColumns` lúc khởi động bổ sung theo kiểu idempotent, không ảnh hưởng cơ sở dữ liệu cũ.

---

## 🧪 Các bước xác minh end-to-end

0. Trang quản trị `/admin` (admin/admin123) → **Cấu hình mô hình** → cấu hình đủ 4 loại văn bản/hình ảnh/video/TTS (nếu không các bước AI không khả dụng)
1. Đăng ký/đăng nhập frontend → tạo dự án mới → 「Dàn ý kịch bản」dán/tải lên kịch bản → **AI tách kịch bản** (trừ credit)
2. 「Thư viện tài nguyên」→ **AI trích xuất tài nguyên** → **tạo ảnh tài nguyên** cho nhân vật/bối cảnh
3. 「Video theo tập」→ **tạo kịch bản** → vào **trình soạn storyboard**
4. Trong trình soạn, chọn đoạn → **tạo ngay** (đoạn video, đồng thời tự trích khung hình đầu làm ảnh bìa xem trước)
5. **Dựng hợp nhất toàn tập** (ffmpeg nối ra mp4 của cả tập)
6. Tại「Trung tâm credit」xem lịch sử giao dịch, nạp tiền; tại trang quản trị đổi định giá / cấm người dùng / đặt lại mật khẩu / xem nhật ký đăng nhập; chuyển chủ đề Sáng/Tối/Tự động

---

## 📡 API chính (tiền tố `/api`, xác thực JWT, thống nhất `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Đăng ký cục bộ (cần captcha ticket) / đăng nhập (công khai, giới hạn tần suất)
POST /auth/password                                            # Đổi mật khẩu (đã đăng nhập)
POST /auth/oauth/refresh                                       # Gia hạn âm thầm (refresh_token đổi access_token mới, công khai)
POST /auth/oauth/:provider                                     # Đăng nhập bên thứ ba đổi phiên cục bộ (apple/google/weixin/huawei, tùy chọn)
GET /auth/me   POST /auth/sync                                 # Hồ sơ người dùng
POST /captcha/challenge | /captcha/verify                      # Captcha chọn chữ
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Trung tâm tác vụ bất đồng bộ (frontend polling)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Phía đọc cấu hình toàn cục + nhập/xuất (trang quản trị duy trì)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # Callback WeChat Pay (không cần xác thực, xác minh chữ ký + idempotent)
GET /showcase/*                                                # Trung tâm triển lãm (đăng tác phẩm/xem/phỏng theo)
GET /market/*                                                  # Trung tâm nhận đơn (đơn nhiệm vụ/ủy thác/nghiệm thu)
GET /pricing
```
Mỗi API AI đều có API `…/estimate` tương ứng để ước lượng credit; các API quản trị (`/admin/*`: người dùng/thanh toán/tác vụ/nhật ký/bảo trì…) dùng token trang quản trị độc lập (`admt_`).

---

## 🛠 Công nghệ sử dụng

**Server**: Express · Sequelize (hai dialect mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (vỏ desktop: Electron + electron-updater)
**Di động**: uni-app (App / vỏ Mini Program / H5)

## 📝 Ghi chú

- Dự án này bàn giao một nền tảng cơ sở với "tính năng hoạt động end-to-end": tất cả API và trang đều hoạt động thật, chạy được; UI tái hiện cấu trúc và trạng thái của ảnh tham khảo.
- Provider bên ngoài (hình ảnh/video/TTS) cần được cấu hình key thật tại **trang quản trị** để tạo ra nguyên liệu thật end-to-end; ffmpeg chỉ dùng để nối và dựng các đoạn video.
- Sau khi sửa model Sequelize, với SQLite hãy xóa `server/data/*.db` để khởi tạo lại (ở production nên dùng migration).

---

## 📄 Giấy phép mã nguồn mở

Dự án này được phát hành mã nguồn mở theo [AGPL-3.0](LICENSE).

- ✅ **Học tập cá nhân, nghiên cứu, sử dụng phi thương mại**: miễn phí; việc cung cấp dịch vụ mạng công khai sau khi sửa đổi vẫn phải tuân thủ nghĩa vụ mở nguồn theo AGPL-3.0
- 💼 **Triển khai thương mại / dịch vụ SaaS / bàn giao on-premise**: cần mua giấy phép thương mại (được miễn nghĩa vụ mở nguồn AGPL-3.0); liên hệ cấp phép thương mại: <kevin@xw.com>

---

## 📮 Liên hệ

- 📧 Email: <kevin@xw.com>
- 🌐 Demo trực tuyến: <https://aiwork.xw.com>
- 💬 Nhóm WeChat「星网AI剧场开源交流」:

  ![Mã QR nhóm WeChat 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
