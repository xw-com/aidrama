import { onBackPress } from '@dcloudio/uni-app';
import { backToParent } from '../utils/back';

/**
 * 系统返回键守卫：接管返回，只回逻辑父级一层，不越级回祖父（规则见 utils/back.js）。
 * 与导航栏返回按钮（ad-navbar → backToParent）同规则。
 *
 * App/鸿蒙端约定：uni.navigateBack() 会再次触发 onBackPress（from='navigateBack'），
 * 此时必须返回 false 放行该次调用，否则 API 被吞掉、所有返回全部失效；
 * 只有 from='backbutton'（系统返回键/手势）才拦截并改走 backToParent。
 *
 * @param {() => boolean} [beforeBack] 返回 true 表示本页已消费本次返回（如先关弹层不退页）。
 * 仅 App/鸿蒙端有系统返回键拦截 API；H5 端 uni-h5 不派发 onBackPress（弹层自兜 popstate），
 * 小程序端无拦截 API——两端注册无副作用，靠干净的页面栈 + 导航栏返回保证同一规则。
 */
export function useBackGuard(beforeBack) {
  onBackPress((options = {}) => {
    if (options.from === 'navigateBack') return false; // backToParent 等程序化返回，放行
    if (typeof beforeBack === 'function' && beforeBack()) return true;
    backToParent();
    return true;
  });
}
