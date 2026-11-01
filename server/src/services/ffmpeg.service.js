import ffmpegLib from 'fluent-ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { genFilePath } from '../utils/fileUtil.js';

let _ffmpegPath = config.ffmpegPath;
function ffmpeg() {
  const inst = ffmpegLib();
  if (_ffmpegPath) inst.setFfmpegPath(_ffmpegPath);
  return inst;
}

export function setFfmpegPath(p) { _ffmpegPath = p; if (p) ffmpegLib.setFfmpegPath(p); }

/** 获取视频时长(秒) */
export function getDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg().input(file).ffprobe((err, data) => {
      if (err) return reject(err);
      const d = data?.format?.duration;
      resolve(d ? Math.round(Number(d)) : 0);
    });
  });
}

function ffmpegBin() { return _ffmpegPath || 'ffmpeg'; }

function ffprobeBin() {
  if (_ffmpegPath) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(path.dirname(_ffmpegPath), 'ffprobe' + ext);
  }
  return 'ffprobe';
}

/** 运行原生 ffmpeg 命令（用于复杂 filter_complex，绕过 fluent-ffmpeg 限制）。opts.execCwd 可指定工作目录（如字幕滤镜用裸文件名规避路径转义） */
function runFfmpegRaw(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin(), args, {
      maxBuffer: 1 << 24,
      // 兜底超时：滤镜图异常（如 probe 失败段注入的无限静音源）会让 ffmpeg 永不结束——
      // 无超时则 promise 永不 resolve，Job 槽位永久占用且 ffmpeg 持续吃 CPU
      timeout: opts.timeoutMs || 30 * 60 * 1000,
      killSignal: 'SIGKILL',
      ...(opts.execCwd ? { cwd: opts.execCwd } : {}),
    }, (err, _stdout, stderr) => {
      if (err) {
        const tail = (stderr || '').slice(-2000);
        const hint = err.killed ? '（ffmpeg 超时被强制终止）' : '';
        return reject(new Error((err.message || 'ffmpeg 失败') + hint + (tail ? `\n${tail}` : '')));
      }
      resolve();
    });
  });
}

/**
 * 精确探测媒体：容器时长 + 视频流时长(秒,浮点) + 是否含音频流 + 视频宽高（字幕 PlayRes 用）。
 * videoDuration 取流级 duration，比容器 format duration 更贴近实际播放时长——
 * 不同容器（mp4/mov/webm/ts…）的 format duration 常与真实流时长有微小偏差，
 * 用它做转场偏移/音视频对齐会让误差在长序列里累积成音画漂移，故单独返回供调用方择优。
 */
/**
 * moov 是否前置（faststart）。同步扫前 2MB 的顶层 box：moov 出现在 mdat 之前即为前置。
 * 背景：第三方视频 API 返回的 MP4 及 ffmpeg 默认输出的 MP4 moov 都在文件尾，
 * 流式播放器起播要先跳到文件尾拉索引再回头拉数据；弱网真机（鸿蒙端实测）播放数秒
 * 缓冲耗尽后播放器重载回 0，表现为「播 2 秒回到开头循环」。moov 前置后数据可纯顺序
 * 下载，是消除该循环的关键一步。详见 scripts/remuxFaststart.js（存量批量修复）。
 */
export function moovIsFaststart(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(2 * 1024 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    let pos = 0;
    while (pos + 8 <= read) {
      let size = buf.readUInt32BE(pos);
      const typ = buf.toString('latin1', pos + 4, pos + 8);
      if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8)); // 64 位 box 大小
      if (size < 8) break; // 非法布局，交由 ffmpeg 兜底
      if (typ === 'moov') return true;
      if (typ === 'mdat') return false;
      pos += size;
    }
    return false; // 前 2MB 没扫到 moov（moov 必在尾部）
  } finally {
    fs.closeSync(fd);
  }
}

/** 无损重排为 faststart（-c copy 不重编码，秒级），成功后原子替换原文件；失败保留原文件并抛错。 */
export async function remuxFaststart(file) {
  if (moovIsFaststart(file)) return false;
  const tmp = `${file}.faststart.${process.pid}.${Date.now()}.mp4`;
  await runFfmpegRaw(['-y', '-i', file, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp], { timeoutMs: 10 * 60 * 1000 });
  fs.renameSync(tmp, file); // 同目录 rename，原子替换
  return true;
}

export function probeMedia(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,avg_frame_rate,sample_aspect_ratio,width,height', '-of', 'json', file];
    execFile(ffprobeBin(), args, { maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(stdout);
        const duration = parseFloat(j.format?.duration) || 0;
        const hasAudio = Array.isArray(j.streams) && j.streams.some((s) => s.codec_type === 'audio');
        const vStream = Array.isArray(j.streams) ? j.streams.find((s) => s.codec_type === 'video') : null;
        const vd = vStream ? parseFloat(vStream.duration) : 0;
        const parseFps = (s) => {
          if (!s || s === '0/0') return 0;
          const [num, den] = String(s).split('/').map(Number);
          return den ? num / den : 0;
        };
        resolve({
          duration, hasAudio,
          videoDuration: Number.isFinite(vd) ? vd : 0,
          fps: vStream ? parseFps(vStream.avg_frame_rate) : 0,
          sar: vStream?.sample_aspect_ratio || '',
          width: vStream?.width || 0,
          height: vStream?.height || 0,
        });
      } catch (e) { reject(e); }
    });
  });
}

// 抽帧统一出口：按 outPath 扩展名分流——.png 等由 ffmpeg 直接出图；.webp 先抽临时 png 再 sharp 转码。
// 原因：部分 ffmpeg 构建（如本机 homebrew 变体，同缺 libass）未编译 libwebp 编码器，直接输出 .webp 会失败；
// 而 sharp 恒带 libwebp。抽帧产物统一 webp（q90 视觉近无损，1080p 帧约 100-300KB，比 PNG 小一个数量级），
// 与图片缩略图管道对齐；webp 作 i2v 首帧输入各家均支持（ffmpeg 亦恒带 webp 解码器）。
const FRAME_WEBP_QUALITY = 90;
async function writeFrame(args, outPath) {
  if (path.extname(outPath).toLowerCase() !== '.webp') {
    await runFfmpegRaw([...args, outPath]);
    return outPath;
  }
  const tmp = path.join(os.tmpdir(), `frame_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await runFfmpegRaw([...args, tmp]);
    await sharp(tmp).webp({ quality: FRAME_WEBP_QUALITY }).toFile(outPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return outPath;
}

/** 抽取视频的第一帧（视频生成后自动生成关键帧/预览封面；按 outPath 扩展名出 png/webp）。失败抛错，由调用方 try/catch。 */
export async function extractFirstFrame(videoPath, outPath) {
  await writeFrame(['-y', '-i', videoPath, '-frames:v', '1'], outPath);
  return outPath;
}

// 成片封面：短边 480 的 webp 一张（列表缩略图口径，与图片缩略图管道 THUMB_EDGE 对齐）
const FILM_COVER_SHORT_EDGE = 480;

/**
 * 生成成片封面：抽视频第一帧 → 按项目画幅（canvasFor 短边 480）裁切缩放出一张 webp，落 outputDir。
 * 长宽由项目画幅比例算出（9:16 → 480x854、16:9 → 854x480、1:1 → 480x480）；
 * 视频画幅与项目不一致的存量片按居中裁切对齐项目画幅。失败抛错，由调用方 try/catch（封面缺失不阻断主流程）。
 * @returns {Promise<string>} 封面绝对路径
 */
export async function extractFilmCover(videoPath, aspect) {
  const { width, height } = canvasFor(aspect, FILM_COVER_SHORT_EDGE);
  // 复用 writeFrame 的 webp 分流出临时 png（部分 ffmpeg 构建无 libwebp），再 sharp 裁切缩放
  const tmp = path.join(os.tmpdir(), `cover_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  const { absPath } = genFilePath(config.outputDir, 'webp', 'episode_cover');
  try {
    await runFfmpegRaw(['-y', '-i', videoPath, '-frames:v', '1', tmp]);
    await sharp(tmp)
      .resize(width, height, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82 })
      .toFile(absPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return absPath;
}

/**
 * 抽取视频的最后一帧（视频生成后保存尾帧备用，例如作为下一镜图生视频的首帧延续；按 outPath 扩展名出 png/webp）。
 * 实现：先 -sseof 定位到末尾前 2s（限制 reverse 滤镜需缓冲的帧数，避免长视频内存膨胀），
 * 再用 reverse 滤镜把缓冲区倒序输出，配合 -frames:v 1 即取到精确尾帧（reverse 的首帧＝输入尾帧）。
 * 失败抛错，由调用方 try/catch。
 */
export async function extractLastFrame(videoPath, outPath) {
  await writeFrame(['-y', '-sseof', '-2', '-i', videoPath, '-vf', 'reverse', '-frames:v', '1'], outPath);
  return outPath;
}

/**
 * 抽取视频在指定时间点（秒）的帧（视频转图片关键帧：均匀取帧用；按 outPath 扩展名出 png/webp）。
 * 输入侧 -ss 快速定位（先 seek 再解码，与 assembleEdit 同范式），-frames:v 1 只出一帧。
 * 失败抛错，由调用方 try/catch。
 */
export async function extractFrameAt(videoPath, timeSec, outPath) {
  const t = Math.max(0, Number(timeSec) || 0).toFixed(3);
  await writeFrame(['-y', '-ss', t, '-i', videoPath, '-frames:v', '1'], outPath);
  return outPath;
}

/**
 * 提取视频音轨为 ASR 友好的 mp3（单声道 16kHz 64kbps，体积小、各类转写接口通吃）。
 * 成片缺音轨时 ffmpeg 会失败，由调用方 try/catch 提示。失败抛错。
 */
export async function extractAudio(videoPath, outPath) {
  await runFfmpegRaw(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outPath]);
  return outPath;
}

/**
 * 把声音样本规整为视频生成「参考音频」契约内的 mp3（各 provider 仅收 wav/mp3 且限长）：
 * 裁剪到 maxSeconds 内、丢弃视频流、单声道 44.1kHz 128kbps（15s 约 230KB，远低于单文件 15MB
 * 与请求体 64MB 上限，避免大文件 Base64）。调用方负责删除输出临时文件。失败抛错，由调用方降级跳过该样本。
 */
export async function prepareReferenceAudio(inputPath, maxSeconds, outPath) {
  await runFfmpegRaw(['-y', '-i', inputPath, '-vn', '-t', String(maxSeconds), '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', outPath]);
  return outPath;
}

/**
 * 把上传视频规整为视频生成「参考视频」契约内的 mp4（各 provider 限时长/限单文件大小，且请求体 ≤64MB）：
 * 裁剪到 maxSeconds 内、长边压到 ≤1280（参考用画质足够，大幅压体积降低 Base64 膨胀）、
 * h264 crf28 + aac 64k + faststart。调用方负责删除输出临时文件。失败抛错，由调用方降级跳过该视频。
 */
export async function prepareReferenceVideo(inputPath, maxSeconds, outPath) {
  await runFfmpegRaw([
    '-y', '-i', inputPath, '-t', String(maxSeconds),
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

/**
 * 检测当前 ffmpeg 是否带 libass（ass/subtitles 滤镜）。结果进程内缓存。
 * 部分精简构建（如某些 homebrew 变体）未编译 libass，无法烧录字幕——提前给出可读错误。
 */
let _assFilterOk = null;
export async function hasAssFilter() {
  if (_assFilterOk !== null) return _assFilterOk;
  _assFilterOk = await new Promise((resolve) => {
    execFile(ffmpegBin(), ['-hide_banner', '-filters'], { maxBuffer: 1 << 22 }, (err, _stdout, stderr) => {
      if (err) return resolve(false);
      resolve(/(^|\s)(ass|subtitles)(\s|$)/m.test(_stdout + stderr));
    });
  });
  return _assFilterOk;
}

/**
 * 把 ASS 字幕烧录进视频（硬字幕，任意播放器可见）。
 * ass 滤镜的文件路径含 ":" 等字符需转义，这里改为把工作目录切到字幕所在目录、
 * 滤镜里只写裸文件名（genFilePath 产物名仅含 [a-z0-9_.]），从根上规避转义问题。
 * 视频重编码（滤镜必须）；音轨直拷；crf 20 略优于合成管线的 23，保证字幕边缘锐利。
 * 失败抛错，由调用方 try/catch。
 */
export async function burnSubtitles(videoPath, assPath, outPath) {
  if (!(await hasAssFilter())) {
    throw new Error('当前 ffmpeg 未编译 libass（缺少 ass 字幕滤镜），无法烧录硬字幕；请为服务器更换带 --enable-libass 的 ffmpeg');
  }
  await runFfmpegRaw(
    [
      '-y', '-i', videoPath,
      '-vf', `ass=${path.basename(assPath)}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outPath,
    ],
    { execCwd: path.dirname(assPath) },
  );
  return outPath;
}

/**
 * 项目画幅（'9:16'/'16:9'/'1:1'/'4:3'/…）→ 合成画布尺寸。
 * 短边默认 1080（另一边按比例取偶，yuv420p 要求）；shortEdge 可指定其他档位
 * （剪辑导出 720p=720 / 合成分辨率档位 480~2160，见 video.routes 的 EDIT/COMPOSE_RESOLUTIONS）。
 * 解析失败回退竖版（短边=shortEdge）；与前端 subtitleStyle.js 的 canonicalDims 口径一致（16:9→1920x1080、1:1→1080x1080）。
 * ⚠ 合成画布必须跟项目画幅走——分镜视频由 provider 按 aspect_ratio 生成（横版项目出横版片段），
 *   若这里硬编码竖版，横版片段会被缩成小横条再上下垫大黑边（背景与视频长宽严重不符）。
 */
export function canvasFor(aspect, shortEdge = 1080) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(String(aspect || '').trim());
  if (m) {
    const rw = parseFloat(m[1]);
    const rh = parseFloat(m[2]);
    if (rw > 0 && rh > 0) {
      let width, height;
      if (rw >= rh) { height = shortEdge; width = Math.round((rw / rh) * shortEdge); }
      else { width = shortEdge; height = Math.round((rh / rw) * shortEdge); }
      width += width % 2;
      height += height % 2;
      return { width, height };
    }
  }
  const h = Math.round((shortEdge * 16) / 9);
  return { width: shortEdge, height: h + (h % 2) };
}

// 画幅归一化滤镜：等比缩入画布 + 居中补边（比例不一致的片段保内容加黑边）+ 方形像素
function padTo(width, height) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

// 单段流拷贝容差：源短边与目标画布短边差 ≤16px 视为同档，可免重编码直接 copy。
// 理由：provider 常出宏块对齐变体（1088/1072/1904 等非精确 1080），±16 覆盖这类视觉不可辨
// （<1.5%）的偏差，保住「同档免重编码、零质量损失」的快路径；升/降档（差值 ≥ 数百 px）远超
// 容差，必须按画布归一化重编码——否则成片分辨率与用户所选（已按系数计费的）档位不符。
const SINGLE_COPY_TOL = 16;

// 转场策略：不再自动添加转场——仅当用户在分镜上手动设置了转场时才插入过渡片段，
// 未设置 / 历史值 'auto' 一律硬切（短剧节奏）。

// 用户可选的转场特效白名单（ffmpeg xfade transition 名称）。
// 'cut' 为特殊值（硬切，不走 xfade）；'auto'/null 同样视为硬切。
const TRANSITION_WHITELIST = new Set([
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'radial', 'pixelize',
]);

// 传统重叠式转场时长（秒）：相邻两段重叠该时长，在重叠区用 xfade 做转场。
// 不再插入独立过渡片段——转场从相邻片段末尾/开头借时长重叠，总时长 = Σdur − (转场边界数)×该值。
const XFADE_DURATION = 0.5;

// （已弃用）插入式过渡片段各相位时长：前 hold A → 中间转场效果 → 后 hold B。
// 旧"插入独立过渡片段"方案已切换为传统重叠式 xfade，下列常量仅供 generateTransitionClip 历史兼容。
const TRANS_HOLD_A = 0.25;  // 前面 hold：A 单独可见
const TRANS_EFFECT = 0.5;   // 中间过渡效果时长
const TRANS_HOLD_B = 0.01;  // 后面 hold：B 收尾

/**
 * 解析某一边界的转场类型（连接 prev → next）。
 * 仅认用户手动设置：prev.transition 为白名单内 xfade 名 → 该名称；
 * 'cut' / 未设置 / null / 历史值 'auto' / 非法值 → null（硬切，不再自动判断）。
 */
function resolveTransition(prev) {
  const override = prev && prev.transition;
  if (override != null && override !== 'auto' && TRANSITION_WHITELIST.has(override)) {
    return override;
  }
  return null;
}

/**
 * 把一张图片做成带 Ken Burns 推拉效果的 mp4（真实的本地视频生成兜底）
 * @param {string} imagePath 本地图片路径
 * @param {number} duration 秒
 * @param {string} outPath 输出 mp4 路径
 * @param {string} [aspect] 项目画幅（'9:16'/'16:9'/…），决定输出画布；缺省竖版
 */
export function imageToVideo(imagePath, duration, outPath, aspect = '9:16') {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(imagePath)) return reject(new Error('图片不存在: ' + imagePath));
    const { width, height } = canvasFor(aspect);
    const totalFrames = Math.max(1, Math.round(duration * 25));
    // 随机轻微推拉方向（用 duration 派生避免随机）
    const dir = duration % 2 === 0 ? 'zoompan' : 'zoomout';
    const vf = [
      `scale=${width}:-2`,
      dir === 'zoompan'
        ? `zoompan=z='min(zoom+0.0015,1.25)':d=${totalFrames}:s=${width}x${height}:fps=25`
        : `zoompan=z='if(eq(on,1),1.25,max(zoom-0.0015,1.0))':d=${totalFrames}:s=${width}x${height}:fps=25`,
      `setsar=1`,
    ].join(',');

    const cmd = ffmpeg().input(imagePath).inputFPS(1);
    cmd.outputOptions([
      '-t', String(duration),
      '-vf', vf,
      '-pix_fmt', 'yuv420p',
      '-r', '25',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
    ]);
    cmd.outputOptions(['-an']);
    cmd.output(outPath)
      .on('end', () => resolve(outPath))
      .on('error', (err) => {
        // 退化：纯静态图转视频（无特效）
        logger.warn('zoompan 失败，退化为静态转视频:', err.message);
        staticImageToVideo(imagePath, duration, outPath, aspect).then(resolve, reject);
      })
      .run();
  });
}

function staticImageToVideo(imagePath, duration, outPath, aspect = '9:16') {
  return new Promise((resolve, reject) => {
    const { width, height } = canvasFor(aspect);
    const cmd = ffmpeg().input(imagePath).loop(duration).outputOptions([
      '-vf', padTo(width, height),
      '-t', String(duration),
      '-pix_fmt', 'yuv420p',
      '-r', '25',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
    ]);
    cmd.outputOptions(['-an']);
    cmd.output(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .run();
  });
}

/**
 * 拼接多个视频（兜底：无转场，按顺序硬切）。
 * 不同片段可能是不同格式/分辨率/帧率/采样率，统一归一化后再用 concat 滤镜拼接，
 * 避免 concat demuxer 对异构参数产生时间戳错乱（音画不同步）。缺音频的片段自动补静音轨。
 * 画布按项目画幅（aspect）+ 短边（shortEdge，用户所选分辨率档位）——横版项目合成横版成片，不再硬塞竖版画布。
 * 单段仅当源短边与目标差 ≤ SINGLE_COPY_TOL 时流拷贝（同档免重编码），否则统一归一化到目标画布。
 * @param {string[]} inputPaths 本地视频路径
 * @param {string} outPath 输出 mp4 路径
 * @param {string} [aspect] 项目画幅（'9:16'/'16:9'/…）
 * @param {number} [shortEdge=1080] 成片画布短边（用户所选分辨率档位）
 */
export async function concatVideos(inputPaths, outPath, aspect = '9:16', shortEdge = 1080) {
  if (!inputPaths.length) throw new Error('没有可拼接的视频');
  const { width, height } = canvasFor(aspect, shortEdge);

  // 单段：源短边与目标同档（差 ≤容差）或 probe 失败（无从判断）时维持流拷贝快路径（零重编码）；
  // 明确不同档 → 跳过 copy 落到下方统一归一化编码路径（concat n=1 合法；probe 已成功、时长可用）
  if (inputPaths.length === 1) {
    const probe = await probeMedia(inputPaths[0]).catch(() => null);
    const srcShort = probe ? Math.min(probe.width || 0, probe.height || 0) : 0;
    if (!(srcShort > 0 && Math.abs(srcShort - shortEdge) > SINGLE_COPY_TOL)) {
      try {
        await runFfmpegRaw(['-y', '-i', inputPaths[0], '-c', 'copy', '-movflags', '+faststart', outPath]);
        return outPath;
      } catch (err) {
        logger.warn('单段流拷贝失败，退化为画布归一化编码:', err.message);
      }
    }
  }

  const n = inputPaths.length;
  // probe 失败的段不能进装配：时长未知 → trim/apad 缺失 + anullsrc 无限静音源会让整条
  // 音频 concat 链永不 EOF（ffmpeg 无限编码静音直到被超时杀掉）。文件损坏/不可读时直接失败，
  // 让上层走失败退款，而不是产出截短视频或永久挂死
  const probes = await Promise.all(inputPaths.map((p) => probeMedia(p)));
  if (probes.some((p) => !p || !(p.videoDuration > 0 || p.duration > 0))) {
    throw new Error('分段媒体探测失败（文件缺失或损坏），无法装配成片');
  }

  const args = ['-y'];
  const audioInputIndex = new Map(); // clipIndex -> 音频来源的输入索引
  for (let i = 0; i < n; i++) {
    args.push('-i', inputPaths[i]);
    audioInputIndex.set(i, i);
  }
  let nextInput = n;
  for (let i = 0; i < n; i++) {
    if (!probes[i].hasAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      audioInputIndex.set(i, nextInput);
      nextInput++;
    }
  }

  // 视频/音频分别归一化到统一参数，再用 concat 滤镜拼接（时间戳连续，杜绝异构格式错位）。
  // ⚠ 每段视频/音频都按"该段基准时长 D"trim+apad 对齐——否则各段视频流与音频流天然长度不等时，
  //   视频/音频两条 concat 链会逐段错位，表现为口型与台词累积错位（混入不同 provider 片段时更明显）。
  //   D 取视频流时长(回退容器时长)并对齐到 25fps 帧边界。
  const FRAME = 1 / 25;
  const toFrame = (sec) => Math.floor((Number(sec) || 0) / FRAME) * FRAME;
  const segDur = (i) => {
    const raw = probes[i].videoDuration > 0 ? probes[i].videoDuration : probes[i].duration;
    return raw > 0 ? toFrame(raw) : 0;
  };
  const filters = [];
  for (let i = 0; i < n; i++) {
    const d = segDur(i);
    const dStr = d.toFixed(3);
    const vTrim = d > 0 ? `trim=duration=${dStr},setpts=PTS-STARTPTS,` : '';
    const aAlign = d > 0
      ? `atrim=0:${dStr},asetpts=PTS-STARTPTS,apad=whole_dur=${dStr},asetpts=PTS-STARTPTS,`
      : 'aresample=44100,';
    filters.push(`[${i}:v]${padTo(width, height)},fps=25,${vTrim}format=yuv420p[v${i}]`);
    filters.push(`[${audioInputIndex.get(i)}:a]${aAlign}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
  }
  const vChain = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
  const aChain = Array.from({ length: n }, (_, i) => `[a${i}]`).join('');
  filters.push(`${vChain}concat=n=${n}:v=1:a=0[vout]`);
  filters.push(`${aChain}concat=n=${n}:v=0:a=1[aout]`);

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart');
  args.push(outPath);

  await runFfmpegRaw(args);
  return outPath;
}

/**
 * 以两张图片（前一镜尾帧 + 后一镜首帧）为蓝本，生成一个独立的过渡视频片段。
 *
 * 结构：hold A(TRANS_HOLD_A) → 按 trans 效果过渡(TRANS_EFFECT) → hold B(TRANS_HOLD_B)。
 *   - A -loop 到 (holdA+effect)，B -loop 到 (effect+holdB)，再 xfade：offset=holdA、duration=effect，
 *     输出总长 = holdA + effect + holdB（两图 loop 时长不同，以实现两侧不对称的 hold）。
 *   - trans 决定效果类型（fade/fadeblack/wipeleft/…，沿用既有转场白名单语义）。
 *   - 两图在同一 filter graph 内被同构归一化（项目画幅画布/25fps/sar1/yuv420p），timebase 天然一致，
 *     不会触发"异构视频流直接 xfade"的 timebase 不匹配问题（历史音画漂移根因）。
 *   - 无音频（纯视觉桥段）；最终由 concatVideos 统一补静音轨。
 * 原始两镜各自完整播放，此片段仅作插入式过渡，不影响原片节奏。
 * 失败抛错，由调用方 try/catch 决定是否降级为该边界硬切。
 */
export async function generateTransitionClip(imgA, imgB, trans, outPath, aspect = '9:16') {
  // A 需 holdA + effect（先单独 hold，再参与 blend）；B 需 effect + holdB（blend 期间引入，再单独收尾）
  const loopA = (TRANS_HOLD_A + TRANS_EFFECT).toFixed(3);
  const loopB = (TRANS_EFFECT + TRANS_HOLD_B).toFixed(3);
  const offset = TRANS_HOLD_A.toFixed(3);   // A 单独可见时长
  const duration = TRANS_EFFECT.toFixed(3); // 转场效果时长
  const { width, height } = canvasFor(aspect);
  const norm = `${padTo(width, height)},fps=25,format=yuv420p`;
  const filters = [
    `[0:v]${norm}[a]`,
    `[1:v]${norm}[b]`,
    `[a][b]xfade=transition=${trans}:duration=${duration}:offset=${offset}[vout]`,
  ];
  const args = [
    '-y',
    '-loop', '1', '-t', loopA, '-i', imgA,
    '-loop', '1', '-t', loopB, '-i', imgB,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '25',
    '-movflags', '+faststart',
    outPath,
  ];
  await runFfmpegRaw(args);
  return outPath;
}

/**
 * 拼接多个视频，分镜之间按用户手动设置的转场做传统重叠式 xfade，其余硬切。
 *
 * 转场实现（重叠式，单次 re-encode）：
 *   - 所有片段统一归一化（项目画幅画布 + 25fps + sar1 + yuv420p + 44.1k 立体声），timebase 一致，
 *     在此前提下直接对相邻归一化流做 xfade——历史"异构流直接 xfade 致音画漂移"根因已由归一化消除。
 *   - 转场边界：视频 `[prev][cur]xfade=transition=T:duration=D:offset=curLen-D`，音频
 *     `[prev][cur]acrossfade=d=D`；offset=curLen−D 使重叠区落在前段末尾，输出时长 = curLen+dur−D，
 *     音视频两条链按同一 curLen 更新、天然同步。
 *   - 硬切边界：视频/音频各 `concat=n=2`，时长相加。
 *   - 片段时长 < D（≈0.5s）的转场边界自动降级为硬切，避免 xfade offset 负值/越界。
 *   - 单段：委托 concatVideos 按容差决定流拷贝（同档）或画布归一化（不同档）；
 *     全部硬切（无任何转场）时走 concatVideos 复用；整体失败 → 回退 concatVideos（全硬切）。
 *
 * @param {string[]} inputPaths 本地视频路径
 * @param {string} outPath 输出 mp4 路径
 * @param {Array<{transition}>} [segments] 与 inputPaths 对齐的分镜元数据（仅 transition 生效，手动设置才做转场）；缺省或长度不符则全部硬切
 * @param {string} [aspect] 项目画幅（'9:16'/'16:9'/…），决定成片画布；缺省竖版
 * @param {number} [shortEdge=1080] 成片画布短边（用户所选分辨率档位）
 */
export async function concatVideosWithTransitions(inputPaths, outPath, segments = [], aspect = '9:16', shortEdge = 1080) {
  if (!inputPaths.length) throw new Error('没有可拼接的视频');

  // 单段：无需转场，能否流拷贝由 concatVideos 按容差统一判定（同档 copy / 不同档归一化编码）
  if (inputPaths.length === 1) {
    return concatVideos(inputPaths, outPath, aspect, shortEdge);
  }

  const useMeta = segments.length === inputPaths.length;
  // 全部硬切时直接复用 concatVideos（归一化硬切装配，逻辑等价且更成熟）
  const hasAnyTransition = useMeta && segments.some((s) => resolveTransition(s));
  if (!hasAnyTransition) {
    return concatVideos(inputPaths, outPath, aspect, shortEdge);
  }

  const { width, height } = canvasFor(aspect, shortEdge);
  const n = inputPaths.length;
  // 同 concatVideos：probe 失败段（时长未知）会让 anullsrc 无限静音源撑爆装配，直接失败退款
  const probes = await Promise.all(inputPaths.map((p) => probeMedia(p)));
  if (probes.some((p) => !p || !(p.videoDuration > 0 || p.duration > 0))) {
    throw new Error('分段媒体探测失败（文件缺失或损坏），无法装配成片');
  }

  // 组装 -i：每段视频一个输入；缺音频的段追加 anullsrc 静音输入
  const args = ['-y'];
  const audioInputIndex = new Map();
  for (let i = 0; i < n; i++) { args.push('-i', inputPaths[i]); audioInputIndex.set(i, i); }
  let nextInput = n;
  for (let i = 0; i < n; i++) {
    if (!probes[i].hasAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      audioInputIndex.set(i, nextInput);
      nextInput++;
    }
  }

  // 每段基准时长：取流级 videoDuration（回退容器时长），对齐到 25fps 帧边界（与 concatVideos 同口径，
  // 保证 offset/curLen 计算落到帧上，杜绝累积漂移）
  const FRAME = 1 / 25;
  const toFrame = (sec) => Math.floor((Number(sec) || 0) / FRAME) * FRAME;
  const segDur = (i) => {
    const raw = probes[i].videoDuration > 0 ? probes[i].videoDuration : probes[i].duration;
    return raw > 0 ? toFrame(raw) : 0;
  };

  const D = XFADE_DURATION;
  const filters = [];
  // 归一化每段：视频 padTo+25fps+yuv420p+setpts 重置；音频对齐到该段基准时长 D_i + 44.1k 立体声
  for (let i = 0; i < n; i++) {
    const d = segDur(i);
    const dStr = d.toFixed(3);
    filters.push(`[${i}:v]${padTo(width, height)},fps=25,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
    const aAlign = d > 0
      ? `atrim=0:${dStr},asetpts=PTS-STARTPTS,apad=whole_dur=${dStr},asetpts=PTS-STARTPTS,`
      : 'asetpts=PTS-STARTPTS,';
    filters.push(`[${audioInputIndex.get(i)}:a]${aAlign}aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
  }

  // 视频/音频两条链同步推进：转场边界 xfade/acrossfade（重叠 D），硬切边界 concat。
  // curLen 为"当前累计流时长"，xfade offset = curLen − D，新 curLen = curLen + dur_i − D；
  // acrossfade d=D 输出时长同样 = curLen + dur_i − D，故音视频 curLen 始终一致 → 音画同步。
  // 每个中间节点后置 settb/setpts/fps 归一化——concat 输出 timebase 默认为 1/1000000，若直接喂给
  // 下一个 xfade 会触发"main timebase(1/1000000) != xfade timebase(1/25)"配置失败，故统一拍齐。
  const V_POST = ',settb=1/25,setpts=PTS-STARTPTS,fps=25,format=yuv420p';
  const A_POST = ',asettb=1/25,asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  let curV = `v0`, curA = `a0`, curLen = segDur(0);
  for (let i = 1; i < n; i++) {
    const trans = useMeta ? resolveTransition(segments[i - 1]) : null;
    const di = segDur(i);
    // 片段时长不足（前段累计或本段 < D）时转场无法成立 → 降级硬切，避免 offset 负值/xfade 越界
    const canFade = trans && curLen >= D && di >= D;
    const nv = `xv${i}`, na = `xa${i}`;
    if (canFade) {
      const offset = (curLen - D).toFixed(3);
      filters.push(`[${curV}][v${i}]xfade=transition=${trans}:duration=${D.toFixed(3)}:offset=${offset}${V_POST}[${nv}]`);
      filters.push(`[${curA}][a${i}]acrossfade=d=${D.toFixed(3)}${A_POST}[${na}]`);
      curLen = curLen + di - D;
    } else {
      filters.push(`[${curV}][v${i}]concat=n=2:v=1:a=0${V_POST}[${nv}]`);
      filters.push(`[${curA}][a${i}]concat=n=2:v=0:a=1${A_POST}[${na}]`);
      curLen = curLen + di;
    }
    curV = nv; curA = na;
  }
  filters.push(`[${curV}]format=yuv420p[vout]`);
  filters.push(`[${curA}]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`);

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart');
  args.push(outPath);

  try {
    await runFfmpegRaw(args);
    logger.info(`[COMPOSE] 重叠式转场合成完成（${n} 段，xfade 时长 ${D}s，成片≈${curLen.toFixed(3)}s）`);
    return outPath;
  } catch (err) {
    logger.warn('重叠式转场拼接失败，退化为普通硬切拼接:', err.message);
    return concatVideos(inputPaths, outPath, aspect, shortEdge);
  }
}

/**
 * 单视频剪辑装配：对同一源视频按 segments 顺序取子区间拼接
 * （在线编辑器「掐头去尾 / 分割 / 删段 / 调序 → 导出」的唯一执行内核）。
 *
 * 与 concatVideos 同一帧对齐范式：每段一个输入、统一归一化（画布 + 25fps + yuv420p + 44.1k 立体声）
 * 后视频/音频两条 concat 链拼接——段间时间戳连续，杜绝音画漂移。与 concatVideos 的差异仅在：
 *  - 输入侧 '-ss ss -t T -i src'（输入侧精确 seek，快且准；-t 多读 2 帧余量防解码器少出尾帧）；
 *  - 每段基准时长 d 用「请求时长按 25fps 帧网格向下取整」（而非 probe 时长）——d×25 恒为整数帧，
 *    trim=duration=d 输出精确帧数，多段求和后与输出 probe 校验只差 ≤1 帧；
 *  - N=1 不特判：concat n=1 合法，且保证任何导出都走同一条画布/帧率/音频归一路径
 *    （stream copy 对子区间会关键帧吸附，掐头不准）。
 *
 * @param {string} srcPath 源视频本地路径
 * @param {Array<{ss:number,t:number}>} segments 有序段（秒；ss=起点，t=时长），须已通过上层校验
 * @param {string} outPath 输出 mp4 路径
 * @param {{width:number,height:number}} canvas 输出画布（调用方由 canvasFor(aspect, shortEdge) 算好）
 */
export async function assembleEdit(srcPath, segments, outPath, { width, height }) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('没有可剪辑的段');
  const probe = await probeMedia(srcPath).catch(() => ({ hasAudio: false }));
  if (!width || !height) ({ width, height } = canvasFor('9:16'));

  const FRAME = 1 / 25;
  const toFrame = (sec) => Math.floor((Number(sec) || 0) / FRAME) * FRAME;
  const segs = segments.map((s) => {
    let d = toFrame(s.t);
    if (d < FRAME) d = FRAME; // 最短保 1 帧
    return { ss: Math.max(0, Number(s.ss) || 0), d };
  });
  const n = segs.length;

  // 每段一个输入：输入侧精确 seek 到段起点，-t 给 2 帧余量（实际时长由滤镜 trim 锁定）
  const args = ['-y'];
  for (const s of segs) {
    args.push('-ss', s.ss.toFixed(3), '-t', (s.d + FRAME * 2).toFixed(3), '-i', srcPath);
  }
  // 源无音轨：逐段补静音输入（与 concatVideos 同口径，保证音频 concat 链每段都有源）
  const audioInputIndex = new Map();
  for (let i = 0; i < n; i++) audioInputIndex.set(i, i);
  let nextInput = n;
  if (!probe.hasAudio) {
    for (let i = 0; i < n; i++) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      audioInputIndex.set(i, nextInput++);
    }
  }

  const filters = [];
  for (let i = 0; i < n; i++) {
    const dStr = segs[i].d.toFixed(3);
    filters.push(`[${i}:v]${padTo(width, height)},fps=25,trim=duration=${dStr},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
    filters.push(`[${audioInputIndex.get(i)}:a]atrim=0:${dStr},asetpts=PTS-STARTPTS,apad=whole_dur=${dStr},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
  }
  const vChain = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
  const aChain = Array.from({ length: n }, (_, i) => `[a${i}]`).join('');
  filters.push(`${vChain}concat=n=${n}:v=1:a=0[vout]`);
  filters.push(`${aChain}concat=n=${n}:v=0:a=1[aout]`);

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart');
  args.push(outPath);

  await runFfmpegRaw(args);
  return outPath;
}

export { ffmpeg };
