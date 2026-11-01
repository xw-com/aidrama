# ApiService 接口文档

> 本文档面向第三方开发者，描述 `frontend/IonicVute` 项目中 `ApiService` 类的鉴权与用户相关接口的**输入参数**与**输出（返回值）结构**。
>
> 源码位置：[`src/services/api.service.ts`](../src/services/api.service.ts)
> 类型定义：[`src/types/index.ts`](../src/types/index.ts)

---

## 一、基础约定

### 1.1 Base URL

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `API_BASE_URL` | `https://auth.example.com/api/v1` | 可通过环境变量 `VITE_API_BASE_URL` 覆盖 |

所有下文接口路径均为相对于该 Base URL 的路径。

### 1.2 请求通用配置

- **请求超时**：`10000ms`
- **默认请求头**：`Content-Type: application/json`
- **鉴权方式**：除登录/注册/发送验证码/重置密码外，`ApiService` 会自动在请求头附加：

  ```
  Authorization: Bearer <access_token>
  ```

  `access_token` 由登录/注册接口返回，自动从本地存储读取。

### 1.3 后端原始响应格式（移动端风格）

后端所有接口统一返回如下结构：

```json
{
  "success": true,
  "message": "操作成功",
  "data": { ... }
}
```

- `success === false` 时，视为业务错误。
- `success === true` 且 `data` 存在时，取 `data` 字段。

### 1.4 前端封装后的返回值结构

`ApiService` 内部 `request()` 方法会自动拆解后端原始响应，统一返回 [`ApiResponse<T>`](#22-apiresponse)：

```ts
interface ApiResponse<T = any> {
  data?: T;        // 业务数据（成功时存在）
  error?: string;  // 错误信息字符串（失败时存在）
  message?: string;// 附加消息
}
```

> ⚠️ **注意**：`ApiService` 的方法**不会抛出异常**（`refreshAccessToken` 除外，见下文）。网络错误或业务错误都会被封装进 `error` 字段返回。调用方应通过判断 `error` 是否存在来区分成功/失败。

### 1.5 错误结构

```ts
interface ApiError {
  message: string;   // 错误描述
  code?: number;     // HTTP 状态码，如 400 / 401
  details?: any;     // 附加错误详情
}
```

---

## 二、通用类型定义

### 2.1 User（用户对象）

```ts
interface User {
  id: string;
  email?: string;
  phone?: string;
  username?: string;
  nickname?: string;
  avatar?: string;
  bio?: string;
  created_at: string;
  updated_at: string;
}
```

### 2.2 ApiResponse

见 [1.4 节](#14-前端封装后的返回值结构)。

---

## 三、接口详情

### 3.1 `login` —— 登录

用户使用账号标识（邮箱 / 手机号 / 用户名）+ 密码登录，返回令牌与用户信息。

| 项 | 值 |
| --- | --- |
| 方法签名 | `login(data: LoginRequest): Promise<ApiResponse<LoginResponse>>` |
| HTTP 方法 | `POST` |
| 路径 | `/auth/login` |
| 是否需要鉴权 | 否 |

**请求参数（`LoginRequest`）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `identity` | `string` | 是 | 登录标识，可为邮箱、手机号或用户名 |
| `password` | `string` | 是 | 密码 |

```json
{
  "identity": "user@example.com",
  "password": "your_password"
}
```

**响应数据（`LoginResponse`，位于 `data` 字段内）**

```ts
interface LoginResponse {
  tokens: {
    access_token: string;   // 访问令牌，后续请求自动携带
    refresh_token: string;  // 刷新令牌，用于刷新 access_token
  };
  user: User;               // 用户信息，见 2.1
}
```

```json
{
  "tokens": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi..."
  },
  "user": {
    "id": "u_123456",
    "email": "user@example.com",
    "username": "user01",
    "nickname": "小明",
    "avatar": "https://...",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-08-13T00:00:00Z"
  }
}
```

---

### 3.2 `register` —— 注册

注册新用户，成功后直接返回令牌与用户信息（与登录返回结构一致）。

| 项 | 值 |
| --- | --- |
| 方法签名 | `register(data: RegisterRequest): Promise<ApiResponse<LoginResponse>>` |
| HTTP 方法 | `POST` |
| 路径 | `/auth/register` |
| 是否需要鉴权 | 否 |

**请求参数（`RegisterRequest`）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `phone` | `string` | 否 | 手机号（与 `email` 二选一作为注册账号） |
| `email` | `string` | 否 | 邮箱（与 `phone` 二选一作为注册账号） |
| `code` | `string` | 否 | 验证码（由 [`sendVerificationCode`](#34-sendverificationcode--发送验证码) 发送） |
| `username` | `string` | 否 | 用户名 |
| `password` | `string` | 是 | 密码 |

```json
{
  "phone": "13800138000",
  "code": "123456",
  "username": "user01",
  "password": "your_password"
}
```

**响应数据**：同 [`login`](#31-login--登录) 的 `LoginResponse`。

---

### 3.3 `logout` —— 登出

退出登录，服务端使当前令牌失效。

| 项 | 值 |
| --- | --- |
| 方法签名 | `logout(): Promise<ApiResponse<void>>` |
| HTTP 方法 | `POST` |
| 路径 | `/auth/logout` |
| 是否需要鉴权 | 是 |

**请求参数**：无。

**响应数据**：无业务数据（`ApiResponse<void>`，仅通过 `error` 是否存在判断成功/失败）。

---

### 3.4 `sendVerificationCode` —— 发送验证码

向指定手机号或邮箱发送验证码，验证码可用于注册或重置密码。

| 项 | 值 |
| --- | --- |
| 方法签名 | `sendVerificationCode(data: SendCodeRequest): Promise<ApiResponse<void>>` |
| HTTP 方法 | `POST` |
| 路径 | `/auth/send-code` |
| 是否需要鉴权 | 否 |

**请求参数（`SendCodeRequest`）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `phone` | `string` | 否 | 接收验证码的手机号（与 `email` 二选一） |
| `email` | `string` | 否 | 接收验证码的邮箱（与 `phone` 二选一） |
| `type` | `'register' \| 'reset_password'` | 是 | 验证码用途：`register` 注册 / `reset_password` 重置密码 |

```json
{
  "phone": "13800138000",
  "type": "register"
}
```

**响应数据**：无业务数据（`ApiResponse<void>`）。

---

### 3.5 `resetPassword` —— 重置密码

通过验证码重置密码（忘记密码场景）。

| 项 | 值 |
| --- | --- |
| 方法签名 | `resetPassword(data: ResetPasswordRequest): Promise<ApiResponse<void>>` |
| HTTP 方法 | `POST` |
| 路径 | `/auth/reset-password` |
| 是否需要鉴权 | 否 |

**请求参数（`ResetPasswordRequest`）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `phone` | `string` | 否 | 手机号（与 `email` 二选一，需与接收验证码的账号一致） |
| `email` | `string` | 否 | 邮箱（与 `phone` 二选一，需与接收验证码的账号一致） |
| `code` | `string` | 是 | 验证码 |
| `password` | `string` | 是 | 新密码 |

```json
{
  "phone": "13800138000",
  "code": "123456",
  "password": "new_password"
}
```

**响应数据**：无业务数据（`ApiResponse<void>`）。

---

### 3.6 `refreshAccessToken` —— 静默刷新访问令牌

使用 `refresh_token` 静默刷新 `access_token`。通常在应用初始化时自动调用，确保令牌新鲜。

| 项 | 值 |
| --- | --- |
| 方法签名 | `refreshAccessToken(): Promise<void>` |
| HTTP 方法 | `POST` |
| 路径 | `/auth/refresh` |
| 是否需要鉴权 | 否（携带 `refresh_token`） |

**请求参数（内部从本地存储读取，非显式入参）**

```json
{
  "refresh_token": "<本地存储中的 refresh_token>"
}
```

**响应数据**

- 该方法返回 `Promise<void>`，**不返回业务数据**。
- 成功时：从本地存储读取的 `refresh_token` 不为空，刷新成功后将新的 `access_token` 写入本地存储。
- 失败时：**静默失败，不会抛出异常**（不向上层抛错）。
- 当 HTTP 状态码为 `400` 或 `401` 时：清除本地令牌并跳转至登录页（`/login`）。

**响应中关键数据（后端返回，方法内部消费）**

```json
{
  "data": {
    "access_token": "eyJhbGciOi..."
  }
}
```

> 💡 **第三方接入说明**：该接口与其它接口不同，不会抛异常，也无标准 `ApiResponse` 返回。若自行实现客户端，请直接以 `refresh_token` 为参数调用 `POST /auth/refresh`，并从响应的 `data.access_token` 取回新令牌。

---

### 3.7 `changePassword` —— 修改密码

登录状态下，用户修改自己的密码（需提供旧密码）。

| 项 | 值 |
| --- | --- |
| 方法签名 | `changePassword(data: { oldPassword: string; newPassword: string }): Promise<ApiResponse<void>>` |
| HTTP 方法 | `POST` |
| 路径 | `/users/me/password` |
| 是否需要鉴权 | 是 |

**请求参数（内联类型）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `current_password` | `string` | 是 | 当前密码（原密码） |
| `new_password` | `string` | 是 | 新密码 |

> 注：前端 `changePassword({ oldPassword, newPassword })` 会在内部映射为 xworld 的 `current_password` / `new_password`。

```json
{
  "current_password": "current_password",
  "new_password": "new_password"
}
```

**响应数据**：无业务数据（`ApiResponse<void>`）。

---

## 四、接口速查表

| 方法 | HTTP | 路径 | 鉴权 | 请求类型 | 返回类型 |
| --- | --- | --- | --- | --- | --- |
| `login` | POST | `/auth/login` | 否 | `LoginRequest` | `ApiResponse<LoginResponse>` |
| `register` | POST | `/auth/register` | 否 | `RegisterRequest` | `ApiResponse<LoginResponse>` |
| `logout` | POST | `/auth/logout` | 是 | 无 | `ApiResponse<void>` |
| `sendVerificationCode` | POST | `/auth/send-code` | 否 | `SendCodeRequest` | `ApiResponse<void>` |
| `resetPassword` | POST | `/auth/reset-password` | 否 | `ResetPasswordRequest` | `ApiResponse<void>` |
| `refreshAccessToken` | POST | `/auth/refresh` | 否 | `{ refresh_token }` | `Promise<void>`（静默） |
| `changePassword` | POST | `/users/me/password` | 是 | `{ current_password, new_password }` | `ApiResponse<void>` |

---

## 五、调用示例

```ts
import { apiService } from '@/services/api.service';

// 1. 登录
const loginRes = await apiService.login({
  identity: 'user@example.com',
  password: 'your_password',
});
if (loginRes.error) {
  console.error('登录失败：', loginRes.error);
} else {
  console.log('登录成功：', loginRes.data.user);
  console.log('access_token：', loginRes.data.tokens.access_token);
}

// 2. 注册前先发送验证码
await apiService.sendVerificationCode({
  phone: '13800138000',
  type: 'register',
});

// 3. 注册
const regRes = await apiService.register({
  phone: '13800138000',
  code: '123456',
  username: 'user01',
  password: 'your_password',
});

// 4. 修改密码（需已登录）
const pwdRes = await apiService.changePassword({
  oldPassword: 'current_password',
  newPassword: 'new_password',
});
if (pwdRes.error) {
  console.error('修改失败：', pwdRes.error);
}

// 5. 登出（需已登录）
await apiService.logout();
```

---

## 六、注意事项

1. **不抛异常设计**：除 `refreshAccessToken` 外，所有方法均以 `error` 字段返回错误，请勿仅依赖 `try/catch` 判断成败，需显式检查 `res.error`。
2. **令牌管理**：`access_token` / `refresh_token` 由 `ApiService` 配合本地存储（`storageService`）自动管理，登录/注册成功后自动持久化，后续请求自动携带。
3. **字段命名风格**：请求/响应字段为 **snake_case**（后端风格，如 `access_token`、`created_at`）；`changePassword` 入参为 **camelCase**（`oldPassword`、`newPassword`），对接时请注意区分。
4. **环境隔离**：Base URL 可通过 `VITE_API_BASE_URL` 环境变量切换不同环境（开发 / 测试 / 生产）。
```
