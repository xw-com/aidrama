<script>
import { watch } from 'vue';
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app';
import { useAuthStore } from './stores/auth';
import { useJobsStore } from './stores/jobs';
import { useInvitationsStore } from './stores/invitations';
import { useLocaleStore } from './stores/locale';
import { useThemeStore } from './stores/theme';
import i18n, { ensureLocaleMessages, detectLocale } from './i18n';
import { isPrivacyAgreed, agreePrivacy, waitPrivacyAgreed } from './utils/privacy';
import { checkAppUpdate, promptAppUpdate } from './utils/appUpdate';

const t = (k, p) => i18n.global.t(k, p);

/** 启动初始化是否已执行：App 端过完隐私门禁才置位，其余端 onLaunch 同步置位 */
let started = false;

/** 真正的启动初始化（原 onLaunch 逻辑整体收拢；App 端同意隐私后才允许进入） */
function startApp() {
  if (started) return;
  started = true;
  const theme = useThemeStore();
  theme.init();
  const locale = useLocaleStore();
  locale.init();
  // 初始语言非 zh-CN 时先装载语言包（zh-CN 静态内置）
  if (locale.locale !== 'zh-CN') ensureLocaleMessages(locale.locale);
  // 恢复会话：令牌过期由 http 层静默刷新；维护期 503 不清会话
  const auth = useAuthStore();
  if (auth.isLoggedIn) {
    auth.fetchMe().then((user) => {
      if (!user) return;
      const inv = useInvitationsStore();
      inv.ensurePolling(); // 顶栏铃铛角标数据源
      const jobs = useJobsStore();
      jobs.fetchAll().then(() => jobs.ensurePolling()); // 接回重启前仍在跑的任务
    });
  }
  // 会话切换统一接线（与 client DefaultLayout 的 watch(auth.token) 对齐）：
  //  - 登出/换号/会话作废（bailSession）→ 清空任务与邀请数据并停轮询——否则旧账号
  //    活跃任务永久留在 store 里，任务角标虚高、还串到下一个登录账号；
  //  - 游客→登录 → 立即补拉并重启轮询——onLaunch 只在启动时跑一次，登录前不拉，
  //    错过这次接线的话登录后角标一直为 0（别端发起的任务看不到），直到进任务中心页。
  watch(() => auth.token, (tok) => {
    const jobs = useJobsStore();
    const inv = useInvitationsStore();
    if (!tok) { jobs.reset(); inv.reset(); return; }
    jobs.fetchAll().then(() => jobs.ensurePolling());
    inv.ensurePolling();
  });
  // App 端版本更新检查（启动期静默；仅 Android 弹窗跳下载页，iOS 走 App Store 不弹）
  /* #ifdef APP-PLUS */
  checkAppUpdate().then((data) => {
    if (data && data.hasUpdate && data.platform === 'android') promptAppUpdate(data);
  });
  /* #endif */
}

/* #ifdef APP-PLUS */
/** App 首启隐私门禁弹窗：原生 modal 无蒙层点击穿透，未同意永远进不了应用。
 *  「同意」→ 落盘 + 继续初始化；「不同意」→ 二次确认（可先跳协议页读全文，或退出）。 */
function showPrivacyGate() {
  uni.showModal({
    title: t('app.privacy.title'),
    content: t('app.privacy.body'),
    confirmText: t('app.privacy.agree'),
    cancelText: t('app.privacy.disagree'),
    confirmColor: '#e0b64e',
    success: (r) => {
      if (r.confirm) {
        agreePrivacy();
        startApp();
        return;
      }
      uni.showModal({
        title: t('app.privacy.exitTitle'),
        content: t('app.privacy.exitBody'),
        confirmText: t('app.privacy.viewTerms'),
        cancelText: t('app.privacy.quit'),
        confirmColor: '#e0b64e',
        success: (r2) => {
          if (r2.confirm) {
            // redirectTo 换掉启动页：门禁模式的协议页是死胡同（只有「同意并继续」/
            // 「不同意并退出」两条出路），不存在绕回应用的可能；同意后 reLaunch 首页
            // 续起（协议页 agreePrivacy 会触发上面 waitPrivacyAgreed 的续起分支）
            uni.redirectTo({ url: '/pages/agreement/index?type=terms&gate=1' });
          } else {
            plus.runtime.quit();
          }
        },
      });
    },
  });
}
/* #endif */

export default {
  onLaunch() {
    /* #ifdef APP-PLUS */
    // 合规门禁：未同意《用户协议》《隐私政策》前不执行任何会发请求的初始化
    //（http 层同步以 waitPrivacyAgreed 挂起全部请求，双保险）
    if (!isPrivacyAgreed()) {
      waitPrivacyAgreed().then(startApp); // 协议页「同意并继续」的续起入口
      // 语言包懒加载（App 端仅 zh-CN 内置）：弹门禁前先装载当前语言，避免非 zh/en
      // 语言的首启用户在弹窗里看到键路径；装载完才弹（幂等，startApp 里不会重复拉）
      const loc = detectLocale();
      Promise.resolve(loc !== 'zh-CN' ? ensureLocaleMessages(loc) : null).finally(showPrivacyGate);
      return;
    }
    /* #endif */
    startApp();
  },
  onShow() {
    /* #ifdef APP-PLUS */
    if (!started) return; // 门禁未过（协议页停留中）：不补拉、不轮询
    /* #endif */
    // 回前台：立即补拉并重启轮询（后台期间完成的任务靠补拉检测跃迁）
    useJobsStore().resume();
    useInvitationsStore().resume();
  },
  onHide() {
    useJobsStore().pause();
    useInvitationsStore().pause();
  },
};
</script>

<style lang="scss">
/* 全局设计系统（docs/mobile-ui-proposal.html「掌上制片厂」1:1 移植）
   注：uni.scss 由构建注入在本块顶部，@use 必须是首条规则，这里只能用 @import
   （告警已在 vite.config.js silenceDeprecations 压制）。 */
@import './styles/ad.scss';
</style>
