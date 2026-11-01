# App 端 Apple 登录（Sign in with Apple）申请与部署

> 适用对象：uniapp 打包的 **iOS App**（H5 / 小程序 / 鸿蒙不展示 Apple 登录）。
>
> 结论先行：**只需 Apple Developer 后台给 App ID 勾选 Sign In with Apple + 服务端配一个
> `APPLE_BUNDLE_ID`**。不需要创建 .p8 密钥、不需要 Services ID、不需要任何回调 URL——
> 服务端只验 `identityToken` 签名（Apple 官方 JWKS 公钥），不做授权码换取。
> 代码链路（uniapp 按钮 → `uni.login` → 服务端 `/api/auth/oauth/apple`）已全部就绪。

---

## 一、链路总览

```
iOS App (uni.login provider=apple)
  │  系统级 Face ID / 密码确认（无 Apple 登录页）
  │◀── authResult { identityToken, user, fullName?, email? }
  ▼
AIDrama 服务端  POST /api/auth/oauth/apple
  │  1. 取 Apple 官方公钥（https://appleid.apple.com/auth/keys，进程内缓存 24h）
  │  2. 验签 RS256 + 校验 iss / aud(=APPLE_BUNDLE_ID) / exp
  │  3. 按 (provider='apple', sub) 查 user_oauth：命中→登录；未命中→建本地账号（赠 66 积分）
  ▼
返回 { user, tokens }（axt_ 前缀会话 JWT，access 7d / refresh 30d 不轮换）
```

要点：

| 事项 | 说明 |
|---|---|
| 账号落点 | **AIDrama 本地库**（users + user_oauth），不经 xworld 账号中心。与 xworld 账号互相独立，两边账号不通用 |
| 令牌 | `axt_` 前缀本地 JWT；客户端 http 层按前缀自动走 `/api/auth/oauth/refresh` 静默续期 |
| 首登资料 | 姓名只在**首次授权**返回（Apple 策略），仅此时落 nickname；邮箱可能是私密转发地址（@privaterelay.appleid.com），回复邮件会被 Apple 转发 |
| 防重放 | identityToken 有效期约 10 分钟；uni.login 无法携带 nonce，存在令牌有效期内重放的极小窗口（登录幂等、无副作用，可接受） |

## 二、Apple Developer 后台申请（约 10 分钟）

1. 登录 [developer.apple.com/account](https://developer.apple.com/account)（需 Apple Developer Program 会员，99 美元/年）。
2. **Certificates, Identifiers & Profiles → Identifiers**，找到（或新建）App 的 **App ID**：
   - 新建：类型选 **App IDs → App**，描述随意，Bundle ID 选 **Explicit**，填与打包一致的值（见第三节）；
   - 在 Capabilities 列表勾选 **Sign In with Apple**（勾"Enable as an App ID"即可，不需要 Configure 服务端组件）；
   - Save。
3. **完成。** 不需要：Keys（.p8）、Services ID、回调域名——那些是"网页端 Apple 登录"才用的，本链路不用。

> Bundle ID 一旦上线不要再改：它同时是 `identityToken` 的 `aud`，服务端按它验签。

## 三、uniapp 端配置

1. `uniapp/src/manifest.json` 已配好（`app-plus.distribute.sdkConfigs.oauth.apple: {}`，`modules.OAuth` 已声明），**无需改动**。
2. **打包要求（重要）**：
   - **云打包**：发行 → 原生 App-云打包，iOS 包名（Bundle ID）填与 Apple 后台一致的值，并使用含该 Bundle ID 的描述文件（profile）；
   - **自定义基座**：真机调试 Apple 登录必须打自定义基座，**标准基座不支持**；
   - **离线打包**：Xcode 工程需手动开启 capability —— Signing & Capabilities → + Capability → **Sign In with Apple**（即 entitlements 加 `com.apple.developer.applesignin = [Default]`），并在 `Android/iOS` 模块配置勾选 OAuth。
3. 登录页按钮**自动出现**：`resolveProviders()` 探测到 manifest 配置了 apple 才显示，无需前端改动；未勾协议时点按钮会被拦截（现有逻辑）。

## 四、服务端配置与部署

1. `server/.env` 增加（留空 = 功能关闭，换取返回 503 `auth.oauth_not_configured`）：

   ```bash
   # iOS App 的 Bundle ID：须与 Apple 后台 Identifiers、HBuilderX 打包面板三处逐字一致
   APPLE_BUNDLE_ID=com.example.aidrama
   ```

2. 生效：

   ```bash
   cd /usr/share/nginx/xworld-gz/AIDrama/server
   pm2 restart aidrama   # 或 systemctl restart aidrama
   ```

3. 快速自检（无真机也能确认端点已挂载、配置已生效）：

   ```bash
   # 未配 APPLE_BUNDLE_ID 时 → 503「第三方登录暂未配置」；配好后缺凭证 → 400
   curl -s -X POST https://<域名>/api/auth/oauth/apple \
     -H 'Content-Type: application/json' -d '{}' -H 'Accept-Language: zh-CN'
   ```

4. **出网要求**：服务器须能访问 `https://appleid.apple.com/auth/keys`（取公钥）。被防火墙拦时登录报 502 `auth.oauth_upstream`。

## 五、上线 Checklist

- [ ] Apple 后台：App ID 已勾选 Sign In with Apple，Bundle ID 已记录
- [ ] HBuilderX：云打包/自定义基座使用该 Bundle ID（离线打包另加 entitlements）
- [ ] server/.env：`APPLE_BUNDLE_ID` 已配，服务已重启
- [ ] 真机（iOS）自定义基座：登录页出现「Apple 登录」按钮 → 点击弹系统授权 → 登录成功进项目列表
- [ ] 管理台（/admin → 用户管理 → 登录日志）：出现 method=apple 的记录
- [ ] 二次点击登录：命中同一账号（不重复建号、不重复赠积分）

## 六、App Store 审核要点

1. **必须提供**：App 内只要出现任何第三方快速登录（Google/微信等），App Store 审核指南 4.8 要求同时提供 Sign in with Apple——本功能落地后即满足；iOS 端只保留 Apple 一个第三方按钮也符合现有 `platformProviders()` 矩阵。
2. **隐私**：用户可選"Hide My Email"（私密转发地址），隐私政策无需逐条列邮箱用途，但建议提及"第三方登录标识符"收集；`user`（稳定标识符）仅存 `user_oauth.provider_user_id`。
3. 账号注销：App 已有账号注销/删除能力的注意——Apple 登录账号同样要走该流程（后续做注销功能时一并覆盖）。

## 七、常见问题排查

| 现象 | 原因与处理 |
|---|---|
| 点按钮提示「该登录方式不可用」 | manifest `sdkConfigs.oauth.apple` 未生效——改完 manifest 必须**重新云打包/换自定义基座**，热更无效 |
| 服务端 401 `auth.oauth_invalid` | `APPLE_BUNDLE_ID` 与实际打包 Bundle ID 不一致（aud 校验失败）；或 Apple 后台未勾 Sign In with Apple |
| 服务端 503 `auth.oauth_not_configured` | `.env` 未配 `APPLE_BUNDLE_ID` 或未重启服务 |
| 服务端 502 `auth.oauth_upstream` | 服务器访问不了 `appleid.apple.com`（出网受限/防火墙） |
| 真机标准基座点击无反应 | 标准基座不带 Apple 登录模块，换自定义基座 |
| 用户反馈邮箱收不到邮件 | 多为私密转发地址，邮件须经 Apple 转发，属正常行为，不是 bug |
