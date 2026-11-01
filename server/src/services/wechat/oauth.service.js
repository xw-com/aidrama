import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../config/index.js';

const { login: wx } = config.wechat;

/**
 * 微信开放平台「网页扫码登录」（qrconnect）服务。
 * 文档：https://open.weixin.qq.com/cgi-bin/showdocument?action=dir_list&t=resource/res_list&verify=1&id=open1419316505
 * 仅在 config.wechat.login.enabled 时可用。
 */

// 生成带 HMAC 签名的 state（防篡改），载荷可携带登录后的前端跳转地址
function buildState(redirect) {
  const payload = Buffer.from(JSON.stringify({ r: redirect || '', n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwt.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// 校验 state 签名并取回 redirect；不合法返回 null
export function verifyState(state) {
  if (!state || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expect = crypto.createHmac('sha256', config.jwt.secret).update(payload).digest('base64url');
  if (sig !== expect) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
}

// 拼接微信扫码登录授权页地址（前端直接 window.location 跳转过去）
export function getAuthorizeUrl(redirect) {
  if (!wx.enabled) throw new Error('微信登录未启用：请在配置中填写 WECHAT_APP_ID / WECHAT_APP_SECRET');
  const redirectUri = wx.redirectUri;
  const state = buildState(redirect);
  const params = new URLSearchParams({
    appid: wx.appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'snsapi_login',
    state,
  });
  // #wechat_redirect 必须保留
  return { url: `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`, state };
}

// 用授权 code 换取 access_token / openid / unionid，并拉取用户资料
export async function loginByCode(code) {
  if (!wx.enabled) throw new Error('微信登录未启用');

  // 1) code → access_token + openid (+ unionid)
  const tokenUrl = 'https://api.weixin.qq.com/sns/oauth2/access_token';
  const { data: token } = await axios.get(tokenUrl, { params: {
    appid: wx.appId, secret: wx.appSecret, code, grant_type: 'authorization_code',
  }, timeout: 10000 });
  if (token.errcode) throw new Error(`微信换 token 失败：${token.errcode} ${token.errmsg}`);
  const { access_token, openid, unionid } = token;

  // 2) 拉取用户资料（snsapi_login 可直接拿到 nickname / headimgurl）
  let profile = { nickname: '', headimgurl: '' };
  try {
    const { data: info } = await axios.get('https://api.weixin.qq.com/sns/userinfo', { params: {
      access_token, openid,
    }, timeout: 10000 });
    if (!info.errcode) profile = info;
  } catch { /* 资料非必须，忽略 */ }

  return {
    openid,
    unionid: unionid || '',
    nickname: profile.nickname || '',
    avatar: profile.headimgurl || '',
  };
}
