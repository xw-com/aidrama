import { chatJSON, complete } from '../llm.service.js';
import { truncate } from './script.service.js';
import {
  resolveStyleKey, getStyleName, buildSystem, buildNarrativeSystem,
  resolveNarrativeKey, loadAdditionSkill, loadProductionSkill, loadRawPrompt,
} from '../artSkills.service.js';

/**
 * AI 把一集剧本生成分镜(片段)脚本
 * @returns 分镜片段数组 [{ title, prompt(画面描述+对白), narration(旁白), duration, asset_refs:[{type,id,name}] }]
 */
export async function generateStoryboard(userId, { episodeTitle, episodeContent, assets, style = '古偶唯美柔光', narrativeType, requirement = '', modelConfigId }) {
  const styleKey = resolveStyleKey(style);
  const styleName = getStyleName(styleKey);
  const narrativeKey = resolveNarrativeKey(narrativeType);

  // 以 system 注入：风格全局锚定(prefix) + 画风分镜技法 + 通用分镜表技法 + 叙事类型规划/分镜表技法
  const system = [
    '你是一名资深分镜导演，擅长把剧本拆解为镜头语言清晰、可直接用于AI视频生成的分镜脚本。生成的分镜提示词（含对白、旁白、系统提示）须保持剧本原文的语种，不得自行翻译或改写语种。',
  ].filter(Boolean).join('\n\n');

  const assistant = [
    buildSystem(styleKey, ['prefix', 'director_storyboard']),
    //buildNarrativeSystem(narrativeKey, ['director_storyboard_table_narrative']),
    loadAdditionSkill('lens-library'),
  ];

  // 资产清单(含真实 id)：供模型引用；同时建立服务端权威查找表，用于回填/校验真实 id，杜绝幻觉 id
  const lookup = { byId: new Map(), byTypeName: new Map(), byName: new Map() };
  const assetList = (assets || []).map((a) => {
    lookup.byId.set(a.id, a);
    lookup.byTypeName.set(`${String(a.kind || '').toLowerCase()}|${String(a.name || '').trim()}`, a);
    if (a.name) lookup.byName.set(String(a.name).trim(), a);
    // 别名同样纳入查找表（按名/类型+名），让模型用任意别名引用时都能解析到本资产
    for (const alias of Array.isArray(a.aliases) ? a.aliases : []) {
      const al = String(alias || '').trim();
      if (!al) continue;
      if (!lookup.byName.has(al)) lookup.byName.set(al, a);
      const tk = `${String(a.kind || '').toLowerCase()}|${al}`;
      if (!lookup.byTypeName.has(tk)) lookup.byTypeName.set(tk, a);
    }
    const role = a.role_tag ? `（${a.role_tag}）` : '';
    const aka = Array.isArray(a.aliases) && a.aliases.filter(Boolean).length ? `（又名：${a.aliases.filter(Boolean).join('、')}）` : '';
    // 本集服饰不写入提示词：画面着装由视频生成阶段的服饰参考图保证（segmentVideo 按集换图）
    return `- id=${a.id} | type=${a.kind} | ${a.name}${role}${aka}：${(a.description || '').slice(0, 40)}`;
  }).join('\n');

  // 用户「本次要求」（确认框填写/快捷输入）：与既有约束同级的 `>` 列表注入，标注优先遵循
  const reqBlock = requirement
    ? `\n[本次要求（请优先遵循，与「语种保持」冲突时以本要求为准）]\n> ${String(requirement).slice(0, 800).trim().replace(/\n/g, '\n> ')}\n`
    : '';

  const prompt = `请把下面这一集剧本拆解为「分镜表」。先按「镜头（场景）」分组，再按时长不超过12秒的标准拆分为场景片段，然后每个场景片段拆分为若干「分镜」。

场景片段拆分标准：
 - 对话+旁白+系统提示等语言文本长度不超过3字/秒，确保分镜时长容得下对白

提示词使用规则：
 - 运动镜头可叠加多个，但至少1个
 - 场景片段里如果有打斗动作，请增强打斗动作的细节描述
 - 场景片段里如果有对话，任何分镜里就不要出现旁白或心理活动及系统提示

分镜提示词标准公式：
 - [x秒-x秒]: [运镜方式] + [景别] + [主体] + [核心动作] + [对话/旁白] + [环境/道具/背景]
 - 对话+旁白+系统提示等语言文本等每3字占用一秒

[限制条件]
> 每个场景片段总时长不超过 15 秒
> 请保证每一时间段单独占一行
${reqBlock}
### 示例 1：雨中信封（情绪向）
0-4秒：固定机位，中景，男主站在雨中，低头看着手中的信封，雨水打湿头发，镜头焦点锁定信封。环境音效：雨声，远处汽车驶过的声音。
4-9秒：缓慢向前推进，从全景推至特写，[男主]缓缓抬起头，向[女主]说：“从此一别两宽，再见已是路人。”，眼神从迷茫转为坚定，背景逐渐虚化。
9-12秒：缓慢向后拉开，男主转身走进雨幕，身影逐渐变小，最终消失在街道尽头。

分镜编写要点
1. **时间连续性**：各时间段必须首尾相接
2. **动作连贯**：上一段的结束动作是下一段的起始状态
3. **焦点明确**：每个时间段指定一个视觉焦点
4. **限制条件**：必要时附加限制（如"背景虚化""镜头焦点锁定XX"）
5. **情绪递进**：应有情绪变化弧线（如迷茫→坚定→释然）
6. **语种保持**：分镜提示词正文（含对白、旁白、系统提示）的语种须与集正文原文一致，不得翻译或改写语种
7. **语速控制**: 注意对白+旁白+系统提示等语言文本长度不超过时长，确保分镜时长容得下对白。
8. **声音保持**: 不要出现非必要的旁白。如果全程没有对话，则提示适合的环境声音，格式：环境音效: （适合当前环境的音效），如果没有适合的音效，则提示“无环境音效”。

每个场景输出字段：
- title: 提炼的场景标题，最长28字
- scene_no: 场景号(整数)
- shot_no: 场景片段号(字符串, 如 "1-1")
- scene_script: 该场景原始剧本
- duration: 总时长（秒）。
- video_prompt: 用于视频生成的提示词(融合景别/构图/运镜/光影/画面描述, 100~800字; 采用三段式：【视频风格】(风格='${styleName}'、8k分辨率，画质锁定词、禁止画外字幕/水印/UI 文字) (双换行)【画面】(分镜列表)(双换行)【光影】(光源/色调/明暗)。若含角色资产，末尾追加一句"保持 <出现的角色名> 的面部特征、发型和服装与参考图完全一致。严格禁止出现背景音乐；严格禁止出现字幕或画面文字。"(双换行)"
- asset_refs: 本镜"可见"的资产 [{type,id,name}], 从下方列表复制准确 id/type/name; 画面出现的每个角色(含背影/局部)与场景都须引用, 不得编造列表外资产

可引用资产列表：
${assetList || '（无）'}

集标题：${episodeTitle}
集正文：
"""
${truncate(episodeContent, 6000)}
"""

只输出 JSON：
{ "segments":[ { title: "", "scene_no":1, "shot_no":"1-1", "scene_script":"", "duration":5, "video_prompt":"", "asset_refs":[{"type":"character","id":0,"name":""}] } ] }`;

  const data = await chatJSON(userId, prompt, { system, assistant, temperature: 0.6, maxTokens: 80000, modelConfigId });
  const raw = Array.isArray(data.segments) ? data.segments : (Array.isArray(data) ? data : []);
  const mapped = raw.map((s, i) => ({
    idx: i + 1,
    scene_no: numOrNull(s.scene_no ?? s.sceneNo),
    shot_no: strOr(s.shot_no ?? s.shotNo, 16),
    scene_script: strOr(s.scene_script ?? s.sceneScript, 6000),
    title: strOr(s.title, 255) || `分镜${String(i + 1).padStart(2, '0')}`,
    duration: resolveDuration(s.duration, s.video_prompt),
    video_prompt: strOr(s.video_prompt ?? s.videoPrompt, 6000),
    asset_refs: resolveAssetRefs(s.asset_refs, lookup),
  }));
  return mapped;
}

/**
 * AI 为单个分镜生成高质量视频提示词（Seedream Mode A + 三段式）
 * 上下文：风格 + 导演要求(directorRequirements)。不附带任何剧本参考（本集剧本/场景原文以外的全文均不进入）。
 * @returns 提示词文本（写入 segment.video_prompt）
 */
export async function generateSegmentPrompt(userId, { segment, assets, style = '古偶唯美柔光', narrativeType, directorRequirements = '', requirement = '', modelConfigId }) {
  const styleKey = resolveStyleKey(style);
  const styleName = getStyleName(styleKey);
  const narrativeKey = resolveNarrativeKey(narrativeType);

  const system = [
    '你是一名视频分镜提示词工程师，擅长把场景片段字段转化为可直接用于多模态生成视频的高质量分镜提示词（直接使用资产真实名称，输出语种须与场景剧本原文保持一致，不得自行翻译或改写语种）。',
  ].filter(Boolean).join('\n\n');

  const assistant = [
    buildSystem(styleKey, ['prefix', 'director_storyboard']),
    loadAdditionSkill('lens-library'),
  ];

  // 关联资产按名称列出（与传入 assets 顺序一致），供模型在正文里直接使用真实名称；
  // 本集服饰不写入提示词：画面着装由视频生成阶段的服饰参考图保证（segmentVideo 按集换图）
  const refs = assets || [];
  const refPrefix = refs.map((a) => `${a.name}（${kindWord(a.kind)}）`).join(' ');

  const fields = [
    `分镜号：${segment.shot_no || ''}`,
    `场景剧本：${segment.scene_script || ''}`,
    `时长：${segment.duration || ''}秒`,
    `关联资产（正文请直接使用以下真实名称）：${refPrefix || '（无）'}`,
  ].join('\n');

  const ctxParts = [];
  if (directorRequirements) ctxParts.push(`【导演要求（必须遵循的整体约束）】\n${String(directorRequirements).slice(0, 1500)}`);
  if (requirement) ctxParts.push(`【本次要求（请优先遵循）】\n${String(requirement).slice(0, 800)}`);
  const context = ctxParts.length ? `\n\n${ctxParts.join('\n\n')}` : '';

  //在第1个时间段里面添加一句简短的旁白

  const prompt = `请根据下场景片段字段，生成一条视频提示词。每个场景片段拆分为若干「分镜」。

分镜生成规则：
 - 运动镜头可叠加多个，但至少1个
 - 片段里如果有打斗动作，请增强打斗动作的细节描述
 - 片段里如果有对话，任何分镜里就不要出现旁白或心理活动及系统提示

分镜提示词标准公式：
 - [x秒-x秒]: [运镜方式] + [景别] + [主体] + [核心动作] + [对话/旁白] + [环境/道具/背景] 
 - 请保证每一分镜单独占一行

### 示例 1：雨中信封（情绪向）
0-4秒：固定机位，中景，[男主]站在雨中，低头看着手中的信封，雨水打湿头发，镜头焦点锁定信封。环境音效：雨声，远处汽车驶过的声音。
4-9秒：缓慢向前推进，从全景推至特写，[男主]缓缓抬起头，向[女主]说：“从此一别两宽，再见已是路人。”，眼神从迷茫转为坚定，背景逐渐虚化。
9-12秒：缓慢向后拉开，男主转身走进雨幕，身影逐渐变小，最终消失在街道尽头。

分镜编写要点
1. **时间连续性**：各时间段必须首尾相接
2. **动作连贯**：上一段的结束动作是下一段的起始状态
3. **焦点明确**：每个时间段指定一个视觉焦点
4. **限制条件**：必要时附加限制（如"背景虚化""镜头焦点锁定XX"）
5. **情绪递进**：应有情绪变化弧线（如迷茫→坚定→释然）
6. **语种保持**：分镜提示词正文（含对白、旁白、系统提示）的语种须与集正文原文一致，不得翻译或改写语种
7. **语速控制**: 注意对白+旁白+系统提示等语言文本长度不超过时长，确保分镜时长容得下对白。
8. **声音保持**: 不要出现非必要的旁白。如果全程没有对话或旁白，则提示适合的环境声音，格式：环境音效: （适合当前环境的音效），如果没有适合的音效，则提示“无环境音效”。

要求：
- 保持剧本原文语种：提示词正文（含对白、旁白、系统提示及心理活动）的语种须与场景剧本原文一致，不得翻译或改写语种
- 正文中角色/场景/道具一律直接使用其真实名称（取自上方关联资产列表），严禁使用占位词 name/名称/资产名
- 采用三段式：【用于视频生成的提示词(融合景别/构图/运镜/光影/画面描述, 100~800字; 采用三段式：【视频风格】(风格='${styleName}'、8k分辨率，画质锁定词、禁止画外字幕/水印/UI 文字) (双换行)【画面】(分镜列表)(双换行)【光影】(光源/色调/明暗)。若含角色资产，末尾追加一句"保持 <出现的角色名> 的面部特征、发型和服装与参考图完全一致。严格禁止出现背景音乐；严格禁止出现字幕或画面文字。"(双换行)"
- 若给出导演要求，必须在画面/光影/风格中体现其约束
- 只输出提示词正文，不要解释、不要 JSON、不要分镜标题

分镜字段：
${fields}${context}`;

  const { content } = await complete(userId, prompt, { system, assistant, temperature: 0.6, maxTokens: 52000, modelConfigId });
  let out = (content || '').trim();
  out = out.replace(/^```[a-zA-Z]*\s*|\s*```$/g, '').trim(); // 去除可能的 markdown 围栏
  return out;
}

/**
 * 组合视频生成所用 prompt：镜头视频提示词(video_prompt) + 固定全局约束。
 * - video_prompt 主体由 generateSegmentPrompt 预先生成（已融合画面/对白/光影、含三段式结构）；
 * - 追加若干全局生成约束（音效/同框/朝向/收尾节奏）。
 */
export function composeVideoPrompt(segment) {
  const seg = segment || {};
  const vp = strOr(seg.video_prompt, 6000).trim();
  const parts = [];
  if (vp) parts.push(vp);
  parts.push('不允许同一画面里出现相同的人物或形象');
  parts.push('当对话内容中出现其他角色时，讲话者要面对这个角色');
  parts.push('分镜结尾处，画面要有收尾节奏感，不能突然结束');
  parts.push('规避伪影与风格偏差，杜绝低画质，确保画面清晰、干净、真实、自然');
  parts.push('排除画质与结构崩坏，杜绝画面残缺、断裂、错位、重影、模糊、噪点、锯齿、拉伸、变形、畸变、扭曲、破碎等问题');
  return parts.join('\n\n');
}

function kindWord(kind) {
  return { character: '角色', scene: '场景', prop: '道具', material: '素材', video: '视频' }[kind] || '资产';
}

export function clamp(v, min, max) {
  v = Number(v) || min;
  return Math.max(min, Math.min(max, v));
}

// 计入停顿余量的标点（中英文）
export const PAUSE_PUNCT = /[，。！？；：、…—,.!?;]/g;

/**
 * 按台词文本长度估算「念完所需」时长(秒)，用于保证分镜时长容得下对白。
 * 规则：保守语速 ~6 字/秒 + 标点停顿 + 1s 安全余量。
 * 从 text 中抽取"会被念出来"的正文：
 *  - video_prompt 的对白格式（[角色名]…说/道/喊："台词"）→ 取引号内的台词（兼容 " " 「」 『』）；
 *  - 兼容旧 "对白：角色：台词" 行式。
 * @param {string} text 综合文本（一般为 video_prompt，可并上 scene_script）
 * @returns 所需秒数（向上取整）；无台词返回 0（交由模型时长兜底）
 */
export function estimateDurationFromText(text) {
  const spoken = [];
  const src = String(text || '');
  // 1) 引号内台词（video_prompt 对白格式）
  const re = /"([^"]*)"|“([^”]*)”|「([^」]*)」|『([^』]*)』/g;
  let m;
  while ((m = re.exec(src))) {
    const line = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (line) spoken.push(line);
  }
  // 2) 兼容旧式 "对白：角色：台词" 行
  for (const line of src.split(/\r?\n/)) {
    const dm = line.match(/^\s*对白[:：]\s*[^:：]+[:：]\s*(.+)$/);
    if (dm) spoken.push(dm[1]);
  }
  const joined = spoken.join('').replace(/\s/g, '');
  if (!joined) return 0;
  const pauses = (joined.match(PAUSE_PUNCT) || []).length;
  return Math.ceil(joined.length / 6 + pauses * 0.1 + 1);
}

/**
 * 综合模型给出时长与「按台词估算的最小时长」取较大值，再 clamp 到 [2, 15]。
 * 确保时长既尊重模型判断，又不会短到容不下对白；无台词时回落到模型时长(缺省 5)。
 */
export function resolveDuration(rawDuration, text) {
  const model = Number(rawDuration);
  const minDur = estimateDurationFromText(text);
  const base = minDur > 0 ? Math.max(model || 0, minDur) : (model || 5);
  return clamp(base, 2, 15);
}

function strOr(v, max) {
  if (v == null) return '';
  const s = String(v).trim();
  return max ? s.slice(0, max) : s;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把模型返回的 asset_refs 解析为服务端权威的 [{type,id,name}]：
 * 优先按 id 命中，回退 type+name，再回退 name；命中失败(幻觉/拼写偏差)的项直接丢弃。
 * type/id/name 一律取自数据库资产记录，保证下游可凭 id 稳定关联主体资产。
 */
function resolveAssetRefs(refs, lookup) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  const seen = new Set();
  for (const r of refs) {
    let asset = null;
    if (r && typeof r === 'object') {
      if (r.id != null && r.id !== '') asset = lookup.byId.get(Number(r.id));
      if (!asset && r.name) asset = lookup.byTypeName.get(`${String(r.type || '').toLowerCase()}|${String(r.name).trim()}`);
      if (!asset && r.name) asset = lookup.byName.get(String(r.name).trim());
    } else if (typeof r === 'string') {
      asset = lookup.byName.get(r.trim());
    }
    if (asset && !seen.has(asset.id)) {
      seen.add(asset.id);
      out.push({ type: asset.kind, id: asset.id, name: asset.name });
    }
  }
  return out;
}
