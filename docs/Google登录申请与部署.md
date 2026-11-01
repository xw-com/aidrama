# App 端 Google 登录申请与部署

> 适用对象：uniapp 打包的 **Android App**（iOS/鸿蒙不展示 Google 登录；国内无 GMS 设备点登录会失败提示）。
>
> 结论先行：**在 Google Cloud Console 建 OAuth 同意屏幕 + 一个 Android 型 OAuth 客户端 ID
> （包名 + 发布证书 SHA-1），client_id 同时填进 uniapp manifest 和服务端 `GOOGLE_CLIENT_IDS`**。
> 代码链路（uniapp 按钮 → `uni.login` → 服务端 `/api/auth/oauth/google`）已全部就绪；
> 服务端优先验 `idToken`（Google JWKS 验签），旧版基座只回 `access_token` 时自动回源 userinfo 兼容。

---

## 一、链路总览

```
Android App (uni.login provider=google，走 Google Play Services 授权)
  │  Google 账号选择弹窗
  │◀── authResult { idToken / access_token, ... }
  ▼
AIDrama 服务端  POST /api/auth/oauth/google
  │  1. 有 idToken：Google 官方 JWKS 验签 RS256 + 校验 iss / aud(∈GOOGLE_CLIENT_IDS) / exp
  │  2. 只有 access_token：回源 https://www.googleapis.com/oauth2/v3/userinfo 换身份
  │  3. 按 (provider='google', sub) 查 user_oauth：命中→登录；未命中→建本地账号（赠 66 积分）
  ▼
返回 { user, tokens }（axt_ 前缀会话 JWT，access 7d / refresh 30d 不轮换）
```

要点：

| 事项 | 说明 |
|---|---|
| 账号落点 | **AIDrama 本地库**（users + user_oauth），不经 xworld 账号中心，与 xworld 账号互不通用 |
| 设备要求 | 必须带 **Google Play Services**（GMS）：海外 ROM / 刷机装 GMS 可用；国行多数机型没有，`uni.login` 会失败走兜底提示（按钮仍显示，属预期） |
| 首登资料 | name / email / 头像（avatar）随身份令牌带回并落库；Google 邮箱与已有账号同邮箱时按全局唯一约束跳过邮箱回填，不影响登录 |
| 出网要求 | 服务端须能访问 `googleapis.com`（JWKS / userinfo）；国内服务器需出网代理，被拦时报 502 `auth.oauth_upstream` |

## 二、Google Cloud Console 申请（约 20 分钟）

1. 登录 [console.cloud.google.com](https://console.cloud.google.com)（Google 账号；**国内网络需代理**），顶部选项目——没有就「新建项目」（如 `aidrama-app`）。
2. **API 和服务 → OAuth 同意屏幕**（OAuth consent screen）：
   - User Type 选 **外部**（个人/组织账号均可）；
   - 填 App 名称、用户支持电子邮件、开发者联系电子邮件；范围走默认（不需要加敏感 scope，openid/email/profile 属基础范围）；
   - 品牌域名、图标可跳过；一路保存。
   - **Publishing status 注意**：保持 **Testing（测试）** 时，只有「测试用户」名单里的 Google 账号能登录，其他人报 `access_denied`；**对外发布前点「发布应用（PUBLISH APP）」切到 In production**（基础范围无需 Google 人工审核，即时生效）。
3. **API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID**：
   - 应用类型选 **Android**；
   - 软件包名称：填 Android 打包的**包名**（与 HBuilderX 云打包面板填的包名逐字一致；manifest 里没写包名，以打包面板为准）；
   - SHA-1：填**打包证书**的 SHA-1 指纹（云打包用 DCloud 证书时，在打包面板「证书」处可查「证书SHA1」；自有 keystore 用 `keytool -list -v -keystore xxx.keystore` 取 `SHA1` 行）；
   - 创建后得到客户端 ID，形如 `1234567890-abcdefg.apps.googleusercontent.com`——**这就是 client_id**。
   - 调试期建议再建一个 Android 客户端，绑定**调试证书**（自定义基座）的 SHA-1；否则自定义基座真机调试会报 `DEVELOPER_ERROR`。

> Android 客户端**没有 client_secret**（Android 原生应用属公开客户端），只需要 client_id 与指纹绑定。

## 三、uniapp 端配置

1. `uniapp/src/manifest.json` → `app-plus.distribute.sdkConfigs.oauth.google.clientid`：
   把占位值 `TODO-REPLACE-WITH-GOOGLE-ANDROID-CLIENT-ID.apps.googleusercontent.com` 替换为上一步的 client_id。

   ```json
   "google" : {
       "clientid" : "1234567890-abcdefg.apps.googleusercontent.com"
   }
   ```

2. 改完 manifest 必须**重新云打包/重打自定义基座**（热更不生效）。
3. 登录页按钮**自动出现**（`resolveProviders()` 探测到 manifest 配置了 google 才显示），无需前端改动。

## 四、服务端配置与部署

1. `server/.env` 增加（留空 = 功能关闭，换取返回 503 `auth.oauth_not_configured`）：

   ```bash
   # 允许的 Google OAuth 客户端 ID（逗号分隔）：
   # Android 客户端必配；以后加 iOS/Web 客户端时把它们的 client_id 也追加进来
   GOOGLE_CLIENT_IDS=1234567890-abcdefg.apps.googleusercontent.com
   ```

2. 生效：

   ```bash
   cd /usr/share/nginx/xworld-gz/AIDrama/server
   pm2 restart aidrama   # 或 systemctl restart aidrama
   ```

3. 快速自检：

   ```bash
   # 未配 GOOGLE_CLIENT_IDS 时 → 503；配好后缺凭证 → 401 auth.oauth_missing
   curl -s -X POST https://<域名>/api/auth/oauth/google \
     -H 'Content-Type: application/json' -d '{"authResult":{}}' -H 'Accept-Language: zh-CN'
   ```

## 五、上线 Checklist

- [ ] Google Cloud：同意屏幕已发布（In production），Android 客户端 ID 已建（包名 + 发布证书 SHA-1）
- [ ] 调试证书 SHA-1 的第二个客户端已建（自定义基座联调用）
- [ ] uniapp manifest：`clientid` 已替换为真实值，重新打包
- [ ] server/.env：`GOOGLE_CLIENT_IDS` 已配，服务已重启
- [ ] 有 GMS 的真机：登录页出现「Google 登录」→ 点击出账号选择 → 登录成功进项目列表
- [ ] 管理台（/admin → 用户管理 → 登录日志）：出现 method=google 的记录
- [ ] 无 GMS 设备（国行）：按钮点击后提示「该登录方式不可用」，不崩溃、不白屏

## 六、常见问题排查

| 现象 | 原因与处理 |
|---|---|
| `uni.login` 报 `DEVELOPER_ERROR` / `apiClient connect failed` | 包名或 SHA-1 与 Google 后台登记不一致：核对打包面板的包名、取**实际签名证书**的 SHA-1（云打包证书与自有 keystore 不同）；调试基座须用调试证书的客户端 ID |
| 登录报 `access_denied`（403） | 同意屏幕还在 Testing 状态，该账号不在测试用户名单——发布应用或加测试用户 |
| 服务端 401 `auth.oauth_invalid` | `GOOGLE_CLIENT_IDS` 不含该 client_id（aud 校验失败）；或 idToken 过期 |
| 服务端 503 `auth.oauth_not_configured` | `.env` 未配 `GOOGLE_CLIENT_IDS` 或未重启服务 |
| 服务端 502 `auth.oauth_upstream` | 服务器访问不了 `googleapis.com`（国内服务器需出网代理） |
| 点按钮提示「该登录方式不可用」 | 设备无 GMS，或 manifest 改后未重新打包 |
| 用户换了 Google 账号仍登录到同一 App 账号 | 正常：同一 Google 账号（sub）永远映射同一本地账号；换账号即另一个 sub、另一个本地账号 |
