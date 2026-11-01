**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | **한국어** | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · AI 숏드라마 제작 플랫폼

> 🌐 **온라인 데모**：<https://aiwork.xw.com> 　·　📮 문의: **kevin@xw.com**

AI 숏드라마 제작 시스템 한 벌: **대본 가져오기 → 캐릭터/장면/소품 추출 → 스토리보드 생성 → 스토리보드 영상 생성 → 전체 회차 합성**.
서버는 **Node.js + MySQL(/ SQLite 폴백)**, 프론트엔드는 **Vue 3 + Element Plus** 기반의 두 클라이언트: **웹(client, 관리자 대시보드 client/admin 및 데스크톱 셸 client/desktop 포함) + 모바일(uniapp, App/미니프로그램 셸/H5)**, REST API로 통신합니다. 계정 체계는 **내장 로컬 회원가입/로그인**(사용자명/이메일/휴대폰 번호 + 비밀번호)이며, 서드파티 계정 센터에 의존하지 않습니다.

---

## 🌐 온라인 데모 & 교류

- **데모 주소**: <https://aiwork.xw.com>
- **버그 신고 / 협업**: <kevin@xw.com>

---

## ✨ 기능

| 모듈 | 설명 |
|---|---|
| 👤 사용자 시스템 | **로컬 회원가입 / 로그인**(사용자명/이메일/휴대폰 번호 + 비밀번호, 가입 시 클릭식 텍스트 캡차 필요) + **팀 공유 프로젝트**(초대/권한) |
| 📖 대본 개요 | 붙여넣기 또는 `.txt` 업로드로 대본을 가져오면 **AI가 여러 회차로 분할**, 회차별 편집 가능 |
| 🎭 에셋 라이브러리 | **AI가 캐릭터 / 장면 / 소품을 추출**, 개별 또는 일괄로 에셋 이미지 생성 |
| 🎬 회차별 영상 | **AI가 스토리보드 스크립트 생성**(세그먼트 스크립트 + 내레이션 + 음성 설정 + 길이) |
| ✂️ 스토리보드 편집기 | 왼쪽 에셋, 가운데 스토리보드 스크립트, 오른쪽 영상 미리보기, 하단 세그먼트 타임라인 |
| 🎞️ 영상 생성 | 각 세그먼트: (TTS 선택) → 영상 클립, 생성 후 첫 프레임을 자동 추출해 미리보기 썸네일로 사용 |
| 🧩 전체 회차 합성 | ffmpeg로 선택한 세그먼트를 이어 붙여 회차 전체 mp4 출력 |
| 🔧 모델 설정 | **모두 관리자 대시보드에서 설정**(텍스트/이미지/영상/음성 4종, 활성화·비활성화 / 가져오기 / 내보내기 가능) |
| 💰 크레딧 과금 | 대규모 모델/미디어를 호출하는 각 단계에 가격이 지정되어 있으며, **사용량에 따라 크레딧 차감** |
| 💳 충전 | 사전 정의 패키지 + **WeChat Pay(V3 · Native QR 스캔 / JSAPI)**, 사용량에 따라 크레딧 차감 |
| 🎨 테마 | 라이트 / 다크 / 시스템 자동 따르기 |

### 가격 정책(편집 가능, 기본값)
| 기능 | 단위 | 크레딧 |
|---|---|---|
| 대본 분할 | 1,000자당 | 10 |
| 에셋 추출 | 회차당 | 20 |
| 에셋 이미지 생성 | 장당 | 5 |
| **스토리보드 스크립트 생성** | **100자당** | **2** |
| **스토리보드 영상 생성** | **초당** | **11** |
| 내레이션 음성(TTS) | 100자당 | 3 |
| 영상 합성 | 회차당 | 30 |

---

## 📂 디렉터리 구조

```
AIDrama/
├─ server/            # Node.js + Express + Sequelize 서버
│  ├─ src/
│  │  ├─ db/models/        # 데이터베이스 테이블 모델 + 연관관계
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # REST 라우트(프로젝트/에셋/스토리보드/영상/크레딧/충전/쇼케이스/수주/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # 가격 정책 + 기본 모델 공급자 카탈로그 + 초기 관리자
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Vue 3 + Vite + Element Plus 웹 클라이언트
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # 관리자 대시보드(독립 진입점 /admin, 독립 로그인 및 토큰)
│  ├─ admin.html           # 관리자 대시보드 진입 HTML
│  └─ desktop/             # Electron 데스크톱 셸(Windows/macOS, client/desktop/README.md 참고)
├─ uniapp/            # 모바일(uni-app: App / 미니프로그램 셸 / H5)
└─ deploy/            # 프로덕션 배포: nginx.conf / PM2 / systemd / backup / DEPLOY.md runbook
```

---

## 🚀 빠른 시작

### 1. 서버 시작

```bash
cd server
cp .env.example .env          # 기본 DB_DIALECT=sqlite, 설정 없이 바로 실행 가능
npm install
npm run dev                   # http://localhost:3000 , 테이블 자동 생성 + seed
```

- **SQLite(기본 제공, 로컬 체험에 권장)**: `DB_DIALECT=sqlite`, 데이터는 `server/data/aidrama.db`에 저장
- **MySQL**: `DB_DIALECT=mysql`로 설정하고 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` 입력
- **최초 실행 시 초기 관리자 자동 생성**(콘솔에 안내가 출력됨):
  - 기본 계정 **`admin / admin123`**, 관리자 대시보드 `/admin` 로그인용
  - 환경 변수 `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`로 재정의 가능, 관리자가 이미 있으면 자동 건너뜀
  - ⚠️ 배포 전 반드시 기본 비밀번호를 변경하세요(`node scripts/setAdminPassword.js`, 또는 아래 관리자 대시보드 절 참고)

### 2. 클라이언트 시작

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

<http://localhost:5173> 열기: 계정이 없으면 「회원가입」 클릭(사용자명 + 비밀번호, 클릭식 캡차 통과, 가입 성공 시 즉시 로그인되며 체험 크레딧 66 지급); 계정이 있으면 바로 로그인(사용자명 / 이메일 / 휴대폰 번호 모두 가능).

> 클라이언트에는 프록시가 설정되어 있어 `/api`와 `/files`가 자동으로 `http://localhost:3000`으로 전달됩니다.

---

## 🛠 관리자 대시보드(client/admin) 사용법

관리자 대시보드는 **독립 진입점, 독립 로그인, 독립 토큰**(`admt_` 접두사 JWT, 프론트 사용자 세션과 완전히 분리):

- **진입점**: <http://localhost:5173/admin>(프로덕션에서는 `https://your-domain.com/admin`)
- **로그인**: 계정 + 비밀번호 + 클릭식 텍스트 캡차. 최초 실행 시 초기 관리자 **`admin / admin123`** 사용;
- **비밀번호 변경**: 관리 화면에는 아직 변경 페이지가 없으므로 서버 측 스크립트로 재설정:
  ```bash
  cd server
  node scripts/setAdminPassword.js <사용자명 또는 이메일> <새 비밀번호>
  ```
  (`adminAuth` 로그인은 사용자명 / 이메일 / 휴대폰 번호 중 하나를 계정으로 지원)

### 기능 모듈

| 모듈 | 용도 |
|---|---|
| **모델 설정** | **텍스트 / 이미지 / 영상 / TTS 4종 LLM 연동**(다음 절 참고, 배포 전 필수 설정) |
| 모델 공급자 | 공급자 및 모델 카탈로그(설정 추가 시 프리셋 소스, seed에 주요 공급자 내장) |
| 아트 스타일 / 캐릭터 옵션 / 보이스 라이브러리 | 창작 소재 사전(프론트 선택 옵션이 여기서 설정됨) |
| 가격 정책 | AI 단계별 크레딧 단가(위 표 참고) |
| 사용자 관리 | 사용자 조회, **밴/해제**, **비밀번호 재설정**(비밀번호 분실 시 통합 창구), 크레딧 조정, **원클릭 사용자 프론트 로그인**(login-as, 사용자 대신 문제 확인) |
| 결제 | WeChat 충전 주문 조회 / 대사 |
| 쇼케이스 심사 | 쇼케이스 센터 작품 게시/내리기 |
| 작업 관리 / 영상 생성 관리 | 비동기 작업과 영상 생성 큐의 재시도/정리 |
| 유지보수 | 유지보수 모드 스위치(503 + 예상 복구 시간), 데이터 유지보수 |
| 로그인 로그 | 전체 사이트 로그인 기록(방식 / IP / UA) |

---

## 🔌 대규모 모델 / 미디어 설정(AI 기능을 실제로 작동시키기)

모든 AI 기능은 **설정 기반**으로 동작하며, **관리자 대시보드 「모델 설정」 페이지에서 일괄 관리**됩니다(`.env`는 기본 LLM 설정을 제공하지 않음). 미설정 시: 텍스트 기능은 호출 전 안내를 표시하고, 이미지/영상/TTS는 「미설정」 오류를 바로 반환합니다.

설정 절차:

1. 관리자 대시보드 `/admin` 로그인 → **모델 설정** → 추가;
2. 유형(텍스트 / 이미지 / 영상 / TTS)과 프로토콜을 선택한 뒤 입력:
   - **Base URL**(예: `https://api.openai.com/v1`)
   - **API Key**(서버에만 저장, 프론트엔드로 전송하지 않음)
   - **모델명**(예: `gpt-4o-mini`, `dall-e-3`)
   - 활성화 상태와 해당 설정의 크레딧 가격;
3. 저장 후 즉시 프론트에서 사용 가능(같은 유형으로 여러 설정 가능, 활성/비활성 전환); 「모델 설정」 페이지는 **JSON 가져오기 / 내보내기**를 지원해 일괄 마이그레이션에 편리합니다.

지원 프로토콜:

- **텍스트 / 이미지 / TTS**: OpenAI 호환(`/chat/completions`, `/images/generations`, `/audio/speech`) 또는 커스텀 엔드포인트(`api_style=custom`)
- **영상**: 비동기 작업 엔드포인트 설정(제출→폴링→영상 URL). 실제 영상 생성 provider 필요(로컬 ffmpeg 「이미지→영상」 기능은 중단됨)

> 사용자 측에서도 「개인 설정 → 내 모델」에서 **프라이빗 모델**을 추가할 수 있습니다(Key 직접 준비, 호출 시 크레딧 미차감). 전역 설정에는 영향을 주지 않습니다.
> 로컬에 `ffmpeg` 설치 필요(macOS: `brew install ffmpeg`). 영상 세그먼트 이어 붙이기 합성이 이에 의존합니다.

---

## 🚢 프로덕션 배포

전체 runbook은 **[deploy/DEPLOY.md](deploy/DEPLOY.md)** 참고(nginx 배포 체크리스트, PM2/systemd 단일 인스턴스, 백업 및 복구, WeChat Pay 배포, 컴플라이언스 할 일). 최소 환경 요구사항:

```bash
NODE_ENV=production            # 미설정 시 JWT 개발용 폴백 키가 적용되어 보안 위험
JWT_SECRET=<로컬 세션 토큰 서명용 무작위 긴 문자열>      # 본 시스템이 사용자 세션을 자체 서명/검증(axt_)
ADMIN_JWT_SECRET=<관리 화면 독립 서명 키>
FILE_SIGN_SECRET=<미디어 핫링크 방지 서명 키>   # deploy/nginx.conf의 secure_link 키와 일치해야 함
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

WeChat Pay에는 추가로 `WECHAT_PAY_*` 5가지(가맹점 번호, AppID, APIv3 키, 인증서 시리얼 번호, 가맹점 개인 키)가 필요합니다. `deploy/DEPLOY.md` ⑦ 참고.

---

## 🔑 로그인 및 계정 체계(로컬, 외부 의존 없음)

계정 체계는 **본 시스템 내장**: 회원가입 / 로그인 / 비밀번호 변경 / 세션 갱신 모두 본 서버의 `/api/auth/*`로 처리되며, 서드파티 계정 센터에 의존하지 않습니다:

- **회원가입**: 사용자명(2-64자 영문·숫자·`_.-`) + 비밀번호(6자 이상) + 이메일(선택), 클릭식 텍스트 캡차 통과 필요(백엔드가 SVG로 출제, `/api/captcha/*`); 가입 성공 시 즉시 로그인되며 체험 크레딧 66 지급;
- **로그인**: 사용자명 / 이메일 / 휴대폰 번호 중 하나 + 비밀번호; 캡차는 「제공된 경우에만 검증」(프론트가 기본적으로 포함);
- **토큰**: 서버 자체 서명 JWT(`axt_` 접두사, access + refresh, refresh는 로테이션하지 않음), 프론트는 `/api/auth/oauth/refresh`로 자동 갱신; 관리 화면 토큰은 독립(`admt_` 접두사);
- **비밀번호 분실**: 자체 배포 인스턴스에는 SMS/메일 경로가 없어 셀프 재설정을 제공하지 않음 — 관리자가 **관리자 대시보드 「사용자 관리」 → 비밀번호 재설정**에서 처리;
- **밴**: 밴 후 해당 사용자의 발급된 모든 토큰이 다음 요청에서 즉시 무효화(서버는 요청마다 사용자 상태를 재확인);
- **서드파티 로그인(선택)**: 모바일 App의 Apple / Google 원탭 로그인은 계속 사용 가능 — 서버가 키를 보유한 채 대리 교환(`POST /api/auth/oauth/:provider`), 동일한 로컬 `axt_` 세션으로 반환. 웹은 콜백 등록이 전혀 필요 없음.

관련 `.env`: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD`(모두 `server/.env.example` 주석 참고).

---

## 💚 WeChat Pay(V3 · Native QR 스캔 / JSAPI)

실제 WeChat Pay, **설정 기반 · 기본 비활성화**(`.env`의 `WECHAT_PAY_*`를 비워 두면 비활성 상태가 유지되며, 프론트는 충전 진입점을 자동 숨김). `WECHAT_APP_ID`는 결제 AppID의 폴백 값으로만 유지됩니다.

[WeChat Pay 가맹점 플랫폼](https://pay.weixin.qq.com/)에서 Native/JSAPI 결제를 개통하고 가맹점 번호, APIv3 키를 발급받은 뒤 가맹점 API 인증서(`apiclient_key.pem` + 인증서 시리얼 번호)를 다운로드하세요. **가맹점 번호와 AppID는 가맹점 플랫폼에서 반드시 연동을 완료해야 합니다**(미연동 시 주문 생성에 `APPID_MCHID_NOT_MATCH` 오류). 설정:
```bash
WECHAT_PAY_METHOD=native       # native=QR 스캔 | jsapi=공식계정 내 결제(PC는 H5 캐셔 이용)
WECHAT_PAY_APP_ID=             # 가맹점 번호에 연동된 AppID(비워 두면 WECHAT_APP_ID로 폴백)
WECHAT_PAY_MCH_ID=<가맹점 번호>
WECHAT_PAY_API_V3_KEY=         # 32자리 APIv3 키
WECHAT_PAY_SERIAL_NO=          # 가맹점 API 인증서 시리얼 번호
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # apiclient_key.pem의 디스크 경로(아래 줄과 택일)
WECHAT_PAY_PRIVATE_KEY=        # 또는 PEM 텍스트를 직접 인라인
WECHAT_PAY_NOTIFY_URL=         # 비워 두면 ${PUBLIC_BASE_URL}/api/recharge/wechat/notify 사용
```
- 절차: 크레딧 센터에서 「WeChat Pay」 선택 → 백엔드 통합 주문 생성(Native는 `code_url`을 반환해 QR 코드 렌더링 / JSAPI는 결제 호출) → 사용자 결제 → WeChat이 `/api/recharge/wechat/notify`로 비동기 콜백(AES-256-GCM 복호화 검증, 멱등 적립).
- 콜백은 **공개 접근 가능한 HTTPS 주소**여야 합니다(개발 중에는 내부망 터널링 사용 가능).

> 배포 절차(가맹점 플랫폼 AppID 연동, 인증서 서버 배치, 0.01위안 실제 주문 회귀 테스트)는 **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ WeChat Pay 배포 절차** 참고.
> 데이터베이스: 결제 주문 거래번호는 `recharge_orders.transaction_id`에 기록되며, 시작 시 `ensureColumns`가 멱등하게 추가하므로 기존 DB에 영향이 없습니다.

---

## 🧪 엔드투엔드 검증 절차

0. 관리자 대시보드 `/admin`(admin/admin123) → **모델 설정** → 텍스트/이미지/영상/TTS 4종 설정(미설정 시 AI 단계 사용 불가)
1. 프론트 회원가입/로그인 → 프로젝트 생성 → 「대본 개요」에 대본 붙여넣기/업로드 → **AI 대본 분할**(크레딧 차감)
2. 「에셋 라이브러리」 → **AI 에셋 추출** → 캐릭터/장면 **에셋 이미지 생성**
3. 「회차별 영상」 → **스크립트 생성** → **스토리보드 편집기** 진입
4. 편집기에서 세그먼트 선택 → **지금 생성**(영상 클립, 첫 프레임 자동 추출해 미리보기 썸네일로)
5. **전체 회차 합성**(ffmpeg로 회차 전체 mp4 이어 붙이기)
6. 「크레딧 센터」에서 거래 내역 확인 및 충전; 관리 화면에서 가격 변경 / 밴 / 비밀번호 재설정 / 로그인 로그 확인; 라이트/다크/자동 테마 전환

---

## 📡 주요 API(`/api` 접두사, JWT 인증, 통일 응답 `{code,message,data}`)

```
POST /auth/register | /auth/login                              # 로컬 회원가입(캡차 ticket 필요) / 로그인(공개, 속도 제한)
POST /auth/password                                            # 비밀번호 변경(로그인 상태)
POST /auth/oauth/refresh                                       # 자동 갱신(refresh_token으로 새 access_token 발급, 공개)
POST /auth/oauth/:provider                                     # 서드파티 로그인으로 로컬 세션 교환(apple/google/weixin/huawei, 선택)
GET /auth/me   POST /auth/sync                                 # 사용자 프로필
POST /captcha/challenge | /captcha/verify                      # 클릭식 텍스트 캡차
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # 비동기 작업 센터(프론트 폴링)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # 전역 설정 읽기 + 가져오기/내보내기(관리 화면에서 관리)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # WeChat Pay 콜백(인증 불필요, 서명 검증+멱등)
GET /showcase/*                                                # 쇼케이스 센터(게시/열람/같은 스타일 만들기)
GET /market/*                                                  # 수주 센터(작업표/에스크로/검수)
GET /pricing
```
각 AI 엔드포인트에는 크레딧을 예측하는 대응 `…/estimate` 엔드포인트가 있습니다. 관리 엔드포인트(`/admin/*`: 사용자/결제/작업/로그/유지보수 등)는 독립 관리 화면 토큰(`admt_`)을 사용합니다.

---

## 🛠 기술 스택

**서버**: Express · Sequelize(mysql/sqlite 이중 dialect) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**웹**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios(데스크톱 셸: Electron + electron-updater)
**모바일**: uni-app(App / 미니프로그램 셸 / H5)

## 📝 안내 사항

- 본 프로젝트는 "기능이 엔드투엔드로 동작하는" 기반을 제공합니다: 모든 API와 페이지가 실제로 동작·실행 가능하며, UI는 참조 이미지의 구조와 상태를 재현합니다.
- 외부 provider(이미지/영상/TTS)는 관리자 대시보드에서 실제 key를 설정해야 엔드투엔드로 실제 소재가 생성됩니다. ffmpeg는 영상 세그먼트 이어 붙이기 합성에만 사용됩니다.
- Sequelize 모델 수정 후 SQLite에서는 `server/data/*.db`를 삭제하고 재초기화하세요(프로덕션에서는 마이그레이션 권장).

---

## 📄 오픈소스 라이선스

본 프로젝트는 [AGPL-3.0](LICENSE) 기반 오픈소스입니다.

- ✅ **개인 학습·연구·비상업 사용**: 무료, 수정 후 네트워크 서비스로 제공 시 AGPL-3.0 오픈소스 의무 준수 필요
- 💼 **상업 배포 / SaaS 서비스 / 온프레미스 납품**: 상업 라이선스 구매 필요(AGPL-3.0 오픈소스 의무 면제 가능), 상업 라이선스 문의: <kevin@xw.com>

---

## 📮 문의

- 📧 이메일: <kevin@xw.com>
- 🌐 온라인 데모: <https://aiwork.xw.com>
- 💬 WeChat 교류 그룹 「星网AI剧场开源交流」(오픈소스 교류 그룹):

  ![星网AI剧场开源交流 WeChat 그룹 QR 코드](docs/wechat-group-qr.jpg)
