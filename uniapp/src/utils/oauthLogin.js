/**
 * 第三方一键登录（按平台条件编译选择登录方式）：
 * - 微信小程序：微信一键登录（uni.login code → 服务端 code2session）
 * - App iOS：Apple 一键登录（Sign in with Apple，App Store 审核要求第三方登录必备）
 * - App Android：Google 登录 + 华为一键登录（华为设备/鸿蒙生态）
 * - App 鸿蒙（APP-HARMONY）：华为一键登录（华为账号服务）
 * 微信/华为暂未就绪，经 DISABLED_PROVIDERS 各端一律不展示，就绪后移出该列表即恢复。
 * 服务端契约：POST /api/auth/oauth/:provider（持密代理换取），返回与直连
 * /auth/login 同构的 { user, tokens }，会话落库复用 auth.applyAuthResult。
 * App 端需在 manifest.json 配置对应 OAuth 模块的 appid/secret（微信开放平台 /
 * Apple / Google Cloud / 华为 AGC），未配置时 uni.login 会 fail，这里统一转文案提示。
 */
import { toast } from './ui';

/** 暂未就绪、各端一律不展示的一键登录方式（服务端/开放平台就绪后移出即可恢复显示） */
const DISABLED_PROVIDERS = ['weixin', 'huawei'];

/** 当前平台的一键登录候选（仅按编译平台静态给出，未含运行时可用性） */
export function platformProviders() {
  const list = [];
  /* #ifdef MP-WEIXIN */
  list.push({ key: 'weixin', labelKey: 'login.oauthWeixin' });
  /* #endif */
  /* #ifdef APP-PLUS */
  try {
    const os = uni.getSystemInfoSync().platform;
    // 微信 App 登录（两端均可，需开放平台 appid）
    list.push({ key: 'weixin', labelKey: 'login.oauthWeixin' });
    if (os === 'ios') list.push({ key: 'apple', labelKey: 'login.oauthApple' });
    if (os === 'android') {
      list.push({ key: 'google', labelKey: 'login.oauthGoogle' });
      list.push({ key: 'huawei', labelKey: 'login.oauthHuawei' });
    }
  } catch (e) { /* 系统信息失败则不展示一键登录 */ }
  /* #endif */
  /* #ifdef APP-HARMONY */
  list.push({ key: 'huawei', labelKey: 'login.oauthHuawei' });
  /* #endif */
  return list.filter((p) => !DISABLED_PROVIDERS.includes(p.key));
}

/** 探测设备上真正可用的 oauth 服务 id（manifest 未配置对应模块时不会出现在结果里） */
function detectOauthServices() {
  return new Promise((resolve) => {
    uni.getProvider({
      service: 'oauth',
      success: (res) => resolve(Array.isArray(res.provider) ? res.provider : []),
      fail: () => resolve([]),
    });
  });
}

/* #ifdef APP-PLUS */
/** 微信 App 登录要求本机装有微信客户端 */
function isWeixinInstalled() {
  try {
    return !!plus.runtime.isApplicationExist({ pname: 'com.tencent.mm', action: 'weixin://' });
  } catch (e) { return false; }
}
/* #endif */

/**
 * 登录页实际展示的一键登录方式：平台候选 ∩ 设备可用性。
 * App 端 manifest 未配置对应 OAuth 模块（sdkConfigs 为空）、或本机缺微信客户端时，
 * 对应按钮直接不显示，避免点了才提示「不可用」；其余端以静态候选（已剔除禁用项）为准。
 */
export async function resolveProviders() {
  let list = platformProviders();
  /* #ifdef APP-PLUS */
  const services = await detectOauthServices();
  const available = list.filter((p) => services.includes(p.key));
  list = available.some((p) => p.key === 'weixin') && !isWeixinInstalled()
    ? available.filter((p) => p.key !== 'weixin')
    : available;
  /* #endif */
  return list;
}

/** 拉起对应提供商的授权，归一取回上游凭证载荷 */
function acquire(provider) {
  return new Promise((resolve, reject) => {
    uni.login({
      provider,
      onlyAuthorize: provider === 'weixin', // 微信只取 code，令牌交换在服务端（持有 app secret）
      success: (res) => {
        // 小程序：{ code }；App 端：{ authResult }（apple 含 identityToken/authorizationCode 等）。
        // 部分 uni 运行时把 authResult 回传为 JSON 字符串；个别 DCloud 桥把 identityToken
        // 落在通用 access_token 字段——此处统一归一成对象 + identityToken，服务端按此契约取值
        let ar = res?.authResult;
        if (typeof ar === 'string') {
          try { ar = JSON.parse(ar); } catch { ar = null; }
        }
        if (provider === 'apple' && ar && ar.identityToken == null && ar.access_token) {
          ar = { ...ar, identityToken: ar.access_token };
        }
        if (ar) resolve({ authResult: ar });
        else if (res?.code) resolve({ code: res.code });
        else reject(new Error('empty auth result'));
      },
      fail: (e) => reject(Object.assign(new Error(e?.errMsg || 'login failed'), { status: -1 })),
    });
  });
}

/** 一键登录全流程：取上游凭证 → 服务端换取 → 落会话（由调用方传入 store 动作） */
export async function loginWithProvider(actions, provider) {
  const payload = await acquire(provider);
  return actions.loginWithProvider(provider, payload);
}

/** 登录页按钮统一入口：错误在 http 层已提示，设备未配置 SDK 时给本地兜底文案 */
export async function tapProvider(actions, provider, unavailableTip) {
  try {
    await loginWithProvider(actions, provider);
    return true;
  } catch (e) {
    if (e?.status === -1) toast(unavailableTip, 'error');
    return false;
  }
}
