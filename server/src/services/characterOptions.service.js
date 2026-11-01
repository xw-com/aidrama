import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import { CHARACTER_PROMPT_SUFFIX } from './ai/assetPrompt.service.js';

// ===== 角色自定义选项注册表（代码常量，单一事实源；预览图由 admin 触发 AI 生成） =====
// 字段约定：
//   group.key   分组 key（前端 i18n: charCreator.group.<key>）
//   group.zh    中文分组名（前端 i18n 缺失时的回退）
//   option.key  选项 key（i18n: charCreator.option.<group>.<key>；亦是预览图文件名）
//   option.zh   中文 label（GET 下发，作前端 i18n 缺失回退）
//   option.prompt 中文提示词片段（拼进角色设定图与预览图 prompt）
//   option.genders 适用性别；bust 组全组仅女性
export const OPTION_GROUPS = [
  {
    key: 'gender', zh: '性别', required: true,
    options: [
      { key: 'male', zh: '男', prompt: '男性', genders: ['male'] },
      { key: 'female', zh: '女', prompt: '女性', genders: ['female'] },
    ],
  },
  {
    key: 'hair', zh: '发型',
    options: [
      { key: 'male_short_neat', zh: '利落短发', prompt: '干净利落的短发，发丝分明', genders: ['male'] },
      { key: 'male_crew', zh: '板寸头', prompt: '极短的板寸发型，轮廓硬朗', genders: ['male'] },
      { key: 'male_slick', zh: '侧分背头', prompt: '梳理整齐的侧分背头，两侧渐变铲短', genders: ['male'] },
      { key: 'male_messy', zh: '凌乱微卷', prompt: '自然凌乱、微微卷翘的短发', genders: ['male'] },
      { key: 'male_curly', zh: '浓密卷发', prompt: '浓密有型的深色短卷发', genders: ['male'] },
      { key: 'male_mid_long', zh: '及肩中长发', prompt: '过耳及肩的中长发，微乱不羁', genders: ['male'] },
      { key: 'male_bun', zh: '顶髻束发', prompt: '头顶束起小髻、两侧利落', genders: ['male'] },
      { key: 'female_long_straight', zh: '长直发', prompt: '垂顺及腰的长直发', genders: ['female'] },
      { key: 'female_long_wavy', zh: '大波浪', prompt: '蓬松的大波浪长卷发', genders: ['female'] },
      { key: 'female_bob', zh: '齐肩波波头', prompt: '齐肩利落的波波头', genders: ['female'] },
      { key: 'female_lob', zh: '锁骨发', prompt: '及锁骨的中长发，发尾微微内扣', genders: ['female'] },
      { key: 'female_pixie', zh: '精灵短发', prompt: '利落干净的精灵超短发', genders: ['female'] },
      { key: 'female_pony', zh: '高马尾', prompt: '利落的高马尾', genders: ['female'] },
      { key: 'female_twin', zh: '双马尾', prompt: '高扎双马尾，青春灵动', genders: ['female'] },
      { key: 'female_bun', zh: '低发髻', prompt: '优雅的低发髻', genders: ['female'] },
      { key: 'female_bangs', zh: '空气刘海长发', prompt: '空气刘海配柔顺长发', genders: ['female'] },
      { key: 'female_half_up', zh: '半扎发', prompt: '上半部扎起、下半披散的半扎发', genders: ['female'] },
      { key: 'female_short_curly', zh: '复古短卷', prompt: '蓬松复古的短卷发', genders: ['female'] },
    ],
  },
  {
    key: 'hairColor', zh: '发色', sharedPreviewGender: 'female',
    options: [
      { key: 'black', zh: '乌黑', prompt: '乌黑发色，光泽健康' },
      { key: 'dark_brown', zh: '深棕', prompt: '深棕色发色' },
      { key: 'light_brown', zh: '浅棕', prompt: '浅棕色发色' },
      { key: 'blonde', zh: '金色', prompt: '自然金色发色' },
      { key: 'platinum', zh: '白金', prompt: '铂金白金发色' },
      { key: 'silver_gray', zh: '银灰', prompt: '银灰色发色' },
      { key: 'wine_red', zh: '酒红', prompt: '深酒红色发色' },
      { key: 'blue_black', zh: '蓝黑', prompt: '蓝黑色发色，冷调光泽' },
      { key: 'chestnut', zh: '栗色', prompt: '温润栗色发色' },
      { key: 'gradient', zh: '渐变染', prompt: '发尾渐变浅色的染发' },
    ],
  },
  {
    key: 'eyeColor', zh: '眼睛颜色', sharedPreviewGender: 'female',
    options: [
      { key: 'dark_brown', zh: '深棕', prompt: '深棕色眼眸' },
      { key: 'hazel', zh: '浅褐', prompt: '浅褐色眼眸' },
      { key: 'amber', zh: '琥珀', prompt: '琥珀色眼眸，通透有神' },
      { key: 'dark_green', zh: '墨绿', prompt: '墨绿色眼眸' },
      { key: 'lake_blue', zh: '湖蓝', prompt: '湖蓝色眼眸' },
      { key: 'gray_blue', zh: '灰蓝', prompt: '灰蓝色眼眸' },
      { key: 'deep_gray', zh: '深灰', prompt: '深灰色眼眸' },
      { key: 'violet', zh: '浅紫', prompt: '淡紫色眼眸' },
    ],
  },
  {
    key: 'faceShape', zh: '脸型', sharedPreviewGender: 'female',
    options: [
      { key: 'oval', zh: '鹅蛋脸', prompt: '标准鹅蛋脸，线条流畅' },
      { key: 'round', zh: '圆脸', prompt: '圆润饱满的脸型，亲和力强' },
      { key: 'square', zh: '方脸', prompt: '棱角分明的方脸，硬朗大气' },
      { key: 'heart', zh: '心形脸', prompt: '额头较宽、下巴尖俏的心形脸' },
      { key: 'oblong', zh: '长脸', prompt: '脸型偏长，轮廓清晰' },
      { key: 'melon_seed', zh: '瓜子脸', prompt: '下巴小巧的瓜子脸' },
      { key: 'high_cheek', zh: '高颧骨', prompt: '颧骨略高的立体脸型' },
    ],
  },
  {
    key: 'ethnicity', zh: '人种', sharedPreviewGender: 'female',
    options: [
      { key: 'east_asian', zh: '东亚', prompt: '东亚面孔' },
      { key: 'southeast_asian', zh: '东南亚', prompt: '东南亚面孔' },
      { key: 'european', zh: '欧洲裔', prompt: '欧洲裔面孔' },
      { key: 'african', zh: '非洲裔', prompt: '非洲裔面孔' },
      { key: 'latino', zh: '拉丁裔', prompt: '拉丁裔面孔' },
      { key: 'middle_eastern', zh: '中东', prompt: '中东面孔' },
      { key: 'south_asian', zh: '南亚', prompt: '南亚面孔' },
      { key: 'mixed_eur_asian', zh: '欧亚混血', prompt: '欧亚混血面孔，轮廓立体' },
    ],
  },
  {
    key: 'bodyType', zh: '身材', sharedPreviewGender: 'female',
    options: [
      { key: 'slender', zh: '纤瘦', prompt: '身形纤瘦修长' },
      { key: 'balanced', zh: '匀称', prompt: '身材匀称挺拔' },
      { key: 'athletic', zh: '健美', prompt: '肌肉线条清晰的健美身材' },
      { key: 'tall_slender', zh: '高挑', prompt: '高挑苗条的身形' },
      { key: 'plump', zh: '丰润', prompt: '体态丰润饱满' },
      { key: 'burly', zh: '壮硕', prompt: '魁梧壮硕的体格' },
    ],
  },
  {
    key: 'bust', zh: '胸', sharedPreviewGender: 'female',
    options: [
      { key: 'flat', zh: '平胸', prompt: '胸部平坦', genders: ['female'] },
      { key: 'moderate', zh: '适中', prompt: '胸部比例适中', genders: ['female'] },
      { key: 'full', zh: '丰满', prompt: '胸部丰满', genders: ['female'] },
      { key: 'voluptuous', zh: '丰腴', prompt: '胸部丰腴，曲线明显', genders: ['female'] },
    ],
  },
  {
    key: 'hip', zh: '臀', sharedPreviewGender: 'female',
    options: [
      { key: 'slim', zh: '平缓', prompt: '臀部线条平缓', genders: ['female'] },
      { key: 'moderate', zh: '适中', prompt: '臀部比例适中', genders: ['female'] },
      { key: 'round', zh: '圆润', prompt: '臀部圆润紧致', genders: ['female'] },
      { key: 'wide', zh: '宽臀', prompt: '臀部较宽，胯部线条明显', genders: ['female'] },
      { key: 'plump', zh: '肥臀', prompt: '臀部肥硕饱满，后侧曲线隆起明显', genders: ['female'] },
    ],
  },
  {
    key: 'legs', zh: '腿型', sharedPreviewGender: 'female',
    options: [
      { key: 'straight_long', zh: '笔直修长', prompt: '双腿笔直修长', genders: ['female'] },
      { key: 'toned', zh: '健实', prompt: '双腿健实有力，肌肉线条清晰', genders: ['female'] },
      { key: 'slender', zh: '纤细', prompt: '双腿纤细', genders: ['female'] },
      { key: 'proportionate', zh: '匀称', prompt: '双腿比例匀称', genders: ['female'] },
    ],
  },
  {
    key: 'personality', zh: '性格', sharedPreviewGender: 'female',
    options: [
      { key: 'gentle', zh: '温柔坚韧', prompt: '温柔坚韧，待人亲和' },
      { key: 'cold_outside', zh: '外冷内热', prompt: '外表清冷，内心炽热' },
      { key: 'sunny', zh: '阳光开朗', prompt: '阳光开朗，笑容明媚' },
      { key: 'calm', zh: '沉稳内敛', prompt: '沉稳内敛，处变不惊' },
      { key: 'playful', zh: '俏皮灵动', prompt: '俏皮灵动，古灵精怪' },
      { key: 'wise', zh: '睿智深沉', prompt: '睿智深沉，洞察人心' },
      { key: 'hotblooded', zh: '热血直率', prompt: '热血直率，敢作敢当' },
      { key: 'melancholic', zh: '忧郁文艺', prompt: '气质忧郁，文艺敏感' },
      { key: 'strong_willed', zh: '干练强势', prompt: '干练强势，气场十足' },
      { key: 'roguish', zh: '痞气幽默', prompt: '痞气幽默，不按常理出牌' },
    ],
  },
  {
    key: 'occupation', zh: '职业', sharedPreviewGender: 'female',
    options: [
      { key: 'detective', zh: '刑警', prompt: '职业为刑警，着装为干练的深色便衣夹克、长裤与战术靴' },
      { key: 'soldier', zh: '军官', prompt: '职业为现役军官，着装为笔挺军装' },
      { key: 'doctor', zh: '医生', prompt: '职业为医生，着装为白大褂与听诊器' },
      { key: 'lawyer', zh: '律师', prompt: '职业为律师，着装为修身西装' },
      { key: 'executive', zh: '企业高管', prompt: '职业为企业高管，着装为高级定制西装' },
      { key: 'journalist', zh: '记者', prompt: '职业为记者，着装为简约通勤装，挂相机' },
      { key: 'teacher', zh: '教师', prompt: '职业为教师，着装为知性得体的通勤装' },
      { key: 'scientist', zh: '科研人员', prompt: '职业为科研人员，着装为白色实验服' },
      { key: 'racer', zh: '赛车手', prompt: '职业为赛车手，着装为赛车服' },
      { key: 'chef', zh: '主厨', prompt: '职业为主厨，着装为白色厨师服' },
      { key: 'student', zh: '大学生', prompt: '身份为大学生，着装为清爽校园休闲装' },
      { key: 'swordsman', zh: '侠客', prompt: '身份为江湖侠客，着装为利落古装劲服' },
    ],
  },
];

// 【外貌特征】行内各分组的固定拼接次序（与用户勾选顺序无关）；personality/occupation 独立成行
const APPEARANCE_ORDER = ['gender', 'ethnicity', 'faceShape', 'hair', 'hairColor', 'eyeColor', 'bodyType', 'bust', 'hip', 'legs'];

const GROUP_MAP = new Map(OPTION_GROUPS.map((g) => [g.key, g]));
const GENDER_GROUP = OPTION_GROUPS[0];
const GENDER_MAP = new Map(GENDER_GROUP.options.map((o) => [o.key, o]));

// 预览图目录：复用 /skills 静态挂载（app.js 整目录递归服务），无需新增挂载
const CHAR_OPTION_ROOT = () => path.resolve(process.cwd(), 'skills', 'char_options');

export function findGroup(groupKey) {
  return GROUP_MAP.get(groupKey) || null;
}

export function findOption(groupKey, optionKey) {
  const g = GROUP_MAP.get(groupKey);
  if (!g) return null;
  return g.options.find((o) => o.key === optionKey) || null;
}

/**
 * 校验/规范化前端提交的选项：白名单（非法 key 直接忽略，防注入）+ 性别过滤
 * @param {Record<string,string>} selections 前端提交的 {groupKey: optionKey}
 * @returns {{ gender: 'male'|'female'|null, picks: Map<string, object> }}
 */
export function resolveSelections(selections = {}) {
  // 空值守卫须在解引用之前：默认参数只兜 undefined，客户端显式传 null 会 TypeError → 500
  if (!selections || typeof selections !== 'object') selections = {};
  const gender = selections.gender === 'male' || selections.gender === 'female' ? selections.gender : null;
  const picks = new Map();
  for (const g of OPTION_GROUPS) {
    if (g.key === 'gender') continue;
    const raw = selections[g.key];
    if (typeof raw !== 'string' || !raw) continue;
    const opt = g.options.find((o) => o.key === raw);
    if (!opt) continue; // 白名单外的 key 一律忽略
    if (gender && opt.genders && !opt.genders.includes(gender)) continue; // 与性别不符的选项丢弃
    picks.set(g.key, opt);
  }
  return { gender, picks };
}

/**
 * 拼装自定义角色设定图 prompt。
 * 顺序对齐换装路由惯例（asset.routes.js）：风格锚 → 角色设定图规格（CHARACTER_PROMPT_SUFFIX）→ 外貌/性格/职业/补充描述。
 * 自定义角色由人形外貌选项（性别/脸型/人种…）构成，必为单人人形，故恒注入设定图规格，无需 isSingleHumanCharacter 判定。
 */
export function buildCustomCharacterPrompt({ gender, picks }, freeText = '', styleName = '') {
  const parts = [];
  if (gender) parts.push(GENDER_MAP.get(gender).prompt);
  for (const gk of APPEARANCE_ORDER) {
    if (gk === 'gender') continue;
    const opt = picks.get(gk);
    if (opt) parts.push(opt.prompt);
  }
  const lines = [];
  if (parts.length) lines.push(`【外貌特征】${parts.join('，')}。`);
  const pers = picks.get('personality');
  if (pers) lines.push(`【性格气质】${pers.prompt}。`);
  const occ = picks.get('occupation');
  if (occ) lines.push(`【职业与着装】${occ.prompt}。`);
  const extra = String(freeText || '').trim().slice(0, 500);
  if (extra) lines.push(`【补充描述】${extra}`);
  return [styleName ? `【风格】${styleName}` : '', CHARACTER_PROMPT_SUFFIX, ...lines].filter(Boolean).join('\n\n');
}

/** 中文摘要（写 Asset.description，供资产卡片/搜索/AI 提取去重使用）；格式统一为「[类型]：[值]；」逐项排列 */
export function summarizeAppearance({ gender, picks }, freeText = '') {
  const items = [];
  if (gender) items.push(`性别：${GENDER_MAP.get(gender).zh}`);
  for (const gk of APPEARANCE_ORDER) {
    if (gk === 'gender') continue;
    const opt = picks.get(gk);
    if (opt) items.push(`${GROUP_MAP.get(gk).zh}：${opt.zh}`);
  }
  const pers = picks.get('personality');
  if (pers) items.push(`性格：${pers.zh}`);
  const occ = picks.get('occupation');
  if (occ) items.push(`职业：${occ.zh}`);
  const extra = String(freeText || '').trim().slice(0, 200);
  if (extra) items.push(`补充描述：${extra}`);
  return items.map((s) => `${s}；`).join('');
}

/** 默认角色名：按项目内已有「自定义角色 N」取最大序号 +1 */
export async function defaultAssetName(projectId) {
  const rows = await db.Asset.findAll({ where: { project_id: projectId, kind: 'character' }, attributes: ['name'] });
  let max = 0;
  for (const r of rows) {
    const m = /^自定义角色[\s·]*(\d+)$/.exec(String(r.name || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `自定义角色 ${max + 1}`;
}

/**
 * 选项预览图 prompt：写实人像、浅灰摄影棚背景、着装完整得体（体型类组仅作轮廓差异展示，非色情化）。
 * 发色组固定中性发型基底，隔离发型变量只让颜色变化。
 * 体型四组（胸/臀/身材/腿型）统一着紧身衣凸显轮廓；臀组背侧面45度视角（脸朝右后方）取中段约三分之一，胸组正面取上半身约二分之一。
 */
export function buildOptionPreviewPrompt(groupKey, option) {
  const group = GROUP_MAP.get(groupKey) || {};
  const genderKey = option.genders?.length === 1 ? option.genders[0] : (group.sharedPreviewGender || 'female');
  const genderText = genderKey === 'male' ? '男性' : '女性';
  let feature = option.prompt;
  if (groupKey === 'hairColor') {
    feature = `发型为${genderKey === 'male' ? '利落短发' : '及肩自然直发'}，${option.prompt}，头发光泽健康，色彩还原准确`;
  }
  let composition;
  let outfit;
  if (groupKey === 'personality') {
    composition = `构图：胸部以上半身特写，正面视角；神态气质：${option.prompt}`;
    outfit = '简洁素色圆领上衣';
  } else if (['gender', 'hair', 'hairColor', 'eyeColor', 'faceShape', 'ethnicity'].includes(groupKey)) {
    composition = '构图：胸部以上半身特写，正面视角，面部与发型清晰';
    outfit = '简洁素色圆领上衣';
  } else if (groupKey === 'hip') {
    // 臀部组：背侧面45度视角、脸朝右后方回望，构图取身体中段约三分之一（腰至大腿上部），突出臀部轮廓差异
    composition = '构图：背侧面45度视角（介于背面与侧面之间），角色斜背对镜头站立，头部回望、脸朝右后方、侧脸微微可见；画面取身体中段约三分之一范围（腰部至大腿上部），臀部轮廓居于画面中心、清晰可辨；仅用于展示体型轮廓差异的人像样图，画面端庄得体';
    outfit = '贴身的运动紧身衣与紧身长裤';
  } else if (groupKey === 'bust') {
    // 胸部组：正面视角，构图取身体上半段约二分之一（头至腰），突出胸部轮廓差异
    composition = '构图：正面视角，画面取身体约二分之一即上半身（头部至腰部）完整入镜，胸部轮廓清晰可辨；仅用于展示体型轮廓差异的人像样图，画面端庄得体';
    outfit = '贴身的运动紧身衣与紧身长裤';
  } else if (['bodyType', 'legs'].includes(groupKey)) {
    composition = '构图：全身标准立姿，从头到脚完整入镜；仅用于展示体型轮廓差异的人像样图，画面端庄得体';
    outfit = '贴身的运动紧身衣与紧身长裤';
  } else if (groupKey === 'occupation') {
    composition = '构图：全身标准立姿，从头到脚完整入镜';
    outfit = `按其职业身份着装：${option.prompt}`;
  } else {
    composition = '构图：胸部以上半身特写，正面视角';
    outfit = '简洁素色圆领上衣';
  }
  return [
    `写实人像摄影示例图。一位25岁左右的${genderText}东亚模特，${feature}。`,
    `${composition}。`,
    '背景与布光：纯浅灰色摄影棚背景，柔光均匀，单人居中构图，无道具。',
    `着装与姿态：${outfit}，姿态端庄自然；着装完整得体，严禁任何裸露、泳装或色情化表达。`,
    '画质：真实摄影质感，肤质细节清晰，85mm焦距人像镜头，平视视角。图像比例：16:9。画面中不要出现任何文字、水印、边框、UI元素。',
  ].join('\n');
}

// ===== 预览图落盘路径与 URL（mtime 版本号；缺失返回 null 由前端降级占位） =====

export function optionImagePaths(groupKey, optionKey) {
  const dir = path.join(CHAR_OPTION_ROOT(), groupKey);
  // 缩略图用 WebP（人像照片比 PNG 小一个数量级，93 张卡片弹窗首屏体积可控）；原图保留 PNG 4K
  return { dir, largePath: path.join(dir, `${optionKey}.png`), thumbPath: path.join(dir, `${optionKey}.thumb.webp`) };
}

function mtimeVersion(p) {
  try { return Math.round(fs.statSync(p).mtimeMs / 1000); } catch { return null; }
}

export function optionPreviewUrl(groupKey, optionKey, large = false) {
  const { thumbPath, largePath } = optionImagePaths(groupKey, optionKey);
  const p = large ? largePath : thumbPath;
  const v = mtimeVersion(p);
  if (!v) return null;
  const file = large ? `${optionKey}.png` : `${optionKey}.thumb.webp`;
  return `/skills/char_options/${groupKey}/${file}?v=${v}`;
}

/** 注册表下发（用户端弹窗/admin 列表共用）：分组 + 选项 + 预览图 URL（未生成为 null） */
export function listCharacterOptionGroups() {
  return OPTION_GROUPS.map((g) => ({
    key: g.key,
    zh: g.zh,
    required: !!g.required,
    options: g.options.map((o) => ({
      key: o.key,
      zh: o.zh,
      genders: o.genders || ['male', 'female'],
      preview: optionPreviewUrl(g.key, o.key, false),
      previewLarge: optionPreviewUrl(g.key, o.key, true),
    })),
  }));
}

/** 统计（admin 页头）：「已生成」以缩略图存在为准（缩略图是生成最后一步） */
export function getCharacterOptionStats() {
  let total = 0;
  let generated = 0;
  for (const g of OPTION_GROUPS) {
    for (const o of g.options) {
      total += 1;
      if (mtimeVersion(optionImagePaths(g.key, o.key).thumbPath)) generated += 1;
    }
  }
  return { total, generated, missing: total - generated };
}

/** 扫描缺失预览图的选项（批量生成用；每次现扫，幂等） */
export function scanMissingOptions() {
  const items = [];
  for (const g of OPTION_GROUPS) {
    for (const o of g.options) {
      if (!mtimeVersion(optionImagePaths(g.key, o.key).thumbPath)) items.push({ group: g, option: o });
    }
  }
  return items;
}
