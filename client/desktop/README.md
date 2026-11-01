# XWorld AI短剧工坊 · 桌面客户端壳（Windows / macOS）

Electron 壳 + 本地构建产物 + 壳内反向代理。前端代码零改动：Vue SPA 继续按
「同源相对路径」运行，`/api`、`/files`、`/skills` 由主进程 `net.fetch` 转发到远端服务。

```
┌─ BrowserWindow ──────────────────────────────┐
│  app://xw-client/   ←── 本地 dist（asar 内）  │
│    /api  /files  /skills ──┐                 │
└────────────────────────────┼─────────────────┘
                             ▼ net.fetch 反向代理
                      apiBase（远端 AIDrama 服务）
```

## 目录结构

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：协议服务/代理、OAuth 授权窗、窗口与下载管理、自动更新、崩溃落盘 |
| `prepare-dist.js` | 打包前把 `../dist` 同步进本目录（跨平台） |
| `config.json` | 运行时配置，随包放在 Resources 下，**发布前可手工改** |
| `build/icon.png` | 应用图标源（≥512，electron-builder 自动生成 icns/ico） |
| `dist/` | 同步产物（脚本生成，勿手改） |
| `release/` | 打包输出（脚本生成） |

## 配置（config.json / 环境变量）

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `apiBase` | `XW_DESKTOP_API` | `http://localhost:3000` | 远端服务地址，`/api /files /skills` 转发目标 |
| `authHosts` | `XW_DESKTOP_AUTH_HOSTS`（逗号分隔） | `["auth.example.com"]` | xworld 授权中心主机，命中即开授权窗 |
| `siteUrl` | `XW_DESKTOP_SITE` | 空 | **非空 = 薄壳模式**：直接加载该站点，不做协议/代理/OAuth 接管 |
| `autoUpdateUrl` | — | 空 | 自动更新源（generic 静态目录，格式 `<base>/`）。**留空 = 完全跳过更新检查，不发任何网络请求**，详见下文「自动更新与发版流程」 |

> `config.json` 是严格 JSON，不能写注释；`autoUpdateUrl` 的取值格式为
> `"https://dl.example.com/aidrama-desktop/"`（以 `/` 结尾的目录地址，指向托管
> `latest.yml` / `latest-mac.yml` 与安装包的位置）。

优先级：环境变量 > config.json > 内置默认。打包后 config.json 落在
`XWorld AI短剧工坊.app/Contents/Resources/config.json`（Windows 为安装目录 `resources/config.json`），
可直接编辑切换环境，无需重新打包。

## 常用命令

```bash
# 依赖安装（国内建议先设镜像，见下「网络」）
npm install

# 开发调试：跑本地 dist（先在 client/ 下 npm run build）
npm start

# 薄壳模式联调（直接加载 vite dev server，改代码热更）
XW_DESKTOP_SITE=http://localhost:5173 npm start        # macOS
# Windows PowerShell：$env:XW_DESKTOP_SITE='http://localhost:5173'; npm start

# 打包（自动先 vite build → 同步 dist → electron-builder）
# 在 client/ 下执行：
npm run desktop:mac        # dmg + zip（x64 + arm64）
npm run desktop:win        # nsis 安装包（x64）
# 或在 desktop/ 下：npm run dist:mac / dist:win / dist

# 冒烟自检（窗口加载成功 2 秒后自动退出，exit 0 = 通过）
XW_DESKTOP_SMOKE=1 npx electron .
```

产物在 `desktop/release/`：
- macOS：`*.dmg` + `*-mac.zip`（x64 / arm64 各一套）
- Windows：`XWorld AI短剧工坊 Setup *.exe`（NSIS，可选安装目录）

## 网络镜像（国内必读）

Electron / electron-builder 的二进制走 GitHub，直连会卡死：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

已安装但 `node_modules/electron/dist` 缺失时补跑：
`cd node_modules/electron && ELECTRON_MIRROR=… node install.js`

⚠️ 注意 `ELECTRON_RUN_AS_NODE=1` 环境变量会让 Electron 退化成纯 Node
（VSCode 终端可能带此变量），调试时先 `env -u ELECTRON_RUN_AS_NODE`。

## OAuth 登录（关键集成点）

前端 `redirectUri()` = `window.location.origin + '/oauth/callback'`，桌面壳下即：

```
app://xw-client/oauth/callback
```

**该回调地址须在 xworld 授权中心登记（逐字节一致）**，桌面端才能登录。
自定义 scheme 回调有先例：uniapp App 端当年登记过 `aidrama://oauth/callback`。
若 xworld 只收 https 回调，退路有二：
1. 环回回调（RFC 8252 §7.3）：登记 `http://127.0.0.1:<port>/oauth/callback`，壳内起小 HTTP 服务接码；
2. 薄壳模式（`siteUrl` 指向线上站）：登录流程原样工作，无需任何登记。

登录流程中壳的行为：主窗口整页跳转 xworld 授权页 → 拦截并开独立「授权窗」；
授权完成后 302 回 `app://xw-client/oauth/callback` 时截获，交回主窗口加载，
由前端既有 `OAuthCallbackView` 完成 state 校验与换令牌（零改动）。

## 签名与分发（对外发布需要）

未签名的包仅适合内部试用（mac 首次右键打开；Windows 会过 SmartScreen 提示）。

⚠️ 本机钥匙串里若已有证书，electron-builder 会自动挑一把来签（实测捡到了
`Apple Development` 证书）——**Development 证书只够本机运行，签出来的包不能对外分发**；
对外必须用 `Developer ID Application` 证书 + 公证，显式指定：

**macOS**（Developer ID + 公证）：
```bash
export CSC_NAME="Developer ID Application: Your Co (TEAMID)"
export APPLE_ID="you@company.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com 生成
export APPLE_TEAM_ID="TEAMID"
npm run dist:mac        # electron-builder 自动签名 + notarize（staple 需 26+ 默认开启）
```

**Windows**（EV/OV 代码签名，否则 SmartScreen 拦截）：
```bash
export CSC_LINK="开发证书.pfx 的路径或 URL"
export CSC_KEY_PASSWORD="pfx 密码"
npm run dist:win
```

## 自动更新与发版流程

主进程已接入 `electron-updater`（**dependencies**，须随包打进 asar）。源地址读
`config.json` 的 `autoUpdateUrl`（generic provider）：**留空或开发态（`npm start`）完全
跳过更新检查，零网络请求**；检查/下载任一步失败（离线、内网、源 404）一律静默，
异常只写本地 `main-error.log`，不打扰用户。

更新策略：发现新版本先弹窗征得同意再下载（`autoDownload=false`）；下载完成后再次确认
才 `quitAndInstall`（`latest.yml` 的 `critical` 字段暂不区分，一律可选更新）；用户选
「稍后」则在退出应用时静默安装（`autoInstallOnAppQuit=true`）。

**发版流程**（每次对外发布）：

1. 改 `package.json` 的 `version`（electron-updater 按版本号比对，必须递增）；
2. 在 `client/` 下执行 `npm run desktop:mac` / `npm run desktop:win`（或 `desktop/` 下
   `npm run dist:*`），产物在 `desktop/release/`；
3. 上传到 `autoUpdateUrl` 指向的静态目录（nginx/autoalias 均可，纯静态托管）：
   - Windows：`*.exe`（NSIS 安装包）+ `latest.yml`
   - macOS：`*.dmg` + `*-mac.zip` + `latest-mac.yml`（zip 是 electron-updater 增量安装
     实际下载的文件，dmg 只给人下载，两者都要传）
4. 用户端最迟下次启动时收到更新提示。

`package.json` 的 `build.publish` 只是 electron-builder 生成上述 yml 的元数据，把 `url`
占位改成真实发版地址即可（与 `autoUpdateUrl` 保持一致）。

## 崩溃收集与日志（本地方案）

无第三方账号依赖，全部落用户本地：

| 内容 | 位置 |
|---|---|
| 主进程未捕获异常 / Promise 拒绝 / 渲染进程崩溃记录 | `userData/logs/main-error.log`（带时间戳，单文件 5MB，超过轮转为 `main-error.old.log`） |
| minidump（crashReporter，`submitURL` 留空只落盘不上传） | `userData/Crash Reports`（Windows）/ `userData/Crashpad`（macOS） |

`userData` 目录：Windows 为 `%APPDATA%\XWorld AI短剧工坊`，macOS 为
`~/Library/Application Support/XWorld AI短剧工坊`。应用内暂无「打开日志目录」入口，
排查问题时直接到上述路径取文件；接 Sentry 时把 `main.js` 里 `crashReporter.start` 的
`submitURL` 填上 Sentry 的 minidump 端点即可开启上传。渲染进程崩溃会给用户
「重新加载」对话框（同一窗口只弹一次）。

## 已知边界

- 交叉打包：mac 上可直接出 Windows NSIS 包（无签名）；正式对外建议在对应平台出包。
- 视频 `Range` 拖动、SSE 流式、`window.open` 子窗口（视频剪辑器）、下载接管、
  深链刷新（history 回退）均已由壳处理。
- 壳层默认放行 `/api /files /skills` 三个前缀；后端若新增独立前缀（如 `/ws`），
  在 `main.js` 的 `PROXY_PREFIXES` 同步追加。
