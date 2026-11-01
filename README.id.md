**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | **Bahasa Indonesia** | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Platform Produksi Drama Pendek AI

> 🌐 **Demo online**: <https://aiwork.xw.com> 　·　📮 Hubungi kami: **kevin@xw.com**

Satu sistem pembuatan drama pendek berbasis AI: **impor naskah → ekstraksi karakter/lokasi/properti → pembuatan storyboard → pembuatan video per segmen → perakitan seluruh episode**.
Sisi server menggunakan **Node.js + MySQL (fallback SQLite)**, frontend terdiri dari dua sisi **Vue 3 + Element Plus**: **Web (client, mencakup dashboard admin client/admin dan shell desktop client/desktop) + mobile (uniapp, shell App/Mini Program/H5)**, saling berkomunikasi melalui REST API. Sistem akun adalah **registrasi/login lokal bawaan** (nama pengguna/email/nomor ponsel + kata sandi), tidak bergantung pada pusat akun pihak ketiga mana pun.

---

## 🌐 Demo online & komunitas

- **Alamat demo**: <https://aiwork.xw.com>
- **Panduan pengguna**: [PC](docs/pc-user-manual.md) · [Ponsel](docs/mobile-user-manual.md)
- **Lapor masalah / kerja sama**: <kevin@xw.com>

---

## ✨ Fitur

| Modul | Deskripsi |
|---|---|
| 👤 Sistem pengguna | **Registrasi / login lokal** (nama pengguna/email/nomor ponsel + kata sandi, registrasi wajib melewati captcha pilih teks) + **proyek bersama tim** (undangan/peran akses) |
| 📖 Kerangka naskah | Tempel atau unggah `.txt` untuk mengimpor naskah, **AI memecahnya menjadi beberapa episode**, dapat diedit per episode |
| 🎭 Perpustakaan aset | **AI mengekstraksi karakter / lokasi / properti**, pembuatan gambar aset satu per satu atau secara batch |
| 🎬 Video per episode | **AI membuat skrip storyboard** (skrip segmen + narasi + konfigurasi suara + durasi) |
| ✂️ Editor storyboard | Kiri panel aset, tengah skrip storyboard, kanan pratinjau video, bawah timeline episode |
| 🎞️ Pembuatan video | Setiap segmen: (TTS opsional) → klip video, setelah dibuat otomatis mengambil frame pertama sebagai gambar sampul pratinjau |
| 🧩 Perakitan seluruh episode | ffmpeg menggabungkan segmen yang dipilih, menghasilkan mp4 satu episode utuh |
| 🔧 Konfigurasi model besar | **Semua dikonfigurasi di dashboard admin** (empat jenis: teks/gambar/video/suara, dapat aktif/nonaktif / impor / ekspor) |
| 💰 Penagihan kredit | Setiap langkah yang memanggil model/media besar memiliki harga, **kredit dipotong sesuai pemakaian** |
| 💳 Isi ulang | Paket preset + **WeChat Pay (V3 · Native scan QR / JSAPI)**, kredit dipotong sesuai pemakaian |
| 🎨 Tema | Terang / gelap / otomatis mengikuti sistem |

### Harga (dapat diedit, nilai default)
| Fitur | Satuan | Kredit |
|---|---|---|
| Pemecahan naskah | per 1.000 karakter | 10 |
| Ekstraksi aset | per episode | 20 |
| Pembuatan gambar aset | per gambar | 5 |
| **Pembuatan skrip storyboard** | **per 100 karakter** | **2** |
| **Pembuatan video storyboard** | **per detik** | **11** |
| Dubbing narasi (TTS) | per 100 karakter | 3 |
| Perakitan video | per episode | 30 |

---

## 📂 Struktur direktori

```
AIDrama/
├─ server/            # Server Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # Model tabel data + relasi
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # Rute REST (proyek/aset/storyboard/video/kredit/isi ulang/showcase/pesanan/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Harga + katalog vendor model default + admin awal
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Web Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Dashboard admin (entry terpisah /admin, login dan token terpisah)
│  ├─ admin.html           # File HTML entry dashboard admin
│  └─ desktop/             # Shell desktop Electron (Windows/macOS, lihat client/desktop/README.md)
├─ uniapp/            # Mobile (uni-app: App / shell Mini Program / H5)
└─ deploy/            # Deploy produksi: nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Mulai cepat

### 1. Menjalankan server

```bash
cd server
cp .env.example .env          # Default DB_DIALECT=sqlite, langsung bisa jalan tanpa konfigurasi
npm install
npm run dev                   # http://localhost:3000 , otomatis membuat tabel + seed
```

- **SQLite (langsung jalan, disarankan untuk mencoba secara lokal)**: `DB_DIALECT=sqlite`, data tersimpan di `server/data/aidrama.db`
- **MySQL**: atur `DB_DIALECT=mysql` dan isi `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **Jalankan pertama otomatis membuat admin awal** (console akan mencetak pemberitahuan):
  - Akun default **`admin / admin123`**, untuk login ke dashboard admin `/admin`
  - Dapat ditimpa dengan variabel lingkungan `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; otomatis dilewati jika sudah ada admin
  - ⚠️ Sebelum go-live segera ubah kata sandi default (`node scripts/setAdminPassword.js`, atau lihat bagian dashboard admin di bawah)

### 2. Menjalankan client

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Buka <http://localhost:5173>: jika belum punya akun klik 「Daftar」 (nama pengguna + kata sandi, melewati satu langkah captcha pilih teks, registrasi berarti langsung login dan mendapat 66 kredit percobaan); jika sudah punya akun langsung login (nama pengguna / email / nomor ponsel semuanya bisa).

> Client sudah dikonfigurasi proxy, `/api` dan `/files` otomatis diteruskan ke `http://localhost:3000`.

---

## 🛠 Penggunaan dashboard admin (client/admin)

Dashboard admin adalah **entry terpisah, login terpisah, token terpisah** (JWT berawalan `admt_`, sepenuhnya terpisah dari sesi pengguna sisi frontend):

- **Entry**: <http://localhost:5173/admin> (di lingkungan produksi `https://domain-anda/admin`)
- **Login**: akun + kata sandi + captcha pilih teks. Untuk pertama kali gunakan admin awal **`admin / admin123`**;
- **Ganti kata sandi**: dashboard admin belum memiliki halaman ganti kata sandi, gunakan skrip sisi server untuk mereset:
  ```bash
  cd server
  node scripts/setAdminPassword.js <nama pengguna atau email> <kata sandi baru>
  ```
  (Login `adminAuth` menerima nama pengguna / email / nomor ponsel sebagai akun)

### Modul fitur

| Modul | Fungsi |
|---|---|
| **Konfigurasi model** | **Integrasi LLM empat jenis: teks / gambar / video / TTS** (lihat bagian berikutnya, wajib dikonfigurasi sebelum go-live) |
| Vendor model | Katalog vendor dan model (sumber preset saat menambah konfigurasi baru, seed sudah berisi vendor-vendor utama) |
| Gaya seni / opsi karakter / pustaka suara | Kamus bahan kreatif (opsi yang tampil di frontend dikonfigurasi dari sini) |
| Harga | Harga satuan kredit per langkah AI (lihat tabel di atas) |
| Manajemen pengguna | Mencari pengguna, **blokir / buka blokir**, **reset kata sandi** (jalur utama untuk kasus lupa kata sandi), menyesuaikan kredit, **login ke frontend sebagai pengguna sekali klik** (login-as, untuk membantu mendiagnosis masalah pengguna) |
| Pembayaran | Pencarian / rekonsiliasi pesanan isi ulang WeChat |
| Moderasi showcase | Naik/turunkan publikasi karya di pusat showcase |
| Manajemen tugas / manajemen pembuatan video | Ulangi/bersihkan antrean tugas asinkron dan pembuatan video |
| Pemeliharaan | Sakelar mode pemeliharaan (503 + estimasi waktu pemulihan), pemeliharaan data |
| Log login | Riwayat login seluruh sistem (metode / IP / UA) |

---

## 🔌 Konfigurasi model besar / media (agar fitur AI benar-benar berfungsi)

Semua kemampuan AI **digerakkan oleh konfigurasi**, dan **dikelola terpusat di halaman 「Konfigurasi Model」 dashboard admin** (`.env` tidak lagi menyediakan konfigurasi LLM default). Ketika belum dikonfigurasi: fitur jenis teks akan memberi peringatan sebelum dipanggil; gambar/video/TTS akan langsung melaporkan 「belum dikonfigurasi」.

Langkah konfigurasi:

1. Login ke dashboard admin `/admin` → **Konfigurasi Model** → tambah baru;
2. Pilih jenis (teks / gambar / video / TTS) dan protokol, lalu isi:
   - **Base URL** (mis. `https://api.openai.com/v1`)
   - **API Key** (hanya disimpan di server, tidak dikirim ke frontend)
   - Nama model (mis. `gpt-4o-mini`, `dall-e-3`)
   - Status aktif dan harga kredit untuk konfigurasi tersebut;
3. Setelah disimpan langsung dapat dipakai di frontend (satu jenis dapat memiliki beberapa entri konfigurasi dan dapat diaktifkan/dinonaktifkan); halaman 「Konfigurasi Model」 mendukung **impor / ekspor JSON**, memudahkan migrasi massal.

Protokol yang didukung:

- **Teks / gambar / TTS**: kompatibel OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) atau endpoint kustom (`api_style=custom`)
- **Video**: konfigurasi endpoint tugas asinkron (kirim → polling → URL video); memerlukan provider pembuatan video sungguhan (fitur ffmpeg lokal 「gambar ke video」 sudah dinonaktifkan)

> Pengguna juga dapat menambahkan **model pribadi** di 「Pengaturan → Model Saya」 (memakai Key sendiri, pemanggilan tidak memotong kredit), tanpa memengaruhi konfigurasi global.
> Perlu menginstal `ffmpeg` secara lokal (macOS: `brew install ffmpeg`). Penggabungan dan perakitan klip video bergantung padanya.

---

## 🚢 Deploy produksi

Runbook lengkap lihat **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist go-live nginx, PM2/systemd instance tunggal, backup & pemulihan, go-live WeChat Pay, pekerjaan kepatuhan yang belum selesai). Persyaratan lingkungan minimum:

```bash
NODE_ENV=production            # Jika tidak diatur, JWT memakai kunci fallback dev — celah keamanan
JWT_SECRET=<kunci penandatanganan token sesi lokal, string acak panjang>      # Sistem ini menandatangani/memverifikasi sesi pengguna sendiri (axt_)
ADMIN_JWT_SECRET=<kunci penandatanganan terpisah untuk dashboard admin>
FILE_SIGN_SECRET=<kunci penandatanganan anti-hotlink media>   # Harus sama dengan kunci secure_link di deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay juga memerlukan lima variabel `WECHAT_PAY_*` (ID merchant, AppID, kunci APIv3, nomor seri sertifikat, kunci privat merchant), lihat `deploy/DEPLOY.md` ⑦.

---

## 🔑 Login & sistem akun (lokal, tanpa dependensi eksternal)

Sistem akun **tertanam di dalam sistem ini**: registrasi / login / ganti kata sandi / penyegaran sesi semuanya melalui `/api/auth/*` di server ini, tidak bergantung pada pusat akun pihak ketiga mana pun:

- **Registrasi**: nama pengguna (2-64 karakter huruf, angka, `_.-`) + kata sandi (≥6 karakter) + email (opsional), wajib melewati captcha pilih teks (backend menghasilkan soal berupa SVG, `/api/captcha/*`); registrasi berhasil berarti langsung login, dan mendapat 66 kredit percobaan;
- **Login**: nama pengguna / email / nomor ponsel mana saja + kata sandi; captcha 「diverifikasi hanya jika dikirim」 (frontend secara default selalu mengirimkannya);
- **Token**: server menandatangani JWT sendiri (awalan `axt_`, access + refresh, refresh tidak dirotasi), frontend memperbarui secara diam-diam melalui `/api/auth/oauth/refresh`; token dashboard admin terpisah (awalan `admt_`);
- **Lupa kata sandi**: instance yang di-deploy sendiri tidak memiliki kanal SMS/email, tidak ada reset mandiri — dilakukan admin melalui **Dashboard Admin 「Manajemen Pengguna」 → Reset kata sandi**;
- **Pemblokiran**: setelah diblokir, semua token yang pernah diterbitkan untuk pengguna tersebut tidak berlaku sejak permintaan berikutnya (server memeriksa ulang status pengguna di setiap permintaan);
- **Login pihak ketiga (opsional)**: login sekali klik Apple / Google di aplikasi mobile tetap berfungsi — server menyimpan kunci dan menjadi proxy pertukaran (`POST /api/auth/oauth/:provider`), ditukar dengan sesi lokal `axt_` yang sama; sisi Web tidak perlu mendaftarkan callback apa pun.

Variabel `.env` terkait: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (lihat komentar di `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native scan QR / JSAPI)

WeChat Pay sungguhan, **digerakkan konfigurasi, nonaktif secara default** (biarkan `WECHAT_PAY_*` kosong di `.env` berarti tidak diaktifkan, frontend otomatis menyembunyikan pintu isi ulang). `WECHAT_APP_ID` hanya dipertahankan sebagai nilai fallback AppID pembayaran.

Aktifkan Native/JSAPI di [WeChat Merchant Platform](https://pay.weixin.qq.com/) dapatkan ID merchant, kunci APIv3, dan unduh sertifikat API merchant (`apiclient_key.pem` + nomor seri sertifikat). **ID merchant dan AppID wajib sudah di-binding di merchant platform** (jika tidak, pembuatan pesanan akan gagal dengan `APPID_MCHID_NOT_MATCH`). Konfigurasi:
```bash
WECHAT_PAY_METHOD=native       # native=scan QR | jsapi=pembayaran di dalam Official Account (PC lewat kasir H5)
WECHAT_PAY_APP_ID=             # AppID yang di-binding dengan ID merchant (kosong akan fallback ke WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<ID merchant Anda>
WECHAT_PAY_API_V3_KEY=         # Kunci APIv3 32 karakter
WECHAT_PAY_SERIAL_NO=          # Nomor seri sertifikat API merchant
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Path apiclient_key.pem di disk (pilih salah satu dengan baris di bawah)
WECHAT_PAY_PRIVATE_KEY=        # Atau langsung sisipkan teks PEM
WECHAT_PAY_NOTIFY_URL=         # Kosong akan memakai ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Alur: di pusat kredit pilih 「WeChat Pay」 → backend membuat pesanan terpadu (Native mengembalikan `code_url` untuk merender QR / JSAPI memanggil pembayaran) → pengguna membayar → WeChat mengirim callback asinkron ke `/api/recharge/wechat/notify` (dekripsi dan verifikasi AES-256-GCM, pencatatan kredit idempoten).
- Callback harus berupa **alamat HTTPS yang dapat diakses publik** (saat pengembangan bisa memakai tunneling NAT).

> Langkah go-live (binding AppID di merchant platform, menempatkan sertifikat di server lokal, regresi dengan satu pesanan sungguhan senilai satu sen) lihat **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Langkah go-live WeChat Pay**.
> Basis data: nomor transaksi pesanan pembayaran ditulis ke `recharge_orders.transaction_id`, dilengkapi secara idempoten oleh `ensureColumns` saat startup, tidak memengaruhi basis data lama.

---

## 🧪 Langkah verifikasi end-to-end

0. Dashboard admin `/admin` (admin/admin123) → **Konfigurasi Model** → lengkapi keempat jenis teks/gambar/video/TTS (jika tidak, langkah AI tidak dapat digunakan)
1. Registrasi/login di frontend → buat proyek baru → 「Kerangka Naskah」 tempel/unggah naskah → **AI memecah naskah** (memotong kredit)
2. 「Perpustakaan Aset」 → **AI mengekstraksi aset** → **buat gambar aset** untuk karakter/lokasi
3. 「Video per Episode」 → **buat skrip** → masuk **editor storyboard**
4. Di editor pilih segmen → **buat sekarang** (klip video, sekaligus otomatis mengambil frame pertama sebagai gambar sampul pratinjau)
5. **Rakit seluruh episode** (ffmpeg menggabungkan menjadi mp4 satu episode utuh)
6. Di 「Pusat Kredit」 lihat riwayat transaksi dan isi ulang; di dashboard admin ubah harga / blokir pengguna / reset kata sandi / lihat log login; beralih tema terang/gelap/otomatis

---

## 📡 API utama (prefiks `/api`, autentikasi JWT, format seragam `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Registrasi lokal (butuh ticket captcha) / login (publik, rate-limited)
POST /auth/password                                            # Ganti kata sandi (sesi login)
POST /auth/oauth/refresh                                       # Pembaruan diam-diam (refresh_token menukar access_token baru, publik)
POST /auth/oauth/:provider                                     # Login pihak ketiga menukar sesi lokal (apple/google/weixin/huawei, opsional)
GET /auth/me   POST /auth/sync                                 # Profil pengguna
POST /captcha/challenge | /captcha/verify                      # Captcha pilih teks
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Pusat tugas asinkron (frontend polling)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Sisi baca konfigurasi global + impor/ekspor (dikelola di dashboard admin)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # Callback WeChat Pay (tanpa autentikasi, verifikasi tanda tangan + idempoten)
GET /showcase/*                                                # Pusat showcase (publikasi/telusuri/buat gaya serupa)
GET /market/*                                                  # Pusat pesanan (lembar tugas/escrow/serah terima)
GET /pricing
```
Setiap API AI memiliki API `…/estimate` yang sesuai untuk estimasi kredit; API admin (`/admin/*`: pengguna/pembayaran/tugas/log/pemeliharaan dsb.) memakai token dashboard admin terpisah (`admt_`).

---

## 🛠 Tumpukan teknologi

**Server**: Express · Sequelize (dua dialect mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (shell desktop: Electron + electron-updater)
**Mobile**: uni-app (App / shell Mini Program / H5)

## 📝 Catatan

- Proyek ini menyediakan fondasi dengan 「fitur yang berfungsi end-to-end」: semua API dan halaman benar-benar berfungsi dan dapat dijalankan; UI mereplikasi struktur dan status gambar referensi.
- Provider eksternal (gambar/video/TTS) perlu dikonfigurasi key asli di **dashboard admin** agar menghasilkan materi asli end-to-end; ffmpeg hanya digunakan untuk penggabungan dan perakitan klip video.
- Setelah mengubah model Sequelize, pada SQLite silakan hapus `server/data/*.db` dan inisialisasi ulang (untuk produksi disarankan memakai migration).

---

## 📄 Lisensi open source

Proyek ini dirilis sebagai open source di bawah [AGPL-3.0](LICENSE).

- ✅ **Pembelajaran pribadi, penelitian, penggunaan non-komersial**: gratis; memodifikasi lalu menyediakannya sebagai layanan jaringan tetap wajib mematuhi kewajiban open source AGPL-3.0
- 💼 **Deploy komersial / layanan SaaS / pengiriman privat**: memerlukan pembelian lisensi komersial (dapat dibebaskan dari kewajiban open source AGPL-3.0), untuk lisensi komersial hubungi: <kevin@xw.com>

---

## 📮 Hubungi kami

- 📧 Email: <kevin@xw.com>
- 🌐 Demo online: <https://aiwork.xw.com>
- 💬 Grup WeChat 「星网AI剧场开源交流」:

  ![QR Grup WeChat 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
