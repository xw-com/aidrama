/**
 * 本地把长剧本文本切成若干块（每块不超过 maxChunkSize 字符）。
 * 优先按章节/场景标记切；无标记则按句界累积切；确保不在句中断。
 * 返回 string[]。
 */
export function splitScriptIntoChunks(rawScript, maxChunkSize = 48000) {
  const text = String(rawScript || '').trim();
  if (!text) return [];
  if (text.length <= maxChunkSize) return [text];

  // 1) 优先按章节/场景标记切分
  //    匹配：第X集/章/回/部、Episode/Chapter/Part/Act/Scene N（阿拉伯或罗马数字，大小写不敏感）、
  //    【场景】、场景：/Scene：、独立行的 # / ## 标题
  const markerRe = /(?:第[一二三四五六七八九十百千零\d]+[集章回部分]|(?:Episode|Chapter|Part|Act|Scene)\s*[\dIVXLCDM]+|【场景】|场景\s*[:：]|Scene\s*[:：]|^[ \t]*#{1,3}\s+.+$)/gmi;
  const segments = [];
  let last = 0;
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    if (m.index > last) segments.push(text.slice(last, m.index));
    last = m.index; // 标记本身归入下一段开头
  }
  if (last < text.length) segments.push(text.slice(last));
  const coarse = segments.length ? segments : [text];

  // 2) 对每段：超长则按句界二次细分；过短由后续合并处理
  const fine = [];
  const sentenceRe = /[^。！？!?…\n]+[。！？!?…\n]*|\n+/g;
  for (const seg of coarse) {
    if (seg.length <= maxChunkSize) { fine.push(seg); continue; }
    // 按句界累积切
    let buf = '';
    let s;
    sentenceRe.lastIndex = 0;
    while ((s = sentenceRe.exec(seg)) !== null) {
      const piece = s[0];
      if ((buf + piece).length > maxChunkSize) {
        if (buf) fine.push(buf);
        // 单句本身就超长，硬切
        if (piece.length > maxChunkSize) {
          for (let i = 0; i < piece.length; i += maxChunkSize) fine.push(piece.slice(i, i + maxChunkSize));
          buf = '';
        } else {
          buf = piece;
        }
      } else {
        buf += piece;
      }
    }
    if (buf) fine.push(buf);
  }

  // 3) 合并过短的相邻块（在不超过 maxChunkSize 的前提下）
  const merged = [];
  for (const seg of fine) {
    const lastMerged = merged.length ? merged[merged.length - 1] : null;
    if (lastMerged && lastMerged.length + seg.length <= maxChunkSize) {
      merged[merged.length - 1] = lastMerged + seg;
    } else {
      merged.push(seg);
    }
  }

  return merged.map((s) => s).filter((s) => s.trim());
}

/**
 * JS 本地拆分（零积分、同步）：不调用大模型，按剧本自带的集级标记切分多集。
 * 优先级：行首「第X集/章/回/部」「Episode N」「#/##/### 标题」；
 * 全文无任何标记时按句界累积切 ~episodeChars 字/集兜底。
 * 返回 [{ idx, title, content }]。
 */
export function parseScriptJS(rawScript, opts = {}) {
  const { episodeChars = 2000 } = opts;
  const text = String(rawScript || '').trim();
  if (!text) return [];

  // 1) 按集级标记切分（【场景】/场景：/Scene 等场景级标记不构成新集；锚定行首避免正文中提及「第一集」误切）
  //    英文剧本文持：Episode/Chapter/Part/Act + 阿拉伯或罗马数字（Episode 1、Chapter II、Act III），大小写不敏感
  const markerRe = /^[ \t]*(?:第[一二三四五六七八九十百千零\d]+[集章回部分](?:[：:、\s].*)?|(?:Episode|Chapter|Part|Act)\s*[\dIVXLCDM]+(?:[:：.\-\s].*)?|#{1,3}[ \t]+\S.*)$/gmi;
  const marks = []; // { title, lineStart, bodyStart }
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    const lineEnd = text.indexOf('\n', m.index);
    const head = lineEnd === -1 ? text.slice(m.index) : text.slice(m.index, lineEnd);
    marks.push({
      title: head.replace(/^[ \t]*#+[ \t]+/, '').trim().slice(0, 50),
      lineStart: m.index,
      bodyStart: lineEnd === -1 ? text.length : lineEnd + 1,
    });
  }
  if (marks.length) {
    const eps = marks.map((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].lineStart : text.length;
      const lead = i === 0 ? text.slice(0, mk.lineStart).trim() : ''; // 首标记前的正文（书名/前言）并入第 1 集，零丢失
      return {
        title: mk.title || `第${i + 1}集`,
        content: (lead ? lead + '\n' : '') + text.slice(mk.bodyStart, end).trim(),
      };
    });
    return eps.filter((e) => e.content).map((e, i) => ({ idx: i + 1, title: e.title, content: e.content }));
  }

  // 2) 兜底：无任何标记，按句界累积切 ~episodeChars 字/集
  return splitScriptIntoChunks(text, episodeChars)
    .map((c, i) => ({ idx: i + 1, title: `第${i + 1}集`, content: c.trim() }))
    .filter((e) => e.content);
}

export function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '\n...(已截断)' : s;
}
