/**
 * 项目字幕样式默认值（纯函数，供设置弹窗展示与预览共用）。
 * 与后端 subtitle.service.js 的硬编码公式保持一致：横竖屏分支以「宽 > 高」为横屏，
 * 字号 = 高/(横屏16 : 竖屏22)，离底边距 = 高/(横屏10 : 竖屏4)。
 */

/** 画面比例 → 画布基准尺寸（短边 1080）；未知比例按竖屏处理 */
export function canonicalDims(aspectRatio) {
  if (aspectRatio === '16:9') return { width: 1920, height: 1080 };
  if (aspectRatio === '1:1') return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

/** 项目比例 → 字幕默认样式（与后端公式一致的展示值：9:16→87/480，16:9→68/108，1:1→49/270） */
export function defaultSubtitleStyle(aspectRatio) {
  const { width, height } = canonicalDims(aspectRatio);
  return {
    fontSize: Math.round((width > height ? 60 : 60)),
    marginV: Math.round((width > height ? 60 : 270)),
  };
}

/** 字幕样式自定义值取值范围（短边 1080 基准像素），与后端 SUBTITLE_STYLE_LIMITS 一致 */
export const SUBTITLE_STYLE_LIMITS = { fontSize: [24, 200], marginV: [0, 800] };
