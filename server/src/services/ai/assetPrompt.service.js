import { complete } from '../llm.service.js';
import { resolveStyleKey, getStyleName, buildSystem } from '../artSkills.service.js';

// 角色（character）类型专用补充约束：在 LLM 生成的提示词前追加，统一角色设定图的画面规格
// 提取资产与生成提示词两条流程共用，保证角色设定图规格一致。
// 注意：这是「单人人形角色」的设定图规格，仅对单人人形角色注入（见 isSingleHumanCharacter），群像/动物等不追加
export const CHARACTER_PROMPT_SUFFIX = '左区：角色正脸特写，面部占满左区，五官 / 发型 / 配饰清晰，无身体入镜、无遮挡变形；右区：标准角色设定三视图，横向依次排列正视图、侧视图和背视图，三个视图严格呈现正视、侧视和背视，从头到脚完整无遮挡；核心约束：特写与三视图为同一角色，五官 / 服装 / 配饰 / 体态 100% 一致；右区尺寸：三视图角色高度画面高度的 80%，三视图高度统一；无多余元素的浅灰色背景，角色无阴影；超高清分辨率，统一85mm焦距，无畸变，角色无动作，平视；中性表情（无喜怒哀乐），眼神平静，自然站立，双手自然下垂，空手（无手持物），身上无任何背负物（无背包/无武器背负）；搭配适合服饰的鞋子。图像比例：16:9';

// ===== 单人人形角色判定：决定是否注入 CHARACTER_PROMPT_SUFFIX =====
// AI 提取（extract.service）、AI 润色提示词与服饰换装生图（asset.routes）共用，保证口径一致。
// 判定优先级：
//   1) asset.meta.singleHuman 显式布尔（AI 提取时由大模型逐角色判定并落库）最准，直接采用；
//   2) 否则按名称/描述/角色定位/提示词 + extraText 做关键词启发式兜底（手动创建的资产无标记）：
//      命中排除词 → 非单人人形；未命中 → 默认视为单人人形（普通角色保持原有注入行为）。
// 词表只收不易误伤的复合词：马/龙/鹿/狐等单字动物名常入人名（马文才/龙傲天）与成语（小鹿乱撞），刻意不收单字。
const NON_SINGLE_HUMAN_WORDS = [
  // 群像/多人
  '群像', '群体', '众人', '多人', '人群', '一群', '一队', '队伍', '合影', '全家福',
  '双人', '两人', '二人', '三人', '四人', '五人', '六人', '七人', '八人', '九人', '十人', '俩',
  '夫妇', '夫妻', '情侣', '双胞胎', '三胞胎', '兄弟', '兄妹', '姐弟', '姐妹', '母子', '母女', '父子', '父女', '祖孙', '师徒', '群演',
  '组合', '乐队', '乐团', '舞团', '合唱团', '战队', '天团', '偶像团体',
  // 动物/非人生物（常见妖兽/神兽复合词）
  '动物', '野兽', '猛兽', '妖兽', '灵兽', '神兽', '凶兽', '魔兽', '异兽', '瑞兽', '坐骑', '灵宠', '宠物', '萌宠',
  '老虎', '老鼠', '狮子', '大象', '老鹰', '猫头鹰', '乌鸦', '麻雀', '喜鹊', '夜莺', '企鹅',
  '猫咪', '小猫', '野猫', '橘猫', '黑猫', '白猫', '小狗', '野狗', '猎犬', '柴犬', '柯基',
  '狐狸', '白狐', '灵狐', '九尾狐', '灰狼', '野狼', '白狼', '骏马', '战马', '汗血宝马', '马驹',
  '梅花鹿', '麋鹿', '驯鹿', '骆驼', '斑马', '长颈鹿', '熊猫', '北极熊', '灰熊', '考拉', '树袋熊',
  '海豚', '鲸鱼', '鲨鱼', '金鱼', '鲤鱼', '乌龟', '海龟', '青蛙', '蟒蛇', '蜘蛛', '蝎子', '蜜蜂', '蝴蝶',
  '蛟龙', '巨龙', '恶龙', '魔龙', '火龙', '飞龙', '龙王', '神龙', '应龙', '龙族', '凤凰', '朱雀', '玄武', '白虎', '麒麟', '貔貅', '鲲鹏',
  // 非人形造物
  '机器人', '机甲', '载具', '战车',
];
// 英文兜底（\b 全词匹配，避免误伤 foxhound/bearing 等派生词）
const NON_SINGLE_HUMAN_EN_RE = new RegExp(
  `\\b(?:${[
    'crowd', 'group portrait', 'group of', 'a pair of', 'duo', 'trio', 'quartet',
    'cat', 'kitten', 'dog', 'puppy', 'horse', 'tiger', 'lion', 'elephant', 'eagle', 'wolf', 'fox',
    'dragon', 'bird', 'owl', 'rabbit', 'panda', 'bear', 'deer', 'snake', 'dolphin', 'whale', 'shark',
    'robot', 'mecha', 'vehicles?', 'creatures?',
  ].join('|')})\\b`,
  'i',
);

/**
 * 判断角色资产是否为「单人人形角色」（角色设定图规格仅对此类角色注入）
 * @param {object} asset 资产（Sequelize 实例或普通对象，取 name/description/role_tag/prompt/meta）
 * @param {string} [extraText] 额外参与判定的文本（如本次要求 requirement）
 * @returns {boolean}
 */
export function isSingleHumanCharacter(asset, extraText = '') {
  if (!asset) return true;
  // 1) AI 提取落库的显式标记最准
  const flag = asset.meta?.singleHuman;
  if (typeof flag === 'boolean') return flag;
  // 2) 文本启发式兜底
  const text = [asset.name, asset.description, asset.role_tag, asset.prompt, extraText]
    .map((s) => String(s || '')).join('\n');
  if (!text.trim()) return true;
  if (NON_SINGLE_HUMAN_WORDS.some((w) => text.includes(w))) return false;
  if (NON_SINGLE_HUMAN_EN_RE.test(text)) return false;
  return true;
}

// 场景/道具类型专用补充约束：画面为纯环境/物品呈现，不得出现任何人物和动物
// 提取资产与生成提示词两条流程共用，保证场景与道具图规格一致
export const SCENE_PROP_PROMPT_SUFFIX = '纯场景/物品呈现，画面中不得出现任何人物和动物（无人物、无动物、无角色身影、无局部肢体）';

const KIND_PROMPT_MAP = {
  character: {
    label: '角色',
    skill: 'art_character',
    instruction: '为该角色生成文生图提示词（中文），描述外貌、服饰、神态、风格',
  },
  scene: {
    label: '场景',
    skill: 'art_scene',
    instruction: '为该场景生成文生图提示词（中文），含时间/天气/氛围、空间布局、风格，画面中不得出现任何人物和动物',
  },
  prop: {
    label: '道具',
    skill: 'art_prop',
    instruction: '为该道具生成文生图提示词（中文），描述材质、细节、用途、风格，画面中不得出现任何人物和动物',
  },
  material: {
    label: '素材',
    instruction: '为该素材生成文生图提示词，描述视觉特征、风格',
  },
};

/**
 * AI 生成资产提示词
 * @param {number} userId
 * @param {{ asset: object, style: string }} param1
 * @returns 提示词文本（写入 asset.prompt）
 */
export async function generateAssetPrompt(userId, { asset, style = '古偶唯美柔光', modelConfigId, requirement = '' }) {
  const styleKey = resolveStyleKey(style);
  const styleName = getStyleName(styleKey);
  const kindInfo = KIND_PROMPT_MAP[asset.kind] || KIND_PROMPT_MAP.material;
  // 注入该风格的全局锚定(prefix) + 按资产类型加载对应的角色/场景/道具提示词约束
  //const skillNames = ['prefix'];
  const skillNames = [];
  if (kindInfo.skill) skillNames.push(kindInfo.skill);
  const system = [
    '你是一名影视美术指导，擅长为角色/场景/道具编写高质量文生图提示词。',
  ].filter(Boolean).join('\n\n');
  const assistant = [buildSystem(styleKey, skillNames)];

  const parts = [
    `资产类型：${kindInfo.label}`,
    `名称：${asset.name}`,
  ];
  if (asset.description) parts.push(`描述：${asset.description}`);
  if (asset.role_tag) parts.push(`角色定位：${asset.role_tag}`);

  const reqLine = requirement ? `\n- 用户本次要求（请优先遵循）：${String(requirement).slice(0, 800)}` : '';

  const prompt = `请根据下方资产信息，${kindInfo.instruction}。

要求：
- 风格='${styleName}'，构图/光影/氛围须与该风格一致
- 提示词应包含核心视觉特征（外貌/服饰/材质/光影/氛围），简洁精确
- 只输出提示词正文，不要解释、不要 JSON、不要标题${reqLine}

资产信息：
${parts.join('\n')}`;

  const { content } = await complete(userId, prompt, { system, assistant, temperature: 0.4, maxTokens: 36000, modelConfigId });
  let out = (content || '').trim();
  out = out.replace(/^```[a-zA-Z]*\s*|\s*```$/g, '').trim();
  // 角色类型：仅单人人形角色在提示词头部追加统一的角色设定图约束（群像/动物等不追加），再入库
  if (asset.kind === 'character' && isSingleHumanCharacter(asset, requirement)) {
    out = `${CHARACTER_PROMPT_SUFFIX}\n\n${out}`;
  }
  // 场景/道具类型：在 LLM 提示词后追加"不得出现任何人物和动物"约束，再入库
  if (asset.kind === 'scene' || asset.kind === 'prop') {
    out = `${out}\n\n${SCENE_PROP_PROMPT_SUFFIX}`;
  }
  return out;
}
