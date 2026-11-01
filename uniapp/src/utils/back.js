/**
 * 统一返回目的地：系统返回键（useBackGuard）与导航栏返回（ad-navbar）共用。
 * 规则：一次返回只回到当前页的「逻辑父级」一层，绝不越级落到祖父级——
 * - 父级在页面栈内：navigateBack 精确退到父级（栈未损坏时即物理上一层）；
 * - 父级不在栈内（redirectTo/reLaunch 跳转链、深链直达）：reLaunch 重建父级页，
 *   不把跳转前的旧栈带回来，否则返回会一路穿到祖父级页面；
 * - 未声明父级的多入口页面（任务中心、登录系、分镜编辑等）：物理上一层即父级（实际来处）；
 * - 栈里只剩当前页（无来处）：回首页兜底。
 */
const HOME_URL = '/pages/showcase/index';

// 页面 → 逻辑父级。只收录父级无歧义的页面；
// 多入口页面（父级 = 实际来处）不收录，走物理上一层。
const PARENT_ROUTES = {
  'pages/showcase/detail': 'pages/showcase/index',
  'pages/projects/edit': 'pages/projects/index',
  'pages/market/detail': 'pages/market/index',
  'pages/tutorial/index': 'pages/mine/index',
  'pages/play/share': 'pages/showcase/index', // 深链播放页无栈上父级，父级视为首页
  'pages/workspace/index': 'pages/projects/index',
  'pages/workspace/outline': 'pages/workspace/index',
  'pages/workspace/assets': 'pages/workspace/index',
  'pages/workspace/episodes': 'pages/workspace/index',
  'pages/workspace/clip': 'pages/workspace/episodes',
};

function routeOf(page) {
  return ('/' + String((page && page.route) || '')).split('?')[0];
}

// 当前页 URL query（H5/App 在 $page.options，微信小程序在原生 Page.options）。
// reLaunch 重建父级时带回：刷新后页面栈只剩当前页，父级参数（如 pid）只能从这里恢复，
// 否则父级拿不到 pid，再往三级页跳会拼出 ?pid=null。
function queryOf(page) {
  const opts = (page && page.$page && page.$page.options) || (page && page.options) || {};
  const qs = Object.keys(opts)
    .filter((k) => opts[k] !== undefined && opts[k] !== null && opts[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(opts[k])}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

export function backToParent() {
  const pages = getCurrentPages();
  const cur = pages[pages.length - 1];
  if (!cur) {
    uni.reLaunch({ url: HOME_URL });
    return;
  }
  const parent = PARENT_ROUTES[routeOf(cur).slice(1)];
  if (!parent) {
    if (pages.length > 1) uni.navigateBack(); // 物理上一层即父级（实际来处）
    else uni.reLaunch({ url: HOME_URL }); // 深链/重定向直达无上级，回首页兜底
    return;
  }
  const idx = pages.map(routeOf).lastIndexOf('/' + parent);
  if (idx >= 0) uni.navigateBack({ delta: pages.length - 1 - idx }); // 栈内有父级：退到父级为止
  else uni.reLaunch({ url: '/' + parent + queryOf(cur) }); // 栈被跳转重写：重建父级，不带回旧栈（防祖父回溯），但带回 pid 等参数
}
