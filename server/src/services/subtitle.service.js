import os from 'os';

/**
 * 字幕文件生成（纯函数，无 IO）：ASR 时间戳段落 → SRT / ASS 文本。
 * ASS 用于 ffmpeg 烧录硬字幕（白字黑边、底部居中的短剧常规样式），
 * SRT 作为独立产物保留，供下载/外部剪辑软件使用。
 * 分段标准：一行字幕不超过屏宽实际可容纳的汉字数（subtitleLineCapacity 按视频真实
 * 宽度/字号动态计算，横屏约为竖屏两倍；拿不到尺寸时回退 15 个汉字 SUB_LINE_MAX）；
 * 超过则拆成条数最少、各条长度尽量接近的独立字幕（断点落词界、优先句读），
 * 时长按各片字宽比例分配；SRT/ASS 内再折行仅作兜底。
 * 标点清洗：字幕不出现标点——句中标点以空格代替（避免前后词粘连），
 * 句首/句尾标点直接去除。
 */

// 字幕字体：优先环境变量显式指定；否则按平台取常见 CJK 字体。
// 部署机需安装对应字体（Linux 常见为 Noto Sans CJK SC），否则 libass 会回退到默认字体（中文可能变方块）。
const SUBTITLE_FONT = process.env.SUBTITLE_FONT || (os.platform() === 'darwin' ? 'PingFang SC' : 'Noto Sans CJK SC');

/** 一行字幕的汉字数上限（拿不到视频尺寸时的产品标准回退：超过 15 个汉字拆成等长的两段） */
const SUB_LINE_MAX = 15;

/** 字幕样式自定义值的取值范围（短边 1080 基准像素）：字号 24–200，离底边距 0–800 */
export const SUBTITLE_STYLE_LIMITS = { fontSize: [24, 200], marginV: [0, 800] };

/**
 * 一行字幕可容纳的汉字当量上限：按视频真实宽度动态算——
 * 可用宽度（宽 − 左右边距）÷ 字号（单个汉字渲染宽 ≈ 字号），横屏约为竖屏两倍；
 * 拿不到视频尺寸时回退产品标准 SUB_LINE_MAX。烧录时 libass 对超宽行仍会自动折行兜底。
 * @param {{width?:number,height?:number}} dims 视频宽高（探测值）
 * @param {{fontSize?:number}} [style] 项目字幕设置（fontSize 为短边 1080 基准像素）
 * @returns {number}
 */
export function subtitleLineCapacity(dims = {}, style = {}) {
  const width = Number(dims?.width) > 0 ? Math.round(Number(dims.width)) : 0;
  const height = Number(dims?.height) > 0 ? Math.round(Number(dims.height)) : 0;
  if (!(width > 0 && height > 0)) return SUB_LINE_MAX;
  const scale = Math.min(width, height) / 1080;
  // 字号口径与 segmentsToAss 保持一致：项目自定义（钳制后）否则默认 60
  const [FS_MIN, FS_MAX] = SUBTITLE_STYLE_LIMITS.fontSize;
  const base = Number.isInteger(style?.fontSize) ? Math.min(FS_MAX, Math.max(FS_MIN, style.fontSize)) : 60;
  const fontSize = Math.round(base * scale);
  const marginLR = Math.round(60 * scale);
  return Math.max(4, Math.floor((width - marginLR * 2) / fontSize));
}

/** ASS Style 行是逗号分隔 CSV：字体名剥除会破坏格式/注入 override 的字符并截长（路由与烧录双保险） */
function sanitizeAssFont(font) {
  return String(font || '').replace(/[,{}\\/\r\n]/g, '').trim().slice(0, 64);
}

/**
 * 归一化项目字幕设置（project.settings.subtitle 写库前校验）：
 * - null/undefined → null（恢复默认，删除子树）
 * - font：字符串清洗后非空才保留；fontSize/marginV：整数且在 SUBTITLE_STYLE_LIMITS 范围内
 * - 清洗后为空对象 → null（视为恢复默认）
 * 非法（类型错/超范围）抛 Error，由路由转 badRequest('project.settings_invalid')。
 */
export function normalizeSubtitleStyle(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('subtitle style invalid');
  const out = {};
  if (raw.font !== undefined && raw.font !== null) {
    if (typeof raw.font !== 'string') throw new Error('subtitle style invalid');
    const font = sanitizeAssFont(raw.font);
    if (font) out.font = font;
  }
  for (const key of ['fontSize', 'marginV']) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    const [min, max] = SUBTITLE_STYLE_LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) throw new Error('subtitle style invalid');
    out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** 单字符宽度权重：汉字/假名/谚文 1，全角标点与空白 0（跟尾不计），拉丁字母/数字按半宽 0.5 */
function charUnits(ch) {
  if (/\s/.test(ch)) return 0;
  const c = ch.codePointAt(0);
  if ((c >= 0x3000 && c <= 0x303F) || (c >= 0xFF01 && c <= 0xFF5E) || c === 0x2014 || c === 0x2026) return 0; // CJK 标点/全角符号/——/…
  if ((c >= 0x3400 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7A3)) return 1;
  return 0.5;
}

/** 字符串的汉字当量宽度 */
function textUnits(str) {
  let u = 0;
  for (const ch of String(str || '')) u += charUnits(ch);
  return u;
}

/** 含字母/数字的残片判定（纯标点行并入前片，不单独成行） */
const HAS_TEXT_RE = /[\p{L}\p{N}]/u;

/** 句读标点：断行同分时优先断在句读后（标点跟句尾，行首不出标点） */
const PUNCT_RE = /[，。！？；：、…—,.!?;:]/;

/** 全部标点（Unicode 标点类 + 波浪线等常见符号；连续标点合并为一个空格） */
const PUNCT_ALL_RE = /[\p{P}~～]+/gu;

/** 去标点：非末尾标点用空格代替，句首/句尾标点去除（trim 掉），空白收敛为单空格 */
export function stripPunctuation(text) {
  return String(text || '').replace(PUNCT_ALL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 词语切分（Node ≥16 自带 Intl.Segmenter，ICU 词典对中英混排均可按词切分；
 * 环境不支持时退化为逐字，行为等同旧版硬切）。
 */
let wordSegmenter = null;
function segmentWords(text) {
  try {
    wordSegmenter ||= new Intl.Segmenter('zh-Hans', { granularity: 'word' });
    return [...wordSegmenter.segment(String(text))].map((s) => s.segment);
  } catch {
    return Array.from(String(text));
  }
}

/** 超宽单字串（超长英文词/数字串）逐字硬切到不超过 maxUnits 的片 */
function charChunkUnits(word, maxUnits) {
  const pieces = [];
  let cur = '';
  let u = 0;
  for (const ch of Array.from(String(word))) {
    const cw = charUnits(ch);
    if (cur && u + cw > maxUnits) { pieces.push(cur); cur = ''; u = 0; }
    cur += ch;
    u += cw;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/**
 * 超长文本 → 条数最少、各条长度尽量接近的字幕行（一般即「拆等长两段」），
 * 断点只落在词语边界（词语不截断），同分时优先断在句读后；
 * 仅当单个词自身超一行宽度（超长英文词/数字串）才逐字硬切。
 * 实现：先贪心求最少行数 k，再 DP 把词分进 k 行，
 * 最小化各行宽度与目标宽度 total/k 的方差和（行首标点小罚、句读收尾小奖）。
 */
function balancedSplitUnits(text, maxUnits) {
  const tokens = [];
  for (const w of segmentWords(text)) {
    if (textUnits(w) > maxUnits) tokens.push(...charChunkUnits(w, maxUnits));
    else tokens.push(w);
  }
  const m = tokens.length;
  if (!m) return [];
  const pre = [0]; // 前缀宽度
  for (const t of tokens) pre.push(pre[pre.length - 1] + textUnits(t));
  // 贪心装行求最少行数 k（first-fit 对顺序切分即最优），保证 DP 必有可行解
  let k = 1;
  for (let i = 0, u = 0; i < m; i++) {
    const w = pre[i + 1] - pre[i];
    if (u > 0 && u + w > maxUnits) { k++; u = 0; }
    u += w;
  }
  const target = pre[m] / k;
  const dp = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(Infinity));
  const cut = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  dp[0][0] = 0;
  for (let r = 1; r <= k; r++) {
    for (let j = r; j <= m - (k - r); j++) { // 行 r 的词区间终点；给后续每行至少留 1 个词
      for (let i = r - 1; i < j; i++) {
        if (dp[i][r - 1] === Infinity) continue;
        const w = pre[j] - pre[i];
        if (w > maxUnits) continue;
        let c = (w - target) ** 2;
        if (PUNCT_RE.test(tokens[j - 1].slice(-1))) c -= 1; // 断在句读后
        if (PUNCT_RE.test(tokens[i][0])) c += 2;            // 行首标点：应并入上一行
        if (c < dp[j][r]) { dp[j][r] = c; cut[j][r] = i; }
      }
    }
  }
  const bounds = [m]; // 回溯断点
  let j = m;
  for (let r = k; r >= 1; r--) { j = cut[j][r]; bounds.unshift(j); }
  const lines = [];
  for (let r = 0; r < k; r++) lines.push(tokens.slice(bounds[r], bounds[r + 1]).join(''));
  const out = [];
  for (const p of lines) {
    if (out.length && !HAS_TEXT_RE.test(p)) out[out.length - 1] += p; // 纯标点残片并入前片
    else out.push(p);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

/**
 * 文本 → 每行不超过 maxUnits 汉字当量的行数组：
 * 不超过上限时整段一行（幂等）；超过时拆成条数最少、各条长度尽量接近的
 * 若干行（一般即「拆等长两段」），断点落在词语边界且优先句读处，词语不截断。
 * @param {string} text
 * @param {number} maxUnits 每行汉字数上限
 * @returns {string[]}
 */
export function splitSubtitleText(text, maxUnits = SUB_LINE_MAX) {
  const clean = stripPunctuation(text);
  if (!clean) return [];
  if (textUnits(clean) <= maxUnits) return [clean];
  return balancedSplitUnits(clean, maxUnits);
}

/**
 * 按「一行不超过 maxUnits 个汉字当量、超长拆成条数最少且等长」标准重新分段：超长段落拆成
 * 多条长度接近的独立字幕，时长按各片字宽比例分配（末片直接吃到段落结尾，避免累计误差）。
 * 对已达标的段落是幂等的（时间与文本原样保留）。
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @param {number} maxUnits 每行汉字数上限
 */
export function segmentizeSegments(segments, maxUnits = SUB_LINE_MAX) {
  const out = [];
  for (const seg of segments || []) {
    const start = Math.max(0, Number(seg?.start) || 0);
    const end = Math.max(start, Number(seg?.end) || start);
    const lines = splitSubtitleText(seg?.text, maxUnits);
    if (!lines.length) continue;
    if (lines.length === 1) { out.push({ start, end, text: lines[0] }); continue; }
    const weights = lines.map((l) => Math.max(1, textUnits(l)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = start;
    lines.forEach((line, i) => {
      const segEnd = i === lines.length - 1 ? end : Math.min(end, cursor + ((end - start) * weights[i]) / total);
      if (segEnd > cursor) out.push({ start: cursor, end: segEnd, text: line });
      cursor = segEnd;
    });
  }
  return out;
}

/** 句读断句标点：遇到即换行（一句一行），连续标点（如 …… ！！）合并消耗为一个断点 */
const SENTENCE_SPLIT_RE = /[，。！？；：、…—,.!?;:]+/;

/**
 * 按标点断句（提取链路第一步，须在 normalizeSegments 去标点之前执行）：
 * 段落内遇到句读标点即断行——一句话一行，标点本身消耗掉（字幕不出标点）；
 * 时间按各句字宽比例分摊（末句直接吃到段落结尾，避免累计误差）。
 * 无标点的段落原样返回，交由后续 segmentizeSegments 按字数二次断句。
 * @param {Array<{start:number,end:number,text:string}>} segments
 */
export function splitSegmentsByPunctuation(segments) {
  const out = [];
  for (const seg of segments || []) {
    const start = Math.max(0, Number(seg?.start) || 0);
    const end = Math.max(start, Number(seg?.end) || start);
    const sentences = String(seg?.text || '')
      .split(SENTENCE_SPLIT_RE)
      .map((s) => stripPunctuation(s))
      .filter(Boolean);
    if (!sentences.length) continue;
    if (sentences.length === 1) { out.push({ start, end, text: sentences[0] }); continue; }
    const weights = sentences.map((l) => Math.max(1, textUnits(l)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = start;
    sentences.forEach((line, i) => {
      const segEnd = i === sentences.length - 1 ? end : Math.min(end, cursor + ((end - start) * weights[i]) / total);
      if (segEnd > cursor) out.push({ start: cursor, end: segEnd, text: line });
      cursor = segEnd;
    });
  }
  return out;
}

/** SRT 时间码：HH:MM:SS,mmm */
function buildSrtTimecode(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  // 浮点进位可能凑出 1000（如 1.9999999 → 2000ms）：钳到 999 保证 mss 合法
  const ms = Math.min(999, Math.round((t - Math.floor(t)) * 1000));
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** ASS 时间码：H:MM:SS.cc（厘秒） */
function buildAssTimecode(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  // 同 SRT：钳到 99 厘秒，防止进位出 ".100" 非法厘秒
  const cs = Math.min(99, Math.round((t - Math.floor(t)) * 100));
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * 归一化 ASR 段落：滤空文本、trim、去标点（非末尾以空格代替）、
 * 修复非法时间（end<=start 补 1s）、end 钳到视频时长内。
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @param {number} duration 视频时长(秒)，0 表示不钳制
 */
export function normalizeSegments(segments, duration = 0) {
  const out = [];
  for (const seg of segments || []) {
    const text = stripPunctuation(seg?.text);
    if (!text) continue;
    let start = Math.max(0, Number(seg.start) || 0);
    let end = Number(seg.end) || 0;
    if (end <= start) end = start + 1; // 零/负时长兜底 1s
    if (duration > 0) {
      if (start >= duration) continue;          // 整段超出视频尾部，丢弃
      end = Math.min(end, duration);
      if (end <= start) end = Math.min(start + 1, duration);
    }
    out.push({ start, end, text });
  }
  return out;
}

/** ASS 文本转义：剔除 {}（防 override 标签注入），换行转 \N */
function escapeAssText(text) {
  return String(text).replace(/\{[^}]*\}/g, '').replace(/\r?\n/g, '\\N');
}

/** SRT 文本：去 {} 标签，多空行压一 */
function cleanSrtText(text) {
  return String(text).replace(/\{[^}]*\}/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 单条字幕折行（多行兜底）：正常情况下段落已由 segmentizeSegments 切到一行 ≤ 屏宽可容纳汉字数 */
function wrapSubtitleLine(text, maxUnits = SUB_LINE_MAX) {
  return splitSubtitleText(text, maxUnits).join('\n');
}

/** ASR 段落 → SRT 文件内容（maxUnits 传调用方算好的行宽容量，保持与 ASS 同口径） */
export function segmentsToSrt(segments, maxUnits = SUB_LINE_MAX) {
  return (segments || [])
    .map((seg, i) => {
      const lines = wrapSubtitleLine(cleanSrtText(seg.text), maxUnits).split('\n').map((l) => l.trim()).filter(Boolean);
      return `${i + 1}\n${buildSrtTimecode(seg.start)} --> ${buildSrtTimecode(seg.end)}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

/**
 * ASR 段落 → ASS 文件内容（供 ffmpeg ass 滤镜烧录）。
 * PlayRes 用视频真实宽高（compose 单段成片走流拷贝，不保证 1080x1920）；
 * 横竖屏统一按短边缩放：字号/描边/左右边距以 min(宽,高)/1080 等比（竖屏=宽、横屏=高），
 * 物理观感一致；垂直位置按屏高 1/4 定位，横屏不因宽度大而飘到屏幕中部。
 * @param {Array<{start,end,text}>} segments
 * @param {{width:number,height:number}} dims 视频宽高（探测值）
 * @param {{font?:string,fontSize?:number,marginV?:number}} [style] 项目字幕设置覆盖（project.settings.subtitle）：
 *   fontSize/marginV 为短边 1080 基准像素，按 min(宽,高)/1080 缩放；未传/非法值回退公式默认。
 */
export function segmentsToAss(segments, dims = {}, style = {}) {
  const width = Number(dims.width) > 0 ? Math.round(Number(dims.width)) : 1080;
  const height = Number(dims.height) > 0 ? Math.round(Number(dims.height)) : 1920;
  const scale = Math.min(width, height) / 1080;
  // 公式默认（未自定义时）：字号 = 屏高/(横屏16:竖屏22)，离底边距 = 屏高/(横屏10:竖屏4)
  const defFontSize = Math.round((width > height ? 60 : 60) * scale);
  const defMarginV = Math.round((width > height ? 60 : 270) * scale);
  // 项目自定义：短边 1080 基准值 × scale；脏数据防御性钳制（路由已校验，此处兜底）
  const [FS_MIN, FS_MAX] = SUBTITLE_STYLE_LIMITS.fontSize;
  const [MV_MIN, MV_MAX] = SUBTITLE_STYLE_LIMITS.marginV;
  const fs = Number.isInteger(style?.fontSize) ? Math.min(FS_MAX, Math.max(FS_MIN, style.fontSize)) : null;
  const mv = Number.isInteger(style?.marginV) ? Math.min(MV_MAX, Math.max(MV_MIN, style.marginV)) : null;
  const fontSize = fs !== null ? Math.round(fs * scale) : defFontSize;
  const marginV = mv !== null ? Math.round(mv * scale) : defMarginV;
  const fontName = sanitizeAssFont(style?.font) || SUBTITLE_FONT;
  const outline = Math.max(2, Math.round(3 * scale));
  const marginLR = Math.round(60 * scale);

  const header = [
    '[Script Info]',
    '; Generated by AIDrama subtitle.service',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},1,2,${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = (segments || []).map((seg) => {
    const text = escapeAssText(wrapSubtitleLine(seg.text, subtitleLineCapacity(dims, style))).replace(/\n/g, '\\N');
    return `Dialogue: 0,${buildAssTimecode(seg.start)},${buildAssTimecode(seg.end)},Default,,0,0,0,,${text}`;
  });

  return header.concat(events).join('\n') + '\n';
}
