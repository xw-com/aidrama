**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | **Türkçe** | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI Kısa Dizi (Short Drama) Yapım Platformu

> 🌐 **Çevrimiçi demo**: <https://aiwork.xw.com> 　·　📮 Bize ulaşın: **kevin@xw.com**

Yapay zekâ ile kısa dizi (short drama) üretme konusunda eksiksiz bir sistem: **senaryo içe aktarma → karakter/sahne/props çıkarma → storyboard oluşturma → storyboard videoları üretme → tüm bölümleri birleştirme**.
Sunucu tarafı **Node.js + MySQL (/ SQLite yedek)**, ön yüz **Vue 3 + Element Plus** ile iki uçtan oluşur: **Web (client; yönetim paneli client/admin ve masaüstü kabuğu client/desktop dahil) + mobil (uniapp; App/mini program kabuğu/H5)**; REST API üzerinden iletişim kurar. Hesap sistemi **yerleşik yerel kayıt/giriş** (kullanıcı adı/e-posta/telefon + şifre) olup üçüncü taraf hiçbir hesap merkezine bağlı değildir.

---

## 🌐 Çevrimiçi Demo & İletişim

- **Demo adresi**: <https://aiwork.xw.com>
- **Kullanıcı kılavuzu**: [PC](docs/pc-user-manual.md) · [Mobil](docs/mobile-user-manual.md)
- **Sorun bildirimi / iş birliği**: <kevin@xw.com>

---

## ✨ Özellikler

| Modül | Açıklama |
|---|---|
| 👤 Kullanıcı sistemi | **Yerel kayıt / giriş** (kullanıcı adı/e-posta/telefon + şifre; kayıt sırasında tıklamalı metin captcha'sı gerekir) + **ekiple paylaşılan projeler** (davet/yetkiler) |
| 📖 Senaryo taslağı | `.txt` dosyasını yapıştırarak veya yükleyerek senaryoyu içe aktarın, **AI bunu birden çok bölüme böler**, bölüm bölüm düzenlenebilir |
| 🎭 Varlık kitaplığı | **AI ile karakter / sahne / props çıkarma**, varlık görsellerini tek tek veya toplu olarak üretme |
| 🎬 Bölüm videoları | **AI ile storyboard senaryosu üretimi** (klip senaryosu + anlatıcı sesi + ses yapılandırması + süre) |
| ✂️ Storyboard düzenleyici | solda varlıklar, ortada storyboard senaryosu, sağda video önizleme, altta klip zaman çizelgesi |
| 🎞️ Video üretimi | her klip için: (isteğe bağlı TTS) → video klip; üretimden sonra ilk kare otomatik olarak önizleme kapağı olarak çıkarılır |
| 🧩 Tüm bölümü birleştirme | ffmpeg seçilen klipleri birleştirir ve bölümün tamamını mp4 olarak çıkarır |
| 🔧 LLM yapılandırması | **tamamı yönetim panelinden yapılır** (metin/görsel/video/ses olmak üzere dört kategori; açma-kapatma / içe aktarma / dışa aktarma) |
| 💰 Kredili faturalandırma | LLM/medya çağıran her adımın bir fiyatı vardır, **krediler kullanıma göre düşülür** |
| 💳 Kredi yükleme | hazır paketler + **WeChat Pay (V3 · Native QR kodu / JSAPI)**, krediler kullanıma göre düşülür |
| 🎨 Tema | açık / koyu / sistemi otomatik izleme |

### Fiyatlandırma (düzenlenebilir, varsayılan değerler)
| İşlev | Birim | Kredi |
|---|---|---|
| Senaryo bölme | 1000 karakter başına | 10 |
| Varlık çıkarma | bölüm başına | 20 |
| Varlık görseli üretimi | görsel başına | 5 |
| **Storyboard senaryosu üretimi** | **100 karakter başına** | **2** |
| **Storyboard videosu üretimi** | **saniye başına** | **11** |
| Anlatıcı seslendirme (TTS) | 100 karakter başına | 3 |
| Video birleştirme | bölüm başına | 30 |

---

## 📂 Dizin yapısı

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize sunucu tarafı
│  ├─ src/
│  │  ├─ db/models/        # veritabanı tablo modelleri + ilişkiler
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST rotaları (projeler/varlıklar/storyboard/videolar/krediler/yükleme/vitrin/siparişler/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # fiyatlar + varsayılan model sağlayıcı kataloğu + başlangıç yöneticisi
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus Web istemcisi
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # yönetim paneli (ayrı giriş /admin, ayrı oturum ve token)
│  ├─ admin.html           # yönetim paneli giriş HTML'i
│  └─ desktop/             # Electron masaüstü kabuğu (Windows/macOS, bkz. client/desktop/README.md)
├─ uniapp/            # mobil istemci (uni-app: App / mini program kabuğu / H5)
└─ deploy/            # üretim dağıtımı: nginx.conf / PM2 / systemd / backup / DEPLOY.md runbook'u
```

---

## 🚀 Hızlı başlangıç

### 1. Sunucuyu başlatma

```bash
cd server
cp .env.example .env          # varsayılan DB_DIALECT=sqlite, yapılandırma gerektirmeden çalışır
npm install
npm run dev                   # http://localhost:3000, tablolar otomatik oluşturulur + seed
```

- **SQLite (kutudan çıktığı gibi çalışır, yerel deneme için önerilir)**: `DB_DIALECT=sqlite`, veriler `server/data/aidrama.db` içinde saklanır
- **MySQL**: `DB_DIALECT=mysql` yapıp `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` alanlarını doldurun
- **İlk çalıştırmada başlangıç yöneticisi otomatik oluşturulur** (konsola bir ipucu yazdırılır):
  - varsayılan hesap **`admin / admin123`**, yönetim paneli `/admin` girişi için
  - `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` ortam değişkenleriyle geçersiz kılınabilir; yönetici zaten varsa bu adım atlanır
  - ⚠️ Canlıya çıkmadan önce varsayılan şifreyi hemen değiştirin (`node scripts/setAdminPassword.js`, veya aşağıdaki yönetim paneli bölümüne bakın)

### 2. İstemciyi başlatma

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

<http://localhost:5173> adresini açın: hesabınız yoksa "Kayıt Ol"a tıklayın (kullanıcı adı + şifre, tıklamalı captcha'yı geçin; kayıt başarıyla tamamlanınca oturum açılır ve 66 deneme kredisi hediye verilir); hesabınız varsa doğrudan giriş yapın (kullanıcı adı / e-posta / telefon hep çalışır).

> İstemcide proxy zaten yapılandırılmıştır: `/api` ve `/files` otomatik olarak `http://localhost:3000` adresine yönlendirilir.

---

## 🛠 Yönetim paneli (client/admin) kullanımı

Yönetim paneli **ayrı giriş, ayrı oturum, ayrı token** kullanır (`admt_` önekli JWT; ön yüzün kullanıcı oturumlarıyla hiçbir bağı yoktur):

- **Giriş**: <http://localhost:5173/admin> (üretimde `https://alanadiniz/admin`)
- **Oturum açma**: hesap + şifre + tıklamalı metin captcha'sı. İlk çalıştırmada başlangıç yöneticisini kullanın: **`admin / admin123`**;
- **Şifre değiştirme**: panelde henüz bir şifre değiştirme sayfası yok; sunucu tarafı betiği kullanın:
  ```bash
  cd server
  node scripts/setAdminPassword.js <kullanıcı adı veya e-posta> <yeni şifre>
  ```
  (`adminAuth` girişi hesap olarak kullanıcı adı / e-posta / telefondan herhangi birini kabul eder)

### İşlev modülleri

| Modül | Amaç |
|---|---|
| **Model yapılandırması** | **metin / görsel / video / TTS olmak üzere dört tür LLM entegrasyonu** (bir sonraki bölüme bakın; canlıya çıkmadan önce zorunludur) |
| Model sağlayıcıları | sağlayıcı ve model kataloğu (yeni yapılandırma eklerken preset kaynağı; popüler sağlayıcılar seed ile birlikte gelir) |
| Sanatsal stiller / karakter seçenekleri / ses kitaplığı | üretim malzemesi sözlükleri (ön yüzdeki seçenekler buradan yapılandırılır) |
| Fiyatlandırma | her AI adımının kredi birim fiyatı (yukarıdaki tabloya bakın) |
| Kullanıcı yönetimi | kullanıcı arama, **yasaklama/yasağı kaldırma**, **şifre sıfırlama** (unutulan şifreler için tek kapı), kredi düzenleme, **tek tıkla kullanıcının ön yüzüne giriş** (login-as; kullanıcının adına sorun teşhisi için) |
| Ödemeler | WeChat kredi yükleme siparişlerinin sorgusu / mutabakatı |
| Vitrin moderasyonu | vitrin merkezindeki eserleri yayınlama/yayından kaldırma |
| Görev yönetimi / video üretim yönetimi | eşzamansız görevler ile video üretim kuyruğunda yeniden deneme/temizleme |
| Bakım | bakım modu anahtarı (503 + tahmini kurtarma süresi), veri bakımı |
| Giriş kayıtları | site genelinde giriş kayıtları (yöntem / IP / UA) |

---

## 🔌 LLM / medya yapılandırması (AI işlevlerini gerçekten çalışır kılmak için)

Tüm AI yetenekleri **yapılandırmayla yönetilir** ve **tek bir yerden, yönetim panelindeki "Model Yapılandırması" sayfasından** idare edilir (`.env` artık hiçbir varsayılan LLM yapılandırması sağlamaz). Yapılandırılmadığında: metin işlevleri çağrıdan önce uyarı verir; görsel/video/TTS doğrudan "yapılandırılmadı" hatası döndürür.

Yapılandırma adımları:

1. `/admin` yönetim paneline girin → **Model Yapılandırması** → ekle;
2. türü (metin / görsel / video / TTS) ve protokolü seçin, şunları doldurun:
   - **Base URL** (örn. `https://api.openai.com/v1`)
   - **API Key** (yalnızca sunucuda saklanır, ön yüze gönderilmez)
   - **Model adı** (örn. `gpt-4o-mini`, `dall-e-3`)
   - etkinlik durumu ve bu yapılandırmanın kredi fiyatı;
3. kaydettikten sonra ön yüzde anında kullanılabilir (aynı tür için birden çok kayıt eklenip açılıp kapatılabilir); "Model Yapılandırması" sayfası **JSON içe / dışa aktarmayı** destekler, toplu taşıma için uygundur.

Desteklenen protokoller:

- **Metin / görsel / TTS**: OpenAI uyumlu (`/chat/completions`, `/images/generations`, `/audio/speech`) veya özel endpoint (`api_style=custom`)
- **Video**: eşzamansız görev uç noktalarını yapılandırın (gönder → yokla → video URL'si); gerçek bir video üretim sağlayıcısı gerekir (yerel ffmpeg "görselden videoya" modu devre dışı bırakıldı)

> Kullanıcı tarafında ayrıca "Kişisel Ayarlar → Modellerim" bölümünden **özel modeller** eklenebilir (kendi anahtarıyla; çağrılar kredi harcamaz), genel yapılandırmayı etkilemez.
> Yerelde `ffmpeg` kurulu olmalıdır (macOS: `brew install ffmpeg`). Video kliplerin birleştirilmesi buna bağlıdır.

---

## 🚢 Üretim dağıtımı

Eksiksiz runbook için bkz. **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (nginx yayına alma kontrol listesi, PM2/systemd tek örnek, yedekleme/geri yükleme, WeChat Pay canlıya alma, uyumluluk yapılacakları). En düşük ortam gereksinimleri:

```bash
NODE_ENV=production            # ayarlanmazsa JWT geliştirme yedek anahtarı devreye girer: güvenlik riski
JWT_SECRET=<yerel oturum jetonlarını imzalama anahtarı, uzun rastgele dizgi>      # sistem kullanıcı oturumlarını kendi imzalar/doğrular (axt_)
ADMIN_JWT_SECRET=<yönetim paneli için ayrı imzalama anahtarı>
FILE_SIGN_SECRET=<medya hotlink koruması imza anahtarı>   # deploy/nginx.conf içindeki secure_link anahtarıyla aynı olmalıdır
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay için ayrıca beşli `WECHAT_PAY_*` seti gerekir (merchant numarası, AppID, APIv3 anahtarı, sertifika seri numarası, merchant özel anahtarı); bkz. `deploy/DEPLOY.md` ⑦.

---

## 🔑 Giriş ve hesap sistemi (yerel, harici bağımlılık yok)

Hesap sistemi **sistemin kendisine gömülüdür**: kayıt / giriş / şifre değiştirme / oturum yenilemenin tamamı kendi sunucumuzdaki `/api/auth/*` üzerinden yürür, üçüncü taraf hiçbir hesap merkezine bağlı değildir:

- **Kayıt**: kullanıcı adı (2-64 karakter; harf, rakam, `_.-`) + şifre (≥6 karakter) + e-posta (isteğe bağlı); tıklamalı metin captcha'sından geçmek gerekir (görselleri sunucu SVG olarak üretir, `/api/captcha/*`); kayıt başarıyla tamamlanınca oturum açılır ve 66 deneme kredisi hediye verilir;
- **Giriş**: kullanıcı adı / e-posta / telefondan herhangi biri + şifre; captcha "gönderildiyse" doğrulanır (ön yüz varsayılan olarak gönderir);
- **Jetonlar**: sunucunun kendi imzaladığı JWT (`axt_` öneki, access + refresh, refresh döndürülmez); ön yüz sessiz yenilemeyi `/api/auth/oauth/refresh` üzerinden yapar; yönetim paneli jetonları ayrıdır (`admt_` öneki);
- **Şifremi unuttum**: kendi kendine kurulan örneklerde SMS/e-posta kanalı olmadığından self servis sıfırlama yoktur — sıfırlamayı yönetici **yönetim paneli → "Kullanıcı Yönetimi" → şifre sıfırlama** üzerinden yapar;
- **Yasaklama**: yasaklamanın ardından kullanıcının verilmiş tüm jetonları bir sonraki istekte geçersiz olur (sunucu her istekte kullanıcı durumunu yeniden sorgular);
- **Üçüncü taraf girişi (isteğe bağlı)**: mobil uygulamalarda Apple / Google tek dokunuşla giriş hâlâ kullanılabilir — sunucu anahtarlarıyla vekil olarak takası yapar (`POST /api/auth/oauth/:provider`) ve aynı yerel `axt_` oturumunu döndürür; Web sürümü herhangi bir callback kaydı gerektirmez.

İlgili `.env` değişkenleri: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (hepsi `server/.env.example` yorumlarında).

---

## 💚 WeChat Pay (V3 · Native QR kodu / JSAPI)

Gerçek WeChat Pay: **yapılandırmayla yönetilir, varsayılan olarak kapalıdır** (`.env` içinde `WECHAT_PAY_*` boş bırakılırsa etkin olmaz ve ön yüz kredi yükleme girişini otomatik gizler). `WECHAT_APP_ID` yalnızca ödeme AppID'si için yedek değer olarak tutulur.

[WeChat merchant platformunda](https://pay.weixin.qq.com/) Native/JSAPI ödemelerini açın, merchant numarası ile APIv3 anahtarını alın ve merchant API sertifikasını indirin (`apiclient_key.pem` + sertifika seri numarası). **Merchant numarası ile AppID'nin merchant platformunda eşleştirilmiş olması gerekir** (aksi halde sipariş oluşturma `APPID_MCHID_NOT_MATCH` döndürür). Yapılandırma:
```bash
WECHAT_PAY_METHOD=native       # native=QR kodla ödeme | jsapi=resmi hesap içinde ödeme (PC'de H5 kasa)
WECHAT_PAY_APP_ID=             # merchant numarasına eşlenmiş AppID (boşsa WECHAT_APP_ID'ye düşer)
WECHAT_PAY_MCH_ID=<merchant numaranız>
WECHAT_PAY_API_V3_KEY=         # 32 karakterlik APIv3 anahtarı
WECHAT_PAY_SERIAL_NO=          # merchant API sertifikası seri numarası
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # apiclient_key.pem'in diskteki yolu (bir alttaki satırla ikisinden biri)
WECHAT_PAY_PRIVATE_KEY=        # veya PEM metnini doğrudan satır içi verin
WECHAT_PAY_NOTIFY_URL=         # boşsa ${PUBLIC_BASE_URL}/api/recharge/wechat/notify kullanılır
```
- Akış: kredi merkezinde "WeChat Pay" seçin → arka uç tek tip sipariş oluşturur (Native `code_url` döndürür ve QR kod çizilir / JSAPI ödemeyi başlatır) → kullanıcı öder → WeChat'in eşzamansız geri çağrısı `/api/recharge/wechat/notify` adresine gelir (AES-256-GCM şifre çözümü ve doğrulama, idempotent hesaba geçirme).
- Geri çağrı **internetten erişilebilir bir HTTPS adresi** olmalıdır (geliştirme sırasında iç ağ tüneli kullanılabilir).

> Canlıya alma adımları (merchant platformunda AppID eşleme, sertifikayı sunucuya yerleştirme, bir kuruşluk gerçek siparişle regresyon testi) için bkz. **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ WeChat Pay canlıya alma adımları**.
> Veritabanı: ödeme siparişinin işlem numarası `recharge_orders.transaction_id` alanına yazılır; başlangıçta `ensureColumns` ile idempotent şekilde tamamlanır, eski veritabanlarını etkilemez.

---

## 🧪 Uçtan uca doğrulama adımları

0. Yönetim paneli `/admin` (admin/admin123) → **Model Yapılandırması** → metin/görsel/video/TTS dördünü de yapılandırın (aksi halde AI adımları kullanılamaz)
1. Ön yüzde kayıt olun/giriş yapın → yeni proje → "Senaryo Taslağı"na senaryoyu yapıştırın/yükleyin → **AI ile senaryo bölme** (kredi düşer)
2. "Varlık Kitaplığı" → **AI ile varlık çıkarma** → karakterler/sahneler için **varlık görsellerini üretin**
3. "Bölüm Videoları" → **senaryo üret** → **storyboard düzenleyiciye** girin
4. Düzenleyicide bir klip seçin → **hemen üret** (video klip; ilk kare otomatik olarak önizleme kapağı çıkarılır)
5. **Tüm bölümü birleştirin** (ffmpeg bölümün tamamını mp4 olarak birleştirir)
6. "Kredi Merkezi"nde hareketleri görüntüleyin, kredi yükleyin; yönetim panelinde fiyatları değiştirin / yasaklayın / şifre sıfırlayın / giriş kayıtlarına bakın; açık/koyu/otomatik temayı değiştirin

---

## 📡 Ana API'ler (`/api` öneki, JWT kimlik doğrulaması, birleşik `{code,message,data}`)

```
POST /auth/register | /auth/login                              # yerel kayıt (captcha ticket'ı gerekir) / giriş (herkese açık, hız sınırı var)
POST /auth/password                                            # şifre değiştirme (oturum açıkken)
POST /auth/oauth/refresh                                       # sessiz yenileme (refresh_token ile yeni access_token, herkese açık)
POST /auth/oauth/:provider                                     # üçüncü taraf girişini yerel oturuma çevirme (apple/google/weixin/huawei, isteğe bağlı)
GET /auth/me   POST /auth/sync                                 # kullanıcı profili
POST /captcha/challenge | /captcha/verify                      # tıklamalı metin captcha'sı
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # eşzamansız görev merkezi (ön yüz yoklama yapar)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # genel yapılandırma okuma tarafı + içe/dışa aktarma (yönetim panelinde yönetilir)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # WeChat Pay geri çağrısı (kimlik doğrulamasız, imza doğrulama + idempotent)
GET /showcase/*                                                # vitrin (yayınlama/göz atma/aynısından yapma)
GET /market/*                                                  # sipariş merkezi (görev emirleri/escrow/kabul)
GET /pricing
```
Her AI uç noktasının kredi tahmini için karşılık gelen bir `…/estimate` ucu vardır; yönetim uçları (`/admin/*`: kullanıcılar/ödemeler/görevler/kayıtlar/bakım vb.) ayrı bir yönetim paneli jetonu (`admt_`) kullanır.

---

## 🛠 Teknoloji yığını

**Sunucu**: Express · Sequelize (mysql/sqlite çift dialect) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (masaüstü kabuğu: Electron + electron-updater)
**Mobil**: uni-app (App / mini program kabuğu / H5)

## 📝 Notlar

- Bu proje "uçtan uca çalışan işlevler" tabanını teslim eder: tüm API'ler ve sayfalar gerçekten çalışır ve çalıştırılabilir; UI, referans tasarımların yapısını ve durumlarını izler.
- Harici sağlayıcıların (görsel/video/TTS) gerçek materyal üretebilmesi için **yönetim panelinde** gerçek anahtarlarla yapılandırılması gerekir; ffmpeg yalnızca video klipleri birleştirmek için kullanılır.
- Sequelize modellerini değiştirdikten sonra SQLite kullanıyorsanız `server/data/*.db` dosyalarını silip yeniden başlatın (üretimde migration önerilir).

---

## 📄 Açık kaynak lisansı

Bu proje [AGPL-3.0](LICENSE) ile açık kaynaklıdır.

- ✅ **Kişisel öğrenim, araştırma, ticari olmayan kullanım**: ücretsiz; değiştirilmiş haliyle ağ hizmeti sunmak AGPL-3.0 açık kaynak yükümlülüklerini gerektirir
- 💼 **Ticari dağıtım / SaaS hizmeti / özel kurulum**: ticari lisans gerekir (AGPL-3.0 açık kaynak yükümlülüklerinden muafiyet sağlar); ticari lisans için iletişim: <kevin@xw.com>

---

## 📮 Bize ulaşın

- 📧 E-posta: <kevin@xw.com>
- 🌐 Çevrimiçi demo: <https://aiwork.xw.com>
- 💬 WeChat grubu "星网AI剧场开源交流" (星网 AI Tiyatrosu açık kaynak topluluğu):

  ![星网AI剧场开源交流 WeChat grubu QR kodu](docs/wechat-group-qr.jpg)
