/**
 * 图标系统：docs/mobile-ui-proposal.html 的 25 个描边 symbol 1:1 移植为运行时清单。
 * 渲染策略（组件 m-icon）：
 *  - H5 / App(vue)：内联 <svg>，currentColor 继承文字色
 *  - 小程序：CSS mask-image（base64 svg 蒙版 + background-color 上色，默认 currentColor）
 */

export const ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.2V20h13V9.2"/><path d="M9.8 20v-5.6h4.4V20"/>',
  clap: '<path d="M4 9.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V9.5Z"/><path d="M4.6 8.9 6.2 5l13.3 2.4-.9 1.9"/><path d="m9 8.2 1.4-3.4M13.6 9l1.3-3.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  case: '<rect x="4" y="8" width="16" height="11.5" rx="1.8"/><path d="M9.5 8V6.4A1.4 1.4 0 0 1 10.9 5h2.2a1.4 1.4 0 0 1 1.4 1.4V8"/><path d="M4 12.8h16"/>',
  user: '<circle cx="12" cy="8.2" r="3.4"/><path d="M5 20c.8-3.4 3.6-5.2 7-5.2s6.2 1.8 7 5.2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m15.6 15.6 4 4"/>',
  bell: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10Z"/><path d="M10 18.7a2.2 2.2 0 0 0 4 0"/>',
  play: '<path d="M8.5 5.8v12.4L18.5 12Z"/>',
  left: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  right: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  tasks: '<path d="M4 6.5h9M4 12h9M4 17.5h6"/><path d="m14.5 16 2 2 3.8-4.2"/>',
  coin: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
  invite: '<circle cx="10" cy="8.5" r="3.2"/><path d="M4 19.5c.7-3 3.2-4.7 6-4.7 1.6 0 3 .5 4.1 1.3"/><path d="M18.5 13.5v6M15.5 16.5h6"/>',
  gift: '<rect x="4.5" y="10" width="15" height="9.5" rx="1.2"/><path d="M4.5 10h15M12 10v9.5"/><path d="M12 10c-1.8-.4-4.4-1-4.4-3a1.9 1.9 0 0 1 3.7-.4c.4 1 .7 2.2.7 3.4 0-1.2.3-2.4.7-3.4a1.9 1.9 0 0 1 3.7.4c0 2-2.6 2.6-4.4 3Z"/>',
  set: '<path d="M4.5 8h8.2M17.5 8h2M4.5 16h2M10.5 16h9"/><circle cx="15.2" cy="8" r="2.1"/><circle cx="8.2" cy="16" r="2.1"/>',
  help: '<circle cx="12" cy="12" r="8.2"/><path d="M9.7 9.5a2.4 2.4 0 0 1 4.7.6c0 1.7-2.4 2-2.4 3.5"/><path d="M12 16.8h.01"/>',
  doc: '<path d="M13.5 4.5H7A1.5 1.5 0 0 0 5.5 6v12A1.5 1.5 0 0 0 7 19.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5Z"/><path d="M13.5 4.5v5h5"/><path d="M9 13.5h6M9 16.5h4"/>',
  spark: '<path d="M12 4.5 13.7 9.3 18.5 11l-4.8 1.7L12 17.5l-1.7-4.8L5.5 11l4.8-1.7Z"/><path d="M18.5 16.5v4M16.5 18.5h4"/>',
  import: '<path d="M12 4.5v9.5M8.5 10.5 12 14l3.5-3.5"/><path d="M5 17.5v1A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
  upload: '<path d="M12 14V4.5M8.5 8 12 4.5l3.5 3.5"/><path d="M5 17.5v1A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
  remake: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.6"/><path d="M15.5 5.5H6A1.5 1.5 0 0 0 4.5 7v9.5"/>',
  film: '<rect x="4" y="5" width="16" height="14" rx="1.6"/><path d="M8.2 5v14M15.8 5v14M4 9.6h4.2M4 14.4h4.2M15.8 9.6H20M15.8 14.4H20"/>',
  video: '<rect x="3.5" y="7" width="12" height="10" rx="1.8"/><path d="m15.5 10.6 4.5-2.4v7.6l-4.5-2.4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.6V12l3 2"/>',
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  drop: '<path d="M12 4c3.4 3.9 5.8 6.6 5.8 9.6a5.8 5.8 0 1 1-11.6 0C6.2 10.6 8.6 7.9 12 4Z"/>',
  wallet: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h10.5"/><path d="M15.5 13h5v3.4h-5a1.7 1.7 0 0 1 0-3.4Z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  cut: '<circle cx="6.2" cy="6.2" r="2.4"/><circle cx="6.2" cy="17.8" r="2.4"/><path d="M8.2 7.8 19.5 17.5M8.2 16.2 19.5 6.5"/><path d="m14.2 14.6 2.4 2.4M14.2 9.4l2.4-2.4"/>',
  undo: '<path d="M4.5 8.5h9.2a5 5 0 0 1 0 10H8.5"/><path d="M8 4.8 4.3 8.5 8 12.2"/>',
  redo: '<path d="M19.5 8.5h-9.2a5 5 0 0 0 0 10h5.2"/><path d="m16 4.8 3.7 3.7L16 12.2"/>',
  trash: '<path d="M4.5 7.5h15M9.5 7.5V6.1a1.6 1.6 0 0 1 1.6-1.6h1.8a1.6 1.6 0 0 1 1.6 1.6v1.4"/><path d="m6.6 7.5.9 11.5a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l.9-11.5"/>',
  up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  expand: '<path d="M9 4.5H5.6a1.1 1.1 0 0 0-1.1 1.1V9"/><path d="M15 4.5h3.4a1.1 1.1 0 0 1 1.1 1.1V9"/><path d="M9 19.5H5.6a1.1 1.1 0 0 1-1.1-1.1V15"/><path d="M15 19.5h3.4a1.1 1.1 0 0 0 1.1-1.1V15"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.5 9.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.5M6.3 8.2A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 3.2-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  pen: '<path d="m4.6 19.4 3.5-.7L18.6 8.2a1.9 1.9 0 0 0-2.7-2.7L5.3 16.1l-.7 3.3Z"/><path d="m13.7 7.6 2.7 2.7"/>',
  layers: '<path d="m12 4.2 8 4.5-8 4.5-8-4.5Z"/><path d="m4.6 13.2 7.4 4.1 7.4-4.1"/>',
};

/**
 * 组装 SVG 标记。默认 currentColor 继承文字色（随主题换色）；
 * 小程序端 m-icon 只拿它做 base64 蒙版（显式传 #000，上色靠 background-color）。
 */
export function svgMarkup(name, { size = 20, color = 'currentColor', sw = 1.7 } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** 字符串 → base64（ASCII 安全；svg 标记不含非 ASCII 字符）。
 *  注意 charCodeAt 越界返回 NaN 而非 undefined，必须显式判界，
 *  否则尾部组会多出 'A'（解码后成 \0 字节），真机上图片解码失败不显示。 */
export function b64(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const b0 = str.charCodeAt(i);
    const hasB1 = i + 1 < str.length, hasB2 = i + 2 < str.length;
    const b1 = hasB1 ? str.charCodeAt(i + 1) : 0;
    const b2 = hasB2 ? str.charCodeAt(i + 2) : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += hasB1 ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += hasB2 ? chars[b2 & 63] : '=';
  }
  return out;
}
