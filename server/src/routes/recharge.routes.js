import { Router } from 'express';
import db from '../db/index.js';
import { config } from '../config/index.js';
import { asyncHandler, ok, badRequest, forbidden } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { addCredits } from '../services/credits.service.js';
import { logger } from '../utils/logger.js';
import { roundCredits } from '../utils/credits.js';
import { getYuanPerCredit, getPackages } from '../services/rechargeConfig.service.js';
import { v4 as uuidv4 } from 'uuid';
import {
  createNativeOrder, createJsapiOrder, buildJsapiAuthUrl, exchangeJsapiOpenid, exchangeMiniappOpenid,
  payTokenFor, verifyPayToken, decodeNotifyResource, verifyNotifySignature,
} from '../services/wechat/pay.service.js';

const router = Router();
const { RechargeOrder } = db;

// 当前可用支付方式：仅微信支付（配置启用后可用）。未配置则返回空——下单时按失败处理。
const availablePayMethods = () => (config.wechat.pay.enabled ? ['wechat'] : []);
// 小程序内直拉支付：支付已配置 + 小程序凭据已配置（还须商户号绑定小程序 AppID，拉起失败会有明确报错）
const miniappPayEnabled = () => config.wechat.pay.enabled && config.wechat.mini.enabled;

// JSAPI openid 内存缓存（userId -> openid）：openid 与用户+公众号绑定且长期有效，进程重启后首次授权重建
const jsapiOpenidCache = new Map();

// 档位列表（含费率说明：1元=N积分，admin 后台可配）+ 可用支付方式 + 当前微信支付模式（native=扫码 / jsapi=公众号内拉起）
router.get('/packages', authRequired, asyncHandler(async (req, res) => {
  return ok(res, {
    rate: { yuanPerCredit: await getYuanPerCredit() },
    packages: await getPackages(),
    payMethods: availablePayMethods(),
    wechatPayMode: config.wechat.pay.method,
    wechatMiniappPay: miniappPayEnabled(),
  });
}));

// 创建订单
router.post('/create', authRequired, asyncHandler(async (req, res) => {
  const { package_id, yuan, pay_method, channel } = req.body;
  // 仅支持微信支付：未配置支付或方法不支持一律失败（不再回退支付宝模拟支付）
  if (!availablePayMethods().includes(pay_method)) throw badRequest('recharge.wechat_not_enabled');
  const method = 'wechat';
  const packages = await getPackages();
  const yuanPerCredit = await getYuanPerCredit();
  let amountYuan = 0;
  let credits = 0;
  let label = '自定义';
  if (package_id) {
    const pkg = packages.find((p) => p.id === package_id);
    if (!pkg) throw badRequest('recharge.package_not_found');
    amountYuan = pkg.yuan; credits = pkg.credits + pkg.bonus; label = pkg.label;
  } else {
    amountYuan = Number(yuan);
    if (!amountYuan || amountYuan <= 0) throw badRequest('recharge.amount_must_be_positive');
    // 上限与 admin 档位同量级（10 万元）：amount_yuan 列 DECIMAL(10,2) 上限 99999999.99，
    // 超限直接 MySQL 1264 → 500；两位小数归一，杜绝 0.999 元产生非整分应付金额
    if (amountYuan > 100000) throw badRequest('recharge.amount_too_large');
    amountYuan = Math.round(amountYuan * 100) / 100;
    credits = roundCredits(amountYuan * yuanPerCredit); // 一位小数精度
  }
  const order = await RechargeOrder.create({
    order_no: `RC${Date.now()}${uuidv4().slice(0, 6)}`,
    user_id: req.user.id,
    amount_yuan: amountYuan,
    credits,
    pay_method: method,
    status: 'pending',
  });

  // 微信支付：按 WECHAT_PAY_METHOD 分流——native 返回 code_url 画二维码；jsapi 返回拉起参数或 H5 收银台链接
  if (method === 'wechat') {
    if (!config.wechat.pay.enabled) throw badRequest('recharge.wechat_not_enabled');
    // 小程序 web-view 直拉：本步不向微信提交下单——微信对同一 out_trade_no 重入时要求参数完全一致，
    // 若此处先按公众号/native 参数提交，壳页 prepay 再以小程序 AppID 提交必报 INVALID_REQUEST。
    // 只落本地订单，由壳支付页的 miniapp/prepay 作为该单号唯一一次微信提交
    if (channel === 'miniapp') {
      if (!miniappPayEnabled()) throw badRequest('recharge.wechat_not_enabled');
      return ok(res, { ...order.toJSON(), label, rate: { yuanPerCredit }, pay_token: payTokenFor(order.order_no) });
    }
    const description = `星网 XW.COM${label ? '·' + label : ''}充值`;
    const amountFen = Math.round(amountYuan * 100);
    try {
      if (config.wechat.pay.method === 'jsapi') {
        const openid = req.body.openid || jsapiOpenidCache.get(req.user.id) || '';
        if (openid) {
          // 微信内 H5（已授权）：直接返回拉起支付参数
          const payParams = await createJsapiOrder({ outTradeNo: order.order_no, description, amountFen, openid });
          return ok(res, { ...order.toJSON(), label, rate: { yuanPerCredit }, pay_token: payTokenFor(order.order_no), pay_params: payParams }, 'recharge.order_created_jsapi_pay');
        }
        // PC / 未授权：返回 H5 收银台链接，前端画二维码——微信扫码打开收银页后在微信内拉起支付
        const payUrl = `${config.wechat.pay.cashierUrl}?no=${encodeURIComponent(order.order_no)}&t=${payTokenFor(order.order_no)}`;
        return ok(res, { ...order.toJSON(), label, rate: { yuanPerCredit }, pay_token: payTokenFor(order.order_no), pay_url: payUrl }, 'recharge.order_created_jsapi_pay');
      }
      const codeUrl = await createNativeOrder({ outTradeNo: order.order_no, description, amountFen });
      // pay_token：小程序壳原生页免登录预支付时校验订单归属用（与收银台 pay_url 内嵌的令牌同源）
      return ok(res, { ...order.toJSON(), label, rate: { yuanPerCredit }, pay_token: payTokenFor(order.order_no), code_url: codeUrl }, 'recharge.order_created_scan_pay');
    } catch (e) {
      // 下单失败：把订单标记失败，便于对账
      await order.update({ status: 'failed' });
      throw badRequest('recharge.wechat_order_failed', { detail: e.message });
    }
  }
}));

// ===== 微信 JSAPI 辅助端点（仅 jsapi 模式）=====

// 授权回跳域白名单：前端站点 + 本服务公网地址（防 open redirect）
const allowedAuthOrigins = () => new Set(
  [...config.clientOrigin, (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')]
    .map((s) => { try { return new URL(s).origin; } catch { return ''; } })
    .filter(Boolean)
);

// 公众号网页授权跳转链接（登录用户微信内 H5 拿 openid 用；redirect 为回跳的完整前端地址）
// state 固定 wxpay：前端只消费 state=wxpay 的回跳 code，避免误吞其他流程的同名参数
router.get('/wechat/jsapi-auth-url', authRequired, asyncHandler(async (req, res) => {
  const redirect = String(req.query.redirect || '');
  let origin = '';
  try { origin = new URL(redirect).origin; } catch { /* 非法 URL 按空处理 */ }
  if (!/^https:\/\//.test(redirect) || !allowedAuthOrigins().has(origin)) throw badRequest('common.bad_request');
  return ok(res, { auth_url: buildJsapiAuthUrl(redirect, 'wxpay') });
}));

// H5 收银台的授权链接（免登录，凭订单号+令牌）：回跳固定为本服务收银页，state 带回 no|t
router.get('/wechat/jsapi/cashier-auth-url', asyncHandler(async (req, res) => {
  const { no, t } = req.query;
  if (!verifyPayToken(String(no || ''), String(t || ''))) throw badRequest('recharge.pay_token_invalid');
  return ok(res, { auth_url: buildJsapiAuthUrl(config.wechat.pay.cashierUrl, `${no}|${t}`) });
}));

// 网页授权 code 换 openid（登录用户一次性交换；服务端按用户缓存，后续 /create 可免重复授权）
router.post('/wechat/jsapi-openid', authRequired, asyncHandler(async (req, res) => {
  const openid = await exchangeJsapiOpenid(req.body?.code);
  jsapiOpenidCache.set(req.user.id, openid);
  return ok(res, { openid });
}));

// H5 收银台下单（免登录，凭订单号+令牌）：pay.html 扫码打开后用 code 换 openid 并 JSAPI 下单
router.post('/wechat/jsapi/token-pay', asyncHandler(async (req, res) => {
  const { no, t, code } = req.body || {};
  if (!verifyPayToken(String(no || ''), String(t || ''))) throw badRequest('recharge.pay_token_invalid');
  const order = await RechargeOrder.findOne({ where: { order_no: no } });
  if (!order) throw badRequest('common.not_found');
  if (order.status === 'paid') return ok(res, { already_paid: true });
  if (order.status !== 'pending') throw badRequest('recharge.payment_failed');
  const openid = await exchangeJsapiOpenid(code);
  // 金额/描述以订单为准，防链接篡改；失败不影响订单状态（可重试）
  const payParams = await createJsapiOrder({
    outTradeNo: order.order_no,
    description: `星网 XW.COM 充值`,
    amountFen: Math.round(Number(order.amount_yuan) * 100),
    openid,
  });
  return ok(res, { pay_params: payParams });
}));

// 小程序拉起支付参数（免登录，凭订单号+令牌）：web-view 内 H5 禁止 JSAPI 拉起，
// 由壳小程序支付页 wx.login 取 code → 此处以小程序 openid/ AppID 下单 → 壳页 wx.requestPayment
router.post('/wechat/miniapp/prepay', asyncHandler(async (req, res) => {
  const { no, t, code } = req.body || {};
  if (!verifyPayToken(String(no || ''), String(t || ''))) throw badRequest('recharge.pay_token_invalid');
  if (!miniappPayEnabled()) throw badRequest('recharge.wechat_not_enabled');
  const order = await RechargeOrder.findOne({ where: { order_no: no } });
  if (!order) throw badRequest('common.not_found');
  if (order.status === 'paid') return ok(res, { already_paid: true });
  if (order.status !== 'pending') throw badRequest('recharge.payment_failed');
  const openid = await exchangeMiniappOpenid(code);
  // 金额/描述以订单为准，防链接篡改；失败不影响订单状态（可重试）
  const payParams = await createJsapiOrder({
    outTradeNo: order.order_no,
    description: `星网 XW.COM 充值`,
    amountFen: Math.round(Number(order.amount_yuan) * 100),
    openid,
    appId: config.wechat.mini.appId,
  });
  return ok(res, { pay_params: payParams });
}));

// 单订单详情（前端轮询微信支付状态用）
router.get('/orders/:id', authRequired, asyncHandler(async (req, res) => {
  const order = await RechargeOrder.findOne({ where: { id: req.params.id, user_id: req.user.id } });
  if (!order) throw badRequest('common.not_found');
  return ok(res, order.toJSON());
}));

// 我的订单
router.get('/orders', authRequired, asyncHandler(async (req, res) => {
  const orders = await RechargeOrder.findAll({
    where: { user_id: req.user.id },
    order: [['id', 'DESC']],
    limit: 100,
  });
  return ok(res, orders);
}));

// 微信支付异步回调（由微信服务器调用，无需鉴权，响应微信要求的 {code,message} 格式）
router.post('/wechat/notify', asyncHandler(async (req, res) => {
  const reply = (code, message) => res.json({ code, message });
  try {
    if (!config.wechat.pay.enabled) return reply('FAIL', '微信支付未启用');
    const { resource } = req.body || {};
    if (!resource) return reply('FAIL', '缺少 resource');

    // 验签：按 Wechatpay-Timestamp/Nonce/Signature/Serial 用平台证书公钥做 SHA256withRSA 严格校验。
    // 原始报文用 JSON.stringify 重建（express.json 未挂 verify 钩子；微信回调为紧凑 JSON，逐字节一致），
    // 未来 app.js 注入 req.rawBody 后透传即可切字节级校验。
    // 平台证书不可用（如网络受限）时模块内降级：仅靠下方 AES-GCM 解密校验兜底 + 每小时一次告警。
    // 验签失败（签名不符/序列号未知/时间戳超窗）→ 401 拒绝，微信会按退避策略重试。
    try {
      await verifyNotifySignature({
        timestamp: req.headers['wechatpay-timestamp'],
        nonce: req.headers['wechatpay-nonce'],
        body: JSON.stringify(req.body),
        signature: req.headers['wechatpay-signature'],
        serial: req.headers['wechatpay-serial'],
        rawBody: req.rawBody, // 当前恒为 undefined；app.js 挂 verify 钩子后自动生效
      });
    } catch (e) {
      logger.warn(`微信回调验签失败，拒绝处理：${e.message}`);
      return res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
    }

    const data = decodeNotifyResource(resource); // 解密失败即抛错 → 回 FAIL
    const order = await RechargeOrder.findOne({ where: { order_no: data.out_trade_no } });
    if (!order) return reply('FAIL', '订单不存在');

    // 幂等：已支付直接回 SUCCESS，不重复入账
    if (order.status === 'paid') return reply('SUCCESS', 'OK');

    if (data.trade_state === 'SUCCESS') {
      // 商户号校验：回调报文必须来自本商户（解密报文内部字段，伪造通知拿不到正确 mchid）
      if (data.mchid && config.wechat.pay.mchId && data.mchid !== config.wechat.pay.mchId) {
        logger.error(`微信回调商户号不符：order ${order.order_no} 报文 mchid=${data.mchid}，拒绝入账`);
        return reply('FAIL', '商户号不符');
      }
      // 金额校验：回调金额（分）必须与订单应付一致——只验签名/订单号不验金额时，
      // 改单、串单或微信侧异常都会按订单全额入账，形成资损口子
      const expectedFen = Math.round(Number(order.amount_yuan) * 100);
      const paidFen = Number(data?.amount?.total);
      if (!Number.isFinite(paidFen) || paidFen !== expectedFen) {
        logger.error(`微信回调金额不符：order ${order.order_no} 应付 ${expectedFen} 分，实付 ${paidFen} 分，拒绝入账`);
        return reply('FAIL', '金额不符');
      }
      // 原子认领 + 入账同事务：并发重复通知只有一路能把 pending→paid（CAS 抢占）；
      // 事务保证「置 paid」与「入账」同生共死——中途失败/崩溃两者都未生效，
      // 落到 catch 回 FAIL 让微信重试，不会出现「已 paid 但没入账、重试被幂等挡死」的永久丢单。
      // （failed 单被迟到 SUCCESS 通知补入账沿用旧口径，一并允许认领。）
      await db.sequelize.transaction(async (t) => {
        const [claimed] = await RechargeOrder.update(
          {
            status: 'paid',
            paid_at: new Date(),
            transaction_id: data.transaction_id || order.transaction_id,
          },
          { where: { id: order.id, status: { [db.Sequelize.Op.in]: ['pending', 'failed'] } }, transaction: t }
        );
        if (claimed === 0) return; // 并发路已认领/已处理，幂等返回
        await addCredits(order.user_id, order.credits, {
          type: 'recharge', refId: order.id, remark: `微信充值 ${order.amount_yuan} 元`, transaction: t,
        });
      });
    }
    return reply('SUCCESS', 'OK');
  } catch (e) {
    // 抛错（解密失败/入账事务失败等瞬时故障）：回 5xx 让微信按退避重试——V3 规范以 HTTP 状态码判定
    // 接收失败，回 200+FAIL 体微信视为已接收、不再重试，会把「已支付未入账」永久卡死。
    // 业务性拒绝（订单不存在/金额不符等）不走这里，上面直接 reply('FAIL') 应答即可，无需重试。
    logger.error(`微信回调处理失败，回 5xx 等待重试：${e.message}`);
    return res.status(500).json({ code: 'FAIL', message: e.message || '处理失败' });
  }
}));

export default router;
