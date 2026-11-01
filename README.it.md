**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | **Italiano** | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Piattaforma AI per la produzione di short drama

> 🌐 **Demo online**: <https://aiwork.xw.com> 　·　📮 Contattaci: **kevin@xw.com**

Un sistema completo di creazione di short drama con AI: **importazione dello script → estrazione di personaggi/scene/props → generazione dello storyboard → generazione dei video dello storyboard → composizione degli episodi completi**.
Il backend è **Node.js + MySQL (con fallback SQLite)**, il frontend **Vue 3 + Element Plus** su due fronti: **Web (client, di cui il pannello admin client/admin e la shell desktop client/desktop) + mobile (uniapp, shell App/mini-programma/H5)**, che comunicano tramite REST API. Il sistema di account è basato su **registrazione/login locali integrati** (nome utente/email/numero di telefono + password), senza dipendere da alcun servizio di account di terze parti.

---

## 🌐 Demo online & community

- **Indirizzo della demo**: <https://aiwork.xw.com>
- **Manuale utente**: [PC](docs/pc-user-manual.md) · [Mobile](docs/mobile-user-manual.md)
- **Segnalazione problemi / collaborazioni**: <kevin@xw.com>

---

## ✨ Funzionalità

| Modulo | Descrizione |
|---|---|
| 👤 Sistema utenti | **Registrazione / login locali** (nome utente/email/telefono + password, con captcha a selezione testo alla registrazione) + **progetti condivisi di team** (inviti/permessi) |
| 📖 Trama dello script | incolla o carica un `.txt` per importare lo script, **l'AI lo suddivide in più episodi**, modificabili episodio per episodio |
| 🎭 Libreria degli asset | **estrazione di personaggi / scene / props con AI**, generazione delle immagini degli asset una per una o in blocco |
| 🎬 Video per episodio | **generazione dello script dello storyboard con AI** (script delle clip + voce narrante + configurazione vocale + durata) |
| ✂️ Editor dello storyboard | asset a sinistra, script dello storyboard al centro, anteprima video a destra, timeline delle clip in basso |
| 🎞️ Generazione video | per ogni clip: (TTS opzionale) → clip video; dopo la generazione il primo fotogramma viene estratto automaticamente come copertina di anteprima |
| 🧩 Composizione degli episodi | ffmpeg concatena le clip selezionate e produce l'mp4 dell'intero episodio |
| 🔧 Configurazione dei modelli | **tutto si configura nel pannello admin** (quattro categorie: testo/immagini/video/voce; attivazione/disattivazione / import / export) |
| 💰 Tariffazione a crediti | ogni fase che invoca LLM/media ha un proprio prezzo, **i crediti vengono scalati in base al consumo** |
| 💳 Ricarica | pacchetti predefiniti + **WeChat Pay (V3 · Native con codice QR / JSAPI)**, crediti scalati in base al consumo |
| 🎨 Tema | chiaro / scuro / automatico in base al sistema |

### Prezzi (modificabili, valori predefiniti)
| Funzionalità | Unità | Crediti |
|---|---|---|
| Suddivisione dello script | per 1000 caratteri | 10 |
| Estrazione degli asset | per episodio | 20 |
| Generazione immagini degli asset | per immagine | 5 |
| **Generazione script dello storyboard** | **per 100 caratteri** | **2** |
| **Generazione video dello storyboard** | **al secondo** | **11** |
| Voce narrante (TTS) | per 100 caratteri | 3 |
| Composizione video | per episodio | 30 |

---

## 📂 Struttura delle directory

```
AIDrama/
├─ server/            # Backend Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # modelli delle tabelle DB + relazioni
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # route REST (progetti/asset/storyboard/video/crediti/ricarica/vetrina/ordini/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # prezzi + catalogo dei vendor di modelli predefiniti + admin iniziale
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Client Web Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # pannello admin (ingresso separato /admin, login e token dedicati)
│  ├─ admin.html           # HTML di ingresso del pannello admin
│  └─ desktop/             # shell desktop Electron (Windows/macOS, vedi client/desktop/README.md)
├─ uniapp/            # client mobile (uni-app: App / shell mini-programma / H5)
└─ deploy/            # deploy in produzione: nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Avvio rapido

### 1. Avvio del backend

```bash
cd server
cp .env.example .env          # di default DB_DIALECT=sqlite, funziona senza alcuna configurazione
npm install
npm run dev                   # http://localhost:3000, creazione automatica delle tabelle + seed
```

- **SQLite (pronto all'uso, consigliato per la prova locale)**: `DB_DIALECT=sqlite`, i dati sono salvati in `server/data/aidrama.db`
- **MySQL**: imposta `DB_DIALECT=mysql` e compila `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **Al primo avvio viene creato automaticamente l'admin iniziale** (la console stampa un avviso):
  - account predefinito **`admin / admin123`**, per accedere al pannello admin `/admin`
  - si può sovrascrivere con le variabili d'ambiente `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; se esiste già un admin, il passaggio viene saltato
  - ⚠️ prima di andare in produzione cambia subito la password predefinita (`node scripts/setAdminPassword.js`, oppure vedi la sezione sul pannello admin qui sotto)

### 2. Avvio del client

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Apri <http://localhost:5173>: se non hai un account premi «Registrati» (nome utente + password, supera il captcha a selezione testo; la registrazione riuscita comporta il login immediato e 66 crediti di prova in omaggio); se hai già un account, effettua direttamente il login (va bene nome utente / email / telefono).

> Il client ha già un proxy configurato: `/api` e `/files` vengono inoltrati automaticamente a `http://localhost:3000`.

---

## 🛠 Uso del pannello admin (client/admin)

Il pannello admin ha **ingresso, login e token completamente separati** (JWT con prefisso `admt_`, nessuna intersezione con le sessioni utente del frontend):

- **Ingresso**: <http://localhost:5173/admin> (in produzione `https://iltuodominio/admin`)
- **Login**: account + password + captcha a selezione testo. Al primo avvio usa l'admin iniziale **`admin / admin123`**;
- **Cambio password**: per ora nel pannello non c'è una pagina dedicata, usa lo script lato server:
  ```bash
  cd server
  node scripts/setAdminPassword.js <nome utente o email> <nuova password>
  ```
  (il login `adminAuth` accetta come account nome utente / email / telefono)

### Moduli funzionali

| Modulo | Scopo |
|---|---|
| **Configurazione modelli** | **integrazione di LLM di quattro tipi: testo / immagini / video / TTS** (vedi la sezione successiva, obbligatoria prima di andare in produzione) |
| Vendor di modelli | catalogo di vendor e modelli (fonte dei preset quando si crea una nuova configurazione; i vendor principali sono già inclusi nel seed) |
| Stili artistici / opzioni personaggi / libreria di voci | dizionari di materiali creativi (da qui derivano le opzioni disponibili nel frontend) |
| Prezzi | costo in crediti di ogni fase AI (vedi tabella sopra) |
| Gestione utenti | ricerca utenti, **ban/sban**, **reset password** (punto unico per le password dimenticate), modifica crediti, **accesso al frontend dell'utente con un clic** (login-as, per diagnosticare i problemi al posto dell'utente) |
| Pagamenti | consultazione degli ordini di ricarica WeChat / riconciliazione |
| Moderazione della vetrina | pubblicazione/ritiro delle opere nel centro vetrina (showcase) |
| Gestione task / gestione generazione video | retry/pulizia dei task asincroni e della coda di generazione video |
| Manutenzione | interruttore della modalità manutenzione (503 + tempo di ripristino previsto), manutenzione dei dati |
| Log di accesso | cronologia degli accessi a tutto il sito (metodo / IP / UA) |

---

## 🔌 Configurare LLM / media (per far funzionare davvero le funzioni AI)

Tutte le capacità AI sono **guidate dalla configurazione** e **si gestiscono in un unico punto: la pagina «Configurazione modelli» del pannello admin** (`.env` non fornisce più alcuna configurazione LLM predefinita). Senza configurazione: le funzioni testuali mostrano un avviso prima della chiamata; immagini/video/TTS restituiscono direttamente un errore «non configurato».

Passaggi di configurazione:

1. Accedi al pannello admin `/admin` → **Configurazione modelli** → aggiungi;
2. scegli il tipo (testo / immagini / video / TTS) e il protocollo, compila:
   - **Base URL** (es. `https://api.openai.com/v1`)
   - **API Key** (salvata solo lato server, mai inviata al frontend)
   - **Nome del modello** (es. `gpt-4o-mini`, `dall-e-3`)
   - stato di attivazione e prezzo in crediti di quella configurazione;
3. dopo il salvataggio è subito disponibile nel frontend (per lo stesso tipo si possono creare più configurazioni e attivarle/disattivarle); la pagina «Configurazione modelli» supporta **import / export JSON**, utile per migrazioni in blocco.

Protocolli supportati:

- **Testo / immagini / TTS**: compatibile OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) o endpoint personalizzato (`api_style=custom`)
- **Video**: configurazione degli endpoint per task asincroni (invio → polling → URL video); serve un vero provider di generazione video (la modalità locale ffmpeg «immagine → video» è stata disattivata)

> L'utente può inoltre aggiungere **modelli privati** da «Impostazioni personali → I miei modelli» (con la propria key, le chiamate non consumano crediti), senza toccare la configurazione globale.
> Serve `ffmpeg` installato in locale (macOS: `brew install ffmpeg`). La concatenazione delle clip video dipende da esso.

---

## 🚢 Deploy in produzione

Il runbook completo è in **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist di pubblicazione con nginx, istanza singola PM2/systemd, backup e ripristino, messa online di WeChat Pay, adempimenti di conformità). Requisiti minimi dell'ambiente:

```bash
NODE_ENV=production            # se non impostato, resta attiva la chiave JWT di fallback da sviluppo: rischio per la sicurezza
JWT_SECRET=<chiave locale per firmare i token di sessione, lunga stringa casuale>      # il sistema firma/verifica da sé le sessioni utente (axt_)
ADMIN_JWT_SECRET=<chiave di firma dedicata del pannello admin>
FILE_SIGN_SECRET=<chiave di firma anti-hotlink dei media>   # deve coincidere con la chiave secure_link in deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

Per WeChat Pay servono inoltre le cinque variabili `WECHAT_PAY_*` (merchant ID, AppID, chiave APIv3, numero di serie del certificato, chiave privata del merchant), vedi `deploy/DEPLOY.md` ⑦.

---

## 🔑 Login e sistema di account (locali, nessuna dipendenza esterna)

Il sistema di account è **integrato nel progetto**: registrazione / login / cambio password / refresh della sessione passano tutti dal proprio server `/api/auth/*`, senza alcun servizio di account di terze parti:

- **Registrazione**: nome utente (2-64 caratteri tra lettere, numeri, `_.-`) + password (≥6 caratteri) + email (facoltativa); occorre superare il captcha a selezione testo (generato lato server in SVG, `/api/captcha/*`); la registrazione riuscita comporta il login immediato e 66 crediti di prova in omaggio;
- **Login**: nome utente / email / telefono (uno qualsiasi) + password; il captcha viene verificato «solo se fornito» (il frontend lo invia di norma);
- **Token**: JWT firmati dal server (prefisso `axt_`, access + refresh, il refresh non ruota); il frontend rinnova la sessione in modo silenzioso tramite `/api/auth/oauth/refresh`; i token del pannello admin sono separati (prefisso `admt_`);
- **Password dimenticata**: le istanze self-hosted non hanno canali SMS/email e non offrono il reset self-service — lo esegue l'amministratore da **pannello admin → «Gestione utenti» → reset password**;
- **Ban**: dopo il ban tutti i token già emessi dell'utente diventano invalidi alla richiesta successiva (il server ricontrolla lo stato dell'utente a ogni richiesta);
- **Login di terze parti (opzionale)**: nelle app mobile restano disponibili l'accesso con un tocco Apple / Google — il server esegue lo scambio in proxy con le proprie chiavi (`POST /api/auth/oauth/:provider`) e restituisce la stessa sessione locale `axt_`; la versione Web non richiede alcuna registrazione di callback.

Variabili `.env` correlate: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (tutte commentate in `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native con codice QR / JSAPI)

WeChat Pay reale, **guidato dalla configurazione e disattivato per impostazione predefinita** (se in `.env` le `WECHAT_PAY_*` restano vuote la funzione non è attiva e il frontend nasconde automaticamente l'ingresso per la ricarica). `WECHAT_APP_ID` resta solo come valore di fallback per l'AppID di pagamento.

Attiva i pagamenti Native/JSAPI nella [piattaforma merchant di WeChat](https://pay.weixin.qq.com/), ottieni il merchant ID e la chiave APIv3 e scarica il certificato API del merchant (`apiclient_key.pem` + numero di serie del certificato). **Merchant ID e AppID devono essere vincolati tra loro nella piattaforma merchant** (altrimenti la creazione dell'ordine restituisce `APPID_MCHID_NOT_MATCH`). Configurazione:
```bash
WECHAT_PAY_METHOD=native       # native=pagamento con codice QR | jsapi=pagamento dentro l'account ufficiale (su PC cassa H5)
WECHAT_PAY_APP_ID=             # AppID vincolato al merchant ID (se vuoto, fallback su WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<il tuo merchant ID>
WECHAT_PAY_API_V3_KEY=         # chiave APIv3 di 32 caratteri
WECHAT_PAY_SERIAL_NO=          # numero di serie del certificato API del merchant
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # percorso su disco di apiclient_key.pem (in alternativa alla riga successiva)
WECHAT_PAY_PRIVATE_KEY=        # oppure il testo PEM direttamente inline
WECHAT_PAY_NOTIFY_URL=         # se vuoto si usa ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Flusso: nel centro crediti scegli «WeChat Pay» → il backend crea l'ordine unificato (Native restituisce `code_url` per disegnare il codice QR / JSAPI apre il pagamento) → l'utente paga → callback asincrono di WeChat su `/api/recharge/wechat/notify` (decifratura e verifica AES-256-GCM, accredito idempotente).
- Il callback deve essere un **indirizzo HTTPS raggiungibile da internet** (in sviluppo si può usare un tunnel).

> Passaggi di messa online (vincolo AppID nella piattaforma merchant, deposito del certificato sul server, test di regressione con un ordine reale da un centesimo) in **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Passaggi di messa online di WeChat Pay**.
> Database: il numero di transazione dell'ordine di pagamento viene scritto in `recharge_orders.transaction_id`, colonna aggiunta in modo idempotente da `ensureColumns` all'avvio, senza impatto sui database esistenti.

---

## 🧪 Passi di verifica end-to-end

0. Pannello admin `/admin` (admin/admin123) → **Configurazione modelli** → configura i quattro tipi testo/immagini/video/TTS (altrimenti le fasi AI non sono disponibili)
1. Registrati/login nel frontend → nuovo progetto → in «Trama dello script» incolla/carica lo script → **suddivisione dello script con AI** (consuma crediti)
2. «Libreria degli asset» → **estrazione asset con AI** → **genera le immagini degli asset** per personaggi/scene
3. «Video per episodio» → **genera lo script** → entra nell'**editor dello storyboard**
4. Nell'editor seleziona una clip → **genera subito** (clip video, con primo fotogramma estratto automaticamente come copertina di anteprima)
5. **Componi l'episodio completo** (ffmpeg concatena l'mp4 dell'intero episodio)
6. Nel «Centro crediti» consulta i movimenti e ricarica; nel pannello admin modifica i prezzi / banna / resetta la password / guarda i log di accesso; commuta il tema chiaro/scuro/automatico

---

## 📡 API principali (prefisso `/api`, autenticazione JWT, formato unificato `{code,message,data}`)

```
POST /auth/register | /auth/login                              # registrazione locale (serve il ticket del captcha) / login (pubblico, con limite di frequenza)
POST /auth/password                                            # cambio password (area autenticata)
POST /auth/oauth/refresh                                       # rinnovo silenzioso (refresh_token scambiato con un nuovo access_token, pubblico)
POST /auth/oauth/:provider                                     # scambio del login di terze parti con una sessione locale (apple/google/weixin/huawei, opzionale)
GET /auth/me   POST /auth/sync                                 # profilo utente
POST /captcha/challenge | /captcha/verify                      # captcha a selezione testo
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # centro dei task asincroni (il frontend esegue il polling)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # lettura delle configurazioni globali + import/export (gestite nel pannello admin)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # callback WeChat Pay (senza autenticazione, verifica firma + idempotenza)
GET /showcase/*                                                # vetrina (pubblicazione/consultazione/crea la tua versione)
GET /market/*                                                  # centro ordini (commesse/deposito garanzia/accettazione)
GET /pricing
```
Ogni endpoint AI ha un corrispettivo `…/estimate` per la stima dei crediti; gli endpoint amministrativi (`/admin/*`: utenti/pagamenti/task/log/manutenzione ecc.) usano un token admin separato (`admt_`).

---

## 🛠 Stack tecnologico

**Backend**: Express · Sequelize (doppio dialect mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (shell desktop: Electron + electron-updater)
**Mobile**: uni-app (App / shell mini-programma / H5)

## 📝 Note

- Questo progetto fornisce una base con «funzionalità utilizzabili end-to-end»: tutte le API e le pagine funzionano davvero e sono eseguibili; l'UI replica la struttura e gli stati dei mockup di riferimento.
- I provider esterni (immagini/video/TTS) richiedono chiavi reali configurate nel **pannello admin** per produrre materiali reali end-to-end; ffmpeg serve solo per concatenare le clip video.
- Dopo aver modificato i modelli Sequelize, con SQLite elimina `server/data/*.db` e reinizializza (in produzione si consigliano le migrazioni).

---

## 📄 Licenza open source

Questo progetto è rilasciato open source sotto licenza [AGPL-3.0](LICENSE).

- ✅ **Studio personale, ricerca, uso non commerciale**: gratuito; se offri una versione modificata come servizio di rete devi rispettare gli obblighi open source di AGPL-3.0
- 💼 **Deploy commerciale / servizi SaaS / consegne private**: richiesta una licenza commerciale (che esonera dagli obblighi open source AGPL-3.0); per la licenza commerciale contatta: <kevin@xw.com>

---

## 📮 Contattaci

- 📧 Email: <kevin@xw.com>
- 🌐 Demo online: <https://aiwork.xw.com>
- 💬 Gruppo WeChat «星网AI剧场开源交流» (community open source di 星网 AI Theater):

  ![Codice QR del gruppo WeChat «星网AI剧场开源交流»](docs/wechat-group-qr.jpg)
