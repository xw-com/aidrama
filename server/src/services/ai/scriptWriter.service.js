/**
 * 剧本创作工作台 —— 4 步向导的 AI 能力
 *
 * 1. 对话打磨创意（chatStream，免费）→ buildOutlineMessages
 * 2. 生成结构化大纲（chatJSON，计费 script_outline）→ generateOutline / formatOutline
 * 3. 分集 + 概要（chatJSON，计费 episode_split）→ splitEpisodes
 * 4. 逐集细化正文（chatJSON，计费 episode_detail）→ expandEpisode
 *
 * 提示词均内联于此（不新增/不修改 skills 下任何 md）；
 * 当用户选定题材时，运行时加载 story_skills/<类型>/director_planning_narrative.md 作风味。
 */
import { chatJSON } from '../llm.service.js';
import { buildNarrativeSystem, NARRATIVE_TYPES } from '../artSkills.service.js';
import { truncate } from './script.service.js';

const VALID_NARRATIVE_KEYS = new Set(NARRATIVE_TYPES.map((n) => n.key));

/** 取题材对应的叙事技法正文（非法/未选题材返回空串） */
function narrativeContext(narrativeType) {
  const key = narrativeType && VALID_NARRATIVE_KEYS.has(narrativeType) ? narrativeType : null;
  if (!key) return '';
  return buildNarrativeSystem(key, ['director_planning_narrative']) || '';
}

function cleanHistory(history = [], maxTurns = 10) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-maxTurns * 2);
}

// ============ 第 1 步：对话打磨创意（免费 SSE） ============

export const OUTLINE_SYSTEM = `你是「星网剧本策划」，一位资深短剧编剧策划人。你正在通过对话帮用户从零打磨一部短剧的创作蓝图。

你的工作方式：
- 通过提问与建议，逐步明确：题材类型、故事设定、主角与核心人物、主线冲突、目标集数、整体基调。
- 每轮回复简洁友好（纯文本，可用「1. 2.」或「-」列点），不要使用 Markdown 标题或表格。
- 主动推进：当核心要素基本明确后，提示用户可以点击「生成大纲」进入下一步。
- 聚焦剧本创作本身，不涉及画面 / 分镜 / 视频等后续制作环节。`;

/** 组装第 1 步对话的 messages（供 SSE 路由直接喂 chatStream） */
export function buildOutlineMessages(history = [], narrativeType) {
  const nat = narrativeContext(narrativeType);
  const sys = nat ? `${OUTLINE_SYSTEM}\n\n【参考：所选题材的叙事技法】\n${nat}` : OUTLINE_SYSTEM;
  return [{ role: 'system', content: sys }, ...cleanHistory(history)];
}

// ============ 第 1 步定稿：生成结构化大纲（计费） ============

/**
 * 基于前期对话，产出结构化大纲 JSON。
 * @returns {Promise<{title,premise,characters:[{name,role,desc}],storyline,tone,suggested_episodes}>}
 */
export async function generateOutline(userId, { history, narrativeType, modelConfigId } = {}) {
  const assistant = [];
  const nat = narrativeContext(narrativeType);
  if (nat) assistant.push(nat);

  const system = '你是一名资深短剧编剧。根据前期沟通记录，整理出一份结构清晰、可直接用于分集的剧本大纲。严格遵守输出格式。';
  const convo = cleanHistory(history)
    .map((m) => `${m.role === 'user' ? '用户' : '策划'}：${m.content}`)
    .join('\n');

  const prompt = `基于以下前期沟通记录，产出一份剧本大纲。
要求：
1. 涵盖：剧名、一句话故事（设定与核心冲突）、主要人物（姓名/身份/性格与动机）、主线脉络（起承转合）、整体基调、建议集数。
2. 主线脉络要充实（200~400 字），便于后续分集。
3. 输出 JSON：{"title":"","premise":"","characters":[{"name":"","role":"","desc":""}],"storyline":"","tone":"","suggested_episodes":10}

前期沟通记录：
"""
${truncate(convo, 12000)}
"""`;

  const data = await chatJSON(userId, prompt, { system, assistant, temperature: 0.6, maxTokens: 4000, modelConfigId });
  return {
    title: String(data.title || '').slice(0, 255),
    premise: String(data.premise || '').trim(),
    characters: Array.isArray(data.characters)
      ? data.characters.map((c) => ({ name: String(c.name || ''), role: String(c.role || ''), desc: String(c.desc || '') }))
      : [],
    storyline: String(data.storyline || '').trim(),
    tone: String(data.tone || '').trim(),
    suggested_episodes: Number(data.suggested_episodes) || 0,
  };
}

/** 把结构化大纲序列化为可读文本（存入 Script.outline，供第 2 步分集与用户编辑） */
export function formatOutline(d) {
  const chars = (d.characters || [])
    .map((c) => `· ${c.name}${c.role ? `（${c.role}）` : ''}：${c.desc}`)
    .join('\n');
  return [
    `【剧名】${d.title || ''}`,
    d.premise ? `【一句话故事】${d.premise}` : '',
    chars ? `【主要人物】\n${chars}` : '',
    d.storyline ? `【主线脉络】\n${d.storyline}` : '',
    d.tone ? `【整体基调】${d.tone}` : '',
    d.suggested_episodes ? `【建议集数】${d.suggested_episodes} 集` : '',
  ].filter(Boolean).join('\n\n');
}

// ============ 第 2 步：分集 + 概要（计费） ============

/**
 * 基于大纲产出分集列表（带概要）。
 * @returns {Promise<[{idx,title,summary}]>}
 */
export async function splitEpisodes(userId, { outline, targetCount, narrativeType, modelConfigId } = {}) {
  const assistant = [];
  const nat = narrativeContext(narrativeType);
  if (nat) assistant.push(nat);

  const system = '你是一名资深短剧编剧。根据剧本大纲规划分集，并为每集产出概要。严格遵守输出格式。';
  const countHint = targetCount
    ? `目标集数：约 ${targetCount} 集（可酌情 ±1 集）。`
    : '请根据故事体量自行决定合适的集数（通常 6~20 集）。';

  const prompt = `基于以下剧本大纲，将故事划分为若干集，并为每集写一段概要（每集 80~150 字，交代该集主要事件与推进）。
${countHint}
要求：
1. 集与集之间要有清晰的推进与钩子，首集抓人、末集收束。
2. 每集包含 idx(从1开始)、title(不超过16字)、summary(概要)。
3. 输出 JSON：{"episodes":[{"idx":1,"title":"","summary":""}]}

剧本大纲：
"""
${truncate(outline || '', 12000)}
"""`;

  const data = await chatJSON(userId, prompt, { system, assistant, temperature: 0.5, maxTokens: 6000, modelConfigId });
  const eps = Array.isArray(data.episodes) ? data.episodes : (Array.isArray(data) ? data : []);
  return eps.map((e, i) => ({
    idx: e.idx || i + 1,
    title: String(e.title || `第${i + 1}集`).slice(0, 255),
    summary: String(e.summary || '').trim(),
  })).filter((e) => e.summary || e.title);
}

// ============ 第 3 步：逐集细化正文（计费，可批量） ============

/**
 * 基于大纲与某集概要，扩写该集完整剧本正文。
 * @param {object} episode { idx, title, summary }
 * @returns {Promise<{content:string}>}
 */
export async function expandEpisode(userId, { outline, episode, narrativeType, modelConfigId } = {}) {
  const assistant = [];
  const nat = narrativeContext(narrativeType);
  if (nat) assistant.push(nat);

  const system = '你是一名资深短剧编剧。根据大纲与某集概要，把该集扩写为完整的分集剧本正文（含场景描述与对白）。严格遵守输出格式。';
  const prompt = `基于以下剧本大纲与第 ${episode.idx} 集《${episode.title}》的概要，扩写出该集的完整剧本正文。
要求：
1. 包含场景描述与人物对白，按短剧节奏推进，结尾留钩子（除末集外）。
2. 字数约 800~1500 字，正文为纯文本（可用【场景】分隔，不要 Markdown 标题）。
3. 与前后集呼应，保持人物性格与主线一致。
4. 输出 JSON：{"content":"...完整剧本正文..."}

剧本大纲：
"""
${truncate(outline || '', 6000)}
"""

本集概要：
"""
第 ${episode.idx} 集《${episode.title}》：${episode.summary || ''}
"""`;

  const data = await chatJSON(userId, prompt, { system, assistant, temperature: 0.7, maxTokens: 8000, modelConfigId });
  return { content: String(data.content || data.text || '').trim() };
}
