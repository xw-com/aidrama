/**
 * 美术风格示例图批量转换脚本（维护工具）：images/preview.png → preview.webp、images/1.png → 1.webp。
 *
 * 背景：美术风格示例图规格已由 PNG 改为 WebP（缩略 854×480 q80 约 50KB/张、4K 大图 q85，
 * 均比 PNG 小一个数量级）。历史上已生成过 PNG 的环境跑一次本脚本即可迁移到新规格。
 *
 * 行为：
 *  - 扫描 skills/art_skills/<key>/images/ 下 preview.png（转 854×480 q80，归一规格）
 *    与 1.png（原尺寸转 q85，不缩放）；
 *  - 默认转换成功后删除对应 .png；--keep 可保留；已有 .webp 跳过（--force 重转）；
 *  - 同步 UPDATE art_styles.thumbnail 的 preview.png → preview.webp（DB 存的是含后缀的相对路径）。
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/convertArtSkillImages.js            # 转换全部 + 更新 DB（成功后删旧 .png）
 *   node scripts/convertArtSkillImages.js --dry-run  # 只列出将处理的文件，不写盘不改库
 *   node scripts/convertArtSkillImages.js --keep     # 转换但保留旧 .png
 *   node scripts/convertArtSkillImages.js --force    # 已有 .webp 也重转覆盖
 *
 * 说明：脚本 UPDATE 数据库不触发运行中服务的内存缓存（reloadArtStyles）刷新，
 * 跑完后需重启服务（dev 环境 node --watch 改动 src 会自动重启；生产随部署重启），
 * 否则列表接口仍按旧 .png 路径出 URL。单张失败跳过继续，失败时退出码 1（便于重跑）。
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { sequelize, default as db } from '../src/db/index.js';

const { ArtStyle } = db;
const ROOT = path.resolve(process.cwd(), 'skills/art_skills');
const DRY = process.argv.includes('--dry-run');
const KEEP = process.argv.includes('--keep');
const FORCE = process.argv.includes('--force');

// [源文件名, 目标文件名, 处理器]
const JOBS = [
  ['preview.png', 'preview.webp', (s) => s.resize(854, 480, { fit: 'cover', position: 'centre' }).webp({ quality: 80 })],
  ['1.png', '1.webp', (s) => s.webp({ quality: 85 })],
];

if (!fs.existsSync(ROOT)) {
  console.log(`目录不存在，无需迁移：${ROOT}`);
  process.exit(0);
}

const targets = [];
for (const key of fs.readdirSync(ROOT).sort()) {
  const imgDir = path.join(ROOT, key, 'images');
  if (!fs.existsSync(imgDir) || !fs.statSync(imgDir).isDirectory()) continue;
  for (const [srcName, dstName] of JOBS) {
    const srcPath = path.join(imgDir, srcName);
    if (!fs.existsSync(srcPath)) continue;
    const dstPath = path.join(imgDir, dstName);
    if (!FORCE && fs.existsSync(dstPath)) continue; // 已迁移过
    targets.push({ key, srcPath, dstPath, srcName });
  }
}

console.log(`扫描 ${ROOT}：待转换 ${targets.length} 张${FORCE ? '（--force）' : ''}${DRY ? '（--dry-run）' : ''}\n`);

let done = 0;
const failed = [];
for (const t of targets) {
  const rel = path.relative(ROOT, t.srcPath);
  if (DRY) { console.log(`  [dry] ${rel}`); done += 1; continue; }
  try {
    const before = fs.statSync(t.srcPath).size;
    await JOBS.find(([s]) => s === t.srcName)[2](sharp(t.srcPath)).toFile(t.dstPath);
    const after = fs.statSync(t.dstPath).size;
    if (!KEEP) fs.unlinkSync(t.srcPath);
    done += 1;
    console.log(`  ✓ ${rel}  ${(before / 1024 / 1024).toFixed(2)}MB → ${(after / 1024 / 1024).toFixed(2)}MB${KEEP ? '' : '（已删旧图）'}`);
  } catch (e) {
    failed.push(rel);
    console.error(`  ✗ ${rel}：${e.message}`);
    try { fs.unlinkSync(t.dstPath); } catch { /* 半成品清理，忽略 */ }
  }
}

// DB 存量 thumbnail 路径迁移（preview.png → preview.webp）
let dbUpdated = 0;
if (!DRY && done > 0) {
  await sequelize.query(
    "UPDATE art_styles SET thumbnail = REPLACE(thumbnail, 'images/preview.png', 'images/preview.webp') WHERE thumbnail LIKE '%images/preview.png'",
    { type: sequelize.QueryTypes.UPDATE }
  );
  // sqlite/mysql 的 UPDATE 返回格式不一致，改按结果口径统计（已是 .webp 的行数）
  const [rows] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM art_styles WHERE thumbnail LIKE '%images/preview.webp'",
    { type: sequelize.QueryTypes.SELECT }
  );
  dbUpdated = rows?.n ?? rows?.[0]?.n ?? 0;
}

console.log(`\n完成：${done} 张转换${KEEP ? '（旧图保留）' : ''}，DB thumbnail 更新 ${dbUpdated} 行，失败 ${failed.length} 张`);
if (failed.length) {
  console.log('失败清单：\n  ' + failed.join('\n  '));
  process.exitCode = 1;
}
if (done > 0 && !DRY) console.log('\n注意：运行中的服务需重启后才会按新路径出图（内存缓存不随 DB 更新刷新）。');
await sequelize.close();
