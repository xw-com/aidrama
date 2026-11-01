/**
 * 美术风格预览图批量生成脚本（维护工具）。
 *
 * 作用：为 skills/art_skills/<type>/images/preview.webp 生成真实风格预览图，替换历史 114x86 占位图。
 * 风格列表从磁盘扫描（不硬编码），新增风格目录后重跑本脚本即可补齐（默认只处理缺失 preview.webp 的）。
 *
 * 生成方式对齐「资产-角色生图」链路（assetPrompt.service.js / asset.routes.js）：
 *  1) 文本 LLM：以该风格 art_prompt/art_character.md 作为 assistant 约束，生成人物文生图提示词；
 *  2) 图像 LLM：调用 generateImage（与角色生图同一入口，内部固定 16:9 高清出图）；
 *  3) 出图后原始高清图存 <type>/images/1.webp，再降采样为 16:9 480p（854x480）落盘 preview.webp
 *     （生成走高清，仅 preview 缩放；两文件均直接覆盖）。
 *
 * 画面要求：整体为符合该风格的场景背景 + 一位半身青年人物（男/女），单幅展示构图。
 *
 * 前置：数据库中存在已启用的 text / image 模型配置（admin 名下的共享模型即可，
 * 脚本以第一个 admin 用户身份解析，见 modelConfig.service.js）。
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/generateArtSkillPreviews.js                       # 全部风格（男女交替）
 *   node scripts/generateArtSkillPreviews.js --only 2D_chibi_sd,realpeople_modern_city
 *   node scripts/generateArtSkillPreviews.js --gender male         # male / female / mixed（默认 mixed 交替）
 *   node scripts/generateArtSkillPreviews.js --dry-run             # 只列出将处理的风格，不调用模型
 *   node scripts/generateArtSkillPreviews.js --force               # 强制重新生成（覆盖已有 preview.webp）
 *
 * 说明：逐套串行调用模型，38 套全量约需数十分钟；单套失败跳过并继续，结束时汇总，
 * 存在失败时退出码为 1（便于 CI/批量重跑）。默认跳过已存在 preview.webp 的风格（增量补图），
 * 需重新生成旧图时加 --force。
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { sequelize, default as db } from '../src/db/index.js';
import { logger } from '../src/utils/logger.js';
import { buildSystem } from '../src/services/artSkills.service.js';
import { complete } from '../src/services/llm.service.js';
import { generateImage } from '../src/services/image.service.js';
import { urlToPath } from '../src/utils/fileUtil.js';

const { User } = db;

const SKILLS_ROOT = path.resolve(process.cwd(), 'skills', 'art_skills');
const PREVIEW_W = 854; // 16:9 480p
const PREVIEW_H = 480;

// 预览图画面规格（对标 assetPrompt.service.js 的 CHARACTER_PROMPT_SUFFIX 前置写法）：
// 与角色设定图「三视图」规格不同——预览图要的是「风格化场景背景 + 半身青年人物」的单幅展示构图
const PREVIEW_COMPOSITION_PROMPT = [
  '画面为单幅风格展示图：整体为符合该风格的场景背景（环境/空间/氛围与风格世界观一致），画面中加入一位青年人物（半身构图，腰部以上），人物与背景自然融合、光影统一。',
  '人物面容清晰、气质鲜明，构图重心稳定，画面具备该风格最具辨识度的质感与色彩特征。',
  '忽略任何多视图/三视图/设定图排版要求，仅生成这一幅半身构图。图像比例：16:9。',
  '不要生成人物四视图，主题背景+人物即可，画面中不要出现多余的文字、logo、边框、UI元素。',
].join('\n');

// —— CLI 参数 ——
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force'); // 默认跳过已有 preview.webp，--force 强制覆盖重生成
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? new Set(String(argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const genderIdx = argv.indexOf('--gender');
const GENDER = genderIdx > -1 ? String(argv[genderIdx + 1] || 'mixed') : 'mixed';
if (!['male', 'female', 'mixed'].includes(GENDER)) {
  console.error(`--gender 仅支持 male / female / mixed，收到：${GENDER}`);
  process.exit(1);
}

/** 扫描磁盘上的全部风格类型（不硬编码）；--only 过滤 */
function scanStyleTypes() {
  return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !ONLY || ONLY.has(name))
    .sort();
}

/** 读风格中文名：README.md 首行（缺失回退目录名） */
function styleNameOf(type) {
  try {
    const first = fs.readFileSync(path.join(SKILLS_ROOT, type, 'README.md'), 'utf8').split(/\r?\n/)[0];
    // 部分首行是 markdown 标题（# 机甲科幻风格），剥掉 # 前缀
    return (first || '').trim().replace(/^#+\s*/, '') || type;
  } catch {
    return type;
  }
}

/** mixed 时按索引交替，保证全量跑下来男女比例均衡 */
function genderOf(index) {
  if (GENDER !== 'mixed') return GENDER;
  return index % 2 === 0 ? 'female' : 'male';
}

/**
 * 第 1 步：文本 LLM 生成人物提示词——调用方式对齐 generateAssetPrompt（assetPrompt.service.js）：
 * system=美术指导人设，assistant=该风格 art_character 技能约束，user=本次人物需求。
 * 不追加 CHARACTER_PROMPT_SUFFIX（那是三视图设定图规格，预览图用 PREVIEW_COMPOSITION_PROMPT 替代）。
 */
async function buildPreviewPrompt(userId, type, styleName, gender) {
  const zhGender = gender === 'male' ? '青年男性' : '青年女性';
  const system = '你是一名影视美术指导，擅长为角色/场景/道具编写高质量文生图提示词。';
  const assistant = [buildSystem(type, ['art_character'])];
  if (!assistant[0]) throw new Error('该风格缺少 art_prompt/art_character.md，无法约束人物生成');
  const prompt = `请根据下方资产信息，为该角色生成文生图提示词（中文），描述外貌、服饰、神态、风格。

要求：
- 风格='${styleName}'，该风格最具辨识度的视觉特征必须写进提示词
- 提示词应包含核心视觉特征（外貌/服饰/光影/氛围），简洁精确
- 人物所处的场景背景需符合该风格世界观
- 只输出提示词正文，不要解释、不要 JSON、不要标题

资产信息：
资产类型：角色
名称：风格展示人物
描述：${zhGender}，约 20-28 岁，气质鲜明，服饰与所处场景均符合该风格`;

  const { content } = await complete(userId, prompt, { system, assistant, temperature: 0.4, maxTokens: 4000 });
  const out = (content || '').trim().replace(/^```[a-zA-Z]*\s*|\s*```$/g, '').trim();
  if (!out) throw new Error('文本模型未返回人物提示词');
  // 构图规格前置（与 CHARACTER_PROMPT_SUFFIX 前置写法一致）
  return `${PREVIEW_COMPOSITION_PROMPT}\n\n${out}`;
}

async function main() {
  await sequelize.authenticate();
  // 模型配置以 admin 身份解析（admin 配置的共享模型全员可用；无 admin 则回退任意用户）
  const admin = await User.findOne({ where: { role: 'admin' }, order: [['id', 'ASC']] })
    || await User.findOne({ order: [['id', 'ASC']] });
  if (!admin) throw new Error('数据库中无可用用户，无法解析模型配置');

  const types = scanStyleTypes();
  if (ONLY) {
    const missing = [...ONLY].filter((k) => !fs.existsSync(path.join(SKILLS_ROOT, k)));
    if (missing.length) logger.warn(`--only 中不存在于磁盘的风格：${missing.join(', ')}`);
  }
  logger.info(`扫描到风格 ${types.length} 套（模型以用户 u${admin.id} 解析）${DRY_RUN ? '【dry-run】' : ''}，性别=${GENDER === 'mixed' ? '男女交替' : GENDER}`);

  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    const styleName = styleNameOf(type);
    const gender = genderOf(i);
    const outAbs = path.join(SKILLS_ROOT, type, 'images', 'preview.webp');

    // 默认增量：已有 preview.webp 则跳过，--force 才重新生成覆盖
    if (!FORCE && fs.existsSync(outAbs)) {
      skipped += 1;
      logger.info(`  [${i + 1}/${types.length}] - ${type}（${styleName}）已有 preview.webp，跳过（--force 强制重生成）`);
      continue;
    }

    if (DRY_RUN) {
      logger.info(`  [${i + 1}/${types.length}] ${type}（${styleName}，${gender}）→ ${path.relative(process.cwd(), outAbs)}`);
      continue;
    }
    try {
      const prompt = await buildPreviewPrompt(admin.id, type, styleName, gender);
      // 第 2 步：与角色生图同一入口调用图像模型（image.service 内部固定 16:9 高清出图）
      const url = await generateImage(admin.id, prompt, { aspect: '16:9' });
      const srcAbs = urlToPath(url);
      if (!srcAbs || !fs.existsSync(srcAbs)) throw new Error(`生成图不在本机：${url}`);
      // 第 3 步：原始高清图转 WebP 存 1.webp，再降采样为 16:9 480p 落盘 preview.webp（生成走高清，仅 preview 缩放）。
      // 注：无论远程返回 PNG/JPEG 字节，均经 sharp 转码保证 .webp 为真 WebP（分辨率不变）
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      await sharp(srcAbs).webp({ quality: 85 }).toFile(path.join(path.dirname(outAbs), '1.webp'));
      await sharp(srcAbs).resize(PREVIEW_W, PREVIEW_H, { fit: 'cover' }).webp({ quality: 80 }).toFile(outAbs);
      done += 1;
      logger.info(`  [${i + 1}/${types.length}] ✔ ${type}（${styleName}，${gender}）→ 1.webp 原图 + preview.webp ${PREVIEW_W}x${PREVIEW_H}`);
    } catch (e) {
      failed += 1;
      logger.warn(`  [${i + 1}/${types.length}] ✘ ${type}（${styleName}）失败，跳过：${e?.message || e}`);
    }
  }

  logger.info(`预览图生成完成：成功 ${done}，失败 ${failed}，跳过 ${skipped}${FORCE ? '（--force）' : ''}${DRY_RUN ? '（dry-run 未调用模型）' : ''}`);
  await sequelize.close();
  process.exit(failed > 0 && !DRY_RUN ? 1 : 0);
}

main().catch((e) => {
  logger.error('预览图生成脚本失败:', e);
  process.exit(1);
});
