import { chatJSON } from '../llm.service.js';
import { stripPunctuation } from '../subtitle.service.js';
import { truncate } from './script.service.js';

/**
 * 字幕智能校正：把「本集剧本原文 + 字幕草稿」交给文本大模型，逐条修正
 * ASR 听写错误（错别字 / 同音近音字 / 人名术语写错 / 明显漏字多字）。
 * 铁律：只改少量文字，改后台词与原台词读音相近、字数相近；无把握不改。
 * 剧本只是对照标准（供 LLM 判断「听写成了什么」），不参与写回。
 */

const SYSTEM_PROMPT = `你是短剧字幕校对专家。字幕草稿由语音识别(ASR)转写，常存在同音/近音听写错误；我会同时提供本集剧本原文作为对照标准。

校正规则（必须严格遵守）：
1. 只修正明显的听写错误：错别字、同音/近音字、人名/地名/术语写错、明显的漏字或多字；不做润色、改写、扩写或缩句。
2. 每条只允许改动少量文字：修改后台词必须与原台词读音相近（同音或近音），且字数与原台词相近（长度增减不超过三分之一）。
3. 把握不准、剧本中找不到对应依据的条目，一律不改。
4. 不得增删条目、不得调整顺序；修正后的台词不要带任何标点符号。
5. 输出只包含需要修改的条目；没有需要修改的条目时输出空数组。

输出格式（纯 JSON，不要多余文字）：
{"corrections":[{"i":<字幕草稿中的序号>,"text":"<修正后的台词>"}]}`;

/**
 * 调大模型校正字幕文本。
 * @param {number} userId
 * @param {{script:string, segments:Array<{start:number,end:number,text:string}>, modelConfigId?:number}} opts
 * @returns {Promise<Array<{i:number,text:string}>>} 校正项（i 为 segments 的 0-based 下标），
 *   已做防御性清洗：序号越界/文本为空/字数漂移超限的一律丢弃。
 */
export async function correctSubtitleText(userId, { script, segments, modelConfigId }) {
  const lines = (segments || []).map((s, i) => `${i + 1}. ${s.text}`);
  const prompt = `【本集剧本】\n${truncate(script, 12000)}\n\n【字幕草稿】（序号. 台词，均已去标点）\n${lines.join('\n')}\n\n请对照剧本逐条校正，只输出需要修改的条目。`;

  const data = await chatJSON(userId, prompt, {
    system: SYSTEM_PROMPT,
    temperature: 0.1,
    maxTokens: Math.min(32000, 1000 + lines.length * 60),
    modelConfigId,
  });
  // 兼容 {"corrections":[...]} 与直接返回数组两种形态
  const list = Array.isArray(data) ? data : Array.isArray(data?.corrections) ? data.corrections : [];

  const out = [];
  const seen = new Set();
  // 行长上限跟随传入字幕的实际最大长度：4K 横版小字号行长可达 ~75 汉字（拉丁按 0.5 当量更长），
  // 固定 60 会把合法长行的校正静默丢弃（任务照常计费却「未生效」）；「只小改」由下方字数相近约束兜底
  const maxLineLen = Math.max(60, ...(segments || []).map((s) => String(s.text || '').length)) + 10;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const no = Number(item.i ?? item.index ?? item.id);
    const idx = Number.isInteger(no) ? no - 1 : -1;
    if (idx < 0 || idx >= segments.length || seen.has(idx)) continue;
    // 字幕不出标点；清洗后为空的丢弃
    const text = stripPunctuation(item.text);
    if (!text || text.length > maxLineLen) continue;
    // 字数相近约束：漂移超过 max(2, 原长 1/3) 视为违反「只小改」，放弃该条
    const old = segments[idx].text || '';
    if (Math.abs(text.length - old.length) > Math.max(2, Math.ceil(old.length / 3))) continue;
    if (text === old) continue;
    seen.add(idx);
    out.push({ i: idx, text });
  }
  return out;
}

/**
 * 把校正项合并回段落：未命中的条目原样保留（时间码不动），返回合并结果与实际修改条数。
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @param {Array<{i:number,text:string}>} corrections
 */
export function mergeCorrections(segments, corrections) {
  const map = new Map((corrections || []).map((c) => [c.i, c.text]));
  let changed = 0;
  const merged = (segments || []).map((s, i) => {
    const text = map.get(i);
    if (!text || text === s.text) return s;
    changed++;
    return { ...s, text };
  });
  return { merged, changed };
}
