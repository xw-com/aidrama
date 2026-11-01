import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

// 读取微信支付商户私钥：路径优先，其次内联 PEM
function loadWxPayPrivateKey() {
  const pemPath = (process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '').trim();
  const inline = (process.env.WECHAT_PAY_PRIVATE_KEY || '').trim();
  let pem = '';
  if (pemPath) {
    try { pem = fs.readFileSync(pemPath, 'utf8'); }
    catch { pem = ''; }
  } else if (inline) {
    pem = inline.includes('-----BEGIN') ? inline : inline.replace(/\\n/g, '\n');
  }
  return pem.trim();
}

const wxLoginAppId = (process.env.WECHAT_APP_ID || '').trim();
const wxLoginAppSecret = (process.env.WECHAT_APP_SECRET || '').trim();
const wxPayAppId = (process.env.WECHAT_PAY_APP_ID || '').trim() || wxLoginAppId;
const wxPayPrivateKey = loadWxPayPrivateKey();

// JWT 密钥：本地签发/校验会话令牌（账号密码登录、第三方登录 axt_ 会话、管理台代登）。
// 生产环境必须显式配置——弱默认密钥一旦上生产，任何人都能本地签发有效令牌冒充任意用户，
// 故缺配置直接拒绝启动。
const jwtSecret = (process.env.JWT_SECRET || '').trim();
if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('生产环境必须配置 JWT_SECRET（本地会话令牌签名密钥），拒绝以开发默认密钥启动');
}

// 生产启动自检：关键安全配置缺失直接拒绝启动（fail-fast），杜绝带着 dev 兜底值上线。
// 各项在开发环境仍可留空（本地零配置启动不受影响）。新增生产必配项时同步更新 deploy/DEPLOY.md。
if (process.env.NODE_ENV === 'production') {
  const requireProd = (v, name, why) => {
    if (!(v || '').trim()) throw new Error(`生产环境必须配置 ${name}：${why}`);
  };
  requireProd(process.env.FILE_SIGN_SECRET, 'FILE_SIGN_SECRET',
    '/files 媒体防盗链签名密钥；缺失时出口不签名（fail-open），且 nginx secure_link 校验块上线后媒体全部 403');
  requireProd(process.env.DB_PASSWORD, 'DB_PASSWORD',
    '数据库口令不得为空（127.0.0.1/root/空 这组默认值仅限本地开发）');
  requireProd(process.env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL',
    '微信支付回调/收银台等外部回调地址基准；缺失时支付下单可提交但回调不可达');
  requireProd(process.env.CLIENT_ORIGIN, 'CLIENT_ORIGIN',
    'CORS 白名单来源；缺失时回退 http://localhost:5173，生产前端将全部跨域失败');
}

// 管理后台专用令牌密钥：签发/校验 admt_ 前缀管理令牌（/admin 管理台登录），与用户令牌体系隔离；
// 留空回退 JWT_SECRET（本地开发零配置）——生产建议配独立随机长钥，避免两套令牌伪造风险互相放大
const adminJwtSecret = (process.env.ADMIN_JWT_SECRET || '').trim();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean),

  jwt: {
    secret: jwtSecret || 'dev-insecure-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    // 本地第三方登录（App 端 Apple/Google，axt_ 前缀令牌）的会话时长：access 短、refresh 长
    //（refresh 不轮换，与直连平台 JWT 同语义）
    appAccessExpiresIn: process.env.APP_TOKEN_TTL || '7d',
    appRefreshExpiresIn: process.env.APP_REFRESH_TTL || '30d',
  },

  // 管理后台独立登录（/admin 管理台）：账号密码 + 验证码 → 本地签发 admt_ 管理令牌
  adminAuth: {
    secret: adminJwtSecret || jwtSecret || 'dev-insecure-secret-change-me',
    expiresIn: process.env.ADMIN_TOKEN_TTL || '12h',
  },

  // 点选文字验证码（登录/注册前人机校验）：内存态出题，无需建表
  captcha: {
    ttlMs: parseInt(process.env.CAPTCHA_TTL_MS || '120000', 10),        // 题目有效期
    maxAttempts: parseInt(process.env.CAPTCHA_MAX_ATTEMPTS || '5', 10), // 单题最多提交次数
    tolerance: parseInt(process.env.CAPTCHA_TOLERANCE || '30', 10),     // 点击容差（viewBox 坐标 px）
    maxStore: parseInt(process.env.CAPTCHA_MAX_STORE || '5000', 10),    // 内存题目上限（防刷）
    // 通过后签发的 ticket 密钥：留空复用 JWT_SECRET
    ticketSecret: (process.env.CAPTCHA_TICKET_SECRET || '').trim() || jwtSecret || 'dev-insecure-secret-change-me',
    ticketExpiresIn: process.env.CAPTCHA_TICKET_TTL || '5m',
  },

  db: {
    dialect: (process.env.DB_DIALECT || 'sqlite').toLowerCase(),
    storage: process.env.DB_STORAGE || './data/aidrama.db',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    name: process.env.DB_NAME || 'aidrama',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    // 每条 SQL 打印执行日志（语句/耗时/返回行数），DB_SQL_LOG=1 开启（默认关：
    // 生产环境逐条 hrtime+console.log 是稳定的每请求开销，调试慢查询时再打开）
    sqlLog: bool(process.env.DB_SQL_LOG, false),
  },

  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  outputDir: process.env.OUTPUT_DIR || './data/outputs',
  ffmpegPath: process.env.FFMPEG_PATH || '',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  // /files 媒体（视频/音频）防盗链签名密钥，与 nginx secure_link 同款（deploy/nginx.conf）；
  // 留空=出口不签名（本地开发零影响）。nginx 上线校验块前必须先配置，否则媒体链接全 403
  fileSignSecret: (process.env.FILE_SIGN_SECRET || '').trim(),
  // 静态图片版本号（追加到缩略图 URL 查询参数破缓存）；留空则不追加
  staticImageVersion: (process.env.STATIC_IMAGE_VERSION || '').trim(),

  recharge: {
    yuanPerCredit: 10, // 1 元 = 10 积分
  },

  // 微信（登录 + 支付），全部可选，留空即未启用
  wechat: {
    login: {
      appId: wxLoginAppId,
      appSecret: wxLoginAppSecret,
      redirectUri: (process.env.WECHAT_LOGIN_REDIRECT_URI || '').trim(),
      get enabled() { return !!(this.appId && this.appSecret); },
    },
    // 小程序（weapp 壳）：wx.login code2Session 凭据；web-view 内拉起支付也走这套（小程序 AppID 下单）
    mini: {
      appId: (process.env.WECHAT_MINI_APP_ID || '').trim() || wxLoginAppId,
      appSecret: (process.env.WECHAT_MINI_APP_SECRET || '').trim(),
      get enabled() { return !!(this.appId && this.appSecret); },
    },
    pay: {
      appId: wxPayAppId,
      // 支付方式：native=扫码（PC 出微信原生二维码）；jsapi=公众号内拉起支付（PC 出 H5 收银台二维码）
      method: (process.env.WECHAT_PAY_METHOD || 'native').trim().toLowerCase() === 'jsapi' ? 'jsapi' : 'native',
      // JSAPI 网页授权换 openid 所用公众号 Secret；留空回退 WECHAT_APP_SECRET（与支付 AppID 须同主体）
      jsapiAppSecret: (process.env.WECHAT_PAY_APP_SECRET || '').trim() || wxLoginAppSecret,
      // PC 端「H5 收银台二维码」指向的收银页；留空取 PUBLIC_BASE_URL + /pay.html
      cashierUrl: (process.env.WECHAT_PAY_JSAPI_CASHIER_URL || '').trim()
        || `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/pay.html`,
      mchId: (process.env.WECHAT_PAY_MCH_ID || '').trim(),
      apiV3Key: (process.env.WECHAT_PAY_API_V3_KEY || '').trim(),
      serialNo: (process.env.WECHAT_PAY_SERIAL_NO || '').trim(),
      privateKey: wxPayPrivateKey,
      notifyUrl: (process.env.WECHAT_PAY_NOTIFY_URL || '').trim()
        || `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/api/recharge/wechat/notify`,
      get enabled() { return !!(this.appId && this.mchId && this.apiV3Key && this.serialNo && this.privateKey); },
    },
  },

  // App 端第三方原生登录（iOS Sign in with Apple / Android Google）：服务端验签配置。
  // 原生登录不换 code，只验厂商 JWKS 签发的身份令牌。
  // Apple 只需 Bundle ID（identityToken 的 aud）；Google 需允许的 OAuth 客户端 ID 白名单。
  // 两家均留空 = 该登录方式未启用（登录端点返回 503，前端按钮仍展示但换取失败给提示）。
  oauthNative: {
    apple: {
      // iOS App 的 Bundle ID（HBuilderX 打包面板填写值，须与 Apple Developer Identifiers 一致）
      bundleId: (process.env.APPLE_BUNDLE_ID || '').trim(),
      // Apple 公钥集（JWKS）；可覆盖用于本地联调
      jwksUrl: (process.env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys').trim(),
    },
    google: {
      // 允许的 Google OAuth 客户端 ID（逗号分隔；Android 客户端必配，后续加 iOS/Web 再追加）
      clientIds: (process.env.GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
      // Google 公钥集 / userinfo 端点；可覆盖用于本地联调
      jwksUrl: (process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs').trim(),
      userinfoUrl: (process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v3/userinfo').trim(),
    },
    // JWKS 内存缓存时长（毫秒）：默认 24h；kid 未命中会强制刷新一次，厂商密钥轮换无需等缓存过期
    jwksCacheTtlMs: parseInt(process.env.OAUTH_JWKS_CACHE_TTL_MS || '86400000', 10),
  },
};

export default config;
