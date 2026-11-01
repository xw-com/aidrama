**🌐 Language**: [简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Português** | [Русский](README.ru.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Українська](README.uk.md) | [हिन्दी](README.hi.md) | [العربية](README.ar.md) | [فارسی](README.fa.md)

# 🎬 星网 XW.COM · Plataforma de Produção de Microsséries com IA

> 🌐 **Demonstração online**: <https://aiwork.xw.com> 　·　📮 Fale conosco: **kevin@xw.com**

Um sistema completo de criação de microsséries com IA: **importar o roteiro → extrair personagens/cenários/objetos → gerar storyboards → gerar vídeos do storyboard → montar o episódio completo**.
O servidor usa **Node.js + MySQL (com fallback para SQLite)**, e há dois frontends em **Vue 3 + Element Plus**: **Web (client, incluindo o painel de administração client/admin e o shell desktop client/desktop) + mobile (uniapp, shell de App/Mini Programas/H5)**, que se comunicam por uma API REST. O sistema de contas é de **cadastro/login local integrado** (nome de usuário/e-mail/telefone + senha), sem depender de nenhum centro de contas de terceiros.

---

## 🌐 Demonstração online & Comunidade

- **Endereço da demonstração**: <https://aiwork.xw.com>
- **Reportar problemas / Parcerias**: <kevin@xw.com>

---

## ✨ Funcionalidades

| Módulo | Descrição |
|---|---|
| 👤 Sistema de usuários | **Cadastro / login local** (nome de usuário/e-mail/telefone + senha, o cadastro exige um captcha de seleção de texto) + **projetos compartilhados em equipe** (convites/permissões) |
| 📖 Estrutura do roteiro | Cole ou envie um arquivo `.txt` para importar o roteiro; a **IA divide em vários episódios**, editáveis um a um |
| 🎭 Biblioteca de assets | **A IA extrai personagens / cenários / objetos**, com geração de imagens de assets individual ou em lote |
| 🎬 Vídeo por episódio | **A IA gera o roteiro do storyboard** (roteiro por trechos + narração + configuração de voz + duração) |
| ✂️ Editor de storyboard | Assets à esquerda, roteiro do storyboard no centro, pré-visualização do vídeo à direita, timeline do episódio embaixo |
| 🎞️ Geração de vídeo | Cada trecho: (TTS opcional) → clipe de vídeo; após a geração, o primeiro frame é extraído automaticamente como capa de pré-visualização |
| 🧩 Montagem do episódio completo | O ffmpeg concatena os trechos selecionados e exporta o mp4 do episódio inteiro |
| 🔧 Configuração de LLMs | **Tudo é configurado no painel de administração** (quatro categorias: texto/imagem/vídeo/voz; pode ativar/desativar, importar e exportar) |
| 💰 Cobrança por créditos | Cada etapa que aciona modelos/mídias tem um preço; **os créditos são descontados conforme o consumo** |
| 💳 Recarga | Pacotes predefinidos + **WeChat Pay (V3 · Native por QR Code / JSAPI)**, desconto de créditos por consumo |
| 🎨 Temas | Claro / escuro / automático conforme o sistema |

### Preços (editáveis; valores padrão)
| Função | Unidade | Créditos |
|---|---|---|
| Divisão do roteiro | por 1000 caracteres | 10 |
| Extração de assets | por episódio | 20 |
| Geração de imagens de assets | por imagem | 5 |
| **Geração do roteiro do storyboard** | **por 100 caracteres** | **2** |
| **Geração de vídeo do storyboard** | **por segundo** | **11** |
| Narração com voz (TTS) | por 100 caracteres | 3 |
| Montagem de vídeo | por episódio | 30 |

---

## 📂 Estrutura de diretórios

```
AIDrama/
├─ server/            # Servidor Node.js + Express + Sequelize
│  ├─ src/
│  │  ├─ db/models/        # Modelos das tabelas + relacionamentos
│  │  ├─ middleware/       # auth(JWT) / error
│  │  ├─ routes/           # Rotas REST (projetos/assets/storyboards/vídeos/créditos/recarga/showcase/market/admin…)
│  │  ├─ services/         # credits / llm / image / video / tts / ffmpeg / ai/* …
│  │  ├─ utils/            # response / ownership / fileUtil / mediaSign …
│  │  ├─ seeders/          # Preços + catálogo padrão de provedores de modelos + administrador inicial
│  │  └─ app.js / index.js
│  └─ .env.example
├─ client/            # Cliente Web Vue 3 + Vite + Element Plus
│  ├─ src/{views,layouts,components,stores,api,composables,styles}
│  ├─ src/admin/           # Painel de administração (entrada própria /admin, com login e token independentes)
│  ├─ admin.html           # HTML de entrada do painel de administração
│  └─ desktop/             # Shell desktop Electron (Windows/macOS, veja client/desktop/README.md)
├─ uniapp/            # Cliente mobile (uni-app: App / shell de Mini Programas / H5)
└─ deploy/            # Implantação em produção: nginx.conf / PM2 / systemd / backup / runbook DEPLOY.md
```

---

## 🚀 Início rápido

### 1. Iniciar o servidor

```bash
cd server
cp .env.example .env          # Por padrão DB_DIALECT=sqlite, roda sem nenhuma configuração
npm install
npm run dev                   # http://localhost:3000 , cria as tabelas e faz o seed automaticamente
```

- **SQLite (funciona de imediato, recomendado para testar localmente)**: `DB_DIALECT=sqlite`, os dados ficam em `server/data/aidrama.db`
- **MySQL**: defina `DB_DIALECT=mysql` e preencha `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- **Na primeira execução, o administrador inicial é criado automaticamente** (o console exibe um aviso):
  - Conta padrão **`admin / admin123`**, para entrar no painel de administração `/admin`
  - Pode ser sobrescrita pelas variáveis de ambiente `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD`; se já houver um administrador, a etapa é pulada automaticamente
  - ⚠️ Antes de ir para produção, troque imediatamente a senha padrão (`node scripts/setAdminPassword.js`, ou veja a seção do painel de administração mais abaixo)

### 2. Iniciar o cliente

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Abra <http://localhost:5173>: se não tiver conta, clique em «Cadastrar» (nome de usuário + senha, com um captcha de seleção de texto; ao cadastrar, você já entra automaticamente e ganha 66 créditos de experiência); se já tem conta, faça login diretamente (nome de usuário / e-mail / telefone, qualquer um serve).

> O cliente já vem com um proxy configurado: `/api` e `/files` são encaminhados automaticamente para `http://localhost:3000`.

---

## 🛠 Uso do painel de administração (client/admin)

O painel de administração tem **entrada, login e token próprios** (JWT com prefixo `admt_`, totalmente separado das sessões de usuário do frontend):

- **Entrada**: <http://localhost:5173/admin> (em produção: `https://seu-dominio.com/admin`)
- **Login**: conta + senha + captcha de seleção de texto. Na primeira execução, use o administrador inicial **`admin / admin123`**;
- **Trocar a senha**: o painel ainda não tem uma página para isso; use o script do servidor para redefinir:
  ```bash
  cd server
  node scripts/setAdminPassword.js <nome de usuário ou e-mail> <nova senha>
  ```
  (o login `adminAuth` aceita nome de usuário / e-mail / telefone como conta)

### Módulos de funções

| Módulo | Finalidade |
|---|---|
| **Configuração de modelos** | **Integração de LLMs nas quatro categorias: texto / imagem / vídeo / TTS** (veja a seção seguinte; obrigatório antes de ir para produção) |
| Provedores de modelos | Catálogo de provedores e modelos (fonte das predefinições ao criar configurações; o seed já traz os principais provedores) |
| Estilos artísticos / Opções de personagens / Biblioteca de vozes | Dicionários de materiais criativos (as opções exibidas no frontend são configuradas aqui) |
| Preços | Preço em créditos de cada etapa de IA (veja a tabela acima) |
| Gerenciamento de usuários | Consultar usuários, **banir/desbanir**, **redefinir senhas** (ponto unificado para casos de senha esquecida), ajustar créditos, **entrar no frontend como o usuário** (login-as, para investigar problemas no lugar dele) |
| Pagamentos | Consulta e conciliação de pedidos de recarga do WeChat |
| Moderação do showcase | Publicar/despublicar obras do centro de showcase |
| Gerenciamento de tarefas / Gerenciamento de geração de vídeo | Repetição e limpeza das filas de tarefas assíncronas e de geração de vídeo |
| Manutenção | Interruptor do modo de manutenção (503 + horário previsto de retorno), manutenção de dados |
| Registro de logins | Histórico de logins de todo o site (método / IP / UA) |

---

## 🔌 Configurar os LLMs / mídias (para que as funções de IA funcionem de verdade)

Toda a capacidade de IA é **orientada a configuração** e **gerenciada de forma centralizada na página «Configuração de modelos» do painel de administração** (o `.env` não fornece mais nenhuma configuração padrão de LLM). Sem configuração: as funções de texto avisam antes da chamada; imagem/vídeo/TTS retornam diretamente o erro «não configurado».

Passos de configuração:

1. Entre no painel `/admin` → **Configuração de modelos** → Adicionar;
2. Escolha o tipo (texto / imagem / vídeo / TTS) e o protocolo, e preencha:
   - **Base URL** (ex.: `https://api.openai.com/v1`)
   - **API Key** (armazenada somente no servidor, nunca enviada ao frontend)
   - **Nome do modelo** (ex.: `gpt-4o-mini`, `dall-e-3`)
   - Estado de ativação e os preços em créditos dessa configuração;
3. Depois de salvar, o frontend fica disponível imediatamente (é possível ter várias configurações do mesmo tipo e alternar a ativação); a página «Configuração de modelos» suporta **importar / exportar JSON**, útil para migrações em massa.

Protocolos suportados:

- **Texto / imagem / TTS**: compatível com OpenAI (`/chat/completions`, `/images/generations`, `/audio/speech`) ou endpoint personalizado (`api_style=custom`)
- **Vídeo**: configure um endpoint de tarefas assíncronas (envio → polling → URL do vídeo); é preciso um provider real de geração de vídeo (o «imagem para vídeo» local com ffmpeg foi descontinuado)

> Os usuários também podem adicionar **modelos privados** em «Configurações pessoais → Meus modelos» (com a própria Key; as chamadas não consomem créditos), sem afetar a configuração global.
> É necessário ter o `ffmpeg` instalado localmente (macOS: `brew install ffmpeg`). A concatenação dos clipes de vídeo depende dele.

---

## 🚢 Implantação em produção

O runbook completo está em **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (checklist de go-live com nginx, instância única com PM2/systemd, backup e restauração, go-live do WeChat Pay, pendências de conformidade). Requisitos mínimos de ambiente:

```bash
NODE_ENV=production            # Sem isso, entra em vigor uma chave JWT de desenvolvimento padrão: risco de segurança
JWT_SECRET=<string longa e aleatória para assinar os tokens de sessão locais>      # Este sistema assina/verifica as próprias sessões de usuário (axt_)
ADMIN_JWT_SECRET=<chave de assinatura independente do painel de administração>
FILE_SIGN_SECRET=<chave de assinatura anti-hotlink das mídias>   # Deve ser igual à chave secure_link do deploy/nginx.conf
PUBLIC_BASE_URL=https://your-domain.com
CLIENT_ORIGIN=https://your-domain.com
DB_DIALECT=mysql               # + DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
```

Para o WeChat Pay, são necessários também os cinco valores `WECHAT_PAY_*` (ID de comerciante, AppID, chave APIv3, número de série do certificado e chave privada do comerciante), veja `deploy/DEPLOY.md` ⑦.

---

## 🔑 Login e sistema de contas (local, sem dependências externas)

O sistema de contas é **integrado ao próprio sistema**: cadastro / login / troca de senha / renovação de sessão passam todos pelo servidor local `/api/auth/*`, sem depender de nenhum centro de contas de terceiros:

- **Cadastro**: nome de usuário (2–64 caracteres: letras, números, `_.-`) + senha (≥6 caracteres) + e-mail (opcional); é preciso passar pelo captcha de seleção de texto (gerado em SVG pelo backend, `/api/captcha/*`); ao cadastrar, você já entra automaticamente e ganha 66 créditos de experiência;
- **Login**: nome de usuário / e-mail / telefone, qualquer um + senha; o captcha «só é validado se for enviado» (o frontend o envia por padrão);
- **Tokens**: JWT assinado pelo próprio servidor (prefixo `axt_`, access + refresh, o refresh não é rotativo); a renovação silenciosa do frontend vai por `/api/auth/oauth/refresh`; os tokens do painel de administração são separados (prefixo `admt_`);
- **Esqueci a senha**: instâncias auto-hospedadas não têm canal de SMS/e-mail e não oferecem redefinição por conta própria — um administrador faz isso no **painel de administração, em «Gerenciamento de usuários» → Redefinir senha**;
- **Banimento**: após o banimento, todos os tokens emitidos daquele usuário ficam inválidos já na próxima requisição (o servidor reconsulta o status do usuário a cada requisição);
- **Login de terceiros (opcional)**: o login com um toque via Apple / Google no app mobile continua funcionando — o servidor faz a troca como intermediário com as chaves secretas (`POST /api/auth/oauth/:provider`) e devolve a mesma sessão local `axt_`; o Web não precisa registrar nenhum callback.

Variáveis `.env` relacionadas: `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CAPTCHA_TICKET_SECRET`, `ADMIN_INIT_USERNAME`, `ADMIN_INIT_PASSWORD` (todas comentadas em `server/.env.example`).

---

## 💚 WeChat Pay (V3 · Native por QR Code / JSAPI)

WeChat Pay real, **orientado a configuração e desativado por padrão** (se `WECHAT_PAY_*` ficar vazio no `.env`, a função fica desabilitada e o frontend oculta automaticamente a entrada de recarga). O `WECHAT_APP_ID` é mantido apenas como valor de fallback do AppID de pagamento.

Habilite os pagamentos Native/JSAPI na [plataforma de comerciantes do WeChat](https://pay.weixin.qq.com/) (WeChat Pay Merchant Platform), obtenha o ID de comerciante e a chave APIv3 e baixe o certificado de API do comerciante (`apiclient_key.pem` + número de série do certificado). **O ID de comerciante e o AppID precisam estar vinculados na plataforma de comerciantes** (caso contrário, a criação do pedido falha com `APPID_MCHID_NOT_MATCH`). Configuração:
```bash
WECHAT_PAY_METHOD=native       # native=QR Code | jsapi=pagamento dentro da Conta Oficial (no PC usa o caixa H5)
WECHAT_PAY_APP_ID=             # AppID vinculado ao ID de comerciante (se vazio, cai para o WECHAT_APP_ID)
WECHAT_PAY_MCH_ID=<seu ID de comerciante>
WECHAT_PAY_API_V3_KEY=         # Chave APIv3 de 32 caracteres
WECHAT_PAY_SERIAL_NO=          # Número de série do certificado de API do comerciante
WECHAT_PAY_PRIVATE_KEY_PATH=cert/apiclient_key.pem   # Caminho em disco do apiclient_key.pem (alternativa à linha seguinte)
WECHAT_PAY_PRIVATE_KEY=        # Ou diretamente o texto PEM inline
WECHAT_PAY_NOTIFY_URL=         # Se vazio, usa ${PUBLIC_BASE_URL}/api/recharge/wechat/notify
```
- Fluxo: no centro de créditos, escolha «WeChat Pay» → o backend cria o pedido unificado (Native devolve o `code_url` para renderizar o QR Code / JSAPI invoca o pagamento) → o usuário paga → o WeChat chama de volta de forma assíncrona `/api/recharge/wechat/notify` (descriptografia e verificação AES-256-GCM, lançamento idempotente).
- O callback precisa ser um **endereço HTTPS acessível pela internet pública** (durante o desenvolvimento, dá para usar um túnel de rede).

> Passos para o go-live (vincular o AppID na plataforma de comerciantes, colocar o certificado no servidor, teste de regressão com um pedido real de um centavo) em **[deploy/DEPLOY.md](deploy/DEPLOY.md) ⑦ Passos de go-live do WeChat Pay**.
> Banco de dados: o número de transação do pedido de pagamento é gravado em `recharge_orders.transaction_id`, adicionado de forma idempotente pelo `ensureColumns` na inicialização; bancos antigos não são afetados.

---

## 🧪 Passos de verificação de ponta a ponta

0. Painel de administração `/admin` (admin/admin123) → **Configuração de modelos** → configure as quatro categorias (texto/imagem/vídeo/TTS); sem isso, as etapas de IA ficam indisponíveis
1. Cadastre-se/faça login no frontend → novo projeto → «Estrutura do roteiro»: cole/envie o roteiro → **divisão do roteiro por IA** (consome créditos)
2. «Biblioteca de assets» → **extração de assets por IA** → **gere imagens de assets** para os personagens/cenários
3. «Vídeo por episódio» → **gerar roteiro** → entre no **editor de storyboard**
4. No editor, selecione um trecho → **gerar agora** (clipe de vídeo, com extração automática do primeiro frame como capa de pré-visualização)
5. **Monte o episódio completo** (o ffmpeg concatena o mp4 do episódio inteiro)
6. No «Centro de créditos», veja o extrato e faça a recarga; no painel de administração, mude os preços / bana usuários / redefina senhas / veja o registro de logins; alterne entre os temas claro/escuro/automático

---

## 📡 Principais APIs (prefixo `/api`, autenticação JWT, resposta unificada `{code,message,data}`)

```
POST /auth/register | /auth/login                              # Cadastro local (requer ticket do captcha) / login (público, com limite de taxa)
POST /auth/password                                            # Troca de senha (com sessão ativa)
POST /auth/oauth/refresh                                       # Renovação silenciosa (refresh_token por um novo access_token, público)
POST /auth/oauth/:provider                                     # Login de terceiros trocado por sessão local (apple/google/weixin/huawei, opcional)
GET /auth/me   POST /auth/sync                                 # Perfil do usuário
POST /captcha/challenge | /captcha/verify                      # Captcha de seleção de texto
GET/POST/PUT/DELETE /projects          GET /projects/:id
POST /projects/:id/script/import       POST /projects/:id/script/parse
POST /projects/:id/extract             GET /projects/:id/assets  POST /assets/:id/generate-image
POST /episodes/:id/generate-storyboard GET /episodes/:id/segments
POST /segments/:id/generate            PUT /segments/:id
POST /episodes/:id/compose             GET /episodes/:id/video
GET /jobs                                                              # Central de tarefas assíncronas (o frontend faz polling)
GET /model-configs                     POST /model-configs/import  GET /model-configs/export   # Lado de leitura da configuração global + importar/exportar (mantido no painel de administração)
GET /credits/balance | /credits/transactions
GET /recharge/packages  POST /recharge/create  GET /recharge/orders/:id
POST /recharge/wechat/notify                                   # Callback do WeChat Pay (sem autenticação, verificação de assinatura + idempotência)
GET /showcase/*                                                # Centro de showcase (publicar/navegar/fazer uma versão própria)
GET /market/*                                                  # Central de encomendas (tarefas/retensão/aceitação)
GET /pricing
```
Cada endpoint de IA tem um endpoint `…/estimate` correspondente para estimar os créditos; os endpoints de administração (`/admin/*`: usuários/pagamentos/tarefas/logs/manutenção etc.) usam um token próprio do painel de administração (`admt_`).

---

## 🛠 Stack tecnológica

**Servidor**: Express · Sequelize (dialetos duplos mysql/sqlite) · JWT · bcrypt · multer · axios · fluent-ffmpeg · sharp
**Web**: Vue 3 · Vite · Vue Router · Pinia · Element Plus · vue-i18n · axios (shell desktop: Electron + electron-updater)
**Mobile**: uni-app (App / shell de Mini Programas / H5)

## 📝 Observações

- Este projeto entrega uma base de "funcionalidade utilizável de ponta a ponta": todas as APIs e páginas funcionam de verdade e são executáveis; a UI replica a estrutura e os estados das telas de referência.
- Os providers externos (imagem/vídeo/TTS) exigem chaves reais configuradas no **painel de administração** para gerar material real de ponta a ponta; o ffmpeg serve apenas para concatenar e montar os clipes de vídeo.
- Após alterar os modelos do Sequelize, no SQLite apague `server/data/*.db` e reinicialize (em produção, recomenda-se usar migrations).

---

## 📄 Licença de código aberto

Este projeto é distribuído como código aberto sob a [AGPL-3.0](LICENSE).

- ✅ **Uso pessoal, de estudo, pesquisa e não comercial**: gratuito; se, após modificar, você oferecer um serviço de rede, deve cumprir as obrigações de código aberto da AGPL-3.0
- 💼 **Implantação comercial / serviços SaaS / entregas privadas**: é preciso adquirir uma licença comercial (que pode dispensar as obrigações de código aberto da AGPL-3.0); para licenças comerciais, contate: <kevin@xw.com>

---

## 📮 Fale conosco

- 📧 E-mail: <kevin@xw.com>
- 🌐 Demonstração online: <https://aiwork.xw.com>
- 💬 Grupo do WeChat «星网AI剧场开源交流» (Comunidade open source do Teatro de IA da Xingwang):

  ![QR Code do grupo do WeChat 星网AI剧场开源交流](docs/wechat-group-qr.jpg)
