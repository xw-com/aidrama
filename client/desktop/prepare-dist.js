// 打包前把 client/dist（web 构建产物）同步进本目录，供 electron-builder 收进 asar。
// 独立成脚本是为了跨平台（Windows 上没有 cp -r / rm -rf）。
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'dist');
const dest = path.join(__dirname, 'dist');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('[desktop] 未找到 client/dist/index.html —— 请先在 client/ 下执行 npm run build');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log('[desktop] dist 已同步 →', dest);
