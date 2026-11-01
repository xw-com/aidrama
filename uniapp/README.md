# AIDrama 掌上制片厂 · uniapp 全端版

H5 / 微信小程序 / App（Android、iOS、鸿蒙 HarmonyOS NEXT）五端同构。

```bash
npm install

# 开发
npm run dev:h5            # H5（/api /files /skills 代理到 localhost:3000）
npm run dev:mp-weixin     # 微信小程序（dist/dev/mp-weixin 导入微信开发者工具）
npm run dev:app           # App 资源（通用 Android + iOS）
npm run dev:app-android   # App 资源（Android 细分，条件编译 APP-ANDROID）
npm run dev:app-ios       # App 资源（iOS 细分，条件编译 APP-IOS）
npm run dev:app-harmony   # 鸿蒙资源

# 发行
npm run build:h5 / build:mp-weixin / build:app / build:app-android / build:app-ios / build:app-harmony
```

编译器版本跟随 package.json（当前 `3.0.0-5020420260813003`，对应 HBuilderX 5.02.04 alpha），
**升级时五端依赖须同步换版**，可用 `npx @dcloudio/uvm@latest alpha`。

## App 端公共配置

- `src/manifest.json`：应用名/版本/图标、`app-plus.distribute`（Android 权限与 abiFilters、iOS 隐私说明）、`app-harmony`（bundleName 等）。
- `.env`：`VITE_API_BASE` 必须为**绝对地址**（App 无同源概念，App 端由它派生 API 源站）；
  OAuth 回调落点默认回退该源站，H5 部署在别处时配 `VITE_H5_ORIGIN`（详见 `.env.example`）。
- 登录走 xworld OAuth2 + PKCE：App 端经内置 web-view 打开授权页，授权后 302 回 H5 部署站的
  `pages/login/callback`，该页通过 uni-webview-js 桥把 code 发回原生层（`pages/webview/index`）。
  **xworld 后台登记的 redirect_uri 必须是 H5 部署站的绝对地址。**
- `manifest.json` 的 `"appid"` 为空时，首次用 HBuilderX 云打包会引导自动生成 DCloud appid（`__UNI__` 开头）。

## Android / iOS

App 端产物是 JS 资源包，打包成安装包需 HBuilderX：

1. HBuilderX（≥5.02 alpha，与编译器版本一致）打开本 `uniapp/` 目录（CLI 项目可直接拖入）。
2. **云打包**：发行 → 原生 App-云打包。Android 证书自持（keystore）；iOS 需 p12 + 描述文件。
   包名/bundleId 在打包面板填写，与证书一致。
3. **离线打包**：下载对应版本 App 离线 SDK，Android 工程 `dcloud_control.xml` 填 appid 后 gradle 打包；
   iOS 工程 Xcode 打包。包名、证书、图标在原生工程里配置。
4. 本项目仅用到 `VideoPlayer` 模块（manifest 已声明），云打包勾选对应模块即可。

## 鸿蒙 HarmonyOS NEXT

只支持 Vue3（本项目即），不支持 plus API；条件编译仅 `APP` / `APP-HARMONY` 可命中（`APP-PLUS` 命不中），
本项目源码只用 `#ifdef H5 / #ifndef H5` 分叉，天然兼容。

环境要求（官方文档：运行和发行）：

1. **DevEco Studio 5.0.3.800+**（HBuilderX 依赖其鸿蒙工具链；模拟器镜像需 API ≥ 19），
   HBuilderX 设置 → 运行配置 → 鸿蒙运行配置里填 DevEco 安装路径。
2. HBuilderX 打开本项目 → 运行 → 运行到手机或模拟器 → **运行到鸿蒙**（首次自动生成
   `harmony-configs/` 目录与 `unpackage/.../app-harmony` 鸿蒙工程）。
3. 真机调试需签名：HBuilderX 4.61+ 在「选择运行设备」对话框点【配置调试证书】可自动申请
   （AGC 建 App ID → 注册设备 UDID → 自动出 .p12/.cer/.p7b）。
4. **上架发行**：发行 → App-Harmony-本地打包，按提示配好发布证书后产出已签名 `.app` 包，
   再走 AppGallery Connect 提审。

注意事项：

- `app-harmony.bundleName`（manifest.json，当前占位 `com.xworld.aidrama`）必须与 AGC 证书/profile
  的包名逐字一致，改包名要重签。
- 鸿蒙工程路径**不得超长/含中文/特殊字符**（uniapp 项目根路径建议 ≤77 字符）；HBuilderX 4.61+ 可在
  `.hbuilderx/launch.json` 用 `distPathDev`/`distPathBuild` 把鸿蒙工程挪到短路径。
- 权限等原生定制放 `harmony-configs/`（整体覆盖到生成的鸿蒙工程）。注意 `module.json5` 是整文件覆盖，
  须先从 `unpackage` 生成的鸿蒙工程拷出完整文件再改；网络权限 `ohos.permission.INTERNET` 模板默认已带。
- 提审被拒「使用了受限 ACL 权限」时，检查 `harmony-configs/entry/src/main/module.json5` 的
  `requestPermissions`，删掉没用到的 `WRITE_IMAGEVIDEO` 等受限权限。
- 应用图标须为 1024×1024 分层资源（前景+背景）；启动图建议正方形 logo。

## 端差异备忘

- SSE：H5 走 fetch 流式读取，App/小程序/Harmony 走 `uni.request enableChunked` 增量接收（`src/api/sse.js`）。
- 视频：全端用 `<video>` + `uni.createVideoContext`；支付：H5 微信内 JSAPI 拉起 / 小程序跳 `pages/pay/mini`
  壳页，App 端不自动拉起（跳转入口均 `#ifdef` 屏蔽），仅展示二维码扫码 + 轮询，原生支付未接。
- 存储统一走 `src/utils/storage.js`（H5 用 localStorage，其余 `uni.setStorageSync`）。
