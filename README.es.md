**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Español** | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt-BR.md) | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Plataforma de Producción de Microdramas con IA

> 🌐 **Demostración en línea**: <https://aiwork.xw.com> 　·　📮 Contáctanos: **kevin@xw.com**

Un sistema completo de creación de microdramas con IA: **importar guion → extraer personajes/escenarios/props → generar storyboards → generar videos de storyboard → montar el episodio completo**.
El servidor usa **Node.js + MySQL (con fallback a SQLite)**, y hay dos clientes frontend **Vue 3 + Element Plus**: **Web (client, que incluye el panel de administración client/admin y el shell de escritorio client/desktop) + móvil (uniapp, shell de App/Mini Programas/H5)**, que se comunican mediante una API REST. El sistema de cuentas es de **registro/inicio de sesión local integrado** (nombre de usuario/correo/teléfono + contraseña), sin depender de ningún centro de cuentas de terceros.

---

## 🌐 Demostración en línea & Comunidad

- **URL de la demostración**: <https://aiwork.xw.com>
- **Manual de usuario**: [PC](docs/pc-user-manual.md) · [Móvil](docs/mobile-user-manual.md)
- **Reporte de problemas / Colaboración**: <kevin@xw.com>

---

## ✨ Funcionalidades

| Módulo | Descripción |
|---|---|
| 👤 Sistema de usuarios | **Registro / inicio de sesión local** (nombre de usuario/correo/teléfono + contraseña, el registro requiere un captcha de selección de texto) + **proyectos compartidos en equipo** (invitaciones/permisos) |
| 📖 Esquema del guion | Pega o sube un archivo `.txt` para importar el guion; la **IA lo divide en varios episodios**, editables uno por uno |
| 🎭 Biblioteca de assets | **La IA extrae personajes / escenarios / props**, con generación de imágenes de assets individual o por lotes |
| 🎬 Video por episodio | **La IA genera el guion del storyboard** (guion por segmentos + narración + configuración de voz + duración) |
| ✂️ Editor de storyboards | Assets a la izquierda, guion del storyboard al centro, vista previa de video a la derecha, línea de tiempo de episodios abajo |
| 🎞️ Generación de video | Cada segmento: (TTS opcional) → clip de video; al generar, se extrae automáticamente el primer fotograma como miniatura de vista previa |
| 🧩 Montaje del episodio completo | ffmpeg une los segmentos seleccionados y exporta el mp4 del episodio completo |
| 🔧 Configuración de LLM | **Todo se configura en el panel de administración** (cuatro categorías: texto/imagen/video/voz; se pueden activar/desactivar, importar y exportar) |
| 💰 Facturación por créditos | Cada paso que invoca modelos/multimedia tiene un precio; **los créditos se descuentan según el uso** |
| 💳 Recarga | Paquetes predefinidos + **WeChat Pay (V3 · Native por código QR / JSAPI)**, descuento de créditos por consumo |
| 🎨 Temas | Claro / oscuro / automático según el sistema |

### Precios (editables; valores predeterminados)
| Función | Unidad | Créditos |
|---|---|---|
| División del guion | por cada 1000 caracteres | 10 |
| Extracción de assets | por episodio | 20 |
| Generación de imágenes de assets | por imagen | 5 |
| **Generación de guion de storyboard** | **por cada 100 caracteres** | **2** |
| **Generación de video de storyboard** | **por segundo** | **11** |
| Narración con voz (TTS) | por cada 100 caracteres | 3 |
| Montaje de video | por episodio | 30 |

---

## 📂 Estructura de directorios

```
AIDrama/
├─ server/            # Servidor Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # Modelos de tablas + relaciones
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # Rutas REST (proyectos/assets/storyboards/videos/créditos/recarga/showcase/ordenes de trabajo/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Precios + catálogo de proveedores de modelos por defecto + administrador inicial
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Cliente Web Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Panel de administración (entrada independiente /admin, con login y token propios)
│  ├─ admin.html           # HTML de entrada del panel de administración
│  └─ desktop/             # Shell de escritorio Electron (Windows/macOS, ver client/desktop/README.md)
├─ uniapp/            # Cliente móvil (uni-app: App / shell de Mini Programas / H5)
└─ deploy/            # Despliegue en producción: nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Inicio rápido

### 1. Iniciar el servidor

```bash
cd server
cp .env.example .env          # Por defecto DB_DIALECT=sqlite, funciona sin ninguna configuración
npm install
npm run dev                   # http://localhost:3000 , crea tablas y ejecuta el seed automáticamente
```

- **SQLite (listo para usar, recomendado para pruebas locales)**: `DB_DIALECT=sqlite`, los datos se guardan en `server/data/aidrama.db`
- **MySQL**: define `DB_DIALECT=mysql` y completa `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **En el primer arranque se crea automáticamente el administrador inicial** (la consola muestra un aviso):
  - Cuenta por defecto **`admin / admin123`**, para iniciar sesión en el panel de administración `/admin`
  - Se puede sobrescribir con las variables de entorno `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; si ya existe un administrador, se omite automáticamente
  - ⚠️ Antes de pasar a producción, cambia la contraseña por defecto de inmediato (`node scripts/setAdminPassword.js`, o consulta la sección del panel de administración más abajo)

### 2. Iniciar el cliente

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Abre <http://localhost:5173>: si no tienes cuenta, pulsa «Registrarse» (nombre de usuario + contraseña, con un captcha de selección de texto; al registrarte inicias sesión automáticamente y recibes 66 créditos de prueba); si ya tienes cuenta, inicia sesión directamente (con nombre de usuario / correo / teléfono).

> El cliente ya tiene configurado un proxy: `/api` y `/files` se reenvían automáticamente a `http://localhost:3000`.

---

## 🛠 Uso del panel de administración (client/admin)

El panel de administración tiene **entrada, inicio de sesión y token independientes** (JWT con prefijo `admt_`, sin relación con las sesiones de usuario del frontend):

- **Entrada**: <http://localhost:5173/admin> (en producción: `https://tu-dominio.com/admin`)
- **Inicio de sesión**: cuenta + contraseña + captcha de selección de texto. En el primer arranque usa el administrador inicial **`admin / admin123`**;
- **Cambio de contraseña**: el panel aún no tiene página para cambiarla; usa el script del servidor para restablecerla:
  ```bash
  cd server
  node scripts/setAdminPassword.js <nombre de usuario o correo> <nueva contraseña>
  ```
  (el login de `adminAuth` acepta nombre de usuario / correo / teléfono como cuenta)

### Módulos de funciones

| Módulo | Propósito |
|---|---|
| **Configuración de modelos** | **Integración de LLM de cuatro tipos: texto / imagen / video / TTS** (ver la sección siguiente; imprescindible antes de producción) |
| Proveedores de modelos | Catálogo de proveedores y modelos (fuente de preajustes al crear configuraciones; el seed ya incluye los proveedores principales) |
| Estilos artísticos / Opciones de personajes / Biblioteca de voces | Diccionarios de material creativo (de aquí se configuran las opciones visibles en el frontend) |
| Precios | Precio en créditos de cada paso de IA (ver la tabla anterior) |
| Gestión de usuarios | Buscar usuarios, **banear/desbanear**, **restablecer contraseñas** (punto unificado para olvidos de contraseña), ajustar créditos, **iniciar sesión en el frontend como usuario** (login-as, para depurar problemas en su nombre) |
| Pagos | Consulta y conciliación de órdenes de recarga de WeChat |
| Revisión del showcase | Publicar/despublicar obras del centro de showcase |
| Gestión de tareas / Gestión de generación de video | Reintentos y limpieza de la cola de tareas asíncronas y de generación de video |
| Mantenimiento | Interruptor del modo de mantenimiento (503 + hora estimada de recuperación), mantenimiento de datos |
| Registro de inicios de sesión | Historial de inicios de sesión de todo el sitio (método / IP / UA) |

---

## 🔌 Configurar los LLM / medios (para que las funciones de IA funcionen de verdad)

Toda la capacidad de IA está **basada en configuración** y **se gestiona de forma unificada en la página «Configuración de modelos» del panel de administración** (el `.env` ya no incluye ninguna configuración de LLM por defecto). Sin configurar: las funciones de texto avisan antes de la llamada; imagen/video/TTS devuelven directamente el error «no configurado».

Pasos de configuración:

1. Inicia sesión en el panel `/admin` → **Configuración de modelos** → Añadir;
2. Elige el tipo (texto / imagen / video / TTS) y el protocolo, y completa:
   - **Base URL** (p. ej. `https://api.openai.com/v1`)
   - **API Key** (se guarda solo en el servidor, nunca se envía al frontend)
   - **Nombre del modelo** (p. ej. `gpt-4o-mini`, `dall-e-3`)
   - Estado de activación y los precios en créditos de esa configuración;
3. Tras guardar, el frontend está disponible de inmediato (puedes crear varias configuraciones del mismo tipo y alternar su activación); la página «Configuración de modelos» admite **importar / exportar JSON**, útil para migraciones en lote.

Protocolos admitidos:

- **Texto / imagen / TTS**: compatible con OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) o endpoint personalizado (`api_style=custom`)
- **Video**: configura un endpoint de tareas asíncronas (envío → sondeo → URL del video); requiere un provider real de generación de video (el «imagen a video» local con ffmpeg está descontinuado)

> Los usuarios también pueden añadir **modelos privados** en «Ajustes personales → Mis modelos» (con su propia Key; las llamadas no consumen créditos), sin afectar la configuración global.
> Se requiere `ffmpeg` instalado localmente (macOS: `brew install ffmpeg`). El montaje de los clips de video depende de él.

---

## 🚢 Despliegue en producción

El runbook completo está en **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist de puesta en producción con nginx, instancia única con PM2/systemd, backup y restauración, puesta en producción de WeChat Pay, pendientes de cumplimiento). Requisitos mínimos de entorno:

```bash
NODE_ENV=production            # Si no se define, se usa una clave JWT de desarrollo por defecto: riesgo de seguridad
JWT_SECRET=<clave aleatoria larga para firmar los tokens de sesión locales>      # Este sistema firma/verifica sus propias sesiones de usuario (axt_)
ADMIN_JWT_SECRET=<clave de firma independiente para el panel de administración>
FILE_SIGN_SECRET=<clave de firma anti-hotlink para los medios>   # Debe coincidir con la clave secure_link de deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

Para WeChat Pay se necesitan además los cinco valores `WECHAT_PAY_*` (ID de comerciante, AppID, clave APIv3, número de serie del certificado y clave privada del comerciante); ver `deploy/DEPLOY.md` ⑦.

---

## 🔑 Inicio de sesión y sistema de cuentas (local, sin dependencias externas)

El sistema de cuentas está **integrado en este sistema**: registro / inicio de sesión / cambio de contraseña / renovación de sesión pasan todos por el servidor local `/api/auth/*`, sin depender de ningún centro de cuentas de terceros:

- **Registro**: nombre de usuario (2-64 caracteres: letras, números, `_.-`) + contraseña (≥6 caracteres) + correo (opcional); requiere pasar el captcha de selección de texto (generado como SVG por el backend, `/api/captcha/*`); al registrarte inicias sesión automáticamente y recibes 66 créditos de prueba;
- **Inicio de sesión**: nombre de usuario / correo / teléfono, cualquiera + contraseña; el captcha «solo se verifica si se envía» (el frontend lo incluye por defecto);
- **Tokens**: JWT firmado por el propio servidor (prefijo `axt_`, access + refresh, el refresh no rota); la renovación silenciosa del frontend va por `/api/auth/oauth/refresh`; los tokens del panel de administración son independientes (prefijo `admt_`);
- **Contraseña olvidada**: las instancias autoalojadas no tienen canal de SMS/correo y no ofrecen restablecimiento por cuenta propia; lo realiza un administrador desde **Panel de administración → Gestión de usuarios → Restablecer contraseña**;
- **Baneo**: tras banear, todos los tokens emitidos de ese usuario dejan de ser válidos en la siguiente petición (el servidor vuelve a consultar el estado del usuario en cada petición);
- **Inicio de sesión de terceros (opcional)**: el inicio de sesión con un toque de Apple / Google en la App móvil sigue disponible; el servidor hace de proxy con las claves para el intercambio (`POST /api/auth/oauth/:provider`) y devuelve la misma sesión local `axt_`; el Web no necesita registrar ninguna URL de callback.

Variables `.env` relacionadas: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (todas comentadas en `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native por código QR / JSAPI)

WeChat Pay real, **basado en configuración y desactivado por defecto** (si `WECHAT_PAY_*` queda vacío en el `.env` está deshabilitado y el frontend oculta automáticamente la entrada de recarga). `WECHAT_APP_ID` se conserva solo como valor de respaldo del AppID de pago.

Activa los pagos Native/JSAPI en la [plataforma de comerciantes de WeChat](https://pay.weixin.qq.com/) (WeChat Pay Merchant Platform), obtén el ID de comerciante y la clave APIv3, y descarga el certificado API del comerciante (`apiclient_key.pem` + número de serie del certificado). **El ID de comerciante y el AppID deben estar vinculados en la plataforma de comerciantes** (si no, la creación de órdenes devuelve `APPID_MCHID_NOT_MATCH`). Configuración:
```bash
WECHAT_PAY_METHOD=native       # native=código QR | jsapi=pago dentro de la Cuenta Oficial (en PC usa la caja H5)
WECHAT_PAY_APP_ID=             # AppID vinculado al ID de comerciante (si se deja vacío, usa WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<tu ID de comerciante>
WECHAT_PAY_API_V3_KEY=         # Clave APIv3 de 32 caracteres
WECHAT_PAY_SERIAL_NO=          # Número de serie del certificado API del comerciante
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Ruta en disco de apiclient_key.pem (alternativa a la línea siguiente)
WECHAT_PAY_PRIVATE_KEY=        # O directamente el texto PEM en línea
WECHAT_PAY_NOTIFY_URL=         # Si se deja vacío, se usa ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Flujo: en el centro de créditos eliges «WeChat Pay» → el backend crea la orden unificada (Native devuelve `code_url` para mostrar el código QR / JSAPI invoca el pago) → el usuario paga → WeChat hace un callback asíncrono a `/api/recharge/wechat/notify` (descifrado y verificación AES-256-GCM, contabilidad idempotente).
- El callback debe ser una **dirección HTTPS alcanzable desde Internet pública** (en desarrollo se puede usar un túnel de red interna).

> Pasos para producción (vincular el AppID en la plataforma de comerciantes, colocar el certificado en el servidor, prueba de regresión con un pedido real de un céntimo) en **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Pasos para poner WeChat Pay en producción**.
> Base de datos: el número de transacción de la orden de pago se escribe en `recharge_orders.transaction_id`, añadido de forma idempotente por `ensureColumns` al arrancar; no afecta a bases de datos antiguas.

---

## 🧪 Pasos de verificación de extremo a extremo

0. Panel de administración `/admin` (admin/admin123) → **Configuración de modelos** → configura los cuatro tipos (texto/imagen/video/TTS); si no, los pasos de IA no estarán disponibles
1. Regístrate/inicia sesión en el frontend → nuevo proyecto → «Esquema del guion»: pega/sube el guion → **división del guion con IA** (consume créditos)
2. «Biblioteca de assets» → **extracción de assets con IA** → **genera imágenes de assets** para personajes/escenarios
3. «Video por episodio» → **generar guion** → entra al **editor de storyboards**
4. Dentro del editor, selecciona un segmento → **generar ahora** (clip de video, con extracción automática del primer fotograma como miniatura)
5. **Monta el episodio completo** (ffmpeg une el mp4 del episodio entero)
6. En el «Centro de créditos» consulta los movimientos y recarga; en el panel de administración cambia precios / banea / restablece contraseñas / mira el registro de inicios de sesión; cambia entre tema claro/oscuro/automático

---

## 📡 API principales (prefijo `/api`, autenticación JWT, respuesta unificada `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Registro local (requiere ticket del captcha) / inicio de sesión (público, con límite de frecuencia)
POST /auth/password                                            # Cambio de contraseña (con sesión iniciada)
POST /auth/oauth/refresh                                       # Renovación silenciosa (refresh_token por un nuevo access_token, público)
POST /auth/oauth/:provider                                     # Login de terceros a cambio de sesión local (apple/google/weixin/huawei, opcional)
GET /auth/me   POST /auth/sync                                 # Perfil de usuario
POST /captcha/challenge | /captcha/verify                      # Captcha de selección de texto
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Centro de tareas asíncronas (el frontend hace polling)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Lado de lectura de la configuración global + importar/exportar (mantenida desde el panel de administración)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # Callback de WeChat Pay (sin autenticación, verificación de firma + idempotencia)
GET /showcase/*                                                # Centro de showcase (publicar/navegar/hacer versión propia)
GET /market/*                                                  # Centro de órdenes de trabajo (tareas/fideicomiso/aceptación)
GET /pricing
```
Cada endpoint de IA tiene su endpoint `…/estimate` para predecir el coste en créditos; los endpoints de administración (`/admin/*`: usuarios/pagos/tareas/logs/mantenimiento, etc.) usan un token de panel de administración independiente (`admt_`).

---

## 🛠 Stack tecnológico

**Servidor**: Express · Sequelize (doble dialecto mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (shell de escritorio: Electron + electron-updater)
**Móvil**: uni-app (App / shell de Mini Programas / H5)

## 📝 Notas

- Este proyecto entrega una base de «funcionalidad utilizable de extremo a extremo»: todas las API y páginas funcionan de verdad y son ejecutables; la UI replica la estructura y los estados de las imágenes de referencia.
- Los providers externos (imagen/video/TTS) requieren configurar claves reales en el **panel de administración** para generar material real de extremo a extremo; ffmpeg solo se usa para unir y montar los clips de video.
- Tras modificar los modelos de Sequelize, en SQLite elimina `server/data/*.db` y reinicializa (en producción se recomienda usar migraciones).

---

## 📄 Licencia de código abierto

Este proyecto se publica como código abierto bajo [AGPL-3.0](LICENSE).

- ✅ **Uso personal, de estudio, investigación y no comercial**: gratis; si tras modificarlo ofreces un servicio de red, debes cumplir las obligaciones de código abierto de la AGPL-3.0
- 💼 **Despliegue comercial / servicios SaaS / entregas privadas**: requiere comprar una licencia comercial (que puede eximir de las obligaciones de código abierto de la AGPL-3.0); para licencias comerciales contacta con: <kevin@xw.com>

---

## 📮 Contáctanos

- 📧 Correo: <kevin@xw.com>
- 🌐 Demostración en línea: <https://aiwork.xw.com>
- 💬 Grupo de WeChat «星网AI剧场开源交流» (Comunidad open source del Teatro de IA de Xingwang):

  ![Código QR del grupo de WeChat 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
