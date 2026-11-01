/** 字幕样式约束（从 client/utils/subtitleStyle.js 原样移植） */

/** 画面比例 → 画布基准尺寸（短边 1080）；未知比例按竖屏处理 */
export function canonicalDims(aspectRatio) {
  if (aspectRatio === '16:9') return { width: 1920, height: 1080 };
  if (aspectRatio === '1:1') return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

/** 项目比例 → 字幕默认样式（与后端公式一致：竖屏 60/270，横屏/方形 60/60） */
export function defaultSubtitleStyle(aspectRatio) {
  const { width, height } = canonicalDims(aspectRatio);
  return {
    fontSize: 60,
    marginV: width > height ? 60 : 270,
  };
}

/** 字幕样式自定义值取值范围（短边 1080 基准像素），与后端 SUBTITLE_STYLE_LIMITS 一致 */
export const SUBTITLE_STYLE_LIMITS = { fontSize: [24, 200], marginV: [0, 800] };

export function clampSubtitleStyle(style, aspectRatio) {
  const def = defaultSubtitleStyle(aspectRatio);
  const s = { ...def, ...(style || {}) };
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
  return {
    fontSize: clamp(s.fontSize, SUBTITLE_STYLE_LIMITS.fontSize),
    marginV: clamp(s.marginV, SUBTITLE_STYLE_LIMITS.marginV),
  };
}
