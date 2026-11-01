**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | **Deutsch** | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · KI-Produktionsplattform für Kurzdramen

> 🌐 **Online-Demo**: <https://aiwork.xw.com> 　·　📮 Kontakt: **kevin@xw.com**

Ein vollständiges KI-System zur Erstellung von Kurzdramen: **Drehbuch importieren → Charaktere/Szenen/Requisiten extrahieren → Storyboards generieren → Storyboard-Videos generieren → Gesamtefolge zusammenfügen**.
Der Server basiert auf **Node.js + MySQL (mit SQLite-Fallback)**; es gibt zwei Frontends auf Basis von **Vue 3 + Element Plus**: **Web (client, inklusive Admin-Dashboard client/admin und Desktop-Shell client/desktop) + Mobile (uniapp, Shell für App/Mini-Programme/H5)**, die über eine REST-API kommunizieren. Das Kontosystem ist eine **integrierte lokale Registrierung/Anmeldung** (Benutzername/E-Mail/Telefon + Passwort) und hängt von keinem externen Kontoanbieter ab.

---

## 🌐 Online-Demo & Austausch

- **Demo-Adresse**: <https://aiwork.xw.com>
- **Fehlermeldungen / Kooperation**: <kevin@xw.com>

---

## ✨ Funktionen

| Modul | Beschreibung |
|---|---|
| 👤 Benutzersystem | **Lokale Registrierung / Anmeldung** (Benutzername/E-Mail/Telefon + Passwort, Registrierung erfordert ein Textauswahl-Captcha) + **geteilte Team-Projekte** (Einladungen/Berechtigungen) |
| 📖 Drehbuch-Gliederung | Drehbuch per Copy-Paste oder `.txt`-Upload importieren; die **KI gliedert es in mehrere Episoden**, die sich einzeln bearbeiten lassen |
| 🎭 Asset-Bibliothek | **KI extrahiert Charaktere / Szenen / Requisiten**, Asset-Bilder einzeln oder im Batch generierbar |
| 🎬 Episoden-Video | **KI generiert das Storyboard-Skript** (Segment-Skript + Erzählung + Sprachkonfiguration + Dauer) |
| ✂️ Storyboard-Editor | Assets links, Storyboard-Skript in der Mitte, Videovorschau rechts, Episoden-Timeline unten |
| 🎞️ Videogenerierung | Je Segment: (optional TTS) → Videoclip; nach der Generierung wird automatisch der erste Frame als Vorschaubild extrahiert |
| 🧩 Gesamtefolge zusammenfügen | ffmpeg verkettet die ausgewählten Segmente und exportiert das mp4 der gesamten Folge |
| 🔧 LLM-Konfiguration | **Alles wird im Admin-Dashboard konfiguriert** (vier Kategorien: Text/Bild/Video/Sprache; aktivierbar/deaktivierbar, importier- und exportierbar) |
| 💰 Credit-Abrechnung | Jeder Schritt, der Modelle/Medien aufruft, hat einen Preis; **Credits werden nach Verbrauch abgezogen** |
| 💳 Aufladung | Vorgefertigte Pakete + **WeChat Pay (V3 · Native per QR-Code / JSAPI)**, Credit-Abzug nach Verbrauch |
| 🎨 Themes | Hell / Dunkel / Systemautomatik |

### Preise (editierbar; Standardwerte)
| Funktion | Einheit | Credits |
|---|---|---|
| Drehbuch-Aufteilung | pro 1000 Zeichen | 10 |
| Asset-Extraktion | pro Episode | 20 |
| Asset-Bildgenerierung | pro Bild | 5 |
| **Storyboard-Skript-Generierung** | **pro 100 Zeichen** | **2** |
| **Storyboard-Videogenerierung** | **pro Sekunde** | **11** |
| Erzählung per Sprachausgabe (TTS) | pro 100 Zeichen | 3 |
| Videoschnitt | pro Episode | 30 |

---

## 📂 Verzeichnisstruktur

```
AIDrama/
├─ server/            # Server: Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # Tabellenmodelle + Beziehungen
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST-Routen (Projekte/Assets/Storyboards/Videos/Credits/Aufladung/Showcase/Market/Admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Preise + Standardkatalog der Modellanbieter + initialer Administrator
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Web-Client: Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Admin-Dashboard (eigenständiger Einstieg /admin, mit eigener Anmeldung und eigenem Token)
│  ├─ admin.html           # Einstiegs-HTML des Admin-Dashboards
│  └─ desktop/             # Electron-Desktop-Shell (Windows/macOS, siehe client/desktop/README.md)
├─ uniapp/            # Mobile Client (uni-app: App / Mini-Programm-Shell / H5)
└─ deploy/            # Produktiv-Deployment: nginx.conf / PM2 / systemd / Backup / DEPLOY.md-Runbook
```

---

## 🚀 Schnellstart

### 1. Server starten

```bash
cd server
cp .env.example .env          # Standard: DB_DIALECT=sqlite, läuft ohne jede Konfiguration
npm install
npm run dev                   # http://localhost:3000 , legt Tabellen automatisch an + Seed
```

- **SQLite (funktioniert sofort, für lokale Tests empfohlen)**: `DB_DIALECT=sqlite`, Daten liegen in `server/data/aidrama.db`
- **MySQL**: `DB_DIALECT=mysql` setzen und `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` ausfüllen
- **Beim ersten Start wird der initiale Administrator automatisch angelegt** (die Konsole gibt einen Hinweis aus):
  - Standardkonto **`admin / admin123`**, für die Anmeldung im Admin-Dashboard `/admin`
  - Per Umgebungsvariablen `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` überschreibbar; falls bereits ein Admin existiert, wird der Schritt automatisch übersprungen
  - ⚠️ Vor dem Produktivbetrieb bitte sofort das Standardpasswort ändern (`node scripts/setAdminPassword.js`, siehe auch den Abschnitt zum Admin-Dashboard weiter unten)

### 2. Client starten

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Öffne <http://localhost:5173>: Ohne Konto auf „Registrieren“ klicken (Benutzername + Passwort, mit einem Textauswahl-Captcha; nach der Registrierung bist du automatisch angemeldet und erhältst 66 Test-Credits); mit Konto direkt anmelden (Benutzername / E-Mail / Telefonnummer – alles möglich).

> Der Client hat bereits einen Proxy konfiguriert: `/api` und `/files` werden automatisch an `http://localhost:3000` weitergeleitet.

---

## 🛠 Nutzung des Admin-Dashboards (client/admin)

Das Admin-Dashboard hat einen **eigenständigen Einstieg, eine eigene Anmeldung und ein eigenes Token** (JWT mit Präfix `admt_`, komplett getrennt von den Frontend-Benutzersitzungen):

- **Einstieg**: <http://localhost:5173/admin> (in Produktion: `https://deine-domain.de/admin`)
- **Anmeldung**: Konto + Passwort + Textauswahl-Captcha. Beim ersten Start das initiale Administratorkonto **`admin / admin123`** verwenden;
- **Passwort ändern**: Das Dashboard hat derzeit keine Seite dafür; zum Zurücksetzen das Server-Skript verwenden:
  ```bash
  cd server
  node scripts/setAdminPassword.js <Benutzername oder E-Mail> <neues Passwort>
  ```
  (Der `adminAuth`-Login akzeptiert Benutzername / E-Mail / Telefonnummer als Konto)

### Funktionsmodule

| Modul | Zweck |
|---|---|
| **Modellkonfiguration** | **Anbindung von LLMs in vier Kategorien: Text / Bild / Video / TTS** (siehe nächster Abschnitt; vor dem Produktivbetrieb zwingend) |
| Modellanbieter | Anbieter- und Modellkatalog (Vorlagen beim Anlegen neuer Konfigurationen; der Seed enthält bereits die gängigen Anbieter) |
| Kunststile / Charakteroptionen / Sprachbibliothek | Wörterbücher der Kreativmaterialien (die Auswahlmöglichkeiten im Frontend werden hier konfiguriert) |
| Preise | Credit-Preis je KI-Schritt (siehe Tabelle oben) |
| Benutzerverwaltung | Benutzer suchen, **sperren/entsperren**, **Passwörter zurücksetzen** (zentraler Einstieg bei vergessenem Passwort), Credits anpassen, **sich als Benutzer im Frontend anmelden** (login-as, zur Fehlersuche im Namen des Nutzers) |
| Zahlungen | Abfrage und Abstimmung der WeChat-Aufladeaufträge |
| Showcase-Prüfung | Werke im Showcase-Center veröffentlichen/offline nehmen |
| Aufgabenverwaltung / Verwaltung der Videogenerierung | Wiederholung und Bereinigung der Warteschlangen für asynchrone Aufgaben und Videogenerierung |
| Wartung | Schalter für den Wartungsmodus (503 + voraussichtliche Wiederherstellungszeit), Datenwartung |
| Anmeldeprotokoll | Anmeldeaufzeichnungen der gesamten Website (Methode / IP / UA) |

---

## 🔌 LLMs / Medien konfigurieren (damit die KI-Funktionen wirklich funktionieren)

Die gesamte KI-Fähigkeit ist **konfigurationsgetrieben** und wird **zentral auf der Seite „Modellkonfiguration“ des Admin-Dashboards gepflegt** (die `.env` stellt keine Standard-LLM-Konfiguration mehr bereit). Ohne Konfiguration: Textfunktionen weisen vor dem Aufruf darauf hin; Bild/Video/TTS liefern direkt den Fehler „nicht konfiguriert“.

Konfigurationsschritte:

1. Im Dashboard `/admin` anmelden → **Modellkonfiguration** → Neu anlegen;
2. Typ (Text / Bild / Video / TTS) und Protokoll wählen und ausfüllen:
   - **Base URL** (z. B. `https://api.openai.com/v1`)
   - **API Key** (wird nur serverseitig gespeichert, niemals an das Frontend ausgeliefert)
   - **Modellname** (z. B. `gpt-4o-mini`, `dall-e-3`)
   - Aktivierungsstatus und die Credit-Preise dieser Konfiguration;
3. Nach dem Speichern ist das Frontend sofort nutzbar (mehrere Konfigurationen pro Typ möglich, umschaltbar); die Seite „Modellkonfiguration“ unterstützt **Import / Export von JSON** – praktisch für Massenmigrationen.

Unterstützte Protokolle:

- **Text / Bild / TTS**: OpenAI-kompatibel (`/chat/completions`, `/images/generations`, `/audio/speech`) oder benutzerdefinierter Endpoint (`api_style=custom`)
- **Video**: Endpoint für asynchrone Aufgaben konfigurieren (Einreichen → Polling → Video-URL); benötigt einen echten Videogenerierungs-Provider (das lokale ffmpeg „Bild-zu-Video“ wurde eingestellt)

> Nutzer können unter „Persönliche Einstellungen → Meine Modelle“ zusätzlich **private Modelle** hinterlegen (eigener Key; Aufrufe kosten keine Credits), ohne die globale Konfiguration zu beeinflussen.
> Dazu muss `ffmpeg` lokal installiert sein (macOS: `brew install ffmpeg`). Das Zusammenfügen der Videoclips hängt davon ab.

---

## 🚢 Produktiv-Deployment

Das vollständige Runbook steht in **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (nginx-Go-live-Checkliste, PM2/systemd-Einzelinstanz, Backup & Wiederherstellung, WeChat-Pay-Go-live, Compliance-Aufgaben). Minimale Umgebungsvoraussetzungen:

```bash
NODE_ENV=production            # Sonst greift ein Entwicklungs-Fallback-JWT-Schlüssel: Sicherheitsrisiko
JWT_SECRET=<zufällige lange Zeichenkette zum Signieren der lokalen Session-Tokens>      # Dieses System signiert/prüft die Benutzersitzungen selbst (axt_)
ADMIN_JWT_SECRET=<eigener Signaturschlüssel des Admin-Dashboards>
FILE_SIGN_SECRET=<Signaturschlüssel gegen Hotlinking von Medien>   # Muss mit dem secure_link-Schlüssel in deploy/nginx.conf übereinstimmen
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

Für WeChat Pay kommen zusätzlich die fünf `WECHAT_PAY_*`-Werte dazu (Händler-ID, AppID, APIv3-Schlüssel, Zertifikatsseriennummer, privater Händlerschlüssel), siehe `deploy/DEPLOY.md` ⑦.

---

## 🔑 Anmeldung und Kontosystem (lokal, ohne externe Abhängigkeiten)

Das Kontosystem ist **im System integriert**: Registrierung / Anmeldung / Passwortwechsel / Sitzungsverlängerung laufen vollständig über den eigenen Server `/api/auth/*`, ohne irgendeinen externen Kontoanbieter:

- **Registrierung**: Benutzername (2–64 Zeichen: Buchstaben, Ziffern, `_.-`) + Passwort (≥6 Zeichen) + E-Mail (optional); das Textauswahl-Captcha ist Pflicht (Backend stellt Aufgaben als SVG, `/api/captcha/*`); nach der Registrierung bist du automatisch angemeldet und erhältst 66 Test-Credits;
- **Anmeldung**: Benutzername / E-Mail / Telefonnummer, je eines + Passwort; das Captcha wird „nur geprüft, wenn es mitgeschickt wird“ (das Frontend sendet es standardmäßig);
- **Tokens**: Serverseitig selbst signiertes JWT (Präfix `axt_`, access + refresh, das refresh rotiert nicht); die stille Verlängerung des Frontends läuft über `/api/auth/oauth/refresh`; die Dashboard-Tokens sind davon getrennt (Präfix `admt_`);
- **Passwort vergessen**: Selbst gehostete Instanzen haben keinen SMS-/E-Mail-Kanal und bieten keine Selbsthilfe-Rücksetzung – ein Administrator erledigt das im **Admin-Dashboard unter „Benutzerverwaltung“ → Passwort zurücksetzen**;
- **Sperrung**: Nach der Sperrung werden alle ausgestellten Tokens dieses Nutzers bei der nächsten Anfrage ungültig (der Server prüft den Benutzerstatus bei jeder Anfrage neu);
- **Anmeldung über Drittanbieter (optional)**: Der Apple-/Google-One-Tap-Login der mobilen App funktioniert weiterhin – der Server tauscht mit hinterlegten Geheimnissen als Vermittler (`POST /api/auth/oauth/:provider`) und liefert dieselbe lokale `axt_`-Sitzung zurück; im Web ist keine Callback-Registrierung nötig.

Relevante `.env`-Variablen: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (alle in den Kommentaren von `server/.env.example` erläutert).

---

## 💚 WeChat Pay (V3 · Native per QR-Code / JSAPI)

Echtes WeChat Pay, **konfigurationsgetrieben und standardmäßig deaktiviert** (bleiben `WECHAT_PAY_*` in der `.env` leer, ist die Funktion aus und das Frontend blendet die Aufladung automatisch aus). `WECHAT_APP_ID` bleibt nur als Fallback-Wert für die Bezahl-AppID erhalten.

Aktiviere Native-/JSAPI-Zahlungen auf der [WeChat-Händlerplattform](https://pay.weixin.qq.com/) (WeChat Pay Merchant Platform), besorge dir Händler-ID und APIv3-Schlüssel und lade das Händler-API-Zertifikat herunter (`apiclient_key.pem` + Zertifikatsseriennummer). **Händler-ID und AppID müssen auf der Händlerplattform verknüpft sein** (sonst schlägt die Auftragsanlage mit `APPID_MCHID_NOT_MATCH` fehl). Konfiguration:
```bash
WECHAT_PAY_METHOD=native       # native=QR-Code | jsapi=Zahlung im offiziellen Konto (am PC über die H5-Kasse)
WECHAT_PAY_APP_ID=             # Mit der Händler-ID verknüpfte AppID (leer lassen → Fallback auf WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<deine Händler-ID>
WECHAT_PAY_API_V3_KEY=         # 32-stelliger APIv3-Schlüssel
WECHAT_PAY_SERIAL_NO=          # Seriennummer des Händler-API-Zertifikats
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Dateipfad von apiclient_key.pem (Alternative zur nächsten Zeile)
WECHAT_PAY_PRIVATE_KEY=        # Oder direkt den PEM-Text inline
WECHAT_PAY_NOTIFY_URL=         # Leer lassen → ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Ablauf: Im Credit-Center „WeChat Pay“ wählen → Backend legt den einheitlichen Auftrag an (Native liefert `code_url` zum Anzeigen des QR-Codes / JSAPI ruft die Zahlung auf) → der Nutzer zahlt → WeChat ruft asynchron `/api/recharge/wechat/notify` auf (AES-256-GCM-Entschlüsselung und -Prüfung, idempotente Gutschrift).
- Der Callback muss eine **vom öffentlichen Internet erreichbare HTTPS-Adresse** sein (in der Entwicklung hilft ein Netzwerktunnel).

> Go-live-Schritte (AppID-Verknüpfung auf der Händlerplattform, Zertifikat auf den Server legen, Regression mit einem echten Ein-Cent-Auftrag) siehe **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Go-live-Schritte für WeChat Pay**.
> Datenbank: Die Transaktionsnummer des Bezahlauftags wird in `recharge_orders.transaction_id` geschrieben, beim Start per `ensureColumns` idempotent ergänzt; bestehende Datenbanken bleiben unberührt.

---

## 🧪 End-to-End-Verifikation

0. Admin-Dashboard `/admin` (admin/admin123) → **Modellkonfiguration** → alle vier Kategorien (Text/Bild/Video/TTS) konfigurieren, sonst sind die KI-Schritte nicht nutzbar
1. Frontend registrieren/anmelden → neues Projekt → „Drehbuch-Gliederung“: Drehbuch einfügen/hochladen → **Drehbuch-Aufteilung per KI** (kostet Credits)
2. „Asset-Bibliothek“ → **Asset-Extraktion per KI** → für Charaktere/Szenen **Asset-Bilder generieren**
3. „Episoden-Video“ → **Skript generieren** → in den **Storyboard-Editor** wechseln
4. Im Editor ein Segment auswählen → **jetzt generieren** (Videoclip, erster Frame wird automatisch als Vorschaubild extrahiert)
5. **Gesamtefolge zusammenfügen** (ffmpeg verkettet das mp4 der ganzen Folge)
6. Im „Credit-Center“ Bewegungen einsehen und aufladen; im Dashboard Preise ändern / sperren / Passwörter zurücksetzen / Anmeldeprotokoll ansehen; zwischen hellem/dunklem/automatischem Theme wechseln

---

## 📡 Wichtigste API (`/api`-Präfix, JWT-Authentifizierung, einheitliches `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Lokale Registrierung (Captcha-Ticket erforderlich) / Anmeldung (öffentlich, ratenbegrenzt)
POST /auth/password                                            # Passwort ändern (eingeloggt)
POST /auth/oauth/refresh                                       # Stille Verlängerung (refresh_token gegen neues access_token, öffentlich)
POST /auth/oauth/:provider                                     # Drittanbieter-Login gegen lokale Sitzung tauschen (apple/google/weixin/huawei, optional)
GET /auth/me   POST /auth/sync                                 # Benutzerprofil
POST /captcha/challenge | /captcha/verify                      # Textauswahl-Captcha
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Zentrum für asynchrone Aufgaben (Frontend pollt)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Leseseite der globalen Konfiguration + Import/Export (im Dashboard gepflegt)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # WeChat-Pay-Callback (ohne Authentifizierung, Signaturprüfung + idempotent)
GET /showcase/*                                                # Showcase-Center (veröffentlichen/stöbern/nachbauen)
GET /market/*                                                  # Auftrags-Center (Aufträge/Treuhänder/Abnahme)
GET /pricing
```
Jeder KI-Endpoint hat einen zugehörigen `…/estimate`-Endpoint zur Credit-Vorhersage; Admin-Endpoints (`/admin/*`: Benutzer/Zahlungen/Aufgaben/Protokolle/Wartung usw.) nutzen ein eigenes Dashboard-Token (`admt_`).

---

## 🛠 Tech-Stack

**Server**: Express · Sequelize (doppelter Dialekt mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (Desktop-Shell: Electron + electron-updater)
**Mobil**: uni-app (App / Mini-Programm-Shell / H5)

## 📝 Hinweise

- Dieses Projekt liefert eine „end-to-end funktionsfähige“ Basis: Alle APIs und Seiten funktionieren wirklich und sind ausführbar; das UI bildet Struktur und Zustände der Referenzdesigns nach.
- Externe Provider (Bild/Video/TTS) brauchen echte Keys im **Admin-Dashboard**, um wirkliches Material end-to-end zu erzeugen; ffmpeg dient ausschließlich dem Verketten und Zusammenfügen der Videoclips.
- Nach Änderungen an den Sequelize-Modellen unter SQLite bitte `server/data/*.db` löschen und neu initialisieren (in Produktion werden Migrationen empfohlen).

---

## 📄 Open-Source-Lizenz

Dieses Projekt ist unter [AGPL-3.0](LICENSE) als Open Source lizenziert.

- ✅ **Persönliche Nutzung, Studium, Forschung und nicht-kommerzielle Nutzung**: kostenlos; wer danach einen Netzwerkdienst anbietet, muss die Open-Source-Pflichten der AGPL-3.0 einhalten
- 💼 **Kommerzielles Deployment / SaaS-Dienste / Private Delivery**: erfordert den Kauf einer kommerziellen Lizenz (die die Open-Source-Pflichten der AGPL-3.0 aufheben kann); für kommerzielle Lizenzen bitte kontaktieren: <kevin@xw.com>

---

## 📮 Kontakt

- 📧 E-Mail: <kevin@xw.com>
- 🌐 Online-Demo: <https://aiwork.xw.com>
- 💬 WeChat-Gruppe „星网AI剧场开源交流“ (Open-Source-Austausch des Xingwang-KI-Theaters):

  ![QR-Code der WeChat-Gruppe 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
