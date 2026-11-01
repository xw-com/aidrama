import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../config/index.js';

const { pay: wx } = config.wechat;
const BASE = 'https://api.mch.weixin.qq.com';

/**
 * 微信支付 V3 · Native（扫码）/ JSAPI（公众号内）支付服务。
 * 文档：https://pay.weixin.qq.com/docs/merchant/apis/native-payment/native-order.html
 *      https://pay.weixin.qq.com/docs/merchant/apis/jsapi-payment/jsapi-prepay.html
 * - 请求签名：RSA-SHA2048(PKCS#1 v1.5)，用商户 API 私钥。
 * - 回调解密：AES-256-GCM，key=APIv3 密钥，iv=nonce，aad=associated_data。
 *   JSAPI 与 Native 回调报文结构相同，共用同一 notify 端点即可。
 * - 回调验签：平台证书 RSA-SHA256 严格校验（见 platformCert.service.js 证书管理）。
 * - 原路退款：createRefund / queryRefund（/v3/refund/domestic/refunds，退款结果走主动查单）。
 * 仅在 config.wechat.pay.enabled 时可用。
 */

const nonceStr = () => crypto.randomBytes(16).toString('hex');
const tsStr = () => Math.floor(Date.now() / 1000).toString();

// 提取微信 V3 错误体（{code,message}），否则 axios 只会留下 "status code 400" 无从排查
export function toWxPayError(e) {
  const data = e?.response?.data;
  if (data?.code) {
    const detail = typeof data.message === 'string' ? data.message : JSON.stringify(data);
    return new Error(`${data.code}: ${detail}`);
  }
  return e;
}

// 生成 V3 请求的 Authorization 头
export function buildAuthorization(method, pathname, bodyStr) {
  const timestamp = tsStr();
  const nonce = nonceStr();
  const signingString = `${method}\n${pathname}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(wx.privateKey, 'base64');
  const token =
    `mchid="${wx.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",` +
    `serial_no="${wx.serialNo}",signature="${signature}"`;
  return `WECHATPAY2-SHA256-RSA2048 ${token}`;
}

// 统一下单（Native 扫码），返回 code_url
export async function createNativeOrder({ outTradeNo, description, amountFen, notifyUrl }) {
  if (!wx.enabled) throw new Error('微信支付未启用：请检查 WECHAT_PAY_* 配置');
  const pathname = '/v3/pay/transactions/native';
  const body = {
    appid: wx.appId,
    mchid: wx.mchId,
    description: description || '星网 XW.COM 积分充值',
    out_trade_no: outTradeNo,
    notify_url: notifyUrl || wx.notifyUrl,
    amount: { total: Math.round(amountFen), currency: 'CNY' },
  };
  const bodyStr = JSON.stringify(body);
  let data;
  try {
    ({ data } = await axios.post(BASE + pathname, bodyStr, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: buildAuthorization('POST', pathname, bodyStr),
      },
    }));
  } catch (e) {
    throw toWxPayError(e);
  }
  if (!data.code_url) throw new Error('微信下单失败：未返回 code_url');
  return data.code_url; // weixin://wxpay/bizpayurl?pr=...
}

// V3 拉起支付签名（JSAPI/小程序通用）：appId\nts\nnonce\npackage\n 用商户私钥 RSA-SHA256
// appId 须与统一下单的 appid 一致（公众号 JSAPI 传公众号 AppID，小程序拉起传小程序 AppID）
function buildPaySign(prepayId, appId = wx.appId) {
  const timestamp = tsStr();
  const nonce = nonceStr();
  const pkg = `prepay_id=${prepayId}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${appId}\n${timestamp}\n${nonce}\n${pkg}\n`);
  signer.end();
  return {
    appId,
    timeStamp: timestamp,
    nonceStr: nonce,
    package: pkg,
    signType: 'RSA',
    paySign: signer.sign(wx.privateKey, 'base64'),
  };
}

// 统一下单（JSAPI 公众号内支付），返回前端可直接传给 WeixinJSBridge 的支付参数
// appId：拉起方 AppID（默认公众号；小程序壳原生页 wx.requestPayment 传小程序 AppID，须与商户号绑定）
export async function createJsapiOrder({ outTradeNo, description, amountFen, notifyUrl, openid, appId }) {
  if (!wx.enabled) throw new Error('微信支付未启用：请检查 WECHAT_PAY_* 配置');
  if (!openid) throw new Error('JSAPI 下单缺少 payer.openid（需先完成公众号网页授权）');
  const pathname = '/v3/pay/transactions/jsapi';
  const body = {
    appid: appId || wx.appId,
    mchid: wx.mchId,
    description: description || '星网 XW.COM 积分充值',
    out_trade_no: outTradeNo,
    notify_url: notifyUrl || wx.notifyUrl,
    amount: { total: Math.round(amountFen), currency: 'CNY' },
    payer: { openid },
  };
  const bodyStr = JSON.stringify(body);
  let data;
  try {
    ({ data } = await axios.post(BASE + pathname, bodyStr, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: buildAuthorization('POST', pathname, bodyStr),
      },
    }));
  } catch (e) {
    throw toWxPayError(e);
  }
  if (!data.prepay_id) throw new Error('微信下单失败：未返回 prepay_id');
  return buildPaySign(data.prepay_id, body.appid);
}

// 小程序 wx.login code 换 openid（code2Session）：小程序拉起支付的 openid 必须是小程序自身的，
// 与公众号网页授权 openid 不互通；须在商户平台把小程序 AppID 与本商户号完成绑定
export async function exchangeMiniappOpenid(jsCode) {
  const mini = config.wechat.mini;
  if (!jsCode) throw new Error('缺少 wx.login code');
  if (!mini.enabled) throw new Error('未配置小程序凭据（WECHAT_MINI_APP_ID / WECHAT_MINI_APP_SECRET）');
  const { data } = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
    params: { appid: mini.appId, secret: mini.appSecret, js_code: jsCode, grant_type: 'authorization_code' },
    timeout: 10000,
  });
  if (data.errcode) throw new Error(`code2Session 失败 ${data.errcode}: ${data.errmsg}`);
  if (!data.openid) throw new Error('code2Session 失败：未返回 openid');
  return data.openid;
}

// 公众号网页授权跳转链接（snsapi_base 静默授权，只为拿 openid）
export function buildJsapiAuthUrl(redirectUri, state = '') {
  const params = new URLSearchParams({
    appid: wx.appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'snsapi_base',
    state,
  });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

// 网页授权 code 换 openid（须用与支付 AppID 同主体的公众号 Secret）
export async function exchangeJsapiOpenid(code) {
  if (!code) throw new Error('缺少网页授权 code');
  if (!wx.jsapiAppSecret) throw new Error('未配置公众号 Secret（WECHAT_PAY_APP_SECRET / WECHAT_APP_SECRET），无法换 openid');
  const { data } = await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
    params: { appid: wx.appId, secret: wx.jsapiAppSecret, code, grant_type: 'authorization_code' },
    timeout: 10000,
  });
  if (data.errcode) throw new Error(`网页授权失败 ${data.errcode}: ${data.errmsg}`);
  if (!data.openid) throw new Error('网页授权失败：未返回 openid');
  return data.openid;
}

// 收银台免登录凭证：HMAC-SHA256(order_no, APIv3Key)，无状态、不入库（知道订单号+令牌才能拉起该单支付）
const payTokenFor = (orderNo) =>
  crypto.createHmac('sha256', wx.apiV3Key || 'wxpay').update(orderNo).digest('hex').slice(0, 32);
export { payTokenFor };
export function verifyPayToken(orderNo, token) {
  const expected = Buffer.from(payTokenFor(orderNo));
  const actual = Buffer.from(String(token || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// AES-256-GCM 解密（回调 resource 与平台证书 encrypt_certificate 共用）：
// key=APIv3 密钥（32 字节），iv=nonce，aad=associated_data；解密成功即证明报文来自持有 APIv3 密钥的微信
export function decryptWithApiV3Key({ ciphertext, nonce, associated_data }) {
  const key = Buffer.from(wx.apiV3Key, 'utf8'); // 必须 32 字节
  const ciphertextBuf = Buffer.from(ciphertext, 'base64');
  const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16);
  const encrypted = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (associated_data) decipher.setAAD(Buffer.from(associated_data, 'utf8'));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// 解密回调 resource：{ out_trade_no, transaction_id, trade_state, amount:{payer_total,...}, ... }
export function decodeNotifyResource(resource) {
  return JSON.parse(decryptWithApiV3Key(resource));
}

// ===== 回调验签（平台证书 RSA-SHA256 严格校验，替代旧的「解密成功即可信」空壳）=====
// 微信规范：对 `Wechatpay-Timestamp\nWechatpay-Nonce\n原始报文\n` 用平台证书对应私钥签名（SHA256withRSA），
// 商户按 Wechatpay-Serial 头指定的平台证书序列号取公钥验签。
// 原始报文说明：app.js 的 express.json() 未挂 verify 钩子（不在本次改动范围，拿不到逐字节原始 body），
// 调用方用 JSON.stringify(req.body) 重建——微信回调是紧凑 JSON（无空格、键序保持），重建逐字节一致；
// 若未来在 app.js 注入 req.rawBody，调用方透传 rawBody 参数即可自动切到字节级严格校验。
let platformCertModulePromise = null;
const getPlatformCertModule = () => (platformCertModulePromise ??= import('./platformCert.service.js')); // 动态引入，避免静态循环依赖

// 回调时间戳允许偏差（秒）：超窗拒绝（防重放）；<=0 关闭该检查（不推荐）
const NOTIFY_MAX_SKEW_SEC = (() => {
  const n = parseInt(process.env.WECHAT_PAY_VERIFY_MAX_SKEW_SEC ?? '300', 10);
  return Number.isFinite(n) ? n : 300;
})();
// WECHAT_PAY_VERIFY_STRICT=1：平台证书不可用时拒绝回调（fail-closed）；默认降级放行仅靠 GCM 校验
const strictVerify = () =>
  ['1', 'true', 'yes', 'on'].includes(String(process.env.WECHAT_PAY_VERIFY_STRICT || '').toLowerCase());

/**
 * 校验微信回调签名（Wechatpay-Timestamp / Wechatpay-Nonce / Wechatpay-Signature / Wechatpay-Serial）。
 * - 验签通过：返回 { ok: true, mode: 'strict', serial }
 * - 平台证书不可用（拉取失败/未配置支付）且未开严格模式：降级放行 { ok: true, mode: 'degraded' }，
 *   仅靠调用方随后的 AES-GCM 解密校验兜底（限频告警见 platformCert.service）
 * - 序列号未知（缓存强制刷新后仍不在证书列表）或签名不匹配 / 时间戳超窗：抛错 → 调用方回 401 拒绝，
 *   微信会按退避策略重试
 */
export async function verifyNotifySignature({ timestamp, nonce, body, signature, serial, rawBody } = {}) {
  if (!wx.enabled) return { ok: true, mode: 'disabled' }; // 路由层已有 enabled 拦截，此处不重复拒绝
  const platformCert = await getPlatformCertModule();
  const tsHeader = String(timestamp ?? '');
  const bodyStr = rawBody != null ? Buffer.from(rawBody).toString('utf8') : String(body ?? '');

  // 防重放：不依赖证书，降级路径同样生效
  if (NOTIFY_MAX_SKEW_SEC > 0) {
    const ts = Number(tsHeader);
    if (!tsHeader || !Number.isFinite(ts)) throw new Error('回调缺少有效 Wechatpay-Timestamp');
    if (Math.abs(Date.now() / 1000 - ts) > NOTIFY_MAX_SKEW_SEC) {
      throw new Error(`回调时间戳偏差超过 ${NOTIFY_MAX_SKEW_SEC}s，疑似重放，拒绝`);
    }
  }
  if (!String(signature || '').trim()) throw new Error('回调缺少 Wechatpay-Signature');

  // 取平台证书公钥：缓存未命中 → 模块内强制刷新一次重试（序列号轮换容错，最小间隔防打爆）
  const cert = await platformCert.getCertBySerial(serial);
  if (!cert) {
    if (platformCert.hasPlatformCerts()) {
      // 微信只用它自己的平台证书签名；证书在手却对不上序列号 = 伪造通知（或签名被调包），直接拒绝
      throw new Error(`回调签名序列号不在平台证书列表：serial=${serial}`);
    }
    if (strictVerify()) throw new Error('平台证书不可用且已开启严格验签（WECHAT_PAY_VERIFY_STRICT），拒绝回调');
    platformCert.warnCertDegraded('verify', `serial=${serial}${platformCert.lastErrorText() ? ` lastErr=${platformCert.lastErrorText()}` : ''}`);
    return { ok: true, mode: 'degraded' };
  }

  const data = Buffer.from(`${tsHeader}\n${String(nonce ?? '')}\n${bodyStr}\n`, 'utf8');
  const sig = Buffer.from(String(signature), 'base64');
  const verified = crypto.verify('RSA-SHA256', data, cert.publicKey, sig);
  if (!verified) throw new Error('回调签名验证失败（Wechatpay-Signature 与报文不匹配）');
  return { ok: true, mode: 'strict', serial: cert.serial };
}

// ===== 原路退款（V3 /v3/refund/domestic/refunds）=====
// 文档：https://pay.weixin.qq.com/docs/merchant/apis/refund-payment/refunds.html
// notify_url 刻意不传：退款结果不走异步回调，由 admin 端 GET /orders/:orderNo/refund-status
// 主动查单（queryRefund）同步终态，省掉一条需要验签的退款回调链路。

/**
 * 发起原路退款。
 * @param {object} p
 * @param {string} p.orderNo        商户订单号（out_trade_no）
 * @param {number} p.refundAmountFen 退款金额（分），<= totalFen
 * @param {number} p.totalFen       原订单金额（分）——微信接口必填，用于校验退款不超原单
 * @param {string} [p.reason]       退款原因（微信限 80 字符，超长截断）
 * @returns {Promise<object>} 微信退款单响应（含 refund_id / out_refund_no / status / amount ...）
 */
export async function createRefund({ orderNo, refundAmountFen, totalFen, reason }) {
  if (!wx.enabled) throw new Error('微信支付未启用：请检查 WECHAT_PAY_* 配置');
  const no = String(orderNo || '').trim();
  if (!no) throw new Error('退款缺少商户订单号');
  const refund = Math.round(Number(refundAmountFen));
  const total = Math.round(Number(totalFen));
  if (!Number.isFinite(refund) || refund <= 0) throw new Error(`退款金额无效（分）：${refundAmountFen}`);
  if (!Number.isFinite(total) || total <= 0) throw new Error(`原订单金额无效（分）：${totalFen}`);
  if (refund > total) throw new Error(`退款金额（${refund} 分）超过原订单金额（${total} 分）`);
  const pathname = '/v3/refund/domestic/refunds';
  const body = {
    out_trade_no: no,
    out_refund_no: `rf_${no}`, // 微信侧幂等键：同单重试复用同一退款单号，受理中重复提交返回同一笔
    amount: { refund, total, currency: 'CNY' },
  };
  if (reason) body.reason = String(reason).slice(0, 80);
  const bodyStr = JSON.stringify(body);
  let data;
  try {
    ({ data } = await axios.post(BASE + pathname, bodyStr, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: buildAuthorization('POST', pathname, bodyStr),
      },
    }));
  } catch (e) {
    throw toWxPayError(e);
  }
  if (!data?.refund_id) throw new Error('微信退款失败：未返回 refund_id');
  return data; // { refund_id, out_refund_no, out_trade_no, status: SUCCESS|PROCESSING|ABNORMAL|CLOSED, amount, ... }
}

// 主动查单：按商户退款单号查询退款状态（admin「刷新退款状态」兜底用）
export async function queryRefund({ outRefundNo }) {
  if (!wx.enabled) throw new Error('微信支付未启用：请检查 WECHAT_PAY_* 配置');
  const no = String(outRefundNo || '').trim();
  if (!no) throw new Error('缺少商户退款单号');
  const pathname = `/v3/refund/domestic/refunds/${encodeURIComponent(no)}`;
  try {
    const { data } = await axios.get(BASE + pathname, {
      timeout: 15000,
      headers: { Accept: 'application/json', Authorization: buildAuthorization('GET', pathname, '') },
    });
    return data; // { refund_id, out_refund_no, status, amount: { refund, total, ... }, ... }
  } catch (e) {
    throw toWxPayError(e);
  }
}
