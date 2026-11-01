// XWorld AI短剧工坊 · 桌面壳（Windows/macOS）主进程
//
// 正式模式（默认）：
//   窗口加载本地构建产物 app://xw-client/（client/ 下 vite build 的 dist）：
//   - 静态资源由壳内协议 handler 提供（含 SPA history 回退，路由直接刷新可用）
//   - /api、/files、/skills 经 net.fetch 反向代理到远端服务（apiBase）
//     —— 前端保持「同源相对路径」假设零改动；/files 的 Range 请求原样透传，视频可拖进度条
//   - 其余 https 外链一律走系统浏览器；window.open 开应用内子窗口（视频剪辑器等具名窗口）
// 薄壳模式（联调）：siteUrl（XW_DESKTOP_SITE）非空时直接加载远端站点，
//   不做协议注册/代理——远端站点原生同源语义，登录支付全部照常。
// 自动更新：config.json 的 autoUpdateUrl 非空时接入 electron-updater（generic 静态源）；
//   为空 = 完全跳过更新检查，零网络请求。全程 try/catch 静默失败。
// 崩溃收集：本地方案（无 Sentry 账号）——主进程未捕获异常/Promise 拒绝、渲染进程崩溃
//   统一追加写 userData/logs/main-error.log（5MB 截断轮转）；minidump 仅本地落盘。
// 冒烟自检：XW_DESKTOP_SMOKE=1 时窗口加载完成 2 秒后自动退出（exit 0），供流水线使用。

const { app, BrowserWindow, protocol, session, shell, dialog, net, Notification, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

const SCHEME = 'app';
const APP_HOST = 'xw-client';
const APP_ORIGIN = `${SCHEME}://${APP_HOST}`;
// 需要转发到远端服务的路径前缀（与 vite dev proxy、nginx 的转发口径一致）
const PROXY_PREFIXES = ['/api', '/files', '/skills'];
// 主窗口背景色：与项目「影棚黑」主题一致，避免启动白闪
const BG_COLOR = '#141316';

const DIST_DIR = path.join(__dirname, 'dist');

// ---------------------------------------------------------------------------
// 崩溃收集（本地方案，无 Sentry 账号）：
// - 主进程 uncaughtException / unhandledRejection → userData/logs/main-error.log
// - 渲染进程崩溃（render-process-gone）→ 同样落盘 + 给用户友好对话框（带「重新加载」）
// - crashReporter：submitURL 留空 + uploadToServer:false = 只在本地落 minidump，
//   不向任何服务器上传；将来接 Sentry 时把 submitURL 填成 Sentry 的 minidump 端点即可。
const ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024; // 单文件 5MB，超过轮转为 main-error.old.log

function errorLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'main-error.log');
}

// 同步写：崩溃路径上异步写可能来不及落盘就退出。5MB 轮转 = 旧文件改名为 .old.log（覆盖）
function appendErrorLog(source, err) {
  try {
    const file = errorLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > ERROR_LOG_MAX_BYTES) {
        fs.rmSync(file.replace(/\.log$/, '.old.log'), { force: true });
        fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
      }
    } catch (e) { /* 轮转失败不影响写入 */ }
    const ts = new Date().toISOString();
    const body = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(file, `[${ts}] [${source}] ${body}\n\n`);
  } catch (e) { /* 日志本身失败只能吞掉，绝不能再抛 */ }
}

try {
  crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
} catch (e) { /* 个别平台不可用时忽略；minidump 目录见 app.getPath('crashes') */ }

// 主进程级异常兜底：只落盘不弹窗（渲染层崩溃才有对话框），也不主动退出——
// Electron 主进程带伤运行通常好过直接闪退，用户可从菜单/F12 观察或手动关闭
process.on('uncaughtException', (err) => appendErrorLog('uncaughtException', err));
process.on('unhandledRejection', (reason) => appendErrorLog('unhandledRejection', reason));

// 渲染进程崩溃：落盘 + 友好对话框（重新加载 / 关闭）。全局挂 web-contents-created，
// 主窗口与授权窗一并覆盖。同一窗口只弹一次，避免连环崩溃时对话框堆叠。
const crashDialogShown = new WeakSet();
app.on('web-contents-created', (_event, wc) => {
  wc.on('render-process-gone', async (_ev, details) => {
    appendErrorLog('render-process-gone', `reason=${details.reason} exitCode=${details.exitCode}`);
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed() || crashDialogShown.has(wc)) return;
    crashDialogShown.add(wc);
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '页面出现问题',
        message: '页面意外崩溃了',
        detail: `渲染进程异常退出（${details.reason}）。重新加载通常即可恢复；若反复出现，请把日志目录中的 main-error.log 反馈给开发者。`,
        buttons: ['重新加载', '关闭'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0 && !win.isDestroyed()) win.webContents.reload();
    } catch (e) { /* 窗口已销毁等场景忽略 */ }
  });
});

// ---------------------------------------------------------------------------
// 配置：resources/config.json（打包后可直接改）→ 环境变量覆盖
function loadConfig() {
  const cfg = {
    apiBase: 'http://localhost:3000', // 远端 AIDrama 服务地址
    siteUrl: '', // 非空 = 薄壳模式：直接加载该站点
    // 自动更新源（generic provider）：指向静态托管 latest*.yml 与安装包的目录，格式 <base>/
    // 如 https://dl.example.com/aidrama-desktop/ 。留空 = 完全跳过更新检查，不发任何网络请求
    autoUpdateUrl: '',
  };
  const p = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'config.json');
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { /* 无配置文件用默认值 */ }
  if (process.env.XW_DESKTOP_API) cfg.apiBase = process.env.XW_DESKTOP_API;
  if (process.env.XW_DESKTOP_SITE) cfg.siteUrl = process.env.XW_DESKTOP_SITE;
  if (cfg.siteUrl) cfg.siteUrl = cfg.siteUrl.replace(/\/+$/, '');
  if (cfg.apiBase) cfg.apiBase = cfg.apiBase.replace(/\/+$/, '');
  return cfg;
}
const CFG = loadConfig();
const BASE_ORIGIN = CFG.siteUrl || APP_ORIGIN; // 导航放行的「站内」origin

let mainWindow = null;

// ---------------------------------------------------------------------------
// app:// 协议：standard+secure 才有正常的 origin/localStorage/history API；
// stream+supportFetchAPI 支撑 SSE 流式读取
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

function isProxied(pathname) {
  return PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// 反向代理：保持同源语义的关键。Range/206 原样透传（视频拖动）、流式透传请求体（上传不进内存）
async function proxyRequest(request) {
  const u = new URL(request.url);
  const target = CFG.apiBase + u.pathname + u.search;
  const headers = new Headers(request.headers);
  for (const h of ['host', 'origin', 'referer', 'connection', 'content-length']) headers.delete(h);
  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body; // ReadableStream
    init.duplex = 'half';
  }
  try {
    return await net.fetch(target, init);
  } catch (err) {
    // 服务不可达等：给前端一个结构化 JSON，走 http 层既有错误提示
    return new Response(JSON.stringify({ message: `desktop proxy: ${err.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// 静态文件 + SPA history 回退（vue-router createWebHistory 的深链刷新都落 index.html）
async function serveStatic(u) {
  const root = DIST_DIR + path.sep;
  let filePath = path.normalize(path.join(DIST_DIR, decodeURIComponent(u.pathname)));
  if (!filePath.startsWith(root)) return new Response('forbidden', { status: 403 });
  try {
    const st = await fs.promises.stat(filePath);
    if (st.isFile()) return await net.fetch(url.pathToFileURL(filePath).toString());
  } catch (e) { /* 不存在则回退 index.html */ }
  return await net.fetch(url.pathToFileURL(path.join(DIST_DIR, 'index.html')).toString());
}

// ---------------------------------------------------------------------------
// 导航接管：站内 origin 放行；其余 https 外链 → 系统浏览器
function attachNavigation(win) {
  const wc = win.webContents;
  // window.open（视频剪辑器具名窗口等）：站内开应用内子窗口，同 session 共享 localStorage 会话
  wc.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(BASE_ORIGIN)) {
      createWindow(target, { width: 1280, height: 800 });
      return { action: 'deny' };
    }
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, target) => {
    if (target.startsWith(BASE_ORIGIN)) return; // 站内放行
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });
  attachDevTools(wc);
}

function attachDevTools(wc) {
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.key === 'I' && input.control && input.shift))) {
      wc.toggleDevTools();
    }
  });
}

// ---------------------------------------------------------------------------
function createWindow(loadTarget, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1440,
    height: opts.height || 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true, // Win 下隐藏菜单栏（Alt 可唤出）；mac 走系统菜单栏
    backgroundColor: BG_COLOR,
    title: 'XWorld AI短剧工坊',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.once('ready-to-show', () => win.show());
  attachNavigation(win);
  win.loadURL(loadTarget);
  return win;
}

// 下载接管：弹保存对话框（默认「下载」目录 + 原文件名），完成后系统通知
function attachDownloadHandler() {
  session.defaultSession.on('will-download', async (e, item) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    });
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
    item.once('done', (_ev, state) => {
      if (state !== 'completed' || !Notification.isSupported()) return;
      new Notification({ title: '下载完成', body: path.basename(filePath) }).show();
    });
  });
}

// ---------------------------------------------------------------------------
// 自动更新（electron-updater · generic 静态源）
// - 源地址：config.json 的 autoUpdateUrl（格式 <base>/，指向托管 latest.yml / latest-mac.yml
//   与安装包的目录）；留空 = 完全跳过更新检查，不发任何网络请求；开发态（未打包）同样跳过
// - 策略：latest.yml 的 critical 字段暂不区分强制升级，一律「可选更新」——发现新版先弹窗
//   征得同意再下载；下载完成后 quitAndInstall 前再次确认；用户选「稍后」则退出时静默安装
// - 全程 try/catch 静默失败：离线/内网/源 404 均不打扰用户，异常只写本地错误日志
function setupAutoUpdate() {
  if (!CFG.autoUpdateUrl || !app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;        // 先询问用户再下载
    autoUpdater.autoInstallOnAppQuit = true; // 用户暂不升级时，退出时自动装上
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({ provider: 'generic', url: CFG.autoUpdateUrl });

    autoUpdater.on('update-available', async (info) => {
      try {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `发现新版本 v${info.version}（当前 v${app.getVersion()}），是否下载？`,
          buttons: ['下载更新', '暂不'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await autoUpdater.downloadUpdate(); // 失败走下面的 error 事件
      } catch (e) {
        appendErrorLog('autoUpdater.downloadUpdate', e);
      }
    });

    autoUpdater.on('update-downloaded', async (info) => {
      try {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: '更新已就绪',
          message: `新版本 v${info.version} 已下载完成，立即重启安装吗？`,
          detail: '选择「稍后」也会在下次退出应用时自动完成安装。',
          buttons: ['立即重启安装', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) autoUpdater.quitAndInstall(false, true);
      } catch (e) {
        appendErrorLog('autoUpdater.update-downloaded', e);
      }
    });

    autoUpdater.on('error', (err) => appendErrorLog('autoUpdater.error', err));

    autoUpdater.checkForUpdates().catch((err) => {
      // 离线 / 内网 / 源不可达：静默失败，只留档
      appendErrorLog('autoUpdater.checkForUpdates', err);
    });
  } catch (e) {
    appendErrorLog('setupAutoUpdate', e);
  }
}

// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    attachDownloadHandler();
    setupAutoUpdate(); // autoUpdateUrl 为空时内部直接返回（零网络请求）

    if (CFG.siteUrl) {
      // 薄壳模式：远端站点原生同源，无需协议与代理接管
      mainWindow = createWindow(CFG.siteUrl);
    } else {
      if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        dialog.showErrorBox('XWorld AI短剧工坊', '缺少前端构建产物（desktop/dist/index.html）。\n请在 client/ 下执行 npm run build 后重试。');
        app.quit();
        return;
      }
      protocol.handle(SCHEME, async (request) => {
        try {
          const u = new URL(request.url);
          if (isProxied(u.pathname)) return await proxyRequest(request);
          return await serveStatic(u);
        } catch (err) {
          return new Response(`desktop shell error: ${err.message}`, { status: 500 });
        }
      });
      mainWindow = createWindow(`${APP_ORIGIN}/`);
    }

    // 冒烟自检：加载完成后自动退出；15s 兜底超时按失败退出
    if (process.env.XW_DESKTOP_SMOKE) {
      const t = setTimeout(() => { console.error('[smoke] timeout'); app.exit(1); }, 15000);
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => { clearTimeout(t); app.exit(0); }, 2000);
      });
    }

    app.on('activate', () => {
      // mac 关窗后点 Dock 图标重建窗口
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow(CFG.siteUrl || `${APP_ORIGIN}/`);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
