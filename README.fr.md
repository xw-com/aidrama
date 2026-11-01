**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | **Français** | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Plateforme de production de micro-séries avec IA

> 🌐 **Démo en ligne** : <https://aiwork.xw.com> 　·　📮 Contactez-nous : **kevin@xw.com**

Un système complet de création de micro-séries avec IA : **importer le scénario → extraire personnages/décors/accessoires → générer les storyboards → générer les vidéos de storyboard → monter l'épisode complet**.
Le serveur utilise **Node.js + MySQL (avec repli SQLite)**, et il existe deux frontaux **Vue 3 + Element Plus** : **Web (client, incluant le back-office client/admin et le shell desktop client/desktop) + mobile (uniapp, shell App/Mini-programmes/H5)**, communiquant via une API REST. Le système de comptes repose sur une **inscription/connexion locale intégrée** (nom d'utilisateur/e-mail/téléphone + mot de passe), sans dépendre d'un centre de comptes tiers.

---

## 🌐 Démo en ligne & Communauté

- **Adresse de la démo** : <https://aiwork.xw.com>
- **Signalement de problèmes / Partenariats** : <kevin@xw.com>

---

## ✨ Fonctionnalités

| Module | Description |
|---|---|
| 👤 Système d'utilisateurs | **Inscription / connexion locale** (nom d'utilisateur/e-mail/téléphone + mot de passe, l'inscription exige un captcha de sélection de texte) + **projets partagés en équipe** (invitations/permissions) |
| 📖 Plan du scénario | Collez ou importez un fichier `.txt` pour charger le scénario ; **l'IA le découpe en plusieurs épisodes**, modifiables un par un |
| 🎭 Bibliothèque d'assets | **L'IA extrait personnages / décors / accessoires**, avec génération d'images d'assets unitaire ou par lot |
| 🎬 Vidéo par épisode | **L'IA génère le script du storyboard** (script par segments + narration + configuration vocale + durée) |
| ✂️ Éditeur de storyboard | Assets à gauche, script du storyboard au centre, aperçu vidéo à droite, timeline de l'épisode en bas |
| 🎞️ Génération vidéo | Chaque segment : (TTS optionnel) → clip vidéo ; après génération, la première image est extraite automatiquement comme vignette d'aperçu |
| 🧩 Montage de l'épisode complet | ffmpeg concatène les segments sélectionnés et exporte le mp4 de l'épisode entier |
| 🔧 Configuration des LLM | **Tout se configure dans le back-office** (quatre catégories : texte/image/vidéo/voix ; activation/désactivation, import et export possibles) |
| 💰 Facturation en crédits | Chaque étape faisant appel à des modèles/médias a un tarif ; **les crédits sont déduits à l'usage** |
| 💳 Recharge | Forfaits prédéfinis + **WeChat Pay (V3 · Native par QR code / JSAPI)**, déduction des crédits à la consommation |
| 🎨 Thèmes | Clair / sombre / automatique selon le système |

### Tarification (modifiable ; valeurs par défaut)
| Fonction | Unité | Crédits |
|---|---|---|
| Découpage du scénario | par 1 000 caractères | 10 |
| Extraction des assets | par épisode | 20 |
| Génération d'images d'assets | par image | 5 |
| **Génération du script de storyboard** | **par 100 caractères** | **2** |
| **Génération vidéo du storyboard** | **par seconde** | **11** |
| Narration vocale (TTS) | par 100 caractères | 3 |
| Montage vidéo | par épisode | 30 |

---

## 📂 Structure des dossiers

```
AIDrama/
├─ server/            # Serveur Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # Modèles de tables + associations
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # Routes REST (projets/assets/storyboards/vidéos/crédits/recharge/showcase/market/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Tarifs + catalogue de fournisseurs de modèles par défaut + administrateur initial
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Client Web Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Back-office (entrée dédiée /admin, avec connexion et token propres)
│  ├─ admin.html           # HTML d'entrée du back-office
│  └─ desktop/             # Shell desktop Electron (Windows/macOS, voir client/desktop/README.md)
├─ uniapp/            # Client mobile (uni-app : App / shell Mini-programmes / H5)
└─ deploy/            # Déploiement en production : nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Démarrage rapide

### 1. Démarrer le serveur

```bash
cd server
cp .env.example .env          # Par défaut DB_DIALECT=sqlite, fonctionne sans aucune configuration
npm install
npm run dev                   # http://localhost:3000 , création des tables + seed automatiques
```

- **SQLite (prêt à l'emploi, recommandé pour un essai local)** : `DB_DIALECT=sqlite`, les données sont stockées dans `server/data/aidrama.db`
- **MySQL** : définissez `DB_DIALECT=mysql` et renseignez `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **Au premier démarrage, l'administrateur initial est créé automatiquement** (un message est affiché dans la console) :
  - Compte par défaut **`admin / admin123`**, pour se connecter au back-office `/admin`
  - Modifiable via les variables d'environnement `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` ; ignoré automatiquement si un administrateur existe déjà
  - ⚠️ Avant toute mise en production, changez immédiatement le mot de passe par défaut (`node scripts/setAdminPassword.js`, ou voir la section sur le back-office plus bas)

### 2. Démarrer le client

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Ouvrez <http://localhost:5173> : si vous n'avez pas de compte, cliquez sur « Inscription » (nom d'utilisateur + mot de passe, avec un captcha de sélection de texte ; l'inscription vous connecte automatiquement et vous offre 66 crédits d'essai) ; sinon connectez-vous directement (nom d'utilisateur / e-mail / téléphone).

> Le client est déjà configuré avec un proxy : `/api` et `/files` sont transférés automatiquement vers `http://localhost:3000`.

---

## 🛠 Utilisation du back-office (client/admin)

Le back-office dispose d'une **entrée, d'une connexion et d'un token dédiés** (JWT préfixé `admt_`, sans lien avec les sessions utilisateurs du frontend) :

- **Entrée** : <http://localhost:5173/admin> (en production : `https://votre-domaine.com/admin`)
- **Connexion** : compte + mot de passe + captcha de sélection de texte. Au premier démarrage, utilisez l'administrateur initial **`admin / admin123`** ;
- **Changement de mot de passe** : le back-office n'a pas encore de page dédiée ; utilisez le script serveur pour le réinitialiser :
  ```bash
  cd server
  node scripts/setAdminPassword.js <nom d'utilisateur ou e-mail> <nouveau mot de passe>
  ```
  (la connexion `adminAuth` accepte nom d'utilisateur / e-mail / téléphone comme identifiant)

### Modules fonctionnels

| Module | Usage |
|---|---|
| **Configuration des modèles** | **Intégration de LLM des quatre types texte / image / vidéo / TTS** (voir la section suivante ; indispensable avant la mise en production) |
| Fournisseurs de modèles | Catalogue des fournisseurs et modèles (source des préréglages lors de la création de configurations ; le seed inclut déjà les principaux fournisseurs) |
| Styles artistiques / Options de personnages / Bibliothèque de voix | Dictionnaires de matériaux créatifs (les options du frontend se configurent ici) |
| Tarification | Prix en crédits de chaque étape d'IA (voir le tableau ci-dessus) |
| Gestion des utilisateurs | Rechercher des utilisateurs, **bannir/débannir**, **réinitialiser les mots de passe** (point d'entrée unifié en cas d'oubli), ajuster les crédits, **se connecter au frontend en tant qu'utilisateur** (login-as, pour déboguer à sa place) |
| Paiements | Consultation et réconciliation des commandes de recharge WeChat |
| Modération du showcase | Publier/dépublier les œuvres du centre de showcase |
| Gestion des tâches / Gestion de la génération vidéo | Nouvelle tentative et nettoyage des files de tâches asynchrones et de génération vidéo |
| Maintenance | Interrupteur du mode maintenance (503 + heure de rétablissement estimée), maintenance des données |
| Journal de connexions | Historique des connexions de tout le site (méthode / IP / UA) |

---

## 🔌 Configurer les LLM / médias (pour que les fonctions IA fonctionnent réellement)

Toute la capacité IA est **pilotée par la configuration** et **se gère de manière centralisée dans la page « Configuration des modèles » du back-office** (le `.env` ne fournit plus aucune configuration LLM par défaut). Sans configuration : les fonctions texte affichent un avertissement avant l'appel ; image/vidéo/TTS renvoient directement une erreur « non configuré ».

Étapes de configuration :

1. Connectez-vous au back-office `/admin` → **Configuration des modèles** → Ajouter ;
2. Choisissez le type (texte / image / vidéo / TTS) et le protocole, puis renseignez :
   - **Base URL** (ex. `https://api.openai.com/v1`)
   - **API Key** (stockée uniquement côté serveur, jamais envoyée au frontend)
   - **Nom du modèle** (ex. `gpt-4o-mini`, `dall-e-3`)
   - État d'activation et tarification en crédits de cette configuration ;
3. Après enregistrement, le frontend est immédiatement opérationnel (plusieurs configurations du même type peuvent coexister et être activées/désactivées) ; la page « Configuration des modèles » prend en charge **l'import / l'export JSON**, pratique pour les migrations en masse.

Protocoles pris en charge :

- **Texte / image / TTS** : compatible OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) ou endpoint personnalisé (`api_style=custom`)
- **Vidéo** : configurez un endpoint de tâches asynchrones (soumission → polling → URL de la vidéo) ; nécessite un provider réel de génération vidéo (le « image-to-video » local via ffmpeg est abandonné)

> Les utilisateurs peuvent également ajouter des **modèles privés** dans « Paramètres personnels → Mes modèles » (avec leur propre clé ; les appels ne consomment pas de crédits), sans affecter la configuration globale.
> `ffmpeg` doit être installé localement (macOS : `brew install ffmpeg`). Le concaténage des clips vidéo en dépend.

---

## 🚢 Déploiement en production

Le runbook complet figure dans **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist de mise en ligne nginx, instance unique PM2/systemd, sauvegarde et restauration, mise en production de WeChat Pay, obligations de conformité). Prérequis d'environnement minimum :

```bash
NODE_ENV=production            # Sinon, une clé JWT de développement par défaut s'applique : risque de sécurité
JWT_SECRET=<longue chaîne aléatoire pour signer les tokens de session locaux>      # Ce système signe/vérifie lui-même les sessions utilisateurs (axt_)
ADMIN_JWT_SECRET=<clé de signature dédiée au back-office>
FILE_SIGN_SECRET=<clé de signature anti-hotlink des médias>   # Doit correspondre à la clé secure_link de deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

Pour WeChat Pay s'ajoutent les cinq valeurs `WECHAT_PAY_*` (ID marchand, AppID, clé APIv3, numéro de série du certificat, clé privée marchande), voir `deploy/DEPLOY.md` ⑦.

---

## 🔑 Connexion et système de comptes (local, sans dépendance externe)

Le système de comptes est **intégré au système** : inscription / connexion / changement de mot de passe / renouvellement de session passent tous par le serveur local `/api/auth/*`, sans dépendre d'un centre de comptes tiers :

- **Inscription** : nom d'utilisateur (2-64 caractères : lettres, chiffres, `_.-`) + mot de passe (≥6 caractères) + e-mail (facultatif) ; passage obligatoire par le captcha de sélection de texte (généré en SVG par le backend, `/api/captcha/*`) ; l'inscription connecte automatiquement et offre 66 crédits d'essai ;
- **Connexion** : nom d'utilisateur / e-mail / téléphone, au choix + mot de passe ; le captcha « n'est vérifié que s'il est fourni » (le frontend l'envoie par défaut) ;
- **Tokens** : JWT signé par le serveur lui-même (préfixe `axt_`, access + refresh, le refresh n'est pas rotatif) ; le renouvellement silencieux du frontend passe par `/api/auth/oauth/refresh` ; les tokens du back-office sont distincts (préfixe `admt_`) ;
- **Mot de passe oublié** : les instances auto-hébergées n'ayant pas de canal SMS/e-mail, aucun réinitialisation en libre-service n'est proposée ; elle est effectuée par un administrateur depuis **Back-office → Gestion des utilisateurs → Réinitialiser le mot de passe** ;
- **Bannissement** : après bannissement, tous les tokens émis de cet utilisateur deviennent invalides dès la requête suivante (le serveur revérifie l'état de l'utilisateur à chaque requête) ;
- **Connexion tierce (optionnel)** : la connexion en un geste Apple / Google de l'app mobile reste disponible ; le serveur sert d'intermédiaire avec les clés secrètes pour l'échange (`POST /api/auth/oauth/:provider`) et renvoie la même session locale `axt_` ; le Web n'a besoin d'aucun callback déclaré.

Variables `.env` concernées : `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (toutes documentées dans les commentaires de `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native par QR code / JSAPI)

WeChat Pay réel, **piloté par la configuration et désactivé par défaut** (si `WECHAT_PAY_*` reste vide dans le `.env`, la fonction est inactive et le frontend masque automatiquement l'entrée de recharge). `WECHAT_APP_ID` est conservé uniquement comme valeur de repli de l'AppID de paiement.

Activez les paiements Native/JSAPI sur la [plateforme marchande WeChat](https://pay.weixin.qq.com/) (WeChat Pay Merchant Platform), obtenez l'ID marchand et la clé APIv3, puis téléchargez le certificat API marchand (`apiclient_key.pem` + numéro de série du certificat). **L'ID marchand et l'AppID doivent être liés sur la plateforme marchande** (sinon, la création de commande renvoie `APPID_MCHID_NOT_MATCH`). Configuration :
```bash
WECHAT_PAY_METHOD=native       # native=QR code | jsapi=paiement dans le compte officiel (sur PC, via la caisse H5)
WECHAT_PAY_APP_ID=             # AppID lié à l'ID marchand (si vide, repli sur WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<votre ID marchand>
WECHAT_PAY_API_V3_KEY=         # Clé APIv3 de 32 caractères
WECHAT_PAY_SERIAL_NO=          # Numéro de série du certificat API marchand
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Chemin disque de apiclient_key.pem (au choix avec la ligne suivante)
WECHAT_PAY_PRIVATE_KEY=        # Ou directement le texte PEM en ligne
WECHAT_PAY_NOTIFY_URL=         # Si vide, utilise ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Flux : dans le centre de crédits, choisissez « WeChat Pay » → le backend crée la commande unifiée (Native renvoie un `code_url` pour afficher le QR code / JSAPI invoque le paiement) → l'utilisateur paie → WeChat rappelle de façon asynchrone `/api/recharge/wechat/notify` (déchiffrement et vérification AES-256-GCM, comptabilisation idempotente).
- Le callback doit être une **adresse HTTPS joignable depuis l'Internet public** (en développement, un tunnel réseau peut dépanner).

> Étapes de mise en production (liaison de l'AppID sur la plateforme marchande, dépôt du certificat sur le serveur, test de régression avec une commande réelle d'un centime) dans **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Étapes de mise en production de WeChat Pay**.
> Base de données : le numéro de transaction de la commande de paiement est écrit dans `recharge_orders.transaction_id`, ajouté de façon idempotente par `ensureColumns` au démarrage ; les anciennes bases ne sont pas affectées.

---

## 🧪 Étapes de vérification de bout en bout

0. Back-office `/admin` (admin/admin123) → **Configuration des modèles** → configurez les quatre types (texte/image/vidéo/TTS), sinon les étapes IA seront indisponibles
1. Inscrivez-vous/connectez-vous côté frontend → nouveau projet → « Plan du scénario » : collez/importez le scénario → **découpage du scénario par IA** (consomme des crédits)
2. « Bibliothèque d'assets » → **extraction des assets par IA** → **générez les images d'assets** des personnages/décors
3. « Vidéo par épisode » → **générer le script** → ouvrez **l'éditeur de storyboard**
4. Dans l'éditeur, sélectionnez un segment → **générer maintenant** (clip vidéo, avec extraction automatique de la première image comme vignette)
5. **Montez l'épisode complet** (ffmpeg concatène le mp4 de l'épisode entier)
6. Dans le « Centre de crédits », consultez les mouvements et rechargez ; dans le back-office, modifiez les tarifs / bannissez / réinitialisez des mots de passe / consultez le journal de connexions ; basculez entre les thèmes clair/sombre/automatique

---

## 📡 API principales (préfixe `/api`, authentification JWT, réponse unifiée `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Inscription locale (ticket de captcha requis) / connexion (public, taux limité)
POST /auth/password                                            # Changement de mot de passe (session active)
POST /auth/oauth/refresh                                       # Renouvellement silencieux (refresh_token contre un nouvel access_token, public)
POST /auth/oauth/:provider                                     # Connexion tierce échangée contre une session locale (apple/google/weixin/huawei, optionnel)
GET /auth/me   POST /auth/sync                                 # Profil utilisateur
POST /captcha/challenge | /captcha/verify                      # Captcha de sélection de texte
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Centre de tâches asynchrones (polling par le frontend)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Côté lecture de la configuration globale + import/export (géré depuis le back-office)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # Callback WeChat Pay (sans authentification, vérification de signature + idempotence)
GET /showcase/*                                                # Centre de showcase (publier/parcourir/refaire à l'identique)
GET /market/*                                                  # Centre de commandes (missions/escrow/réception)
GET /pricing
```
Chaque endpoint IA possède son endpoint `…/estimate` pour estimer le coût en crédits ; les endpoints d'administration (`/admin/*` : utilisateurs/paiements/tâches/journaux/maintenance, etc.) utilisent un token de back-office dédié (`admt_`).

---

## 🛠 Stack technique

**Serveur** : Express · Sequelize (double dialecte mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web** : Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (shell desktop : Electron + electron-updater)
**Mobile** : uni-app (App / shell Mini-programmes / H5)

## 📝 Remarques

- Ce projet livre une base « fonctionnelle de bout en bout » : toutes les API et pages fonctionnent réellement et sont exécutables ; l'UI reproduit la structure et les états des maquettes de référence.
- Les providers externes (image/vidéo/TTS) exigent la configuration de clés réelles dans le **back-office** pour produire des médias réels de bout en bout ; ffmpeg ne sert qu'à concaténer et monter les clips vidéo.
- Après modification des modèles Sequelize, supprimez `server/data/*.db` sous SQLite et réinitialisez (en production, privilégiez les migrations).

---

## 📄 Licence open source

Ce projet est publié en open source sous [AGPL-3.0](LICENSE).

- ✅ **Usage personnel, académique et non commercial** : gratuit ; toute modification offerte en service réseau doit respecter les obligations open source de l'AGPL-3.0
- 💼 **Déploiement commercial / services SaaS / livraisons privées** : une licence commerciale est requise (pouvant exonérer des obligations open source de l'AGPL-3.0) ; pour toute licence commerciale, contactez : <kevin@xw.com>

---

## 📮 Contactez-nous

- 📧 E-mail : <kevin@xw.com>
- 🌐 Démo en ligne : <https://aiwork.xw.com>
- 💬 Groupe WeChat « 星网AI剧场开源交流 » (Échange open source du Théâtre IA de Xingwang) :

  ![QR code du groupe WeChat 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
