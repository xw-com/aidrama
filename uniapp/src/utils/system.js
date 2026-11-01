/** 系统信息（memoized）：状态栏高度 / 窗口宽度（390px 设计基准的适配用） */
let cached = null;
function info() {
  if (cached) return cached;
  try { cached = uni.getSystemInfoSync() || {}; } catch (e) { cached = {}; }
  return cached;
}
export function statusBarHeight() {
  return info().statusBarHeight || 0;
}
export function windowWidth() {
  return info().windowWidth || 390;
}
/** 是否刘海屏/挖孔屏（状态栏 > 30 视为异形屏，加大顶部留白） */
export function hasNotch() {
  return statusBarHeight() > 30;
}
/** 微信小程序端：导航内容行与右上角胶囊垂直对齐、右侧插槽让出胶囊宽度，避免叠压。
 *  其余端走默认值（内容行 48px、右边距 12px），与 ad-navbar 原样式一致。 */
let capsule = null;
function capsuleFit() {
  if (capsule) return capsule;
  capsule = { barH: 48, rightPad: 12 };
  // #ifdef MP-WEIXIN
  try {
    const rect = uni.getMenuButtonBoundingClientRect();
    if (rect && rect.height && rect.top > statusBarHeight()) {
      const gap = rect.top - statusBarHeight(); // 胶囊距状态栏的上下留白
      capsule.barH = rect.height + gap * 2;
      capsule.rightPad = windowWidth() - rect.left + 8;
    }
  } catch (e) { /* 拿不到胶囊信息时用默认值 */ }
  // #endif
  return capsule;
}
/** 自定义导航栏内容行高度（不含状态栏） */
export function navBarContentHeight() {
  return capsuleFit().barH;
}
/** 导航栏右侧需让出的宽度（仅微信小程序端为胶囊宽度 + 间隙） */
export function navBarRightPad() {
  return capsuleFit().rightPad;
}
/** 微信小程序端页头（.ptop 自带 18px 右内边距）需额外让出的宽度，其余端为 0 */
export function headerExtraRight() {
  // #ifdef MP-WEIXIN
  return Math.max(0, capsuleFit().rightPad - 18);
  // #endif
  return 0;
}
/** App 端是否 iOS（合规分流用：App Store 3.1.1 禁应用内充值 / 版本更新走商店）。
 *  非 App 端恒 false；鸿蒙端不在 APP-PLUS 编译分支内，同样恒 false。 */
export function isIosApp() {
  // #ifdef APP-PLUS
  try {
    return info().platform === 'ios';
  } catch (e) {
    return false;
  }
  // #endif
  // #ifndef APP-PLUS
  return false;
  // #endif
}
