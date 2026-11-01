/**
 * 角色选项示例图缩略图批量转换脚本（维护工具）：.thumb.png → .thumb.webp。
 *
 * 背景：characterOptions 缩略图规格已由 PNG 改为 WebP（854×480 q80，人像约 50KB/张，
 * 比 PNG 小一个数量级）。历史上已生成过 .thumb.png 的环境（如生产库）跑一次本脚本即可
 * 迁移到新规格；转换后服务端 stats/缺失扫描/URL（characterOptions.service.js 单点
 * optionImagePaths）即按 .webp 计，无需其它操作。
 *
 * 行为：
 *  - 扫描 skills/char_options/<group>/ 下所有 *.thumb.png；
 *  - sharp 转 WebP（q80），统一归一到 854×480 cover（源已是该尺寸则等效无损幂等）；
 *  - 默认转换成功后删除对应 .png（避免留下会被误用的旧文件）；--keep 可保留；
 *  - 已存在同名 .thumb.webp 时跳过（增量迁移），--force 可强制重转。
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/convertCharOptionThumbs.js            # 转换全部（成功后删旧 .png）
 *   node scripts/convertCharOptionThumbs.js --dry-run  # 只列出将处理的文件，不写入
 *   node scripts/convertCharOptionThumbs.js --keep     # 转换但保留旧 .png
 *   node scripts/convertCharOptionThumbs.js --force    # 已有 .webp 也重转覆盖
 *
 * 说明：单张失败跳过并继续，结束时汇总；存在失败时退出码为 1（便于重跑）。
 * 纯磁盘操作，不依赖数据库，服务运行中执行也安全（URL 以 mtime 为版本号，重生成即失效）。
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ROOT = path.resolve(process.cwd(), 'skills/char_options');
const DRY = process.argv.includes('--dry-run');
const KEEP = process.argv.includes('--keep');
const FORCE = process.argv.includes('--force');

if (!fs.existsSync(ROOT)) {
  console.log(`目录不存在，无需迁移：${ROOT}`);
  process.exit(0);
}

const targets = [];
for (const group of fs.readdirSync(ROOT).sort()) {
  const dir = path.join(ROOT, group);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.thumb.png')) continue;
    const pngPath = path.join(dir, f);
    const webpPath = path.join(dir, f.replace(/\.thumb\.png$/, '.thumb.webp'));
    if (!FORCE && fs.existsSync(webpPath)) continue; // 已迁移过
    targets.push({ group, pngPath, webpPath });
  }
}

console.log(`扫描 ${ROOT}：待转换 ${targets.length} 张${FORCE ? '（--force）' : ''}${DRY ? '（--dry-run）' : ''}\n`);
if (!targets.length) process.exit(0);

let done = 0;
const failed = [];
for (const t of targets) {
  const rel = path.relative(ROOT, t.pngPath);
  if (DRY) { console.log(`  [dry] ${rel}`); continue; }
  try {
    const before = fs.statSync(t.pngPath).size;
    await sharp(t.pngPath).resize(854, 480, { fit: 'cover', position: 'centre' }).webp({ quality: 80 }).toFile(t.webpPath);
    const after = fs.statSync(t.webpPath).size;
    if (!KEEP) fs.unlinkSync(t.pngPath);
    done += 1;
    console.log(`  ✓ ${rel}  ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB${KEEP ? '' : '（已删旧图）'}`);
  } catch (e) {
    failed.push(rel);
    console.error(`  ✗ ${rel}：${e.message}`);
    try { fs.unlinkSync(t.webpPath); } catch { /* 半成品清理，忽略 */ }
  }
}

console.log(`\n完成：${done} 张转换${KEEP ? '（旧图保留）' : ''}，失败 ${failed.length} 张`);
if (failed.length) {
  console.log('失败清单：\n  ' + failed.join('\n  '));
  process.exit(1);
}
