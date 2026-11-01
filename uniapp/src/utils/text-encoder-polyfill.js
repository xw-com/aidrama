/**
 * TextEncoder 兜底（App 端）：鸿蒙 app-service.js 的 JSVM 未提供 TextEncoder 全局
 * （H5/小程序均有），qrcode 1.5.4 的 lib/core/byte-data.js 依赖它做 UTF-8 编码，
 * 缺失时 QRCode.create 直接抛「TextEncoder is not defined」。
 * 手写 UTF-8 编码（codePointAt 处理代理对），仅在缺失时注入，不覆盖原生实现。
 */
function getGlobalObj() {
  // 鸿蒙 JSVM 下 globalThis 存在（ES2020）；兜底 Node 式 global，再兜 window/self
  if (typeof globalThis !== 'undefined') return globalThis;
  if (typeof global !== 'undefined') return global;
  if (typeof window !== 'undefined') return window;
  if (typeof self !== 'undefined') return self;
  return null;
}

try {
  const g = getGlobalObj();
  if (g && typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class TextEncoder {
      // encode(): 无参默认 ''；只支持 UTF-8（规范中的 label 参数不实现）
      encode(str = '') {
        str = String(str);
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
          const code = str.codePointAt(i);
          if (code > 0xffff) i++; // 增补平面字符占两个 code unit，跳过低位代理
          if (code < 0x80) {
            bytes.push(code);
          } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
          } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
          } else {
            bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
          }
        }
        return new Uint8Array(bytes);
      }
      // encoding 属性按规范恒为 'utf-8'
      get encoding() { return 'utf-8'; }
    };
  }
} catch (e) {
  // 极端环境连全局对象都拿不到：保持静默，调用处已有 qrError 重试兜底
  console.error('[text-encoder-polyfill] install failed:', e);
}
