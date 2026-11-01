/**
 * 复制文本到剪贴板（带降级）。
 * navigator.clipboard 仅在安全上下文（https / localhost）可用，内网 http 预览时为 undefined，
 * 降级走离屏 textarea + execCommand('copy')。
 * @param {string} text 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功（失败时调用方应给出可手动复制的兜底）
 */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 落入降级路径 */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const done = document.execCommand('copy');
    ta.remove();
    return done;
  } catch {
    return false;
  }
}
