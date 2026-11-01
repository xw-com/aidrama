**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | **Polski** | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Platforma AI do produkcji short drama (krótkich seriali)

> 🌐 **Demo online**: <https://aiwork.xw.com> 　·　📮 Skontaktuj się z nami: **kevin@xw.com**

Kompletny system tworzenia short drama z wykorzystaniem AI: **import scenariusza → ekstrakcja postaci/scen/rekwizytów → generowanie storyboardu → generowanie wideo ze storyboardu → składanie pełnych odcinków**.
Backend to **Node.js + MySQL (z fallbackiem na SQLite)**, frontend **Vue 3 + Element Plus** w dwóch warstwach: **Web (client, w tym panel administracyjny client/admin i powłoka desktopowa client/desktop) + mobile (uniapp, powłoki App/mini-programa/H5)**, komunikujące się przez REST API. System kont to **wbudowana lokalna rejestracja/logowanie** (nazwa użytkownika/e-mail/telefon + hasło), bez zależności od zewnętrznych centrów kont.

---

## 🌐 Demo online & społeczność

- **Adres demo**: <https://aiwork.xw.com>
- **Zgłaszanie problemów / współpraca**: <kevin@xw.com>

---

## ✨ Funkcje

| Moduł | Opis |
|---|---|
| 👤 System użytkowników | **lokalna rejestracja / logowanie** (nazwa użytkownika/e-mail/telefon + hasło, przy rejestracji captcha z wybieraniem tekstu) + **projekty współdzielone w zespole** (zaproszenia/uprawnienia) |
| 📖 Zarys scenariusza | wklej lub wgraj `.txt`, aby zaimportować scenariusz — **AI podzieli go na odcinki**, każdy można edytować osobno |
| 🎭 Biblioteka zasobów (assetów) | **ekstrakcja postaci / scen / rekwizytów przez AI**, generowanie obrazów zasobów pojedynczo lub wsadowo |
| 🎬 Wideo odcinków | **generowanie skryptu storyboardu przez AI** (skrypty klipów + narracja + konfiguracja głosu + czas trwania) |
| ✂️ Edytor storyboardu | po lewej zasoby, w środku skrypt storyboardu, po prawej podgląd wideo, na dole oś czasu klipów |
| 🎞️ Generowanie wideo | dla każdego klipu: (opcjonalny TTS) → klip wideo; po wygenerowaniu pierwszy kadr jest automatycznie wyciągany jako okładka podglądu |
| 🧩 Składanie pełnego odcinka | ffmpeg skleja zaznaczone klipy i zapisuje cały odcinek jako mp4 |
| 🔧 Konfiguracja modeli (LLM) | **cała konfiguracja w panelu administracyjnym** (cztery kategorie: tekst/obrazy/wideo/głos; włączanie/wyłączanie / import / eksport) |
| 💰 Rozliczanie w kredytach | każdy krok wywołujący LLM/mediany ma swoją cenę, **kredyty są odliczane wg zużycia** |
| 💳 Doładowanie | gotowe pakiety + **WeChat Pay (V3 · Native przez kod QR / JSAPI)**, kredyty odliczane wg zużycia |
| 🎨 Motyw | jasny / ciemny / automatycznie wg systemu |

### Cennik (edytowalny, wartości domyślne)
| Funkcja | Jednostka | Kredyty |
|---|---|---|
| Podział scenariusza | za 1000 znaków | 10 |
| Ekstrakcja zasobów | za odcinek | 20 |
| Generowanie obrazów zasobów | za obraz | 5 |
| **Generowanie skryptu storyboardu** | **za 100 znaków** | **2** |
| **Generowanie wideo ze storyboardu** | **za sekundę** | **11** |
| Narracja (TTS) | za 100 znaków | 3 |
| Składanie wideo | za odcinek | 30 |

---

## 📂 Struktura katalogów

```
AIDrama/
├─ server/            # Backend Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # modele tabel bazy danych + relacje
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # trasy REST (projekty/zasoby/storyboard/wideo/kredyty/doładowania/galeria/zlecenia/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # cennik + katalog domyślnych dostawców modeli + początkowy administrator
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Klient webowy Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # panel administracyjny (osobne wejście /admin, osobne logowanie i token)
│  ├─ admin.html           # HTML punktu wejścia panelu administracyjnego
│  └─ desktop/             # powłoka desktopowa Electron (Windows/macOS, zob. client/desktop/README.md)
├─ uniapp/            # klient mobilny (uni-app: App / powłoka mini-programa / H5)
└─ deploy/            # wdrożenie produkcyjne: nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Szybki start

### 1. Uruchomienie serwera

```bash
cd server
cp .env.example .env          # domyślnie DB_DIALECT=sqlite, działa bez żadnej konfiguracji
npm install
npm run dev                   # http://localhost:3000, automatyczne tworzenie tabel + seed
```

- **SQLite (działa od razu, polecane do lokalnych testów)**: `DB_DIALECT=sqlite`, dane trafiają do `server/data/aidrama.db`
- **MySQL**: ustaw `DB_DIALECT=mysql` i uzupełnij `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **Przy pierwszym uruchomieniu automatycznie tworzony jest początkowy administrator** (w konsoli pojawia się komunikat):
  - domyślne konto **`admin / admin123`**, do logowania w panelu administracyjnym `/admin`
  - można je nadpisać zmiennymi środowiskowymi `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; jeśli administrator już istnieje, krok jest pomijany
  - ⚠️ przed wdrożeniem produkcyjnym natychmiast zmień domyślne hasło (`node scripts/setAdminPassword.js`, albo zobacz sekcję o panelu administracyjnym poniżej)

### 2. Uruchomienie klienta

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Otwórz <http://localhost:5173>: jeśli nie masz konta, kliknij „Rejestracja" (nazwa użytkownika + hasło, przepuść captcha z wybieraniem tekstu; po udanej rejestracji od razu jesteś zalogowany i dostajesz 66 kredytów na start); jeśli masz konto, po prostu się zaloguj (nazwa użytkownika / e-mail / telefon — cokolwiek).

> Klient ma już skonfigurowane proxy: `/api` i `/files` są automatycznie przekazywane na `http://localhost:3000`.

---

## 🛠 Użytkowanie panelu administracyjnego (client/admin)

Panel administracyjny ma **osobny punkt wejścia, osobne logowanie i osobny token** (JWT z prefiksem `admt_`, całkowicie niezależny od sesji użytkowników frontendu):

- **Wejście**: <http://localhost:5173/admin> (w produkcji `https://twoja-domena/admin`)
- **Logowanie**: konto + hasło + captcha z wybieraniem tekstu. Przy pierwszym uruchomieniu użyj początkowego administratora **`admin / admin123`**;
- **Zmiana hasła**: na razie nie ma w panelu strony do zmiany hasła — użyj skryptu serwerowego:
  ```bash
  cd server
  node scripts/setAdminPassword.js <nazwa użytkownika lub e-mail> <nowe hasło>
  ```
  (logowanie `adminAuth` przyjmuje jako konto nazwę użytkownika / e-mail / telefon)

### Moduły funkcjonalne

| Moduł | Przeznaczenie |
|---|---|
| **Konfiguracja modeli** | **integracja LLM czterech typów: tekst / obrazy / wideo / TTS** (zob. następna sekcja, obowiązkowa przed wdrożeniem produkcyjnym) |
| Dostawcy modeli | katalog dostawców i modeli (źródło presetów przy tworzeniu konfiguracji; popularni dostawcy są już w seedzie) |
| Style graficzne / opcje postaci / biblioteka głosów | słowniki materiałów twórczych (stąd pochodzą opcje dostępne na froncie) |
| Cennik | cena jednostkowa w kredytach każdego kroku AI (zob. tabela wyżej) |
| Zarządzanie użytkownikami | wyszukiwanie użytkowników, **ban/odbanowanie**, **reset hasła** (jedno miejsce na zapomniane hasła), zmiana kredytów, **logowanie na frontend użytkownika jednym kliknięciem** (login-as, do diagnozowania problemów w imieniu użytkownika) |
| Płatności | podgląd zamówień doładowania WeChat / rozliczanie (reconciliacja) |
| Moderacja galerii | publikowanie/wycofywanie z publikacji prac w centrum galerii (showcase) |
| Zarządzanie zadaniami / zarządzanie generowaniem wideo | ponawianie/czyszczenie zadań asynchronicznych i kolejki generowania wideo |
| Utrzymanie | przełącznik trybu serwisowego (503 + przewidywany czas przywrócenia), utrzymanie danych |
| Logi logowań | rejestr logowań w całym serwisie (sposób / IP / UA) |

---

## 🔌 Konfiguracja LLM / mediów (żeby funkcje AI naprawdę działały)

Wszystkie możliwości AI są **sterowane konfiguracją** i **obsługiwane w jednym miejscu: stronie „Konfiguracja modeli" w panelu administracyjnym** (`.env` nie dostarcza już żadnej domyślnej konfiguracji LLM). Bez konfiguracji: funkcje tekstowe ostrzegą przed wywołaniem; obrazy/wideo/TTS od razu zwrócą błąd „brak konfiguracji".

Kroki konfiguracji:

1. Zaloguj się do panelu administracyjnego `/admin` → **Konfiguracja modeli** → dodaj;
2. wybierz typ (tekst / obrazy / wideo / TTS) i protokół, uzupełnij:
   - **Base URL** (np. `https://api.openai.com/v1`)
   - **API Key** (przechowywany wyłącznie po stronie serwera, nigdy nie wysyłany do frontendu)
   - **Nazwa modelu** (np. `gpt-4o-mini`, `dall-e-3`)
   - stan włączenia oraz cenę w kredytach dla tej konfiguracji;
3. po zapisaniu od razu dostępne na froncie (dla tego samego typu można dodać kilka konfiguracji i włączać/wyłączać); strona „Konfiguracja modeli" obsługuje **import / eksport JSON**, co ułatwia migrację hurtową.

Obsługiwane protokoły:

- **Tekst / obrazy / TTS**: zgodny z OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) albo własny endpoint (`api_style=custom`)
- **Wideo**: konfiguracja endpointów zadań asynchronicznych (zgłoszenie → odpytywanie → URL wideo); potrzebny prawdziwy dostawca generowania wideo (lokalny tryb ffmpeg „obraz → wideo" został wyłączony)

> Po stronie użytkownika w „Ustawienia osobiste → Moje modele" można dodać **prywatne modele** (z własnym kluczem; wywołania nie zużywają kredytów) — nie wpływa to na konfigurację globalną.
> Lokalnie trzeba mieć zainstalowany `ffmpeg` (macOS: `brew install ffmpeg`). Sklejanie klipów wideo od niego zależy.

---

## 🚢 Wdrożenie produkcyjne

Pełny runbook: **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist wdrożenia z nginx, pojedyncza instancja PM2/systemd, backup i odtwarzanie, uruchomienie WeChat Pay, zadania z zakresu zgodności). Minimalne wymagania środowiska:

```bash
NODE_ENV=production            # bez tego zadziała deweloperski zapasowy klucz JWT — ryzyko dla bezpieczeństwa
JWT_SECRET=<lokalny klucz do podpisywania tokenów sesji, długi losowy ciąg>      # system sam podpisuje/weryfikuje sesje użytkowników (axt_)
ADMIN_JWT_SECRET=<osobny klucz podpisu panelu administracyjnego>
FILE_SIGN_SECRET=<klucz podpisu ochrony mediów przed hotlinkowaniem>   # musi być zgodny z kluczem secure_link w deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

Dla WeChat Pay potrzebne są dodatkowo pięć zmiennych `WECHAT_PAY_*` (numer merchant, AppID, klucz APIv3, numer seryjny certyfikatu, klucz prywatny merchantu), zob. `deploy/DEPLOY.md` ⑦.

---

## 🔑 Logowanie i system kont (lokalny, bez zależności zewnętrznych)

System kont jest **wbudowany w projekt**: rejestracja / logowanie / zmiana hasła / odświeżanie sesji — wszystko przechodzi przez własny serwer `/api/auth/*`, bez żadnych zewnętrznych centrów kont:

- **Rejestracja**: nazwa użytkownika (2-64 znaków: litery, cyfry, `_.-`) + hasło (≥6 znaków) + e-mail (opcjonalnie); trzeba przejść captcha z wybieraniem tekstu (zadania generuje backend w postaci SVG, `/api/captcha/*`); po udanej rejestracji od razu następuje logowanie i przyznawane jest 66 kredytów na start;
- **Logowanie**: nazwa użytkownika / e-mail / telefon (dowolny) + hasło; captcha sprawdzana „tylko jeśli została przesłana" (frontend domyślnie ją wysyła);
- **Tokeny**: JWT podpisywane przez serwer (prefiks `axt_`, access + refresh, refresh nie jest rotowany); frontend odnawia sesję w tle przez `/api/auth/oauth/refresh`; tokeny panelu administracyjnego są osobne (prefiks `admt_`);
- **Zapomniane hasło**: w instancjach self-hosted nie ma kanałów SMS/e-mail, brak resetu self-service — robi to administrator w **panelu administracyjnym → „Zarządzanie użytkownikami" → reset hasła**;
- **Ban**: po zbanowaniu wszystkie wydane tokeny użytkownika stają się nieważne przy kolejnym żądaniu (serwer przy każdym żądaniu odpytuje status użytkownika);
- **Logowanie zewnętrzne (opcjonalnie)**: w aplikacjach mobilnych nadal działa logowanie jednym dotknięciem Apple / Google — serwer wymienia tokeny w trybie proxy z własnymi kluczami (`POST /api/auth/oauth/:provider`) i zwraca tę samą lokalną sesję `axt_`; wersja Web nie wymaga rejestracji żadnych callbacków.

Powiązane zmienne `.env`: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (wszystkie opisane w komentarzach `server/.env.example`).

---
