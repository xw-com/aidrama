import { chatJSON } from '../llm.service.js';
import { truncate } from './script.service.js';
import { resolveStyleKey, getStyleName, buildSystem } from '../artSkills.service.js';
import { CHARACTER_PROMPT_SUFFIX, SCENE_PROP_PROMPT_SUFFIX, isSingleHumanCharacter } from './assetPrompt.service.js';

/**
 * AI 从剧本文本中提取主体资产：角色 / 场景 / 道具
 * 返回 { characters:[], scenes:[], props:[] }
 * 每项：{ name, description, prompt(用于生图), role_tag }
 */
export async function extractAssets(userId, scriptText, style = '古偶唯美柔光', opts = {}) {
  const styleKey = resolveStyleKey(style);
  const styleName = getStyleName(styleKey);

  // 以 system 注入该风格的全局锚定(prefix) + 角色/场景/道具提示词约束
  const system = '你是一名影视美术指导与编剧助理，擅长从剧本中提炼可视觉化的角色/场景/道具，并为每个对象编写高质量的文生图提示词。';

  const assistant = [buildSystem(styleKey, ['prefix', 'art_character', 'art_scene', 'art_prop'])];

  const prompt = `请阅读下面的剧本，提取其中的"角色""场景""道具"三类主体资产。

要求：
1. 角色(characters)：列出所有有名字或重要角色。给出 name、description(外貌/性格/服装,30-80字)、role_tag(主角/配角/群演)、prompt(用于AI生图的英文+中文混合提示词，描述外貌、服饰、神态、风格='${styleName}')。另给出 single_human(布尔)：是否为「单人人形角色」——单一人类或类人形态的角色为 true；群像、多人组合、动物、妖兽/神兽、机器人等非单人人形为 false。
2. 场景(scenes)：列出主要场景地点。给出 name、description、prompt(场景生图提示词，含时间/天气/氛围，风格='${styleName}', 画面中不得出现任何人物和动物)。
3. 道具(props)：关键道具。给出 name、description、prompt(道具特写生图提示词, 风格='${styleName}'，画面中不得出现任何人物和动物)。
4. description 只描述对象本身（角色：外貌/性格/服装；场景：地点/氛围；道具：材质/外观），严禁出现画幅比例（如 9:16、16:9）、竖屏/横屏/横竖版、构图、分辨率、焦距等任何画面规格信息；
5. 只输出 JSON，结构：
{
  "characters":[{"name":"","description":"","role_tag":"","prompt":"","single_human":true}],
  "scenes":[{"name":"","description":"","prompt":""}],
  "props":[{"name":"","description":"","prompt":""}]
}

剧本：
"""
${truncate(scriptText, 10000)}
"""`;

  const data = await chatJSON(userId, prompt, { system, assistant, temperature: 0.3, maxTokens: 80000, modelConfigId: opts.modelConfigId });
  return {
    // 角色类型：仅单人人形角色在提示词前追加统一的角色设定图约束（与 generateAssetPrompt 保持一致）；
    // 大模型的 single_human 判定最准，缺省时 isSingleHumanCharacter 内部走关键词启发式兜底
    characters: normalize(data.characters).map((c) => ({
      ...c,
      prompt: isSingleHumanCharacter({ ...c, meta: { singleHuman: c.single_human } })
        ? `${CHARACTER_PROMPT_SUFFIX}\n\n${c.prompt}`
        : c.prompt,
    })),
    // 场景/道具类型：在 LLM 提示词后追加"不得出现任何人物和动物"约束（与 generateAssetPrompt 保持一致）
    scenes: normalize(data.scenes).map((s) => ({ ...s, prompt: `${s.prompt}\n\n${SCENE_PROP_PROMPT_SUFFIX}` })),
    props: normalize(data.props).map((p) => ({ ...p, prompt: `${p.prompt}\n\n${SCENE_PROP_PROMPT_SUFFIX}` })),
  };
}

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && (x.name || x.title))
    .map((x) => ({
      name: String(x.name || x.title).slice(0, 128),
      description: stripAspectFromDesc(String(x.description || x.desc || '')).slice(0, 1000),
      prompt: String(x.prompt || x.image_prompt || x.description || '').slice(0, 2000),
      role_tag: x.role_tag || '',
      // 「单人人形角色」判定（仅角色有）：布尔透传，缺省 undefined → 注入时走关键词启发式兜底
      ...(typeof x.single_human === 'boolean' ? { single_human: x.single_human } : {}),
    }));
}

// description 是给人看的文字说明；画幅/构图等画面规格只允许出现在生图 prompt 里。
const KNOWN_RATIOS = new Set([
  '1:1', '2:1', '1:2', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4',
  '9:16', '16:9', '9:21', '21:9', '10:16', '16:10', '18:9', '9:18',
]);

function stripAspectFromDesc(text) {
  let s = String(text || '');
  if (!s) return s;
  // 「画幅比例 9:16」「图像比例：16:9」「宽高比为 3:4」「竖屏 9:16」（词在前，比在后）。
  // 前缀允许带 0-2 个汉字（图像/画面/显示…比例），词表长词放前避免只吞一半
  s = s.replace(/[（(]?\s*(?:[一-鿿]{0,2})?(?:画幅比例|宽高比例?|长宽比例?|纵横比例?|画幅|宽高比|长宽比|纵横比|比例|竖屏|横屏|竖版|横版)\s*[为:：]?\s*\d{1,2}\s*[:：]\s*\d{1,2}\s*(?:画幅|比例|构图|格式)?\s*[）)]?/g, ' ');
  // 「9:16 竖屏」「16:9 构图」（比在前，词在后）
  s = s.replace(/\d{1,2}\s*[:：]\s*\d{1,2}\s*(?:画幅|比例|构图|格式|横屏|竖屏|横版|竖版|横幅|竖幅)/g, ' ');
  // 孤立的常见画幅比（白名单匹配，避免误伤「下午5:30」这类时间）
  s = s.replace(/\d{1,2}\s*[:：]\s*\d{1,2}/g, (m) => (KNOWN_RATIOS.has(m.replace(/\s/g, '').replace(/：/g, ':')) ? ' ' : m));
  // 「竖屏构图」「横版画幅」；括号里孤立的「(竖屏)」。「竖屏手机」这类实体描述不受影响
  s = s.replace(/(?:竖屏|横屏|竖版|横版|竖幅|横幅)\s*(?:构图|画幅|比例|格式)/g, ' ');
  s = s.replace(/[（(]\s*(?:竖屏|横屏|竖版|横版|竖幅|横幅)\s*[）)]/g, ' ');
  // 清理清理后遗留的连续标点/首尾分隔符/句首「的」
  return s.replace(/\s{2,}/g, ' ').replace(/[,，、;；]\s*[,，、;；]+/g, '，').replace(/^[\s，,、;；的]+|[\s，,、;；]+$/g, '').trim();
}
