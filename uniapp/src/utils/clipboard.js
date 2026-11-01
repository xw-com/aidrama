/** 剪贴板（uniapp 全端） */
/** 读剪贴板：成功 resolve 文本（可能为空串），失败 reject（如端上未授权） */
export function readClipboard() {
  return new Promise((resolve, reject) => {
    uni.getClipboardData({
      success: (r) => resolve(String((r && r.data) ?? '')),
      fail: (e) => reject(e),
    });
  });
}
export function copyText(text) {
  return new Promise((resolve, reject) => {
    if (!text) return reject(new Error('empty'));
    uni.setClipboardData({
      data: String(text),
      success: () => resolve(true),
      fail: (e) => reject(e),
    });
  });
}
