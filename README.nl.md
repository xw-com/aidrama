**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | **Nederlands** | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI-kortdramaplatform

> 🌐 **Online demo**: <https://aiwork.xw.com> 　·　📮 Contact: **kevin@xw.com**

Een AI-systeem voor het maken van kortdrama's: **scenario importeren → personages/scènes/props extraheren → storyboard genereren → storyboardvideo's genereren → volledige aflevering monteren**.
De serverzijde draait op **Node.js + MySQL (met SQLite als fallback)**, de frontend bestaat uit twee Vue 3 + Element Plus-versies: **web (client, inclusief het beheerderspaneel client/admin en de desktopshell client/desktop) + mobiel (uniapp, app-/miniprogramma-/H5-shell)**, die via een REST API communiceren. Het accountsysteem is een **ingebouwd lokaal registratie-/loginsysteem** (gebruikersnaam/e-mailadres/telefoonnummer + wachtwoord), zonder afhankelijkheid van enige externe accountdienst.

---

## 🌐 Online demo & community

- **Demo-adres**: <https://aiwork.xw.com>
- **Gebruikershandleiding**: [PC](docs/pc-user-manual.md) · [Mobiel](docs/mobile-user-manual.md)
- **Problemen melden / samenwerken**: <kevin@xw.com>

---

## ✨ Functies

| Module | Omschrijving |
|---|---|
| 👤 Gebruikerssysteem | **Lokaal registreren / inloggen** (gebruikersnaam/e-mailadres/telefoonnummer + wachtwoord, registratie vereist een tekstselectie-captcha) + **teamgedeelde projecten** (uitnodigingen/rechten) |
| 📖 Scenario-outline | Plak een script of upload een `.txt`-bestand, **AI splitst het in meerdere afleveringen**, per aflevering bewerkbaar |
| 🎭 Assetbibliotheek | **AI extraheert personages / scènes / props**, assetafbeeldingen afzonderlijk of in bulk genereren |
| 🎬 Video per aflevering | **AI genereert het storyboardscenario** (scène-script + voice-over + spraakconfiguratie + duur) |
| ✂️ Storyboardeditor | Links de assets, in het midden het storyboardscenario, rechts de videovoorbeeldweergave, onderaan de tijdlijn van de aflevering |
| 🎞️ Videogeneratie | Per scène: (optionele TTS) → videoclip; na generatie wordt automatisch het eerste frame als voorbeeldcover geëxtraheerd |
| 🧩 Volledige aflevering monteren | ffmpeg voegt de geselecteerde scènes samen tot één mp4 van de hele aflevering |
| 🔧 Modelconfiguratie | **Alles wordt ingesteld in het beheerderspaneel** (vier typen: tekst/afbeelding/video/spraak, in- en uitschakelbaar / importeerbaar / exporteerbaar) |
| 💰 Creditfacturering | Elke stap die een model/media aanroept heeft een vastgestelde prijs, **credits worden per gebruik afgeschreven** |
| 💳 Opwaarderen | Vastgestelde paketten + **WeChat Pay (V3 · Native QR-scan / JSAPI)**, credits worden per gebruik afgeschreven |
| 🎨 Thema | Licht / donker / automatisch volgens systeem |

### Prijzen (aanpasbaar, standaardwaarden)
| Functie | Eenheid | Credits |
|---|---|---|
| Scenario splitsen | per 1000 tekens | 10 |
| Asset-extractie | per aflevering | 20 |
| Assetafbeelding genereren | per afbeelding | 5 |
| **Storyboardscenario genereren** | **per 100 tekens** | **2** |
| **Storyboardvideo genereren** | **per seconde** | **11** |
| Voice-over (TTS) | per 100 tekens | 3 |
| Video monteren | per aflevering | 30 |

---

## 📂 Mappenstructuur

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize-server
│  ├─ src/
│  │  ├─ db/models/        # Datatabelemodellen + relaties
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST-routes (projecten/assets/storyboard/video/credits/opwaarderen/showcase/opdrachten/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Prijzen + standaardcatalogus modelproviders + initiële beheerder
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus web-versie
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Beheerderspaneel (aparte entry /admin, aparte login en token)
│  ├─ admin.html           # HTML-invoerbestand van het beheerderspaneel
│  └─ desktop/             # Electron-desktopshell (Windows/macOS, zie client/desktop/README.md)
├─ uniapp/            # Mobiel (uni-app: app / miniprogramma-shell / H5)
└─ deploy/            # Productie-implementatie: nginx.conf / PM2 / systemd / backup / DEPLOY.md-runbook
```

---

## 🚀 Snel starten

### 1. Start de server

```bash
cd server
cp .env.example .env          # Standaard DB_DIALECT=sqlite, draait zonder configuratie
npm install
npm run dev                   # http://localhost:3000 , maakt automatisch tabellen aan + seed
```

- **SQLite (werkt direct, aanbevolen voor lokaal uitproberen)**: `DB_DIALECT=sqlite`, data staat in `server/data/aidrama.db`
- **MySQL**: zet `DB_DIALECT=mysql` en vul `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` in
- **Bij de eerste start wordt automatisch een initiële beheerder aangemaakt** (de console toont een melding):
  - Standaardaccount **`admin / admin123`**, bedoeld voor het inloggen op het beheerderspaneel `/admin`
  - Te overschrijven met de omgevingsvariabelen `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; wordt automatisch overgeslagen als er al een beheerder bestaat
  - ⚠️ Wijzig vóór livegang direct het standaardwachtwoord (`node scripts/setAdminPassword.js`, of zie hieronder het hoofdstuk over het beheerderspaneel)

### 2. Start de client

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Open <http://localhost:5173>: nog geen account? Klik op 「Registreren」 (gebruikersnaam + wachtwoord, met één stap tekstselectie-captcha; na geslaagde registratie ben je meteen ingelogd en ontvang je 66 proefcredits); al een account? Log dan direct in (gebruikersnaam / e-mailadres / telefoonnummer — allemaal mogelijk).

> De client heeft een proxy ingesteld: `/api` en `/files` worden automatisch doorgestuurd naar `http://localhost:3000`.

---

## 🛠 Gebruik van het beheerderspaneel (client/admin)

Het beheerderspaneel heeft een **aparte entry, aparte login en apart token** (JWT met prefix `admt_`, volledig gescheiden van de gebruikerssessies aan de voorkant):

- **Entry**: <http://localhost:5173/admin> (in productie: `https://jouw-domein/admin`)
- **Inloggen**: account + wachtwoord + tekstselectie-captcha. Gebruik bij de eerste start de initiële beheerder **`admin / admin123`**;
- **Wachtwoord wijzigen**: het paneel heeft (nog) geen wachtwoordwijzigingspagina; gebruik het serverscript om te resetten:
  ```bash
  cd server
  node scripts/setAdminPassword.js <gebruikersnaam of e-mailadres> <nieuw wachtwoord>
  ```
  (Bij `adminAuth`-login kan de gebruikersnaam / het e-mailadres / het telefoonnummer als account dienen)

### Functiemodules

| Module | Doel |
|---|---|
| **Modelconfiguratie** | **Koppeling van LLM's in vier typen: tekst / afbeelding / video / TTS** (zie het volgende hoofdstuk, verplicht in te stellen vóór livegang) |
| Modelproviders | Catalogus van providers en modellen (presetbron bij het toevoegen van nieuwe configuraties; de seed bevat al de grote providers) |
| Kunststijlen / personageopties / stemmenbibliotheek | Woordenboek met creatief materiaal (de opties aan de voorkant worden hier ingesteld) |
| Prijzen | Credits eenheidsprijs per AI-stap (zie de tabel hierboven) |
| Gebruikersbeheer | Gebruikers opzoeken, **blokkeren / deblokkeren**, **wachtwoord resetten** (het centrale punt voor wachtwoordherstel), credits aanpassen, **met één klik als gebruiker bij de voorkant inloggen** (login-as, om problemen namens gebruikers te onderzoeken) |
| Betalingen | Opzoeken / afstemmen van WeChat-opwaardeerorders |
| Showcase-moderatie | Publiceren/intrekken van werken in het showcasecentrum |
| Taakbeheer / videogeneratiebeheer | Opnieuw uitvoeren/opschonen van wachtrijen voor asynchrone taken en videogeneratie |
| Onderhoud | Onderhoudsmodus-schakelaar (503 + verwachte hersteltijd), gegevensonderhoud |
| Loginlogboek | Loginregistratie van het hele systeem (methode / IP / UA) |

---

## 🔌 Modellen / media configureren (zodat de AI-functies echt werken)

Alle AI-mogelijkheden zijn **configuratiegedreven** en worden **centraal beheerd op de pagina 「Modelconfiguratie」 van het beheerderspaneel** (`.env` bevat geen standaard-LLM-configuratie meer). Zonder configuratie: tekstfuncties geven voor het aanroepen een melding; afbeelding/video/TTS rapporteren direct 「niet geconfigureerd」.

Configuratiestappen:

1. Log in op het beheerderspaneel `/admin` → **Modelconfiguratie** → nieuwe toevoegen;
2. Kies het type (tekst / afbeelding / video / TTS) en het protocol en vul in:
   - **Base URL** (bijv. `https://api.openai.com/v1`)
   - **API Key** (wordt alleen serverzijde opgeslagen, nooit naar de frontend gestuurd)
   - Modelnaam (bijv. `gpt-4o-mini`, `dall-e-3`)
   - Activeringsstatus en de creditprijs van deze configuratie;
3. Na opslaan is de configuratie direct actief aan de voorkant (per type kunnen meerdere configuraties bestaan en aan-/uitgezet worden); de pagina 「Modelconfiguratie」 ondersteunt **import / export van JSON** voor eenvoudige migratie in bulk.

Ondersteunde protocollen:

- **Tekst / afbeelding / TTS**: OpenAI-compatibel (`/chat/completions`, `/images/generations`, `/audio/speech`) of een aangepast endpoint (`api_style=custom`)
- **Video**: configureer het asynchrone taakendpoint (taak indienen → polling → video-URL); er is een echte videogeneratie-provider nodig (de lokale ffmpeg-functie 「afbeelding-naar-video」 is buiten gebruik gesteld)

> Gebruikers kunnen bovendien via 「Persoonlijke instellingen → Mijn modellen」 een **privémodel** toevoegen (met eigen Key; aanroepen kosten geen credits) zonder de globale configuratie te beïnvloeden.
> `ffmpeg` moet lokaal geïnstalleerd zijn (macOS: `brew install ffmpeg`). Het samenvoegen en monteren van videoclips is ervan afhankelijk.

---

## 🚢 Productie-implementatie

Het volledige runbook staat in **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (nginx-livegang-checklist, PM2/systemd single instance, back-up & herstel, WeChat Pay-livegang, nog openstaande compliancepunten). Minimale omgevingsvereisten:

```bash
NODE_ENV=production            # Zonder deze variabele wordt de JWT dev-fallbacksleutel actief — veiligheidsrisico
JWT_SECRET=<sleutel voor het ondertekenen van lokale sessietokens, lange willekeurige tekenreeks>      # Dit systeem tekent/verifieert gebruikerssessies zelf (axt_)
ADMIN_JWT_SECRET=<aparte ondertekeningssleutel voor het beheerderspaneel>
FILE_SIGN_SECRET=<ondertekeningssleutel tegen hotlinking van media>   # Moet overeenkomen met de secure_link-sleutel in deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay vereist daarnaast de vijf `WECHAT_PAY_*`-variabelen (merchant-ID, AppID, APIv3-sleutel, certificaatserienummer, merchant-privésleutel), zie `deploy/DEPLOY.md` ⑦.

---

## 🔑 Login & accountsysteem (lokaal, zonder externe afhankelijkheden)

Het accountsysteem is **in dit systeem zelf ingebouwd**: registratie / inloggen / wachtwoordwijziging / sessievernieuwing lopen allemaal via `/api/auth/*` van deze server, zonder afhankelijkheid van enige externe accountdienst:

- **Registratie**: gebruikersnaam (2-64 tekens: letters, cijfers, `_.-`) + wachtwoord (≥6 tekens) + e-mailadres (optioneel), met een tekstselectie-captcha (de backend genereert SVG-opgaven, `/api/captcha/*`); na geslaagde registratie ben je meteen ingelogd en ontvang je 66 proefcredits;
- **Inloggen**: gebruikersnaam / e-mailadres / telefoonnummer (elk mogelijk) + wachtwoord; captcha wordt 「alleen gecontroleerd indien meegestuurd」 (de frontend stuurt hem standaard mee);
- **Tokens**: de server ondertekent zelf JWT's (prefix `axt_`, access + refresh, refresh wordt niet gerouleerd); de frontend vernieuwt stilzwijgend via `/api/auth/oauth/refresh`; het token van het beheerderspaneel is apart (prefix `admt_`);
- **Wachtwoord vergeten**: een zelf-geïmplementeerde instantie heeft geen SMS-/e-mailkanaal en biedt dus geen zelfservice-reset aan — dit gebeurt door de beheerder via **Beheerderspaneel 「Gebruikersbeheer」 → Wachtwoord resetten**;
- **Blokkade**: na blokkade vervallen alle eerder uitgegeven tokens van die gebruiker bij het eerstvolgende verzoek (de server controleert bij elk verzoek opnieuw de gebruikersstatus);
- **Inloggen via derden (optioneel)**: de Apple / Google one-click login in de mobiele app blijft werken — de server houdt de sleutels en wisselt als proxy (`POST /api/auth/oauth/:provider`), en geeft dezelfde lokale `axt_`-sessie terug; aan de webkant is geen callback-registratie nodig.

Relevante `.env`-variabelen: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (zie de toelichting in `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native QR-scan / JSAPI)

Echte WeChat Pay-functionaliteit, **configuratiegedreven en standaard uitgeschakeld** (laat `WECHAT_PAY_*` in `.env` leeg = niet geactiveerd; de frontend verbergt de opwaardeerfunctie dan automatisch). `WECHAT_APP_ID` blijft alleen als fallback voor het betalings-AppID bestaan.

Activeer Native/JSAPI-betalingen op het [WeChat Merchant Platform](https://pay.weixin.qq.com/) en verkrijg de merchant-ID en APIv3-sleutel, en download het merchant-API-certificaat (`apiclient_key.pem` + certificaatserienummer). **De merchant-ID en het AppID moeten op het merchant platform gekoppeld zijn** (anders mislukt het plaatsen van orders met `APPID_MCHID_NOT_MATCH`). Configuratie:
```bash
WECHAT_PAY_METHOD=native       # native=QR-scan | jsapi=betaling binnen het Official Account (PC via H5-kassa)
WECHAT_PAY_APP_ID=             # AppID gekoppeld aan de merchant-ID (leeg = fallback naar WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<jouw merchant-ID>
WECHAT_PAY_API_V3_KEY=         # 32-tekens APIv3-sleutel
WECHAT_PAY_SERIAL_NO=          # Serienummer van het merchant-API-certificaat
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Schijfpad van apiclient_key.pem (kies er één van deze regel en de volgende)
WECHAT_PAY_PRIVATE_KEY=        # Of direct PEM-tekst inline meegeven
WECHAT_PAY_NOTIFY_URL=         # Leeg = ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Proces: in het creditcentrum kies je 「WeChat Pay」 → de backend plaatst een uniforme order (Native geeft een `code_url` terug voor het renderen van de QR-code / JSAPI opent de betaling) → de gebruiker betaalt → WeChat stuurt een asynchrone callback naar `/api/recharge/wechat/notify` (AES-256-GCM-decryptie en verificatie, idempotente bijschrijving).
- De callback moet een **publiek bereikbaar HTTPS-adres** zijn (tijdens ontwikkeling kan NAT-tunneling gebruikt worden).

> Livegangstappen (AppID koppelen op het merchant platform, certificaat lokaal op de server plaatsen, regressietest met één echte order van één cent) zie **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Livegangstappen WeChat Pay**.
> Database: het transactienummer van de betalingsorder wordt weggeschreven in `recharge_orders.transaction_id`, idempotent aangevuld door `ensureColumns` bij het opstarten; bestaande databases blijven onaangetast.

---

## 🧪 End-to-end-verificatiestappen

0. Beheerderspaneel `/admin` (admin/admin123) → **Modelconfiguratie** → alle vier de typen tekst/afbeelding/video/TTS instellen (anders zijn de AI-stappen niet bruikbaar)
1. Voorkant registreren/inloggen → nieuw project aanmaken → 「Scenario-outline」 script plakken/uploaden → **AI splitst het scenario** (credits worden afgeschreven)
2. 「Assetbibliotheek」 → **AI extraheert assets** → voor personages/scènes **assetafbeeldingen genereren**
3. 「Video per aflevering」 → **scenario genereren** → naar de **storyboardeditor**
4. In de editor een scène selecteren → **direct genereren** (videoclip, met automatische extractie van het eerste frame als voorbeeldcover)
5. **Volledige aflevering monteren** (ffmpeg voegt samen tot de mp4 van de hele aflevering)
6. In het 「Creditcentrum」 transacties bekijken en opwaarderen; in het beheerderspaneel prijzen aanpassen / gebruikers blokkeren / wachtwoorden resetten / loginlogboek bekijken; schakelen tussen licht/donker/automatisch thema

---

## 📡 Belangrijkste API's (prefix `/api`, JWT-authenticatie, uniform `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Lokale registratie (captcha-ticket vereist) / inloggen (openbaar, met snelheidsbeperking)
POST /auth/password                                            # Wachtwoord wijzigen (ingelogde sessie)
POST /auth/oauth/refresh                                       # Stille vernieuwing (refresh_token ruilen voor nieuw access_token, openbaar)
POST /auth/oauth/:provider                                     # Inloggen via derden omzetten naar lokale sessie (apple/google/weixin/huawei, optioneel)
GET /auth/me   POST /auth/sync                                 # Gebruikersprofiel
POST /captcha/challenge | /captcha/verify                      # Tekstselectie-captcha
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Asynchroon taakcentrum (frontend polled)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Leeszijde globale configuratie + import/export (beheerd in het beheerderspaneel)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # WeChat Pay-callback (geen authenticatie, handtekeningverificatie + idempotent)
GET /showcase/*                                                # Showcasecentrum (publiceren/browsen/namaak maken)
GET /market/*                                                  # Opdrachtcentrum (taakbonnen/beheer/oplevering)
GET /pricing
```
Elke AI-API heeft een bijbehorend `…/estimate`-endpoint voor creditberekening; beheer-API's (`/admin/*`: gebruikers/betalingen/taken/logboeken/onderhoud enz.) gebruiken een apart beheerderspaneel-token (`admt_`).

---

## 🛠 Technologiestack

**Server**: Express · Sequelize (twee dialecten: mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (desktopshell: Electron + electron-updater)
**Mobiel**: uni-app (app / miniprogramma-shell / H5)

## 📝 Toelichting

- Dit project levert een basis waarmee 「functies end-to-end werken」: alle API's en pagina's werken echt en zijn uitvoerbaar; de UI volgt de structuur en statussen van het referentiemateriaal na.
- Externe providers (afbeelding/video/TTS) moeten in het **beheerderspaneel** met echte keys geconfigureerd worden om end-to-end echt materiaal op te leveren; ffmpeg wordt uitsluitend gebruikt voor het samenvoegen en monteren van videoclips.
- Na het wijzigen van Sequelize-modellen: verwijder bij SQLite `server/data/*.db` en initialiseer opnieuw (voor productie worden migraties aanbevolen).

---

## 📄 Opensourcelicentie

Dit project is open source onder [AGPL-3.0](LICENSE).

- ✅ **Persoonlijk leren, onderzoek, niet-commercieel gebruik**: gratis; bij het aanbieden van een aangepaste versie als netwerkdienst gelden de opensourceverplichtingen van AGPL-3.0
- 💼 **Commerciële implementatie / SaaS-diensten / private levering**: hiervoor is een commerciële licentie vereist (die vrijstelling van de AGPL-3.0-opensourceverplichtingen mogelijk maakt); voor een commerciële licentie: <kevin@xw.com>

---

## 📮 Contact

- 📧 E-mail: <kevin@xw.com>
- 🌐 Online demo: <https://aiwork.xw.com>
- 💬 WeChat-groep 「星网AI剧场开源交流」:

  ![QR-code van de WeChat-groep 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
