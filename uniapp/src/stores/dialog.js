import { defineStore } from 'pinia';

let resolver = null;
let toastTimer = null;

/**
 * 主题化弹层控制器：confirm / promptInput / actionSheet / toast 的页面内渲染宿主
 * （components/ad-dialog，挂在页面根 view 内继承 --ad-* 主题令牌）。
 * utils/ui.js 优先路由到这里；页面没挂宿主（hostMounted=false）时回退 uni 原生弹窗。
 */
export const useDialogStore = defineStore('dialog', {
  state: () => ({
    // 挂载计数（非布尔）：页面栈里多个 <AdDialog /> 共存，下层页 keep-alive 不重走
    // onMounted；若顶层页卸载直接复位布尔，幸存页会被误回退 uni 原生弹窗。计数只随
    // 配对的 mount/unmount 增减，与卸载顺序无关。
    hostCount: 0,
    show: false,
    mode: 'confirm', // confirm | prompt | sheet
    title: '',
    content: '',
    placeholder: '',
    input: '',
    required: false,
    danger: false,
    confirmText: '',
    cancelText: '',
    items: [], // sheet 模式：[{ key, label, danger, icon, on }]（icon 为行首描边图标名，见 utils/icons.js）
    // 叠层档：false 基础档（.ad-mask/.ad-sheet 750/760）；true 叠层档（.top 780/790）——
    // 从另一只弹层（如 gen-confirm-sheet）里触发的弹层要压过宿主，不依赖挂载顺序；
    // 'max' 顶档（.max 980/990）——从最高层宿主（全屏播放器 VideoPlayerPopup 900）里
    // 触发的确认/输入用，叠层档压不过 900
    top: false,
    // toast：由 <AdToast />（随 AdDialog 宿主携带）渲染，中上部匀速上移到顶部消失
    toastText: '',
    toastShow: false,
    toastKey: 0, // 连发时 :key 重建节点重启动画
    toastDuration: 2400,
  }),
  getters: {
    hostMounted: (s) => s.hostCount > 0,
  },
  actions: {
    _ask(payload) {
      return new Promise((resolve) => {
        if (resolver) this.cancel(); // 连环弹：前一个未结算的按取消处理
        resolver = resolve;
        this.$patch({ input: '', ...payload, show: true });
      });
    },
    confirm(opts = {}) {
      return this._ask({
        mode: 'confirm',
        top: opts.top === 'max' ? 'max' : !!opts.top,
        title: opts.title || '',
        content: opts.content || '',
        danger: !!opts.danger,
        confirmText: opts.confirmText || '',
        cancelText: opts.cancelText || '',
      });
    },
    prompt(opts = {}) {
      return this._ask({
        mode: 'prompt',
        top: opts.top === 'max' ? 'max' : !!opts.top,
        title: opts.title || '',
        content: opts.content || '',
        placeholder: opts.placeholder || '',
        required: !!opts.required,
        danger: !!opts.danger,
        confirmText: opts.confirmText || '',
        cancelText: opts.cancelText || '',
      });
    },
    sheet(items = [], opts = {}) {
      return this._ask({
        mode: 'sheet',
        top: !!opts.top,
        title: opts.title || '',
        // on: 当前选中项（selectSheet 单选场景）渲染高亮 + 对勾
        items: items.map((it) => (typeof it === 'string' ? { key: it, label: it } : it)),
      });
    },
    settle(value) {
      const r = resolver;
      resolver = null;
      this.show = false;
      this.top = false; // 复位叠层档，防止下一次基础弹层残留 top
      if (r) r(value);
    },
    cancel() {
      this.settle(this.mode === 'confirm' ? false : null);
    },
    showToast(text, duration = 2400) {
      clearTimeout(toastTimer);
      this.toastText = String(text).slice(0, 40);
      this.toastDuration = duration;
      this.toastKey++; // 连发时重建节点，动画从头再来
      this.toastShow = true;
      toastTimer = setTimeout(() => { this.toastShow = false; }, duration);
    },
  },
});
