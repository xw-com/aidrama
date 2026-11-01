import { estimateDurationFromText, resolveDuration } from './ai/storyboard.service.js';

/**
 * 分镜审计（纯函数模块，不依赖 db）
 *
 * 两类可修复问题：
 *  1) 资产缺失：本镜 video_prompt(画面+对白)/scene_script(场景剧本) 中提及的资产名，未出现在 asset_refs 中。
 *  2) 时长不足：按台词估算「念完所需」秒数，若当前 duration 容不下则建议延长（只延长不缩短）。
 *
 * 时长估算/裁决复用 ai/storyboard.service.js 的 estimateDurationFromText / resolveDuration，
 * 与 AI 首次生成分镜时完全同源，保证审计与生成口径一致。
 */

const DURATION_MAX = 15;
const KIND_PRIORITY = { character: 0, scene: 1, prop: 2, material: 3, video: 4 };

// 对白说话人行尾的「引述动词」：仅剥离这些后缀以还原角色名。
// 注意：不剥离单个「道」字（避免误伤"明道"这类以道结尾的真名），仅剥离 X道/说着 等组合与单字「说」。
const VERB_SUFFIX = /(?:哭着说|轻声说|低声说|低声道|冷声说|冷笑道|说道|喊道|笑道|问道|答道|叹道|怒道|惊道|说着|说)$/;
// 名字首尾可能出现的引号/空白
const NAME_QUOTE = /^[「」“”‘’"'()\s]+|[「」“”‘’"'()\s]+$/g;

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * 从文本中抽取对白说话人名称。
 * 识别两种格式：
 *  - video_prompt 对白行：[角色名]…说/道/喊："台词"（角色名在方括号内，本行含引号对白）；
 *  - 兼容旧式 "对白：<说话人>(说|道|喊…)：<台词>" 行。
 * 去掉首尾引号与引述动词后缀，返回去重后的人名数组（保持首次出现顺序）。
 */
export function extractDialogueSpeakers(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    let name = String(raw || '').replace(NAME_QUOTE, '').trim();
    name = name.replace(VERB_SUFFIX, '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(name); }
  };
  for (const line of String(text).split(/\r?\n/)) {
    // video_prompt 对白格式：[角色名]…说："台词"
    const bm = line.match(/\[([^\]\s]+)\]/);
    if (bm && /["「『]/.test(line)) { push(bm[1]); continue; }
    // 兼容旧式 "对白：角色：台词"
    const dm = line.match(/^\s*对白[:：]\s*([^:：]+)[:：]/);
    if (dm) push(dm[1]);
  }
  return out;
}

/**
 * 检测本镜文本中出现、却未绑定到 asset_refs 的资产。
 * 另产出「已绑定但无形象图」的只读告警（不自动修复、不计入 apply 计数）。
 *
 * 检测策略（防误报）：
 *  - 仅考虑 name 长度 >= 2 的资产（过滤「我/他」类单字噪声）。
 *  - 信号1（高置信，reasonKey='speaker'）：video_prompt 对白说话人名与资产名精确匹配（仅扫 video_prompt 对白）。
 *  - 信号2（广义，reasonKey='mention'）：资产名作为子串出现在 video_prompt+scene_script 中。
 *  - 最长名优先 + 已命中区间占用：避免「李四」⊂「李小四」式的子名误命中
 *    （长名先占段，短名只能在未被占用的别处命中）。
 *  - 同名多资产各自独立判定、按 id 去重。
 *
 * @param {{video_prompt?:string, scene_script?:string, asset_refs?:Array}} segment
 * @param {Array<{id:number,kind:string,name:string,image_url?:string,aliases?:string[]}>} assets
 * @returns {{missingAssets:Array<{id:number,type:string,name:string,reason:string,reasonKey:'speaker'|'mention'}>, warnings:Array<{kind:'no_image',id:number,type:string,name:string}>}}
 */
export function detectMissingAssets(segment, assets = []) {
  const refs = Array.isArray(segment?.asset_refs) ? segment.asset_refs : [];
  const boundIds = new Set(refs.map((r) => Number(r && r.id)).filter(Number.isFinite));
  const text = `${segment?.video_prompt || ''}\n${segment?.scene_script || ''}`;
  const haystack = text.toLowerCase();

  // 候选资产：name 与别名均作为等价名参与匹配（去重、trim、长度 >=2），按名长度 DESC（最长优先）
  const candidates = (assets || [])
    .filter((a) => a && !boundIds.has(Number(a.id)))
    .flatMap((a) => {
      const names = new Set();
      const pushName = (raw) => {
        const n = String(raw || '').trim();
        if (n.length >= 2) names.add(n);
      };
      pushName(a.name);
      if (Array.isArray(a.aliases)) a.aliases.forEach(pushName);
      return [...names].map((name) => ({ id: Number(a.id), type: a.kind, name }));
    })
    .sort((a, b) => b.name.length - a.name.length);

  const consumed = []; // 已占用区间 [start,end)
  const overlaps = (s, e) => consumed.some(([cs, ce]) => s < ce && e > cs);
  // 标记 name 在 haystack 上的所有出现区间（后续短名不能再命中这些字符）
  const markAll = (nameL) => {
    const len = nameL.length;
    let from = 0;
    while (from + len <= haystack.length) {
      const idx = haystack.indexOf(nameL, from);
      if (idx === -1) break;
      consumed.push([idx, idx + len]);
      from = idx + len;
    }
  };
  // 在未占用区间中找 name 的首个命中下标；无则 -1
  const firstHit = (nameL) => {
    const len = nameL.length;
    let from = 0;
    while (from + len <= haystack.length) {
      const idx = haystack.indexOf(nameL, from);
      if (idx === -1) return -1;
      if (!overlaps(idx, idx + len)) return idx;
      from = idx + 1;
    }
    return -1;
  };

  const takenIds = new Set();
  const detected = [];
  const pushDetected = (asset, reason, reasonKey) => {
    if (takenIds.has(asset.id)) return;
    takenIds.add(asset.id);
    detected.push({ id: asset.id, type: asset.type, name: asset.name, reason, reasonKey });
  };

  // 1) 对白说话人精确匹配
  for (const sp of extractDialogueSpeakers(text)) {
    const spL = norm(sp);
    const hit = candidates.find((c) => norm(c.name) === spL);
    if (hit) { pushDetected(hit, sp, 'speaker'); markAll(norm(hit.name)); }
  }

  // 2) 剩余候选做子串匹配（最长优先、区间不重叠）
  for (const c of candidates) {
    if (takenIds.has(c.id)) continue;
    const nameL = norm(c.name);
    if (!nameL) continue;
    if (firstHit(nameL) !== -1) { pushDetected(c, c.name, 'mention'); markAll(nameL); }
  }

  // 只读告警：已绑定但缺少形象图（image_url 为空）—— 指引用户去资产库补图
  const warnings = [];
  const assetById = new Map((assets || []).filter(Boolean).map((a) => [Number(a.id), a]));
  for (const r of refs) {
    const a = assetById.get(Number(r && r.id));
    if (a && !a.image_url) warnings.push({ kind: 'no_image', id: Number(r.id), type: a.kind, name: a.name });
  }

  return { missingAssets: detected, warnings };
}

/**
 * 单镜完整审计（资产 + 时长）。
 * @returns 每镜报告项：missingAssets / warnings / duration{current,estimated,recommended,overflow,changed,hasVideo}
 */
export function auditSegment(segment, assets) {
  const { missingAssets, warnings } = detectMissingAssets(segment, assets);
  const current = Number(segment?.duration) || 0;
  const segText = `${segment?.video_prompt || ''}\n${segment?.scene_script || ''}`;
  const estimated = estimateDurationFromText(segText); // 对白所需下限
  const recommended = resolveDuration(segment?.duration, segText); // 只增不减
  return {
    segmentId: segment?.id,
    idx: segment?.idx,
    shot_no: segment?.shot_no,
    title: segment?.title,
    missingAssets,
    warnings,
    duration: {
      current,
      estimated,
      recommended,
      overflow: estimated > DURATION_MAX, // 对白太长，即便封顶 15 秒也念不完
      changed: recommended !== current,
      hasVideo: !!segment?.video_url, // 信息标记：该镜已有视频（不阻断 apply；UI 提示需重生成）
    },
  };
}

/**
 * 多镜审计 + 汇总计数。
 */
export function auditSegments(segments, assets) {
  const items = (segments || []).map((s) => auditSegment(s, assets));
  return {
    items,
    summary: {
      segmentCount: items.length,
      assetIssueCount: items.filter((i) => i.missingAssets.length).length,
      durationIssueCount: items.filter((i) => i.duration.changed).length,
      overflowCount: items.filter((i) => i.duration.overflow).length,
      warningCount: items.filter((i) => i.warnings.length).length,
    },
  };
}

/**
 * 纯规划：给定单镜审计项 + 修复开关，产出该镜的 patch（不触碰 DB）。
 * 与审计报告同源，保证「报告里看到什么 → apply 就改什么」以及重复 apply 的幂等性。
 *
 * @param {object} item auditSegment 返回的报告项
 * @param {{fixAssets:boolean, fixDuration:boolean}} opts
 * @returns {{assetRefsToAdd?:Array, duration?:number}}
 */
export function planSegmentPatch(item, { fixAssets, fixDuration }) {
  const patch = {};
  if (fixAssets && item.missingAssets.length) {
    // 新增资产按 类型优先级(角色>场景>道具>素材) → 名称 → id 稳定排序，UI 顺序可预期
    patch.assetRefsToAdd = [...item.missingAssets].sort(
      (a, b) => (KIND_PRIORITY[a.type] ?? 9) - (KIND_PRIORITY[b.type] ?? 9)
        || String(a.name).localeCompare(String(b.name))
        || a.id - b.id,
    );
  }
  // 决策：已生成视频的分镜也照常调整时长（用户可自行重生成视频）
  if (fixDuration && item.duration.changed) patch.duration = item.duration.recommended;
  return patch;
}
