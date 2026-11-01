// AIGC 显式标识服务（合规）：按《人工智能生成合成内容标识办法》要求，对 AI 生成的
// 图片/视频添加显式可见标识（「AI生成」+「AI-generated」小字，右下角）。
//
// 能力：
//   1) ensureLabelPng()：用 sharp 生成半透明角标 PNG 源图（深色底 + 白字），落 data/aigc-label.png，
//      480px 宽源图，幂等（已存在即跳过）；
//   2) labelVideo(inputPath, outputPath)：ffmpeg PNG overlay 给成片右下角打角标
//      （drawtext 跨平台字体不可靠，故预渲染 PNG 再 overlay）；
//   3) labelImage(bufOrPath)：sharp composite 给图片右下角打角标，返回 buffer。
//
// 降级原则：ffmpeg 缺失/执行失败/角标生成失败 → console 告警并原样返回输入，
// 绝不阻塞生成业务主流程（合规标识缺失可事后补，业务失败不可逆）。
// 接入口径：只给「最终成片 / 对外展示图」打标（合成成片、AI 封面）；分镜图/资产图等
// 中间素材不打标——中间素材带角标会把标识像素传导进后续生成结果。
//
// 开关：env AIGC_LABEL，'0' / 'false'（不分大小写）关闭，默认开启。
// 注意：本模块不读 src/config（除 ffmpegPath 复用），新增 env 一律在模块内 process.env 直读。
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// 角标源图落盘位置：data/aigc-label.png（/files 静态只暴露 uploads/outputs 子目录，源图不对外）
const LABEL_PATH = path.resolve(process.cwd(), 'data', 'aigc-label.png');
const LABEL_SRC_WIDTH = 480;  // 源图宽（px）
const LABEL_SRC_HEIGHT = 150; // 源图高（px），宽高比供 overlay/图片缩放换算

let _ffmpegOk = null; // null = 未探测；探测结果进程内缓存

/** 开关：AIGC_LABEL=0/false 关闭，默认开 */
export function aigcLabelEnabled() {
  const v = String(process.env.AIGC_LABEL ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

/** 角标源图：深色半透明圆角底 + 白色主标识（中文字体列表逐级兜底，最终 sans-serif） */
function labelSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_SRC_WIDTH}" height="${LABEL_SRC_HEIGHT}">
  <rect x="0" y="0" width="${LABEL_SRC_WIDTH}" height="${LABEL_SRC_HEIGHT}" rx="18" fill="#000000" fill-opacity="0.55"/>
  <text x="26" y="82" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, WenQuanYi Micro Hei, sans-serif" font-size="60" font-weight="bold" fill="#FFFFFF">AI生成</text>
  <text x="28" y="126" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="26" fill="#FFFFFF" fill-opacity="0.82">AI-generated</text>
</svg>`;
}

/** 生成角标 PNG（幂等：已存在即跳过）。返回是否可用（关闭/失败均 false，调用方据此降级） */
export async function ensureLabelPng() {
  if (!aigcLabelEnabled()) return false;
  if (fs.existsSync(LABEL_PATH)) return true;
  try {
    fs.mkdirSync(path.dirname(LABEL_PATH), { recursive: true });
    const tmp = `${LABEL_PATH}.${process.pid}.${Date.now()}.tmp`;
    await sharp(Buffer.from(labelSvg())).png().toFile(tmp);
    fs.renameSync(tmp, LABEL_PATH); // 同目录 rename，避免并发请求读到半写文件
    return true;
  } catch (e) {
    logger.warn('[aigc-label] 角标 PNG 生成失败，标识将降级跳过:', e?.message || e);
    return false;
  }
}

function ffmpegBin() {
  return config.ffmpegPath || 'ffmpeg'; // 与 ffmpeg.service 同口径：支持自定义 ffmpeg 路径
}

/** 探测 ffmpeg 可用性（进程内只探测一次） */
async function probeFfmpeg() {
  if (_ffmpegOk != null) return _ffmpegOk;
  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegBin(), ['-version'], { timeout: 5000 }, (e) => (e ? reject(e) : resolve()));
    });
    _ffmpegOk = true;
  } catch (e) {
    _ffmpegOk = false;
    logger.warn('[aigc-label] ffmpeg 不可用，视频/图片标识降级跳过:', e?.message || e);
  }
  return _ffmpegOk;
}

/**
 * 给视频打 AI 生成角标：右下角，角标宽 = 源图 1/4 缩放（480→120px），距边 24px。
 * 整条 ffmpeg 链路（转场/concat）完成后的成品后处理，不介入既有合成流程。
 * @param {string} inputPath 输入视频绝对路径
 * @param {string} [outputPath] 输出路径；缺省/与输入相同 → 先出临时文件再同目录原位替换（rename 原子）
 * @returns {Promise<string>} 最终生效的文件路径（成功 = 带标识输出；开关关闭/降级 = 原路径不变）
 */
export async function labelVideo(inputPath, outputPath) {
  const inPlace = !outputPath || path.resolve(outputPath) === path.resolve(inputPath);
  const dest = inPlace ? inputPath : outputPath;
  if (!aigcLabelEnabled()) return dest;
  let tmp = `${dest}.aigc.${process.pid}.${Date.now()}.mp4`;
  try {
    if (!(await probeFfmpeg())) return dest;
    if (!(await ensureLabelPng())) return dest;
    // 音频优先流拷贝（零损耗）；源音轨编码与 mp4 不兼容（罕见）时整体失败，下面降级重编一次
    const attempt = (audioArgs) => new Promise((resolve, reject) => {
      const args = [
        '-y', '-i', inputPath, '-i', LABEL_PATH,
        '-filter_complex', '[1]scale=iw/4:-1[label];[0][label]overlay=W-w-24:H-h-24',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        ...audioArgs,
        '-movflags', '+faststart',
        '-metadata', 'comment=AI-generated content',
        tmp,
      ];
      execFile(ffmpegBin(), args, { maxBuffer: 1 << 24, timeout: 30 * 60 * 1000, killSignal: 'SIGKILL' },
        (err, _stdout, stderr) => (err ? reject(new Error((err.message || 'ffmpeg 失败') + (stderr ? `\n${String(stderr).slice(-1000)}` : ''))) : resolve()));
    });
    try {
      await attempt(['-c:a', 'copy']);
    } catch (e1) {
      logger.warn('[aigc-label] 音频流拷贝失败，改为重编码音频重试:', e1?.message || e1);
      tmp = `${dest}.aigc.${process.pid}.${Date.now()}.mp4`;
      await attempt(['-c:a', 'aac', '-b:a', '128k']);
    }
    fs.renameSync(tmp, dest); // 同目录 rename：原位原子替换（episode_videos.video_url 指向的即带标识文件）
    return dest;
  } catch (e) {
    logger.warn('[aigc-label] 视频标识失败，降级使用未标识文件:', e?.message || e);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理失败不影响主流程 */ }
    return dest;
  }
}

/**
 * 给图片打 AI 生成角标：右下角，角标宽 = 图片宽 1/4，边距 ≈ 图宽 2.5%。
 * @param {Buffer|string} bufOrPath 图片 buffer 或文件路径
 * @returns {Promise<Buffer>} 带角标的 PNG buffer（开关关闭/降级时返回未打标的 PNG / 原始 buffer）
 */
export async function labelImage(bufOrPath) {
  const asPng = () => sharp(bufOrPath).png().toBuffer();
  if (!aigcLabelEnabled()) return asPng();
  try {
    if (!(await ensureLabelPng())) return asPng();
    const meta = await sharp(bufOrPath).metadata();
    if (!meta.width) return asPng();
    const lw = Math.max(48, Math.round(meta.width / 4));
    const margin = Math.max(8, Math.round(meta.width / 40));
    const labelBuf = await sharp(LABEL_PATH).resize({ width: lw }).png().toBuffer();
    const lh = Math.round((lw * LABEL_SRC_HEIGHT) / LABEL_SRC_WIDTH);
    return await sharp(bufOrPath)
      .composite([{
        input: labelBuf,
        left: Math.max(0, meta.width - lw - margin),
        top: Math.max(0, (meta.height || 0) - lh - margin),
      }])
      .png()
      .toBuffer();
  } catch (e) {
    logger.warn('[aigc-label] 图片标识失败，降级使用未标识图:', e?.message || e);
    if (Buffer.isBuffer(bufOrPath)) return bufOrPath;
    return fs.readFileSync(bufOrPath);
  }
}
