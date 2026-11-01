/**
 * UI 适配层：ElMessage / ElMessageBox / ElMessageBox.prompt / action-sheet 的
 * uniapp 实现。全站交互提示统一走这里，业务代码不再直接摸 uni.*。
 * 提示文案 i18n key 见 locales mobile.* 键族。
 */
import { i18n } from '../i18n';
import { useDialogStore } from '../stores/dialog';

const t = (k, params) => i18n.global.t(k, params || {});

/** 页面挂了 <AdDialog /> 宿主时弹层走主题化渲染，否则回退 uni 原生弹窗 */
function themeDialogs() {
  try {
    return useDialogStore().hostMounted;
  } catch (e) {
    return false; // pinia 未就绪（极早期调用）按原生兜底
  }
}

export function toast(message, opts = {}) {
  // 兼容 client 风格位置参数 toast(msg, 'success' | 'error')；主题化 Tips 为纯文本气泡，
  // icon 仅在无宿主的原生 toast 兜底路径生效
  if (typeof opts === 'string') opts = { icon: opts };
  if (!message) return;
  const text = String(message).slice(0, 40);
  // 主题化 Tips：中上部出现，匀速上移到顶部渐隐（<AdToast /> 渲染）
  if (themeDialogs()) {
    useDialogStore().showToast(text, opts.duration || 2400);
    return;
  }
  // 无宿主兜底：原生 toast 也置顶，视觉行为尽量一致
  uni.showToast({
    title: text,
    icon: opts.icon || 'none',
    duration: opts.duration || 2400,
    position: 'top',
  });
}
export const toastError = (e, fallback) => {
  const msg = (e && (e.message || e.msg)) || fallback || t('common.error');
  toast(msg, { icon: 'none' });
};

/** 确认框：resolve(true/false)。兼容对象 {title,content,...} 或位置参数 (content, title)（client ElMessageBox 风格） */
export function confirm(opts = {}, legacyTitle) {
  if (typeof opts === 'string') opts = { content: opts, title: legacyTitle };
  if (themeDialogs()) return useDialogStore().confirm(opts);
  return nativeConfirm(opts);
}
function nativeConfirm(opts) {
  return new Promise((resolve) => {
    uni.showModal({
      title: opts.title || t('common.confirm'),
      content: opts.content || '',
      confirmText: opts.confirmText || t('common.ok'),
      cancelText: opts.cancelText || t('common.cancel'),
      confirmColor: opts.danger ? '#f87171' : '#e0b64e',
      showCancel: opts.showCancel !== false,
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

/** 单选下拉（替代系统原生 <picker>）：selectSheet({ title, items, current })
 * items: [{ key, label }] | [string]；current: 当前选中 key。
 * resolve 选中 key；取消返回 null。当前项渲染高亮 + 对勾。 */
export function selectSheet(opts = {}) {
  const items = (opts.items || []).map((it) => {
    const o = typeof it === 'string' ? { key: it, label: it } : it;
    return { ...o, on: o.key === opts.current };
  });
  if (!themeDialogs()) return nativeSheet(items); // 无宿主兜底（原生面板不显对勾）
  // 默认走叠层档（780/790）：下拉永远是从某个弹层/抽屉里触发的，须压过宿主
  // （如 gen-confirm-sheet 790），不能依赖 DOM 挂载顺序
  return useDialogStore().sheet(items, { title: opts.title || '', top: opts.top !== false });
}

/** 带输入的确认（驳回原因 / 仲裁意见等）：resolve(string|null)。
 * 兼容对象 {title,placeholder,...} 或位置参数 (title, content, placeholder) */
export function promptInput(opts = {}, legacyContent, legacyPlaceholder) {
  if (typeof opts === 'string') opts = { title: opts, content: legacyContent, placeholder: legacyPlaceholder };
  if (themeDialogs()) return useDialogStore().prompt(opts);
  return nativePrompt(opts);
}
function nativePrompt(opts) {
  return new Promise((resolve) => {
    uni.showModal({
      title: opts.title || '',
      content: opts.content || '',
      editable: true,
      placeholderText: opts.placeholder || '',
      confirmText: opts.confirmText || t('common.ok'),
      cancelText: opts.cancelText || t('common.cancel'),
      confirmColor: opts.danger ? '#f87171' : '#e0b64e',
      success: (r) => {
        if (!r.confirm) return resolve(null);
        const v = (r.content || '').trim();
        if (opts.required && !v) {
          toast(t('common.required'), { icon: 'none' });
          return resolve(null);
        }
        resolve(v);
      },
      fail: () => resolve(null),
    });
  });
}

/** 底部动作面板（el-dropdown 替代）：items: string | {key,label,danger} → resolve(key|null) */
export function actionSheet(items, opts = {}) {
  if (themeDialogs()) {
    return useDialogStore().sheet(
      items.map((it) => {
        const o = typeof it === 'string' ? { key: it, label: it } : it;
        // 未显式标注时，删除/移除类 key 视为危险项（红字）
        return { ...o, danger: o.danger !== undefined ? o.danger : ['delete', 'remove', 'leave'].includes(o.key) };
      }),
      opts,
    );
  }
  return nativeSheet(items, opts);
}
function nativeSheet(items, opts = {}) {
  return new Promise((resolve) => {
    const norm = items.map((it) => (typeof it === 'string' ? { key: it, label: it } : it));
    uni.showActionSheet({
      itemList: norm.map((it) => String(it.label)),
      itemColor: '#f3f0e8',
      success: (r) => resolve(norm[r.tapIndex]?.key ?? null),
      fail: () => resolve(null),
    });
  });
}

/** 加载遮罩 */
export function showLoading(title) {
  uni.showLoading({ title: title || t('common.loading'), mask: true });
}
export function hideLoading() {
  uni.hideLoading();
}

/** 回到顶部提示通用「功能在桌面端完成更顺手」 */
export function desktopHint() {
  toast(t('mobile.desktopHint'), { icon: 'none' });
}
