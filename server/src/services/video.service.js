import axios from "axios";
import fs from "fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveConfig, getConfig, resolveSystemConfig, vendorParams } from "./modelConfig.service.js";
import { complete } from "./llm.service.js";
import { imageToVideo, probeMedia, prepareReferenceAudio, prepareReferenceVideo } from "./ffmpeg.service.js";
import { genFilePath, toUrl, urlToPath } from "../utils/fileUtil.js";
import { signMediaUrl, MEDIA_SIGN_PROVIDER_TTL_MS } from "../utils/mediaSign.js";
import { config } from "../config/index.js";
import { logger, maskKey } from "../utils/logger.js";
import { writeSubmissionLog, writeResponseLog } from "../utils/submitLog.js";
import {
  createGenerationRecord, createSyncSuccessRecord, createFailedSubmitRecord, waitForGeneration, findJobGeneration,
} from "./videoGenTracking.service.js";

// 资产类型 -> 中文词，用于日志描述（让运维一眼看出命中的是人/物/景）
function kindWord(kind) {
  return { character: "角色", scene: "场景", prop: "道具", material: "素材", video: "视频" }[kind] || "资产";
}

// ---- admin「任务状态查询」出站请求捕获（modelconfig /task-query 调试用）----
// 6 个厂商查询 handler 的唯一出站调用点统一走 queryVendorGet：路由侧用 vendorQueryCapture.run()
// 包住 handler 调用即可按调用上下文取到「提交给厂商」的请求描述（URL/方法/头/超时），
// AsyncLocalStorage 保证并发隔离；未包住的调用方（扫描器/提交链路）getStore 为空，零开销透传。
export const vendorQueryCapture = new AsyncLocalStorage();

// 出站请求描述：鉴权头脱敏（保留 Bearer 前缀，与 submitLog 同口径），密钥不回传前端
function describeOutbound(conf = {}, url) {
  const headers = { ...(conf.headers || {}) };
  if (headers.Authorization != null) {
    const raw = String(headers.Authorization);
    headers.Authorization = /^Bearer\s+/i.test(raw)
      ? `Bearer ${maskKey(raw.replace(/^Bearer\s+/i, ""))}`
      : maskKey(raw);
  }
  const desc = { method: "GET", url, headers };
  if (conf.timeout != null) desc.timeout = conf.timeout;
  return desc;
}

// 查询 handler 的出站调用点：先捕获请求描述再发起（请求失败也已有捕获）
function queryVendorGet(url, conf) {
  const store = vendorQueryCapture.getStore();
  if (store) store.push(describeOutbound(conf, url));
  return axios.get(url, conf);
}

// 提交体日志：完整提交数据打成一行 JSON 便于排查；若仍出现 base64 长字段（data:<mime>;base64,xxx，
// 历史配置的 params 等来源）截断只保留前 50 字，避免几 MB 编码撑爆日志——完整原文落两处：
// server/logs/<日期>/ 提交日志文件（writeVideoSubmitLog，不截断）与 video_generations.params 留档，
// 需要全文去那里查（提交媒体已全面改为公网 URL，不再编码 Base64）
const SUBMIT_LOG_B64_KEEP = 50;

// 视频提交完整留档（与 llm.service 文本提交同机制）：把每次提交给视频厂商的完整提交数据
// （一律 URL 模式、无 Base64）异步写入 server/logs/<日期>/<HHmmss_SSS>_video_u<userId>_req.json，
// headers 密钥脱敏；写失败仅告警，绝不影响提交主流程
function writeVideoSubmitLog({ tag, userId, url, model, headers, body, logCtx = {}, genCtx = {} }) {
  return writeSubmissionLog({
    userId, type: "video", mode: "req", provider: tag,
    url, model, headers, body,
    extra: { ...logCtx, genCtx },
  });
}

// 提交返回留档：与 writeVideoSubmitLog 经 reqFile 精确配对，记录厂商即时返回。
// 异步厂商（Seedance/DashScope/MiniMax/Agnes/ComfyUI）此时只是任务 id 形态；
// 厂商终态结果已由扫描器落 video_generations.raw，此处不重复留档
function writeVideoResponseLog({ tag, userId, url, model, resp, reqFile, durationMs, genCtx = {} }) {
  writeResponseLog({
    userId, type: "video", provider: tag,
    url, model, resp, reqFile, durationMs,
    extra: { genCtx },
  });
}

function truncateLogValue(value, depth = 0) {
  if (typeof value === "string") {
    if (value.length > SUBMIT_LOG_B64_KEEP && /^data:[^,]{0,64};base64,/i.test(value)) {
      return `${value.slice(0, SUBMIT_LOG_B64_KEEP)}…(base64，共${value.length}字已截断)`;
    }
    return value;
  }
  if (Array.isArray(value)) return depth >= 6 ? "[…]" : value.map((v) => truncateLogValue(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth >= 6) return "{…}";
    const out = {};
    for (const k of Object.keys(value)) out[k] = truncateLogValue(value[k], depth + 1);
    return out;
  }
  return value;
}

function submitBodyLog(body) {
  try {
    return JSON.stringify(truncateLogValue(body));
  } catch {
    return String(body);
  }
}

// 各 provider「参考音频」契约限档：maxCount=段数上限 / maxPer=单段秒数上限 / maxTotal=总时长上限
// 依据：Seedance 2.5 单段[2,30]s、≤10段、总≤30s；Seedance 2.0 系列与 MiniMax 均为单段[2,15]s、≤3段、总≤15s；仅收 wav/mp3
// 总时长在候选角色间均分（见 collectRefAudios），避免首个长样本吃光预算把靠后角色的音色挤掉
const REF_AUDIO_LIMITS = {
  seedance25: { maxCount: 10, maxPer: 30, maxTotal: 30 },
  seedance20: { maxCount: 3, maxPer: 15, maxTotal: 15 },
  minimax: { maxCount: 3, maxPer: 15, maxTotal: 15 },
  // Agnes Video 2.5：≤3 段、总时长[2,12]s、单文件<15MB（collectRefAudios 单段最短 2s 已覆盖契约下限）
  agnes: { maxCount: 3, maxPer: 12, maxTotal: 12 },
  // 万相3.0（wan3.0-video 全模态参考）：≤5 段、单段[1,15]s（单段最短 2s 已覆盖契约下限）、总≤15s、单文件<15MB（仅 wav/mp3）
  aliwan: { maxCount: 5, maxPer: 15, maxTotal: 15 },
};

// 各 provider「参考视频」(reference_video) 契约限档：与参考音频完全对称
// 依据：Seedance 2.5 ≤10段/总≤30s；Seedance 2.0 系列与 MiniMax 均 ≤3段/单段[2,15]s/总≤15s
// （MiniMax 单文件≤50MB、请求体≤64MB——本实现一律以外网 URL 提交（PUBLIC_BASE_URL，provider 自行拉取），
//   超时长/非 mp4/超 50MB 的先转码为小体积 mp4 后仍以 URL 提交，见 collectRefVideos）
const REF_VIDEO_LIMITS = {
  seedance25: { maxCount: 10, maxPer: 30, maxTotal: 30 },
  seedance20: { maxCount: 3, maxPer: 15, maxTotal: 15 },
  minimax: { maxCount: 3, maxPer: 15, maxTotal: 15 },
  // Agnes Video 2.5：≤1 个、总时长[2,12]s、单文件<50MB（mp4）
  agnes: { maxCount: 1, maxPer: 12, maxTotal: 12 },
  // 万相3.0（wan3.0-video 全模态参考）：≤5 段、单段[1,15]s、总≤15s、单文件<100MB（mp4/mov，非 mp4 先转码）
  aliwan: { maxCount: 5, maxPer: 15, maxTotal: 15 },
};

// 「去除字幕」编辑提示词：原视频为唯一输入（@视频1），仅擦除画面中的字幕文字、其余保持不变
const ERASE_SUBTITLE_PROMPT =
  "请以@视频1为唯一依据重绘输出：完整保留其画面内容、人物、动作、运镜与节奏，仅擦除画面中出现的所有字幕与文字，其他均保持不变。";

// Seedance 2.x 系列识别（模型名形如 doubao-seedance-2-0-xxx / seedance-2.5-xxx；
// 要求 2 与档位间有分隔符，避免误匹配 250428 之类日期后缀；1.x 系列不支持参考音频）
function isSeedance2x(model) {
  return /2[.\-_][0-9]/.test(String(model || ""));
}

// Seedance 参考音频限档：2.5 系列放宽到 30s/10段，其余 2.x 按 2.0 系列 15s/3段
function seedanceAudioLimits(model) {
  return /2[.\-_]5/.test(String(model || "")) ? REF_AUDIO_LIMITS.seedance25 : REF_AUDIO_LIMITS.seedance20;
}

// Seedance 参考视频限档：与音频同规则（2.5 系列放宽，其余 2.x 按 2.0 系列）
function seedanceVideoLimits(model) {
  return /2[.\-_]5/.test(String(model || "")) ? REF_VIDEO_LIMITS.seedance25 : REF_VIDEO_LIMITS.seedance20;
}

// 声音样本 URL -> 本地文件路径；远程 http(s) 样本返回 null（无法探测/裁剪，只能原样透传）
function audioLocalPath(url) {
  const isLocal = String(url).startsWith("/files/")
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/files\//i.test(url)
    || (config.publicBaseUrl && url.startsWith(config.publicBaseUrl));
  if (!isLocal) return null;
  try { return urlToPath(url); } catch { return null; }
}

// 本地 /files 视频 -> 外网绝对 URL（PUBLIC_BASE_URL）：参考视频让 provider 自行拉取，
// 避免大文件 Base64 撑爆 64MB 请求体。非本地 /files 或未配置 PUBLIC_BASE_URL 时返回 null（调用方跳过）。
// 出口统一做媒体时效签名：先剥历史 query（兼容前端回传的已签名 URL）再签，TTL 放长 24h 覆盖厂商长任务与重试。
function publicFilesUrl(url) {
  const base = config.publicBaseUrl;
  const bare = String(url || "").split("?")[0];
  if (!base) return null;
  let out = null;
  if (bare.startsWith("/files/")) out = base + bare; // base 已去尾斜杠
  else if (/^https?:\/\//i.test(bare) && bare.startsWith(base)) out = bare; // 已是本服务公网绝对 URL
  else {
    // 本机绝对 URL（localhost/127.0.0.1）：取其 /files/ 路径重建公网 URL
    const m = bare.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/files\/[^\s]*)$/i);
    if (m) out = base + m[1];
  }
  return out ? signMediaUrl(out, MEDIA_SIGN_PROVIDER_TTL_MS) : null;
}

// 媒体 URL 规整（视频生成统一出口，已全面禁用 Base64）：本机 /files（相对 / localhost / 本服务公网
// 绝对形态）映射 PUBLIC_BASE_URL 公网 URL（出口统一媒体时效签名，TTL 24h）；远程 http(s) URL 原样
// 透传；本机文件缺失（孤儿路径）或无法映射（未配置 PUBLIC_BASE_URL）返回 null，调用方跳过并留痕。
function resolveMediaUrl(url) {
  const raw = String(url || "");
  if (!raw) return null;
  const byUrl = publicFilesUrl(raw);
  if (byUrl) {
    try { return fs.existsSync(urlToPath(raw)) ? byUrl : null; } catch { return null; } // 孤儿路径不出 URL
  }
  // 远程 URL（CDN 等）透传；本机 localhost 绝对 URL 在未配置 PUBLIC_BASE_URL 时厂商不可达，判不可用
  if (/^https?:\/\//i.test(raw) && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?/i.test(raw)) return raw;
  return null;
}

/**
 * 收集引用资产（角色）绑定的声音样本，并按 provider 契约限档规整为参考音频（一律以 URL 提交，不编码 Base64）：
 * - 按 asset_refs 顺序逐角色取 voice_url（segmentVideo 已逐角色解析）；
 * - 本地样本：probeMedia 探时长，超单段预算 / 扩展名不合规（契约仅收 wav/mp3）/ 大于 15MB 时经
 *   prepareReferenceAudio 裁剪转码为小体积 mp3，产物落 uploads（refaudio_ 前缀）以 /files 公网 URL
 *   提交（provider 拉取的是转码结果，保留不删）；不足契约最短单段 2s 的样本跳过；
 *   未配置 PUBLIC_BASE_URL 无法映射公网 URL 的样本跳过；
 * - 远程样本无法探测，原样透传，并按其均分份额计入总量；
 * - 总时长上限在「待附加候选」间均分（每段≥2s、≤单段上限）：先到先得会让首个长样本吃光总预算、
 *   靠后角色被静默丢弃；有候选被跳过或实际不足份额时，余额自动流向靠后角色；段数用尽即止。
 * （ComfyUI 不挂载音频——见 viaComfyUI，URL-only 形态已随之移除。）
 * 单个样本失败仅 log 跳过，不阻断整体提交。
 */
async function collectRefAudios(refAssets, limits, tag) {
  const out = [];
  let remaining = limits.maxTotal;
  const voiced = (refAssets || []).filter((a) => a && a.voice_url);
  if (voiced.length) {
    logger.info(`[VIDEO→${tag}] 参考音频候选 ${voiced.length} 个：${voiced.map((a) => `「${a.name || "未命名"}」${a.voice_url}`).join("，")}`);
  }
  let voiceLeft = voiced.length; // 尚未处理的候选角色数
  for (const asset of refAssets || []) {
    if (out.length >= limits.maxCount || remaining < 2) break;
    if (!asset || !asset.voice_url) continue;
    voiceLeft -= 1;
    // 均分预算：剩余总时长 ÷ 待附加候选数（含本角色，且不超过剩余段数），再夹到 [2, 单段上限]
    const slots = Math.min(voiceLeft + 1, limits.maxCount - out.length);
    const budget = Math.min(limits.maxPer, Math.max(2, Math.floor(remaining / Math.max(1, slots))));
    try {
      let encoded = null;
      let seconds = 0;
      const localPath = audioLocalPath(asset.voice_url);
      if (localPath && fs.existsSync(localPath)) {
        seconds = (await probeMedia(localPath).catch(() => null))?.duration || 0;
        if (seconds > 0 && seconds < 2) {
          logger.warn(`[VIDEO→${tag}] 角色「${asset.name || ""}」声音样本不足 2s（${seconds.toFixed(1)}s），低于契约最短单段，已跳过`);
          continue;
        }
        const byUrl = publicFilesUrl(asset.voice_url);
        if (!byUrl) {
          logger.warn(`[VIDEO→${tag}] 角色「${asset.name || ""}」声音样本为本地文件且未配置 PUBLIC_BASE_URL，无法以公网 URL 提交，已跳过`);
          continue;
        }
        const ext = (localPath.split(".").pop() || "").toLowerCase();
        const size = fs.statSync(localPath).size;
        // 扩展名合规线：契约仅收 wav/mp3；URL 提交不受请求体挤压，单文件按契约放宽到 15MB
        const needsFix = seconds > budget || !["mp3", "wav"].includes(ext) || size > 15 * 1024 * 1024;
        if (needsFix) {
          // 转码产物落 uploads（refaudio_ 前缀）：以 /files 公网 URL 提交，保留给 provider 异步拉取
          const dest = genFilePath(config.uploadDir, "mp3", "refaudio");
          await prepareReferenceAudio(localPath, Math.max(2, Math.floor(budget)), dest.absPath);
          encoded = publicFilesUrl(toUrl(dest.absPath)); // byUrl 非空已保证 base 配置，产物必有 URL
          logger.info(`[VIDEO→${tag}] 角色「${asset.name || ''}」声音样本已裁剪转码为参考音频（≤${Math.floor(budget)}s mp3）并以 URL 提交`);
        } else {
          encoded = byUrl;
        }
      } else if (/^https?:\/\//i.test(String(asset.voice_url || ""))) {
        encoded = asset.voice_url; // 远程样本：无法探测/裁剪，原样透传（本就是 web URL）
      } else {
        // 本地文件缺失又非 http(s) URL（如换机部署后的孤儿 /files/ 路径）：任何 provider 都无法消费，跳过
        logger.warn(`[VIDEO→${tag}] 角色「${asset.name || ""}」声音样本本地文件不存在且非 http(s) URL，已跳过: ${asset.voice_url}`);
        continue;
      }
      if (!encoded) continue;
      const charge = seconds > 0 ? Math.min(seconds, budget) : budget; // 远程时长未知按整段预算计
      out.push({ asset, encoded, seconds: charge });
      remaining -= Math.max(2, charge);
    } catch (e) {
      logger.warn(`[VIDEO→${tag}] 角色「${asset.name || ""}」声音样本处理失败，已跳过: ${e?.message || e}`);
    }
  }
  // 有音色却未附加的角色（超段数上限/样本不合规/处理失败）：warn 留痕，避免静默丢音色难排查
  const voiceCount = (refAssets || []).filter((a) => a && a.voice_url).length;
  if (voiceCount > out.length) {
    logger.warn(`[VIDEO→${tag}] ${voiceCount - out.length} 个角色的声音样本未附加（超段数上限 ${limits.maxCount} 或样本不合规/处理失败）`);
  }
  return out;
}

/**
 * 收集引用资产中的「视频」资产（用户上传素材），按 provider 契约限档规整为参考视频（reference_video）：
 * - 按 asset_refs 顺序逐资产取 video_url（仅 kind=video 的资产，segmentVideo 已透传）；
 * - 本地视频：probeMedia 探时长；一律转成外网绝对 URL（PUBLIC_BASE_URL + 时效签名）提交，provider
 *   自行拉取、不做 Base64 编码（请求体不受 64MB 上限挤压，单文件上限放宽到 50MB）；未配置
 *   PUBLIC_BASE_URL 无法映射公网 URL 的直接跳过；
 * - 超单段预算 / 非 mp4（上传还允许 mov/webm 等）/ 超单文件上限时经 prepareReferenceVideo 裁剪转码为
 *   小体积 mp4；转码产物落 uploads 拿 /files 外网 URL 提交（provider 拉取的是转码结果而非原片）；
 * - 不足契约最短单段 2s 的跳过；远程视频无法探测/裁剪，原样透传，并按其均分份额计入总量；
 * - 总时长上限在「待附加候选」间均分（每段≥2s、≤单段上限），算法与 collectRefAudios 一致。
 * 单个视频失败仅 log 跳过，不阻断整体提交。
 */
export async function collectRefVideos(refAssets, limits, tag) {
  const out = [];
  let remaining = limits.maxTotal;
  const vids = (refAssets || []).filter((a) => a && a.kind === "video" && a.video_url);
  if (vids.length) {
    logger.info(`[VIDEO→${tag}] 参考视频候选 ${vids.length} 个：${vids.map((a) => `「${a.name || "未命名"}」${a.video_url}`).join("，")}`);
  }
  let videoLeft = vids.length; // 尚未处理的候选数
  for (const asset of vids) {
    if (out.length >= limits.maxCount || remaining < 2) break;
    videoLeft -= 1;
    // 均分预算：剩余总时长 ÷ 待附加候选数（含本条，且不超过剩余段数），再夹到 [2, 单段上限]
    const slots = Math.min(videoLeft + 1, limits.maxCount - out.length);
    const budget = Math.min(limits.maxPer, Math.max(2, Math.floor(remaining / Math.max(1, slots))));
    try {
      let encoded = null;
      let seconds = 0;
      const localPath = audioLocalPath(asset.video_url);
      if (localPath && fs.existsSync(localPath)) {
        seconds = (await probeMedia(localPath).catch(() => null))?.duration || 0;
        if (seconds > 0 && seconds < 2) {
          logger.warn(`[VIDEO→${tag}] 视频「${asset.name || ""}」时长不足 2s（${seconds.toFixed(1)}s），低于契约最短单段，已跳过`);
          continue;
        }
        const byUrl = publicFilesUrl(asset.video_url);
        if (!byUrl) {
          logger.warn(`[VIDEO→${tag}] 视频「${asset.name || ""}」为本地文件且未配置 PUBLIC_BASE_URL，无法以公网 URL 提交，已跳过`);
          continue;
        }
        const ext = (localPath.split(".").pop() || "").toLowerCase();
        const size = fs.statSync(localPath).size;
        // 外网 URL 直传：provider 自行拉取，无请求体压力，单文件按契约放宽到 50MB
        const needsFix = seconds > budget || ext !== "mp4" || size > 50 * 1024 * 1024;
        if (needsFix) {
          // 转码产物落 uploads（refvideo_ 前缀）：以 /files 公网 URL 提交，保留给 provider 异步拉取
          const dest = genFilePath(config.uploadDir, "mp4", "refvideo");
          await prepareReferenceVideo(localPath, Math.max(2, Math.floor(budget)), dest.absPath);
          encoded = publicFilesUrl(toUrl(dest.absPath)); // byUrl 非空已保证 base 配置，产物必有 URL
          logger.info(`[VIDEO→${tag}] 视频「${asset.name || ''}」已裁剪转码为参考视频（≤${Math.floor(budget)}s 720p mp4）并以 URL 提交: ${encoded}`);
        } else {
          encoded = byUrl; // 外网 URL 直传，不做 Base64 编码
        }
      } else if (/^https?:\/\//i.test(String(asset.video_url || ""))) {
        encoded = asset.video_url; // 远程视频：无法探测/裁剪，原样透传（本就是 web URL）
      } else {
        // 本地文件缺失又非 http(s) URL（如换机部署后的孤儿 /files/ 路径）：任何 provider 都无法消费，跳过
        logger.warn(`[VIDEO→${tag}] 视频「${asset.name || ""}」本地文件不存在且非 http(s) URL，已跳过: ${asset.video_url}`);
        continue;
      }
      const charge = seconds > 0 ? Math.min(seconds, budget) : budget; // 远程时长未知按整段预算计
      out.push({ asset, encoded, seconds: charge });
      remaining -= Math.max(2, charge);
    } catch (e) {
      logger.warn(`[VIDEO→${tag}] 视频「${asset.name || ""}」处理失败，已跳过: ${e?.message || e}`);
    }
  }
  // 有视频却未附加的资产（超段数上限/视频不合规/处理失败）：warn 留痕，避免静默丢参考视频难排查
  if (vids.length > out.length) {
    logger.warn(`[VIDEO→${tag}] ${vids.length - out.length} 个参考视频未附加（超段数上限 ${limits.maxCount} 或视频不合规/处理失败）`);
  }
  return out;
}

// 起始帧说明（中文，占位符写法）：跨镜尾帧作为首张参考图时，提示模型从该参考图起始、自然延续，
// 保持相邻镜头视觉连贯（Seedance/MiniMax/ComfyUI 三处共用）
function startFrameNote(n) {
  return `[起始帧] @图片${n} 是本镜头的起始画面（即上一镜头的最后一帧）。请从该画面的构图、人物姿态、服装与光线自然延续，完成本镜头的动作，并保持相邻镜头视觉一致。`;
}

// 「声音样本」说明（中文，占位符写法）：把每个参考音频关联到其角色的图片占位符，
// 例如 @音频1 是 @图片2 的声音样本；该角色的台词请使用此音色演绎...。
// 仅对同资产已附图的角色生成——其正文已用 @图片N 指代，音频无法在正文锚定，靠此行关联；
// 无图资产正文本就以 @音频N 指代，无需此行。
function refAudioVoiceNote(audios, assetToN) {
  const lines = [];
  (audios || []).forEach((x, i) => {
    const n = assetToN?.get(x.asset);
    if (!n) return;
    lines.push(`@音频${i + 1} 是 @图片${n} 的声音样本；该角色的台词请使用此音色演绎，并保持口型同步。`);
  });
  return lines.join("\n");
}

/**
 * 已附加素材 -> 多模态占位符清单：把本次实际提交的素材汇总为 [{ asset, token }]，
 * 供正文资产名批量替换（见 replaceAssetNamesWithTokens）。占位符按素材分类编号（从 1 起，
 * 与 content/媒体槽位顺序一致）：图片 @图片N / 音频 @音频N / 视频 @视频N。
 * 同一资产命中多种素材时图片优先（正文中的资产名首先是视觉主体），其次视频，最后音频。
 * @param assetToN Map<资产, 图片序号 N>（含跨镜起始帧占位顺延后的真实序号）
 * @param refVideos collectRefVideos 规整产物（按提交顺序）
 * @param refAudios collectRefAudios 规整产物（按提交顺序）
 */
function assetTokenRefs({ assetToN, refVideos = [], refAudios = [] }) {
  const byAsset = new Map();
  for (const [asset, n] of assetToN || []) byAsset.set(asset, `@图片${n}`);
  refVideos.forEach((x, i) => { if (!byAsset.has(x.asset)) byAsset.set(x.asset, `@视频${i + 1}`); });
  refAudios.forEach((x, i) => { if (!byAsset.has(x.asset)) byAsset.set(x.asset, `@音频${i + 1}`); });
  return [...byAsset].map(([asset, token]) => ({ asset, token }));
}

/**
 * 提示词正文资产名批量替换（取代旧的「参考图/音频/视频映射」前置说明）：
 * 把正文中出现的资产名（含别名）替换为 @图片N / @音频N / @视频N，
 * 视频模型按占位符序号直接对到本次提交的第 N 个同类素材。
 * - 旁白/对话等「说出的内容」不做替换（引号内台词 “ ” 「」 『』 " "，以及 旁白/系统提示/心理活动
 *   等标签引导到行尾的内容）——说辞念出来/配字幕用，保留原文；
 * - 未成功附加素材的资产不替换（正文保留原名，避免引用不存在的占位符）；
 * - 候选按名称长度降序替换，避免「林小雨」被「林小」之类短名抢先截断；同名首个资产生效。
 */
function replaceAssetNamesWithTokens(text, refs) {
  const out = String(text || "");
  if (!out || !(refs || []).length) return out;
  const seen = new Set();
  const cands = [];
  for (const { asset, token } of refs) {
    const names = [asset?.name, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])];
    for (const needle of names) {
      const s = String(needle || "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      cands.push({ needle: s, token });
    }
  }
  cands.sort((a, b) => b.needle.length - a.needle.length);
  if (!cands.length) return out;

  // 保护区间：引号内台词 + 旁白/系统提示等标签引导到行尾的内容（含英文 narration/voiceover/monologue）
  const spans = [];
  const quotePairs = { "“": "”", "「": "」", "『": "』" };
  for (let i = 0; i < out.length; i++) {
    const close = quotePairs[out[i]] || (out[i] === '"' ? '"' : null);
    if (!close) continue;
    const end = out.indexOf(close, i + 1);
    spans.push([i, end < 0 ? out.length : end + 1]); // 未闭合引号保护到文末
    if (end >= 0) i = end;
  }
  const labelRe = /(?:旁白|系统提示|心理活动|内心独白|画外音|独白|narration|voiceover|monologue)\s*[：:][^\n]*/gi;
  for (const m of out.matchAll(labelRe)) spans.push([m.index, m.index + m[0].length]);
  if (!spans.length) return applyNameCands(out, cands);

  // 区间外的文本逐段替换后回拼，区间原文保留
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const apply = (t) => applyNameCands(t, cands);
  let result = "", pos = 0;
  for (const [s, e] of merged) {
    result += apply(out.slice(pos, s)) + out.slice(s, e);
    pos = e;
  }
  return result + apply(out.slice(pos));
}

// 逐候选全局子串替换（名称长度降序，避免短名截断长名）
function applyNameCands(text, cands) {
  for (const { needle, token } of cands) text = text.split(needle).join(token);
  return text;
}

// ---- 提示词英译（模型配置 translate_prompt_en 开关，仅 video 生效）----

// 含 CJK（中文/日文假名/韩文谚文/全角标点）才需要翻译；纯英文提示词直接跳过，省一次文本 LLM 调用
const PROMPT_CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯！-～]/;

// 抽取双引号内的原文片段（中英文双引号与 CJK 直角/单双引号，与 replaceAssetNamesWithTokens 保护区间同口径）
function extractQuotedSpans(text) {
  const s = String(text || "");
  const spans = [];
  const quotePairs = { "“": "”", "「": "」", "『": "』" };
  for (let i = 0; i < s.length; i++) {
    const close = quotePairs[s[i]] || (s[i] === '"' ? '"' : null);
    if (!close) continue;
    const end = s.indexOf(close, i + 1);
    spans.push(end < 0 ? s.slice(i + 1) : s.slice(i + 1, end)); // 未闭合引号取到文末
    if (end >= 0) i = end;
  }
  return spans.filter((x) => x.trim());
}

/**
 * 提示词英译（提交前）：模型配置开了 translate_prompt_en 时，先用系统默认文本大模型把提示词翻译成英文
 * 再提交视频模型。调用时机在各厂商装配函数的「占位符替换与备注拼装之后、提交之前」——必须晚于
 * 资产名→@图片N/@音频N/@视频N 占位符替换，否则资产名先被翻成英文会导致替换失配。
 * 翻译固定走系统默认文本模型（admin 配置的共享模型，resolveSystemConfig）：无论本次视频用的是
 * 共享还是私有视频模型，都不跟随用户私有文本模型——私有模型自带 Key、能力参差，英译质量直接
 * 决定视频质量，统一由系统默认文本模型承担。
 * 翻译原则：双引号内的旁白或对话保持原样不翻译（台词要念出来/配字幕，须保留原文）；
 * 心理活动/内心独白/系统提示等非对话语音标签统一译成旁白形态 Narrator:（与分镜规则「非对话语音
 * 都以旁白出现」对齐，避免译成无声心理描写）；
 * 占位符原样保留；翻译失败（未配置系统默认文本模型/调用出错/返回为空）回退原文，绝不阻断视频生成。
 */
async function translatePromptIfNeeded(cfg, userId, prompt, tag = "Video") {
  const text = String(prompt || "");
  if (!cfg?.translate_prompt_en || !text.trim() || !PROMPT_CJK_RE.test(text)) return text;
  try {
    // 系统默认文本模型（共享侧）：解析不到即视为未配置，走 catch 回退原文
    const sysText = await resolveSystemConfig("text");
    if (!sysText) throw new Error("未配置系统默认文本模型（共享文本模型）");
    const system = [
      "你是视频生成提示词翻译器，把用户提交的视频生成提示词忠实翻译成英文。要求：",
      '1. 只输出翻译结果本身，不要任何解释、前缀或引号包裹。',
      '2. 双引号内的旁白或对话保持原样不翻译：中英文双引号 " " 与 “ ” 「」 『』 内的内容连同引号本身原样保留。',
      "3. @图片N、@音频N、@视频N 等多模态占位符（N 为数字）必须原样保留，不得翻译、改写、增删或调整位置。",
      "4. 旁白/心理活动/内心独白/系统提示/画外音等非对话语音的标签统一译成旁白形态（如「心理活动：」「内心独白：」→「Narrator:」，与「旁白：」同式）：这些内容都要以画外音念白出现，严禁译成 inner monologue / psychological description 等会被理解为无声心理描写的说法；标签后引号内的内容仍按第 2 条原样保留。",
      "5. 其余内容翻译为自然、具体的英文，完整保留画面、动作、运镜等全部信息；人名等专有名词音译，不丢信息。",
    ].join("\n");
    // 显式传共享配置 id：complete 内部 getConfig 允许命中共享模型，确保不走用户私有解析
    const { content } = await complete(userId, text, { type: "text", modelConfigId: sysText.id, system, temperature: 0.2 });
    let out = String(content || "").trim();
    const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/); // 剥模型偶发的 ``` 包裹
    if (fence) out = fence[1].trim();
    if (!out) throw new Error("翻译结果为空");
    // 校验 1：@图片N/@音频N/@视频N 占位符必须原样全数保留（占位符是参考素材的引用锚点，丢/改即失配）
    const tokens = (s) => (String(s).match(/@(?:图片|音频|视频)\d+/g) || []).sort().join(",");
    if (tokens(text) !== tokens(out)) throw new Error("译文占位符与原文不一致，放弃翻译结果");
    // 校验 2：双引号内的旁白/对话必须逐字保留（按去空白后包含比对；违则整体回退原文，方向安全）
    const quotes = extractQuotedSpans(text);
    const outFlat = out.replace(/\s+/g, "");
    for (const q of quotes) {
      if (!outFlat.includes(q.replace(/\s+/g, ""))) throw new Error(`译文丢失引号内原文：「${q.slice(0, 20)}…」，放弃翻译结果`);
    }
    logger.info(`[VIDEO→${tag}] 提示词已英译（${text.length} 字 → ${out.length} 字）`);
    return out;
  } catch (e) {
    logger.warn(`[VIDEO→${tag}] 提示词英译失败，回退原文提交: ${e?.message || e}`);
    return text;
  }
}

/**
 * 生成视频
 *  - 若配置了真实视频 provider：提交任务->轮询->下载真实视频（provider 自带音频，如 Seedance 的 generate_audio）
 *  - 否则（或调用失败）：用 ffmpeg 对图片做推拉，生成真实 mp4（兜底）
 * @returns { videoUrl, mode: 'provider'|'local', outPath, lastFrameUrl, lastFrameSource }
 *   lastFrameUrl：provider 随任务返回的尾帧图（Seedance return_last_frame:true，已原样落盘）；无则为 null
 *   lastFrameSource：尾帧来源 'seedance'（provider 原图）/ null（无，由调用方 ffmpeg 抽帧兜底后自记 'ffmpeg'）
 */
/**
 * 模型输入上限裁剪（admin 可配 max_input_images / max_input_audios / max_input_videos，仅 video 消费）。
 * NULL=不限（存量行保持原有行为，不裁剪）；0=该类输入整体弃用。
 * 超限淘汰规则（产品约定）：
 *  - 图片：优先丢弃起始帧（跨镜尾帧延续），仍超限再从 refAssets 末尾逐个整卡淘汰；
 *  - 音频/视频：从 refAssets 末尾淘汰（仅置空对应槽位，资产卡与图片槽保留）。
 * 必须在占位符替换之前调用：各厂商装配函数按「最终列表」编号 @图片N/@音频N/@视频N，
 * 先裁后编序号天然一致；被整卡淘汰的资产正文保留原名（与「未附加素材不替换」同口径）。
 * 厂商契约限档（REF_AUDIO_LIMITS 等 / ComfyUI 槽位 / Agnes 8 张硬顶）在适配器内继续生效，此处只管模型配置。
 */
export function trimRefInputsByLimits(cfg, { imagePath, continuityFrame, refAssets = [] } = {}) {
  // NULL/undefined/空串 = 未配置（不限）：必须先判空再 Number——Number(null)===0，
  // 否则存量 NULL 行会被当成「上限 0」把起始帧与全部参考图裁光
  const lim = (v) => (v == null || v === '' ? null : (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null));
  const maxImg = lim(cfg?.max_input_images);
  const maxAud = lim(cfg?.max_input_audios);
  const maxVid = lim(cfg?.max_input_videos);
  if (maxImg == null && maxAud == null && maxVid == null) {
    return { imagePath, continuityFrame, refAssets };
  }
  const originStartFrame = continuityFrame || imagePath || null;
  let startFrame = originStartFrame;
  let assets = [...refAssets];

  if (maxImg != null) {
    let total = (startFrame ? 1 : 0) + assets.length;
    if (total > maxImg && startFrame) { startFrame = null; total -= 1; } // 优先丢弃起始帧
    while (total > maxImg && assets.length) { assets.pop(); total -= 1; } // 末位淘汰整卡（图片槽随之消失）
  }
  if (maxAud != null) {
    let n = assets.filter((a) => a?.voice_url).length;
    for (let i = assets.length - 1; i >= 0 && n > maxAud; i--) {
      if (assets[i]?.voice_url) { assets[i] = { ...assets[i], voice_url: null, voice_name: null }; n -= 1; }
    }
  }
  if (maxVid != null) {
    let n = assets.filter((a) => a?.kind === 'video' && a?.video_url).length;
    for (let i = assets.length - 1; i >= 0 && n > maxVid; i--) {
      if (assets[i]?.kind === 'video' && assets[i]?.video_url) { assets[i] = { ...assets[i], video_url: null }; n -= 1; }
    }
  }
  const changed = startFrame !== originStartFrame
    || assets.length !== refAssets.length
    || assets.some((a, i) => a !== refAssets[i]);
  if (changed) {
    logger.info(`[VIDEO→输入上限] 模型 ${cfg?.model || cfg?.id} 限 图${maxImg ?? '∞'}/音${maxAud ?? '∞'}/视${maxVid ?? '∞'}：`
      + `起始帧${startFrame ? '保留' : '已丢弃'}，参考资产 ${refAssets.length}→${assets.length}（音频/视频槽位随之空置）`);
  }
  return { imagePath: startFrame, continuityFrame: startFrame, refAssets: assets };
}

export async function generateVideo(userId, params) {
  let {
    prompt, imagePath, duration = 5, aspect, outDir, refAssets, modelConfigId, resolution,
    continuityFrame, continuitySource,
    jobId = null, projectId = null, episodeId = null, segmentId = null, feature = null,
  } = params;
  const { absPath: outPath } = genFilePath(outDir || config.outputDir, "mp4", "seg");

  // 重启恢复：该 (job,segment) 已有仍在厂商侧跑的任务（上次进程重启时 workFn 蒸发、任务未清）
  // → 不重新提交（避免对同一分镜双跑双扣厂商额度），等本地库终态后走与首次生成完全相同的收尾
  const resumed = await resumePendingProviderResult(jobId, segmentId, "VIDEO");
  if (resumed) return resumed;

  let cfg;
  try {
    cfg = modelConfigId ? await getConfig(userId, modelConfigId) : await resolveConfig(userId, "video");
  } catch {
    cfg = null;
  }

  // 真实 provider 路径
  if (cfg && cfg.base_url && cfg.api_key && cfg.model && cfg.provider !== "local-ffmpeg") {
    // 不带水印（会员体系已下线，全员同权益；DB params 仍可覆盖）
    const showWatermark = false;
    // 留档上下文：随 record 落库（video_generations），便于按 Job/项目/分镜追溯
    const genCtx = { userId, jobId, projectId, episodeId, segmentId, feature };
    // 模型输入上限裁剪（max_input_*，NULL=不限）：在占位符替换之前收口，序号由适配器按最终列表重排
    ({ imagePath, continuityFrame, refAssets } = trimRefInputsByLimits(cfg, { imagePath, continuityFrame, refAssets }));
    const res = await viaProvider(cfg, { prompt, imagePath, duration, aspect, userId, refAssets, resolution, continuityFrame, continuitySource, watermark: showWatermark, genCtx });
    return downloadProviderOutputs(res, "VIDEO");
  }

  // 未配置 provider 或 provider 为 local-ffmpeg：本地图转视频
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error("本地 ffmpeg「图生视频」已停用：关键帧现由生成视频的首帧自动抽取，请在「大模型配置」中配置真实视频生成 provider。");
  }
  await imageToVideo(imagePath, duration, outPath, aspect);
  const localUrl = toUrl(outPath);
  return { videoUrl: localUrl, mode: "local", outPath };
}

/**
 * 去除视频字幕（视频编辑）：把分镜已生成的原视频作为唯一参考输入（@视频1）提交多模态
 * 视频模型，要求仅擦除画面中的字幕、其余保持不变；产物用于替换本镜视频。
 * 仅支持 r2v（参考视频）契约的模型：Seedance 2.x / MiniMax / 万相3.0（reference_video 编辑模式）；
 * HappyHorse（media 仅 first_frame）与通用 OpenAI 风格接口无视频输入通道，直接报错引导换模型。
 * @returns { videoUrl, outPath, lastFrameUrl, lastFrameSource }
 *   lastFrameUrl：provider 随任务返回的尾帧图（Seedance return_last_frame:true，已原样落盘）；无则为 null
 *   lastFrameSource：尾帧来源 'seedance'（provider 原图）/ null（无，由调用方 ffmpeg 抽帧兜底后自记 'ffmpeg'）
 */
export async function eraseVideoSubtitles(userId, params) {
  const {
    videoUrl, duration = 5, aspect, modelConfigId, resolution,
    jobId = null, projectId = null, episodeId = null, segmentId = null,
  } = params;

  // 重启恢复：该 (job,segment) 已有仍在厂商侧跑的擦除任务 → 不重新提交（也无需再规整原视频），
  // 等本地库终态后走与首次生成相同的收尾
  const resumed = await resumePendingProviderResult(jobId, segmentId, "ERASE");
  if (resumed) return resumed;

  let cfg;
  try {
    cfg = modelConfigId ? await getConfig(userId, modelConfigId) : await resolveConfig(userId, "video");
  } catch {
    cfg = null;
  }
  // 厂商归位（与 viaProvider 同一判定 videoVendorOf）：仅 Seedance / MiniMax / 万相 契约支持参考视频输入
  const vendor = cfg ? videoVendorOf(cfg) : null;
  const isSeedance = vendor === "seedance";
  const isMiniMax = vendor === "minimax";
  const isAliwan = vendor === "aliwan";
  if (!cfg || !cfg.base_url || !cfg.api_key || !cfg.model || cfg.provider === "local-ffmpeg" || (!isSeedance && !isMiniMax && !isAliwan)) {
    throw new Error("「去除字幕」需要支持视频参考输入的多模态视频模型（Seedance 2.x / MiniMax / 万相3.0 系列），请在确认框中更换模型或到「大模型配置」中配置后重试");
  }
  if (isSeedance && !isSeedance2x(cfg.model)) {
    throw new Error(`模型 ${cfg.model} 非 Seedance 2.x 系列，不支持参考视频输入（去除字幕），请更换为 Seedance 2.x 或 MiniMax 系列模型`);
  }
  // 输入上限能力校验：模型配置显式关闭视频输入（max_input_videos=0，NULL=不限）时，
  // 擦字幕以原视频为唯一输入（@视频1）无法提交，直接报错引导换模型/调配置，不做静默降级
  if (cfg.max_input_videos === 0) {
    throw new Error("当前模型已配置「输入视频上限 = 0」（不支持视频输入），无法执行去除字幕，请调整模型配置或更换模型");
  }

  // 原视频规整为 provider 可消费的输入：一律以公网 URL 提交（PUBLIC_BASE_URL + 时效签名）
  const { encoded, seconds } = await prepareEraseSourceVideo(videoUrl, {
    tag: isSeedance ? "Seedance" : isMiniMax ? "MiniMax" : "万相",
  });
  logger.info(`[VIDEO→擦除字幕] 原视频 ${videoUrl}（${seconds ? seconds.toFixed(1) + "s" : "时长未知"}）模型 ${cfg.model}`);

  // 不带水印（会员体系已下线，全员同权益）
  const watermark = false;
  // 时长优先取原视频实测值（输出尽量等长），探测不到再退 segment.duration
  const opts = {
    // 提示词英译开关（模型配置 translate_prompt_en）：去除字幕的固定提示词同样遵循
    prompt: await translatePromptIfNeeded(cfg, userId, ERASE_SUBTITLE_PROMPT, isSeedance ? "Seedance" : isMiniMax ? "MiniMax" : "万相"),
    editVideo: encoded,
    duration: seconds > 0 ? seconds : duration,
    aspect, userId, resolution,
    // 留档上下文（video_generations）：feature 固定为去除字幕场景
    genCtx: { userId, jobId, projectId, episodeId, segmentId, feature: "segment_erase_subtitle" },
  };
  const res = isSeedance
    ? await viaSeedanceErase(cfg, { ...opts, watermark })
    : isMiniMax
      ? await viaMiniMaxErase(cfg, opts)
      : await viaAliwanErase(cfg, opts);
  return downloadProviderOutputs(res, "VIDEO→擦除字幕");
}

/**
 * 厂商终态结果的统一收尾：下载视频到本地 + 尾帧原图原样落盘，返回与首次生成一致的形状
 * （Seedance return_last_frame 契约返回 { videoUrl, lastFrameUrl }，其余 provider 仍返回 string）。
 * 首次生成路径与「重启恢复」路径共用——恢复只是跳过提交、等本地库终态后走同一收尾。
 */
async function downloadProviderOutputs(res, tag) {
  const remoteUrl = typeof res === "string" ? res : res?.videoUrl;
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
    throw new Error(`provider 未返回可下载的视频 URL: ${JSON.stringify(res).slice(0, 300)}`);
  }
  const remoteLastFrame = typeof res === "string" ? null : res.lastFrameUrl || null;
  const localAbs = await downloadVideo(remoteUrl);
  // 尾帧图：provider 返回的原图直接落盘（原样保存，不得修改/重编码）；拿不到则为 null，由调用方兜底抽帧
  let lastFrameUrl = null;
  let lastFrameSource = null;
  if (remoteLastFrame) {
    try {
      lastFrameUrl = toUrl(await downloadImageAsIs(remoteLastFrame));
      lastFrameSource = "seedance"; // 目前仅 Seedance 契约随任务返回尾帧原图
    } catch (e) {
      logger.warn(`[${tag}] 尾帧图下载失败（将由调用方 ffmpeg 抽帧兜底）: ${e?.message || e}`);
    }
  }
  return { videoUrl: toUrl(localAbs), mode: "provider", outPath: localAbs, lastFrameUrl, lastFrameSource };
}

/**
 * 重启恢复：该 (job, segment) 若已有提交过的厂商任务（服务重启时 workFn 蒸发、record 仍在），
 * 不重新提交，按 record 现状收尾——pending 则继续等本地库终态（扫描线程无超时，会一直查到
 * 厂商成功/失败为止），已终态则直接消费结果；失败终态抛厂商错误（与首次生成同口径）。
 * 该 Job 尚无厂商任务时返回 null（调用方走正常提交路径）。
 */
async function resumePendingProviderResult(jobId, segmentId, tag) {
  if (!jobId) return null;
  const record = await findJobGeneration(jobId, segmentId || null);
  if (!record) return null;
  logger.info(`[${tag}→恢复] job=${jobId} seg=${segmentId ?? "-"} 命中已有厂商任务 record=#${record.id}（${record.status}），不重新提交`);
  const final = record.status === "pending" ? await waitForGeneration(record.id, { tag: `${tag}→恢复` }) : record;
  if (final.status === "failed") throw new Error(final.error || "视频生成失败");
  const r = final.result || {};
  return downloadProviderOutputs({ videoUrl: r.videoUrl, lastFrameUrl: r.lastFrameUrl || null }, `${tag}→恢复`);
}

// 厂商 → 契约归位：ModelConfig.provider 存的是模型厂商 code（ModelVendor.code，见 seed DEFAULT_VENDORS），
// 优先按厂商路由；provider 为通用值（openai/custom/空）时退回模型名/域名识别，兼容厂商目录上线前的
// 存量配置（如 provider=openai + ark 域名的 Seedance、provider=openai 的 MiniMax-H3）。
// 返回 'seedance' | 'dashscope' | 'minimax' | 'comfyui' | 'agnes' | 'aliwan' | 'generic'
export function videoVendorOf(cfg) {
  const provider = String(cfg?.provider || "").trim().toLowerCase();
  if (provider === "volcengine") return "seedance";
  // 阿里万相（百炼 wan3.0-video / wan3.0-video-prime，全模态参考生视频）
  if (provider === "aliwan") return "aliwan";
  if (provider === "dashscope") return "dashscope";
  if (provider === "minimax") return "minimax";
  if (provider === "autodl-comfyui") return "comfyui";
  // agnes_cn（国内中转端点）契约与 agnes 完全一致，仅 base_url/api_key 等配置不同，共用同一套处理逻辑
  if (provider === "agnes" || provider === "agnes_cn") return "agnes";
  // 通用厂商（openai/custom 及未识别 code，如 kling/vidu）：再按模型名/域名兜底识别专属契约
  const model = String(cfg?.model || "");
  const base = String(cfg?.base_url || "").trim().toLowerCase();
  if (/seedance/i.test(model) || /ark\.volces\.com/.test(base)) return "seedance";
  if (/wan3/i.test(model)) return "aliwan"; // 万相3.0（input.media 数组形态，与 wan2.x 的 img_url 形态不兼容，勿按域名宽匹配）
  if (/happyhorse/i.test(model)) return "dashscope";
  if (/minimax/i.test(model) || /minimax/i.test(base)) return "minimax";
  if (/agnes/i.test(model) || /agnes-ai\.com/.test(base) || /agnes-ai\.cn/.test(base)) return "agnes";
  return "generic";
}

// provider 分流（按 videoVendorOf 厂商归位）：Seedance 走火山方舟专属契约，HappyHorse 走百炼 DashScope
// 异步任务契约，MiniMax-H3 走 v2 异步任务契约，AutoDL ComfyUI 走工作流包装契约，万相3.0 走全模态参考契约，
// 其余保留通用 OpenAI 风格
async function viaProvider(cfg, opts) {
  const hasVoice = (opts.refAssets || []).some((a) => a && a.voice_url);
  const hasRefVideo = (opts.refAssets || []).some((a) => a && a.kind === "video" && a.video_url);
  switch (videoVendorOf(cfg)) {
    case "seedance":
      return viaSeedance(cfg, opts);
    case "aliwan":
      return viaAliwan(cfg, opts);
    case "dashscope":
      if (hasVoice) logger.info(`[VIDEO→DashScope] 已绑定角色音色，但该模型契约(media 仅 first_frame)不支持音频输入，已跳过`);
      if (hasRefVideo) logger.info(`[VIDEO→DashScope] 分镜引用了视频资产，但该模型契约(media 仅 first_frame)不支持参考视频输入，已跳过（封面图仍可作首帧）`);
      return viaDashScopeVideo(cfg, opts);
    case "minimax":
      return viaMiniMax(cfg, opts);
    case "comfyui":
      return viaComfyUI(cfg, opts);
    case "agnes":
      return viaAgnes(cfg, opts);
    default:
      if (hasVoice) logger.info(`[VIDEO→Generic] 已绑定角色音色，该通用接口未必支持音频输入，按尽力而为附加`);
      return viaGeneric(cfg, opts);
  }
}

// ---- 视频生成留档桥接层（video_generations）----
// 提交参数与厂商返回落库 pending record；厂商状态查询全部移交 videoGenScanner 独立线程
// （扫描器按 record.vendor 分发到下方各 queryXxxTask），本文件只等本地库终态——没有轮询超时，
// 一直查到厂商给出成功/失败为止（pollLoops 预算制已废除）。

// 组装留档 record 的公共字段：厂商归位 + 配置快照 + 业务上下文（job/项目/分集/分镜）
function submitRecordFields(cfg, genCtx = {}, extra = {}) {
  return {
    userId: genCtx.userId,
    jobId: genCtx.jobId ?? null,
    projectId: genCtx.projectId ?? null,
    episodeId: genCtx.episodeId ?? null,
    segmentId: genCtx.segmentId ?? null,
    feature: genCtx.feature || "segment_video",
    vendor: videoVendorOf(cfg),
    provider: String(cfg.provider || ""),
    model: cfg.model,
    modelConfigId: cfg.id ?? null,
    baseUrl: cfg.base_url ?? null,
    // 完整厂商端点：各提交 helper 把 submitUrl 挂到 genCtx 上随链路带回（成功/失败/sync 直出统一落档）
    submitUrl: genCtx.submitUrl ?? null,
    ...extra,
  };
}

/**
 * 提交成功后落 pending record 并等待厂商终态（查询由扫描器独立线程负责，这里只轮询本地库，无超时）。
 * @returns { videoUrl, lastFrameUrl }（lastFrameUrl 目前仅 Seedance return_last_frame 契约返回）
 */
async function submitAndTrack({ cfg, tag, taskId, response, params, genCtx }) {
  const record = await createGenerationRecord(submitRecordFields(cfg, genCtx, { taskId, params, submitResponse: response }));
  logger.info(`[VIDEO→提交/${tag}] record=#${record.id} task=${taskId} 已落库，等待厂商终态（无超时，直至成功/失败）`);
  const final = await waitForGeneration(record.id, { tag });
  const r = final.result || {};
  return { videoUrl: r.videoUrl, lastFrameUrl: r.lastFrameUrl || null };
}

/**
 * 火山方舟 Doubao Seedance 2.0 系列（视频生成）契约
 * POST {base}/contents/generations/tasks  -> 轮询 GET {base}/contents/generations/tasks/{id}
 *
 * 多模态输入（content 数组按需组合，三种图生场景互斥）：
 *   - 文生视频：仅 1 个 { type:'text', text }
 *   - 图生视频-首帧：text(可选) + 1 个 { type:'image_url', image_url:{url}, role:'first_frame' }
 *   - 图生视频-首尾帧：text(可选) + 2 个 image_url，role 分别为 first_frame / last_frame
 *   - 引用参考图：text(可选) + N 个 { type:'image_url', image_url:{url}, role:'reference_image' }
 *   - 参考视频（仅 2.x 系列，视频资产的文件本体）：参考图之外可叠加
 *     { type:'video_url', video_url:{url}, role:'reference_video' }；⚠ url 仅收公网 web URL，
 *     不支持 Base64（400 "reference_video must be provided as a web url"）；
 *     2.5 ≤10段/总≤30s，2.0 系列单段[2,15]s/≤3段/总≤15s（与参考音频限档一致；组合上限 9图+3视频+3音频）
 *   - 参考音频（仅 2.x 系列）：参考图之外可叠加 { type:'audio_url', audio_url:{url}, role:'reference_audio' }，
 *     须与至少 1 个图片/视频同传；仅 wav/mp3；2.5 单段[2,30]s/≤10段/总≤30s，2.0 系列单段[2,15]s/≤3段/总≤15s；
 *     单文件≤15MB、请求体≤64MB、大文件勿用 Base64
 *   image_url.url 支持公网 URL、Base64(data:image/<fmt>;base64,...)、素材 ID(asset://...)
 *   ⚠ role 合法取值 first_frame / last_frame / reference_image / reference_video / reference_audio(仅2.x)，其余会 400
 * 参数按 2.0「新方式」直接置于请求体顶层（严格校验，值非法会 400）：
 *   resolution / ratio / duration / watermark / generate_audio / return_last_frame / callback_url
 *   return_last_frame:true 时任务结果 content 同时返回 last_frame_url（尾帧图），本实现将其原样落盘为
 *   last_frame_url 字段（不经 ffmpeg 重抽/重编码）；Mini/Fast 档位同样适用
 *   ⚠ Seedance 2.0 不支持 seed、camera_fixed；Mini/Fast 不支持 1080p(仅 480p/720p)，标准版支持 1080p/4K
 * 鉴权：Authorization: Bearer <ARK_API_KEY>（key 形如 volc-sk-xxx，原样透传，勿带其他前缀）
 */
async function viaSeedance(cfg, { prompt, imagePath, duration, aspect, userId, refAssets, resolution, watermark, continuityFrame, continuitySource, genCtx }) {
  const headers = { "Content-Type": "application/json" };
  const auth = arkAuthHeader(cfg.api_key);
  if (auth) headers.Authorization = auth;

  const dur = clampInt(duration, 4, 15); // Seedance 2.0 系列 [4,15]；传 -1 可智能选时长
  const ratio = mapRatio(aspect);

  // 多模态 content：text 在前，引用资产图片链接进来（关键帧首帧路径已停用，见 hasImage）
  const promptText = String(prompt || "").trim();
  const content = [];
  const hasImage = false;
  /*const hasImage = !!(imagePath && fs.existsSync(imagePath));
  if (hasImage) {
    const mime = imageMime(imagePath);
    const b64 = fs.readFileSync(imagePath).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` }, role: 'first_frame' });
  }*/
  // 按"成功添加进 content 的顺序"编号，建立 资产 -> 图片序号 N（从 1 起）映射，用于正文占位符替换
  let refImageCount = 0;
  const assetToN = new Map(); // 资产对象 -> 其在 content 中的图片序号 N（从 1 起）
  // 跨镜首尾帧延续：上一镜尾帧（Seedance return_last_frame 原图或 ffmpeg 抽帧兜底均可）作为首张
  // 参考图（图片1）加入，并在提示词注明「视频开始请参考此图片」（与 MiniMax 的起始帧语义一致）。
  // 历史版本仅 seedance 原图才附加，存量段/ffmpeg 尾帧一律不延续，已放宽对齐 MiniMax
  let startFrameN = 0;
  if (continuityFrame) {
    const encoded = resolveMediaUrl(continuityFrame);
    if (encoded) {
      refImageCount += 1;
      startFrameN = refImageCount;
      content.push({ type: "image_url", image_url: { url: encoded }, role: "reference_image" });
      logger.info(`[VIDEO→Seedance] 跨镜延续：上一镜尾帧作为起始帧参考图（图片${startFrameN}，来源 ${continuitySource || "ffmpeg/历史"}）`);
    }
  }
  // 参考视频（视频资产的文件本体，仅 2.x 系列 r2v 支持）：先按契约限档规整；命中者资产循环里跳过封面图
  let refVideos = [];
  if ((refAssets || []).some((a) => a && a.kind === "video" && a.video_url)) {
    if (isSeedance2x(cfg.model)) {
      // 参考视频一律以公网 web URL 提交（本实现已全面禁用 Base64）
      refVideos = await collectRefVideos(refAssets, seedanceVideoLimits(cfg.model), "Seedance");
    } else {
      logger.info(`[VIDEO→Seedance] 模型 ${cfg.model} 非 2.x 系列，不支持参考视频输入，已跳过（视频资产回退封面图作参考图）`);
    }
  }
  const videoAssets = new Set(refVideos.map((x) => x.asset));
  // 引用资产图片（角色/场景/道具参考图）链接进 content，提升视频生成角色一致性
  for (const asset of refAssets || []) {
    // 视频资产本体已附加为 reference_video（见循环后），封面图不再重复作参考图；未规整成功的回退封面图
    if (videoAssets.has(asset)) continue;
    // 豆包数字资产：若填写了 doubao_asset_id，则改用 asset:// 引用该数字资产（保持跨镜角色一致性），不再用 image_url
    if (asset && asset.doubao_asset_id) {
      refImageCount += 1;
      content.push({ type: "image_url", image_url: { url: `asset://${asset.doubao_asset_id}` }, role: "reference_image" });
      if (!assetToN.has(asset)) assetToN.set(asset, refImageCount);
      logger.info(`[VIDEO→Seedance] ${kindWord(asset.kind)}「${asset.name || ''}」命中 doubao_asset_id=${asset.doubao_asset_id}，参考图改用 asset:// 引用（图片${refImageCount}），跳过 image_url`);
      continue;
    }
    if (asset && asset.image_url) {
      const encoded = resolveMediaUrl(asset.image_url);
      if (encoded) {
        refImageCount += 1;
        content.push({ type: "image_url", image_url: { url: encoded }, role: "reference_image" });
        if (!assetToN.has(asset)) assetToN.set(asset, refImageCount);
      }
    }
  }
  // 参考视频紧随参考图之后进入 content（r2v 多模态；2.0 组合上限 9图+3视频+3音频）
  for (const x of refVideos) {
    content.push({ type: "video_url", video_url: { url: x.encoded }, role: "reference_video" });
  }
  // 参考音频（多模态参考生视频，仅 2.x 系列）：每个绑定音色的角色一条 reference_audio。
  // 契约要求音频必须与至少 1 个图片/视频同传 → 仅在本镜已附参考图（含 asset:// 数字资产）或参考视频时附加。
  let refAudios = [];
  if ((refImageCount > 0 || refVideos.length > 0) && isSeedance2x(cfg.model)) {
    refAudios = await collectRefAudios(refAssets, seedanceAudioLimits(cfg.model), "Seedance");
    for (const x of refAudios) {
      content.push({ type: "audio_url", audio_url: { url: x.encoded }, role: "reference_audio" });
    }
  } else if ((refImageCount > 0 || refVideos.length > 0) && (refAssets || []).some((a) => a && a.voice_url)) {
    logger.info(`[VIDEO→Seedance] 模型 ${cfg.model} 非 2.x 系列，不支持参考音频输入，已跳过`);
  }
  // 起始帧备注：仅当上一镜尾帧（Seedance 原图）成功加入时，提示模型从该参考图起始、自然延续
  const startNote = startFrameN ? startFrameNote(startFrameN) : "";
  // 正文资产名批量替换为多模态占位符（@图片N/@音频N/@视频N，N 为同类素材提交序号），
  // 不再前置「参考图/音频/视频映射」说明；未附加素材的资产名保留原文。
  // 声音样本说明（中文）紧随其后：把 @音频N 关联到角色的 @图片M（正文中的名称已被图片占位符取代）
  const promptBody = replaceAssetNamesWithTokens(promptText, assetTokenRefs({ assetToN, refVideos, refAudios }));
  // 提示词英译开关（模型配置 translate_prompt_en）：占位符替换之后、提交之前翻译
  const finalPrompt = await translatePromptIfNeeded(
    cfg, userId,
    [promptBody, startNote, refAudioVoiceNote(refAudios, assetToN)].filter(Boolean).join("\n\n"),
    "Seedance",
  );
  if (finalPrompt.trim()) content.unshift({ type: "text", text: finalPrompt }); // text 在前
  if (!content.length) content.push({ type: "text", text: "" }); // content 不可为空

  const body = {
    model: cfg.model,
    content,
    ratio,
    duration: dur,
    watermark,
    generate_audio: true,
    return_last_frame: true, // 任务结果随带尾帧图 last_frame_url，原样保存供下一镜延续
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项（如 resolution/ratio/duration）
    //draft: true,// boolean 默认值 false  |  样片模式
  };
  // resolution：用户所选 > cfg.params > 模型默认；Mini/Fast 不支持 1080p/4K，强制降级避免 400
  body.resolution = resolution || body.resolution || pickResolution(cfg.model);
  if (/mini|fast/i.test(cfg.model || "") && !["480p", "720p"].includes(body.resolution)) {
    logger.warn(`[VIDEO→Seedance] 模型 ${cfg.model} 不支持 resolution=${body.resolution}，降级 720p`);
    body.resolution = "720p";
  }

  const promptStr = finalPrompt;
  // 提交（公共助手，常规生成与「去除字幕」编辑共用）→ 落 pending record → 等待厂商终态
  const { taskId, response } = await seedanceSubmit(cfg, {
    body, headers, userId, genCtx,
    logCtx: {
      model: cfg.model,
      duration: dur,
      ratio,
      resolution: body.resolution,
      contentTypes: content.map((c) => c.type),
      promptChars: promptStr.length,
      promptHead: promptStr.slice(0, 150),
      promptTail: promptStr.length > 150 ? promptStr.slice(-150) : "",
      hasImage,
      refImageCount,
      refVideoCount: refVideos.length,
      refAudioCount: refAudios.length,
      continuityStart: !!startFrameN,
    },
  });
  return submitAndTrack({ cfg, tag: "Seedance", taskId, response, params: body, genCtx });
}

// Seedance 提交任务（viaSeedance 常规生成与「去除字幕」编辑共用）：
// POST {base}/contents/generations/tasks，返回 { taskId, response }；
// 提交失败（已触网）先落一条 failed 留档 record（参数/厂商错误响应可追溯）再抛原中文文案
async function seedanceSubmit(cfg, { body, headers, userId, logCtx = {}, genCtx = {} }) {
  const submitUrl = joinUrl(cfg.base_url, "/contents/generations/tasks");
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  logger.info(`[VIDEO→提交/Seedance] POST ${submitUrl}`, { userId, ...logCtx, key: maskKey(cfg.api_key) });
  logger.info(`[VIDEO→提交/Seedance] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "Seedance", userId, url: submitUrl, model: cfg.model, headers, body, logCtx, genCtx });
  const t0 = Date.now();

  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    // 捕获方舟 4xx/5xx 错误体，便于定位（参数校验/鉴权/限流/内容审核）
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/Seedance] 请求失败 status=${status}`, {
      userId,
      model: cfg.model,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
      ...logCtx,
    });
    // 内容审核拦截：面向用户给出可操作提示，不把原始错误体抛给前端
    const moderationMsg = arkModerationMessage(data);
    const hint = status === 400 ? "（多为参数校验：Mini/Fast 不支持 1080p、duration 越界、content 缺失等）" : "";
    const message = moderationMsg || `Seedance 提交失败 status=${status}${hint}${data ? " :: " + JSON.stringify(data).slice(0, 300) : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }
  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "Seedance", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  const taskId = resp.data?.id || resp.data?.data?.id;
  if (!taskId) {
    const message = "Seedance 未返回任务 id: " + JSON.stringify(resp.data).slice(0, 200);
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }
  return { taskId, response: resp.data };
}

// Seedance 单次任务查询（扫描器 videoGenScanner 调用）：GET {base}/contents/generations/tasks/{id}
// 返回归一化 { state: 'running'|'succeeded'|'failed', vendorStatus, videoUrl?, lastFrameUrl?, message?, raw, httpStatus }；
// 网络/HTTP 层错误直接 throw，由扫描器记 error 明细并按降频重试
export async function querySeedanceTask(cfg, taskId) {
  const headers = { "Content-Type": "application/json" };
  const auth = arkAuthHeader(cfg.api_key);
  if (auth) headers.Authorization = auth;
  const statusUrl = joinUrl(cfg.base_url, `/contents/generations/tasks/${taskId}`);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const status = st.data?.status || st.data?.data?.status;
  if (status === "succeeded" || status === "success" || status === "completed") {
    const url = st.data?.content?.video_url || st.data?.data?.content?.video_url || st.data?.video_url || st.data?.data?.video_url;
    if (!url) {
      return { state: "failed", vendorStatus: status, message: "Seedance 任务成功但未返回 video_url: " + JSON.stringify(st.data).slice(0, 200), raw: st.data, httpStatus: st.status };
    }
    // 尾帧图（提交须带 return_last_frame:true）：随任务一并返回，调用方原样保存、不得修改
    const lastFrame = st.data?.content?.last_frame_url || st.data?.data?.content?.last_frame_url
      || st.data?.last_frame_url || st.data?.data?.last_frame_url || null;
    return { state: "succeeded", vendorStatus: status, videoUrl: url, lastFrameUrl: lastFrame, raw: st.data, httpStatus: st.status };
  }
  if (status === "failed" || status === "error" || status === "expired") {
    const d = st.data?.data || st.data || {};
    const moderationMsg = arkModerationMessage(d);
    const reason = moderationMsg || d.error || d.content?.error || JSON.stringify(d).slice(0, 300);
    return { state: "failed", vendorStatus: status, message: `Seedance 视频生成${status === "expired" ? "超时" : "失败"}: ${status} ${reason}`, raw: st.data, httpStatus: st.status };
  }
  // queued / running 等其余状态 -> 继续查询
  return { state: "running", vendorStatus: status || "unknown", raw: st.data, httpStatus: st.status };
}

// 通用异步视频 provider 调用（尽力兼容非 Seedance 模型，失败回退）
async function viaGeneric(cfg, { prompt, imagePath, duration, userId, resolution, refAssets, genCtx }) {
  const submitUrl = joinUrl(cfg.base_url, "/videos/generations");
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  const headers = { "Content-Type": "application/json" };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  // 提示词英译开关（模型配置 translate_prompt_en）：提交前翻译
  const promptEn = await translatePromptIfNeeded(cfg, userId, prompt, "Generic");
  const body = {
    model: cfg.model,
    prompt: promptEn,
    duration,
    ...vendorParams(cfg.params),
  };
  if (resolution) body.resolution = resolution;
  // 若提供本地图片，以公网 URL 提交（尽力；未配置 PUBLIC_BASE_URL 时跳过并留痕）
  if (imagePath && fs.existsSync(imagePath)) {
    const imageUrl = publicFilesUrl(toUrl(imagePath));
    if (imageUrl) body.image = imageUrl;
    else logger.warn(`[VIDEO→Generic] 首帧图为本地文件且未配置 PUBLIC_BASE_URL，无法以公网 URL 提交，已跳过`);
  }
  // 角色声音样本：取首个绑定音色的角色，尽力而为附加（该通用接口未必支持音频输入，也无角色对应语义）
  const firstVoice = (refAssets || []).find((a) => a && a.voice_url);
  if (firstVoice) {
    const audioUrl = resolveMediaUrl(firstVoice.voice_url);
    if (audioUrl) body.audio = audioUrl;
  }

  const promptStr2 = String(promptEn || "");
  logger.info(`[VIDEO→提交/Generic] POST ${submitUrl}`, {
    userId,
    model: cfg.model,
    duration,
    promptChars: promptStr2.length,
    promptHead: promptStr2.slice(0, 150),
    promptTail: promptStr2.length > 150 ? promptStr2.slice(-150) : "",
    hasImage: !!(imagePath && fs.existsSync(imagePath)),
    key: maskKey(cfg.api_key),
  });
  logger.info(`[VIDEO→提交/Generic] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "Generic", userId, url: submitUrl, model: cfg.model, headers, body, genCtx });
  const t0 = Date.now();
  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/Generic] 请求失败 status=${status}`, {
      userId,
      model: cfg.model,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
    });
    const msg = data?.message || data?.error?.message || (data ? JSON.stringify(data).slice(0, 300) : err.message);
    const message = `视频提交失败 status=${status}${msg ? " :: " + msg : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }

  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "Generic", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  // 同步直接返回视频：无异步任务可查，直接落 succeeded record（无查询明细行）
  const direct = resp.data?.data?.[0]?.url || resp.data?.video_url || resp.data?.output?.[0] || resp.data?.url;
  if (direct) {
    const record = await createSyncSuccessRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, videoUrl: direct }));
    logger.info(`[VIDEO→提交/Generic] record=#${record.id} 同步直出视频 URL，已落库终态`);
    return direct;
  }

  // 异步：落 pending record，等待厂商终态（查询由扫描器负责，无超时）
  const taskId = resp.data?.id || resp.data?.task_id || resp.data?.data?.id;
  if (!taskId) {
    const message = "视频接口未返回结果或任务 id";
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }
  return submitAndTrack({ cfg, tag: "Generic", taskId, response: resp.data, params: body, genCtx });
}

// Generic 单次任务查询（扫描器 videoGenScanner 调用）：GET {base}/videos/generations/{id}
export async function queryGenericTask(cfg, taskId) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const statusUrl = joinUrl(cfg.base_url, `/videos/generations/${taskId}`);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const status = st.data?.status || st.data?.data?.status;
  if (status === "succeeded" || status === "success" || status === "completed") {
    const url = st.data?.video_url || st.data?.output?.[0] || st.data?.data?.url || st.data?.data?.video_url;
    if (!url) {
      return { state: "failed", vendorStatus: status, message: "视频任务成功但未返回视频 URL: " + JSON.stringify(st.data).slice(0, 200), raw: st.data, httpStatus: st.status };
    }
    return { state: "succeeded", vendorStatus: status, videoUrl: url, lastFrameUrl: null, raw: st.data, httpStatus: st.status };
  }
  if (status === "failed" || status === "error") {
    return { state: "failed", vendorStatus: status, message: "视频生成任务失败", raw: st.data, httpStatus: st.status };
  }
  // 其余状态（queued/processing 等）-> 继续查询
  return { state: "running", vendorStatus: status || "unknown", raw: st.data, httpStatus: st.status };
}

/**
 * 阿里云百炼 DashScope 视频生成契约（HappyHorse 图生视频等异步任务模型）
 * POST {origin}/api/v1/services/aigc/video-generation/video-synthesis  -> 轮询 GET {origin}/api/v1/tasks/{task_id}
 *
 * 与火山 Seedance 的关键差异：
 *   - 必须带请求头 X-DashScope-Async: enable（缺失会报 "current user api does not support synchronous calls"）
 *   - 请求体为嵌套结构 { model, input:{ prompt, media:[{ type:'first_frame', url }] }, parameters:{ resolution, duration, ... } }
 *   - 图生视频(i2v)的 input.media 有且仅有 1 张 type:'first_frame' 图（必填，无图必 400）
 *   - 分辨率取值 480P / 720P / 1080P（注意大写 P，默认 1080P）；时长 [3,15] 整数
 *   - 图生视频不支持 ratio，输出宽高比自动跟随输入首帧
 *   - 图片可为公网 URL 或 Base64；本实现一律以公网 URL 提交（本机 /files 经 PUBLIC_BASE_URL 映射，须可被百炼访问）
 * 鉴权：Authorization: Bearer <DASHSCOPE_API_KEY>
 * 注意：base_url 可能含 /compatible-mode/v1 兼容模式后缀，需取其 origin 拼接 /api/v1/... 路径
 */
async function viaDashScopeVideo(cfg, { prompt, imagePath, duration, userId, resolution, watermark, genCtx }) {
  // 首帧图（i2v 必填）：imagePath 仅来自跨镜尾帧延续（同场连续），非连续生成为空
  const firstFrame = resolveFirstFrame(imagePath);
  if (!firstFrame) {
    throw new Error("当前视频模型为图生视频(i2v)，必须提供「首帧图」：仅当本镜与上一镜同场连续时自动沿用其尾帧作首帧，非连续生成请改用支持文生视频的模型（本地尾帧素材须在服务端配置 PUBLIC_BASE_URL 才能以公网 URL 提交）。");
  }

  const headers = {
    "Content-Type": "application/json",
    "X-DashScope-Async": "enable", // 必填
  };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  // 提示词英译开关（模型配置 translate_prompt_en）：提交前翻译，再按契约截断
  const promptEn = await translatePromptIfNeeded(cfg, userId, String(prompt || ""), "DashScope");
  const body = {
    model: cfg.model,
    input: {
      prompt: promptEn.slice(0, 2500), // ≤2500 中文字符
      media: [{ type: "first_frame", url: firstFrame }],
    },
    parameters: {
      duration: clampInt(duration, 3, 15), // [3,15] 整数，默认 5
      watermark,
      resolution: mapDashScopeResolution(resolution),
      ...vendorParams(cfg.params), // DB params 可覆盖以上任意项
    },
  };

  const submitUrl = dashScopeUrl(cfg.base_url, "/api/v1/services/aigc/video-generation/video-synthesis");
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  const promptStr = String(promptEn || "");
  logger.info(`[VIDEO→提交/DashScope] POST ${submitUrl}`, {
    userId,
    model: cfg.model,
    duration: body.parameters.duration,
    resolution: body.parameters.resolution,
    promptChars: promptStr.length,
    promptHead: promptStr.slice(0, 50),
    promptTail: promptStr.length > 50 ? promptStr.slice(-50) : "",
    hasFirstFrame: !!firstFrame,
    firstFrameKind: "url", // 一律以公网 URL 提交（本实现已全面禁用 Base64）
    key: maskKey(cfg.api_key),
  });
  logger.info(`[VIDEO→提交/DashScope] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "DashScope", userId, url: submitUrl, model: cfg.model, headers, body, genCtx });
  const t0 = Date.now();

  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    // 捕获百炼 4xx/5xx 错误体，便于定位（鉴权/参数校验/限流/内容审核）
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/DashScope] 请求失败 status=${status}`, {
      userId,
      model: cfg.model,
      resolution: body.parameters.resolution,
      duration: body.parameters.duration,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
    });
    const msg = data?.message || (data ? JSON.stringify(data).slice(0, 300) : err.message);
    const message = `HappyHorse 视频提交失败 status=${status}${msg ? " :: " + msg : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }
  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "DashScope", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  const taskId = resp.data?.output?.task_id;
  if (!taskId) {
    const message = "HappyHorse 视频未返回任务 id: " + JSON.stringify(resp.data).slice(0, 200);
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }

  // 异步：落 pending record，等待厂商终态（查询由扫描器负责，无超时）
  return submitAndTrack({ cfg, tag: "DashScope", taskId, response: resp.data, params: body, genCtx });
}

// DashScope 单次任务查询（扫描器 videoGenScanner 调用）：GET {origin}/api/v1/tasks/{task_id}
export async function queryDashScopeTask(cfg, taskId) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const statusUrl = dashScopeUrl(cfg.base_url, `/api/v1/tasks/${taskId}`);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const taskStatus = st.data?.output?.task_status;
  if (taskStatus === "SUCCEEDED") {
    const url = st.data?.output?.video_url;
    if (!url) {
      return { state: "failed", vendorStatus: taskStatus, message: "HappyHorse 任务成功但未返回 video_url: " + JSON.stringify(st.data).slice(0, 200), raw: st.data, httpStatus: st.status };
    }
    return { state: "succeeded", vendorStatus: taskStatus, videoUrl: url, lastFrameUrl: null, raw: st.data, httpStatus: st.status };
  }
  if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "UNKNOWN") {
    const d = st.data?.output || {};
    const reason = d.message || d.code || taskStatus;
    return { state: "failed", vendorStatus: taskStatus, message: `HappyHorse 视频生成${taskStatus === "UNKNOWN" ? "任务已过期" : "失败"}: ${taskStatus} ${reason}`, raw: st.data, httpStatus: st.status };
  }
  // PENDING / RUNNING -> 继续查询
  return { state: "running", vendorStatus: taskStatus || "unknown", raw: st.data, httpStatus: st.status };
}

/**
 * MiniMax-H3 视频生成契约（v2 异步任务，多模态输入）
 * POST {base}/v2/video_generation  -> 轮询 GET {base}/v2/query/video_generation/{task_id}
 *
 * 多模态 content（元素按 type=text/image_url/video_url/audio_url 区分，可带 role）：
 *   ⚠ 本实现仅提交多模态输入，纯文生视频(t2v)不支持（无图直接报错）
 *   - 图生视频(i2v)：text + 1 个 first_frame 图（+可选 last_frame 图）
 *   - 引用生视频(r2v)：text + reference_image / reference_video / reference_audio
 *     - 参考视频：≤3 段、单段[2,15]s、总时长≤15s、单文件≤50MB；请求体≤64MB，故本实现优先外网 URL 直传
 *     ⚠ 参考音频：≤3 段、单段[2,15]s、总时长≤15s、仅 WAV/MP3、单文件≤15MB；不可仅传音频（r2v 恒有参考图）
 *   ⚠ i2v(first_frame/last_frame) 与 r2v(reference_*) 互斥，不可混用；本实现按「首帧优先」二选一
 *   - 每次请求必须含 1 个非空 text（prompt 必填）
 *   - image_url.url 支持公网 URL 与 Base64(data:image/<fmt>;base64,...)；大文件请用公网 URL
 * 顶层参数：resolution(768P|2K) / duration[4,15] 整数 / ratio(adaptive|21:9|16:9|4:3|1:1|3:4|9:16)
 *   - i2v：ratio 恒为 adaptive（跟随首帧，传具体值也会被忽略）；r2v：ratio 可选默认 adaptive
 * 鉴权：Authorization: Bearer <MINIMAX_API_KEY>
 * 注意：MiniMax 接口位于 /v2 根（非 OpenAI 的 /v1）；minimaxUrl 会把 base_url 规整到 /v2
 */
async function viaMiniMax(cfg, { prompt, duration, aspect, userId, refAssets, resolution, continuityFrame, genCtx }) {
  const dur = clampInt(duration, 4, 15); // [4,15] 整数
  const promptText = String(prompt || "").trim();

  // ---- 多模态 content：text 在前，按「首帧优先」二选一地加入图片（i2v / r2v 互斥）----
  const content = [];
  content.push({ type: "text", text: promptText }); // text 必填；空文本会被 MiniMax 以 2013 拒绝

  const hasRef = !!(continuityFrame || (refAssets && refAssets.some((a) => a && (a.image_url || a.video_url))));
  // 仅提交多模态输入：i2v(首帧图) / r2v(引用资产图) 均含图；纯文生视频(t2v)不支持，无图直接报错
  if (!hasRef) {
    throw new Error("当前视频模型(MiniMax)仅支持多模态输入：必须提供首帧图或引用资产图，请先为该分镜生成/上传关键帧，或为分镜引用带图的资产后重试（本地素材须在服务端配置 PUBLIC_BASE_URL 才能以公网 URL 提交）。");
  }

  let imageCount = 0;
  // r2v：引用资产图（角色/场景/道具参考）-> reference_image；编号用于正文 @图片N 占位符替换
  const assetToN = new Map();
  // 跨镜首尾帧延续：把上一镜尾帧作为首张参考图（图片1），让模型从此帧起始；后续资产图顺延编号
  let startFrameN = 0;
  if (continuityFrame) {
    const encoded = resolveMediaUrl(continuityFrame);
    if (encoded) {
      imageCount += 1;
      startFrameN = imageCount;
      content.push({ type: "image_url", image_url: { url: encoded }, role: "reference_image" });
    }
  }
  // r2v：参考视频（视频资产的文件本体）先按契约限档规整（≤3 段、单段[2,15]s、总≤15s），命中者资产循环里跳过封面图
  const refVideos = await collectRefVideos(refAssets, REF_VIDEO_LIMITS.minimax, "MiniMax");
  const videoAssets = new Set(refVideos.map((x) => x.asset));
  for (const asset of refAssets || []) {
    // 视频资产本体已附加为 reference_video（见下），封面图不再重复作参考图；未规整成功的回退封面图
    if (!asset || videoAssets.has(asset)) continue;
    if (!asset.image_url) continue;
    const encoded = resolveMediaUrl(asset.image_url);
    if (!encoded) continue;
    imageCount += 1;
    content.push({ type: "image_url", image_url: { url: encoded }, role: "reference_image" });
    if (!assetToN.has(asset)) assetToN.set(asset, imageCount);
  }
  // 参考视频紧随参考图之后附加
  for (const x of refVideos) {
    content.push({ type: "video_url", video_url: { url: x.encoded }, role: "reference_video" });
  }
  // r2v：参考音频（角色音色）逐角色附加为 reference_audio（≤3 段、单段[2,15]s、总≤15s，MiniMax 契约含总时长，由 collectRefAudios 规整）
  const refAudios = await collectRefAudios(refAssets, REF_AUDIO_LIMITS.minimax, "MiniMax");
  for (const x of refAudios) {
    content.push({ type: "audio_url", audio_url: { url: x.encoded }, role: "reference_audio" });
  }
  // 起始帧备注：仅当尾帧成功加入时，提示模型从该参考图起始、自然延续（保持相邻镜头视觉连贯）
  const startNote = startFrameN ? startFrameNote(startFrameN) : "";
  // 正文资产名批量替换为多模态占位符（@图片N/@音频N/@视频N，N 为同类素材提交序号），
  // 不再前置「参考图/音频/视频映射」说明；未附加素材的资产名保留原文。
  // 声音样本说明（中文）紧随其后：把 @音频N 关联到角色的 @图片M（正文中的名称已被图片占位符取代）
  const promptBody = replaceAssetNamesWithTokens(promptText, assetTokenRefs({ assetToN, refVideos, refAudios }));
  // 提示词英译开关（模型配置 translate_prompt_en）：占位符替换之后、提交之前翻译
  content[0].text = await translatePromptIfNeeded(
    cfg, userId,
    [promptBody, startNote, refAudioVoiceNote(refAudios, assetToN)].filter(Boolean).join("\n\n"),
    "MiniMax",
  );

  // ratio：i2v 恒 adaptive（跟随首帧）；r2v 用具体比例
  const ratio = (cfg.params && cfg.params.ratio) || mapRatio(aspect);

  const body = {
    model: cfg.model,
    content,
    duration: dur,
    ratio,
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项（含 resolution/ratio/duration）
  };
  // resolution：cfg.params > 入参，统一规整到 MiniMax 档位（768P/2K）
  body.resolution = mapMiniMaxResolution(body.resolution || resolution);

  const finalText = content[0].text;
  // 提交（公共助手，常规生成与「去除字幕」编辑共用）→ 落 pending record → 等待厂商终态
  const { taskId, response } = await minimaxSubmit(cfg, {
    body, userId, genCtx,
    logCtx: {
      model: cfg.model,
      duration: dur,
      ratio: body.ratio,
      resolution: body.resolution,
      contentTypes: content.map((c) => c.type),
      imageCount,
      refVideoCount: refVideos.length,
      refAudioCount: refAudios.length,
      continuityStart: !!startFrameN,
      promptChars: finalText.length,
      promptHead: finalText.slice(0, 150),
      promptTail: finalText.length > 150 ? finalText.slice(-150) : "",
    },
  });
  return submitAndTrack({ cfg, tag: "MiniMax", taskId, response, params: body, genCtx });
}

// MiniMax 提交任务（viaMiniMax 常规生成与「去除字幕」编辑共用）：
// POST {base}/v2/video_generation，返回 { taskId, response }；
// 提交失败（已触网）先落一条 failed 留档 record 再抛原中文文案
async function minimaxSubmit(cfg, { body, userId, logCtx = {}, genCtx = {} }) {
  const submitUrl = minimaxUrl(cfg.base_url, "/video_generation");
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` };
  logger.info(`[VIDEO→提交/MiniMax] POST ${submitUrl}`, { userId, ...logCtx, key: maskKey(cfg.api_key) });
  logger.info(`[VIDEO→提交/MiniMax] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "MiniMax", userId, url: submitUrl, model: cfg.model, headers, body, logCtx, genCtx });
  const t0 = Date.now();

  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    // 捕获 MiniMax 4xx/5xx 错误体，便于定位（参数校验/鉴权/限流/内容审核）
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/MiniMax] 请求失败 status=${status}`, {
      userId,
      model: cfg.model,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
      ...logCtx,
    });
    const moderationMsg = minimaxModerationMessage(data);
    const msg = data?.error?.message || (data ? JSON.stringify(data).slice(0, 300) : err.message);
    const message = moderationMsg || `MiniMax 视频提交失败 status=${status}${msg ? " :: " + msg : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }
  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "MiniMax", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  const taskId = resp.data?.task_id;
  if (!taskId) {
    const message = "MiniMax 视频未返回 task_id: " + JSON.stringify(resp.data).slice(0, 200);
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }
  return { taskId, response: resp.data };
}

// MiniMax 单次任务查询（扫描器 videoGenScanner 调用）：GET {base}/v2/query/video_generation/{task_id}
export async function queryMiniMaxTask(cfg, taskId) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` };
  const statusUrl = minimaxUrl(cfg.base_url, `/query/video_generation/${taskId}`);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const task = st.data?.task || {};
  const status = task.status;
  if (status === "succeeded") {
    const url = task.content?.url;
    if (!url) {
      return { state: "failed", vendorStatus: status, message: "MiniMax 任务成功但未返回 content.url: " + JSON.stringify(st.data).slice(0, 200), raw: st.data, httpStatus: st.status };
    }
    return { state: "succeeded", vendorStatus: status, videoUrl: url, lastFrameUrl: null, raw: st.data, httpStatus: st.status };
  }
  if (status === "failed" || status === "cancelled") {
    const moderationMsg = minimaxModerationMessage(st.data);
    const reason = moderationMsg || task.error?.message || JSON.stringify(st.data).slice(0, 300);
    return { state: "failed", vendorStatus: status, message: `MiniMax 视频生成${status === "cancelled" ? "已取消" : "失败"}: ${status} ${reason}`, raw: st.data, httpStatus: st.status };
  }
  // queued / running -> 继续查询
  return { state: "running", vendorStatus: status || "unknown", raw: st.data, httpStatus: st.status };
}

/**
 * Agnes Video 2.5 视频生成契约（OpenAI Videos 兼容 API，文档：https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25.md）
 * POST {base}/videos（base 默认 https://apihub.agnes-ai.com/v1）
 *   -> 轮询 GET {base 去 /v1}/agnesapi?video_id=<video_id>&model_name=<model>（查询端点在 /agnesapi，见 agnesQueryUrl）
 *      终态 completed 的视频地址：顶层 url 或 metadata.url 两种形态均有实测（internal_status 可仍为 pending，
 *      不代表可交付性；两者皆缺才进宽限期继续轮询，见 queryAgnesTask）
 *
 * 与其余 provider 的关键差异：
 *   - 三种生成模式互斥：text（纯文生视频）/ keyframe（first_frame/last_frame）/ reference（images/audios/videos）；
 *     本实现按「有无参考素材」二选一：装配到任一素材走 reference，否则走 text。keyframe 的首尾帧语义与
 *     本实现「跨镜尾帧按参考图延续」口径不同（首帧图路径已停用，同 Seedance/MiniMax），故不使用
 *   - 参考媒体限档：图片≤8 张（单张<15MB、宽高 256-5760）；视频≤1 个、总时长[2,12]s、单文件<50MB；
 *     音频≤3 段、总时长[2,12]s、单段 2s 起；单请求媒体总数≤12（媒体 URL 须公网可访问，本实现一律 URL 提交）
 *   - 提示词占位符契约是 <Picture N>/<Audio N>/<Video N>（各素材数组从 1 编号）：本实现仍以 @图片N/@音频N/@视频N
 *     装配与英译（translate_prompt_en 按 @ 形态校验占位符与台词保护），提交前统一转换为 Agnes 形态
 *   - seconds 为字符串 "4"-"12"（默认 "5"）；size 档位 720P/1080P/1K/2K（1K 固定 1024x1024 方形，
 *     与剧集画幅不符不选用，见 mapAgnesSize）；aspect_ratio 支持 21:9/16:9/4:3/1:1/3:4/9:16（不支持 auto/像素直填）
 *   - 提交响应的 video_id 是查询键（id/task_id 为任务标识，查询不可用）；不支持 width/height/fps 等字段（传则 400）
 * 鉴权：Authorization: Bearer <AGNES_API_KEY>
 */
async function viaAgnes(cfg, { prompt, duration, aspect, userId, refAssets, resolution, continuityFrame, continuitySource, genCtx }) {
  const dur = clampInt(duration, 4, 12); // seconds 契约 [4,12]，字符串提交
  const promptText = String(prompt || "").trim();

  // ---- 参考素材装配（reference 模式）：跨镜尾帧 + 资产图 -> images；视频资产本体 -> videos；角色音色 -> audios ----
  const images = [];
  const assetToN = new Map(); // 资产 -> 图片序号 N（1 起），用于正文占位符替换
  let startFrameN = 0;
  if (continuityFrame) {
    const encoded = resolveMediaUrl(continuityFrame);
    if (encoded) {
      images.push(encoded);
      startFrameN = images.length;
      logger.info(`[VIDEO→Agnes] 跨镜延续：上一镜尾帧作为起始帧参考图（图片${startFrameN}，来源 ${continuitySource || "ffmpeg/历史"}）`);
    }
  }
  const refVideos = await collectRefVideos(refAssets, REF_VIDEO_LIMITS.agnes, "Agnes");
  const videoAssets = new Set(refVideos.map((x) => x.asset));
  for (const asset of refAssets || []) {
    if (images.length >= 8) break; // 契约：图片最多 8 张
    if (!asset || videoAssets.has(asset) || !asset.image_url) continue;
    const encoded = resolveMediaUrl(asset.image_url);
    if (!encoded) continue;
    images.push(encoded);
    if (!assetToN.has(asset)) assetToN.set(asset, images.length);
  }
  const refAudios = await collectRefAudios(refAssets, REF_AUDIO_LIMITS.agnes, "Agnes");

  // 生成模式二选一：装配到任一素材走 reference，否则纯文生视频 text
  const mode = images.length || refVideos.length || refAudios.length ? "reference" : "text";

  // 起始帧备注 + 正文资产名批量替换为占位符（@形态）+ 声音样本说明 -> 英译开关 -> 转 Agnes 占位符形态
  const startNote = startFrameN ? startFrameNote(startFrameN) : "";
  const promptBody = replaceAssetNamesWithTokens(promptText, assetTokenRefs({ assetToN, refVideos, refAudios }));
  const translated = await translatePromptIfNeeded(
    cfg, userId,
    [promptBody, startNote, refAudioVoiceNote(refAudios, assetToN)].filter(Boolean).join("\n\n"),
    "Agnes",
  );
  const finalPrompt = toAgnesPromptTokens(translated);

  const body = {
    model: cfg.model,
    prompt: finalPrompt,
    mode,
    seconds: String(dur),
    aspect_ratio: mapRatio(aspect),
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项（如 size/seed；置 null 的键从提交体剔除）
  };
  // reference 模式媒体字段（text 模式禁止携带任何媒体字段，否则 400）：
  // images=URL 数组；videos=对象数组（url 必填；本实现无起始秒/强制音轨诉求，require_audio 恒 false）；
  // audios=URL 数组。url 均为公网可访问 URL（resolveMediaUrl/collectRef* 已规整）。
  if (mode === "reference") {
    if (images.length) body.images = images;
    if (refVideos.length) body.videos = refVideos.map((x) => ({ url: x.encoded, require_audio: true }));
    if (refAudios.length) body.audios = refAudios.map((x) => x.encoded);
  }
  // size 档位：cfg.params.size > 入参 resolution 规整；params 显式置 null 表示不传（用厂商默认档）
  if (body.size === null) delete body.size;
  else body.size = mapAgnesSize(body.size || resolution);
  for (const k of Object.keys(body)) if (body[k] === null) delete body[k];

  const submitUrl = joinUrl(cfg.base_url, "/videos");
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` };
  logger.info(`[VIDEO→提交/Agnes] POST ${submitUrl}`, {
    userId,
    model: cfg.model,
    mode,
    seconds: body.seconds,
    size: body.size,
    aspect_ratio: body.aspect_ratio,
    refImageCount: images.length,
    refVideoCount: refVideos.length,
    refAudioCount: refAudios.length,
    continuityStart: !!startFrameN,
    promptChars: finalPrompt.length,
    promptHead: finalPrompt.slice(0, 150),
    promptTail: finalPrompt.length > 150 ? finalPrompt.slice(-150) : "",
    key: maskKey(cfg.api_key),
  });
  logger.info(`[VIDEO→提交/Agnes] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "Agnes", userId, url: submitUrl, model: cfg.model, headers, body, genCtx });
  const t0 = Date.now();

  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    // 捕获 Agnes 4xx/5xx 错误体，便于定位（模式与媒体不匹配/参数校验/鉴权/限流/内容审核）
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/Agnes] 请求失败 status=${status}`, {
      userId,
      model: cfg.model,
      mode,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
    });
    const msg = data?.error?.message || data?.message || (data ? JSON.stringify(data).slice(0, 300) : err.message);
    const message = `Agnes 视频提交失败 status=${status}${msg ? " :: " + msg : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }
  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "Agnes", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  // video_id 是后续查询的键（id/task_id 是任务标识，不可用于 /agnesapi 查询）
  const taskId = resp.data?.video_id || resp.data?.task_id || resp.data?.id;
  if (!taskId) {
    const message = "Agnes 视频未返回 video_id: " + JSON.stringify(resp.data).slice(0, 200);
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }
  // 异步：落 pending record，等待厂商终态（查询由扫描器负责，无超时）
  return submitAndTrack({ cfg, tag: "Agnes", taskId, response: resp.data, params: body, genCtx });
}

// Agnes 单次任务查询（扫描器 videoGenScanner 调用）：GET {origin}/agnes/agnesapi?video_id=<video_id>&model_name=<model>
// （查询端点在 /agnes 前缀之下，非 base_url 的 /v1 之下；不带 model_name 仅 text 模式可查，故恒带）
export async function queryAgnesTask(cfg, taskId) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const statusUrl = agnesQueryUrl(cfg, taskId);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const status = st.data?.status;
  if (status === "completed") {
    // 仅 status=completed 时地址字段才是可交付的视频地址。实测两种返回形态：
    //   ① 结果在 metadata.url（早期口径）② 结果直接在顶层 url（r#1904，此时 internal_status 仍可为
    //   pending——internal_* 字段不代表可交付性，以 status=completed 为准）。其余为命名差异兜底
    const meta = st.data?.metadata || {};
    const url = st.data?.url || meta.url || meta.video_url || meta.download_url || st.data?.video_url || null;
    if (!url) {
      // 实测（r#1894）：厂商会出现 status=completed 但 metadata.url 缺失、internal_status 仍 pending 的
      // 不一致态（疑似结果落盘延迟）。宽限期内按 running 继续轮询（间隔由扫描器降频控制），超宽限期
      // 仍未给出 URL 才判失败；完整 raw 落日志，便于确认真实响应结构
      const since = agnesMissingUrlSince.get(taskId);
      const first = since || Date.now();
      if (!since) agnesMissingUrlSince.set(taskId, first);
      const waitedMs = Date.now() - first;
      logger.warn(`[VIDEO→Agnes] status=completed 但未返回视频地址（已等待 ${(waitedMs / 1000).toFixed(0)}s，宽限 ${AGNES_METADATA_GRACE_MS / 1000}s），raw=${JSON.stringify(st.data).slice(0, 2000)}`);
      if (waitedMs < AGNES_METADATA_GRACE_MS) {
        return { state: "running", vendorStatus: "completed_no_url", raw: st.data, httpStatus: st.status };
      }
      agnesMissingUrlSince.delete(taskId);
      return { state: "failed", vendorStatus: status, message: `Agnes 任务已完成但超宽限期仍未返回视频地址: ${JSON.stringify(st.data).slice(0, 500)}`, raw: st.data, httpStatus: st.status };
    }
    agnesMissingUrlSince.delete(taskId);
    return { state: "succeeded", vendorStatus: status, videoUrl: url, lastFrameUrl: null, raw: st.data, httpStatus: st.status };
  }
  if (status === "failed") {
    agnesMissingUrlSince.delete(taskId);
    const reason = st.data?.error?.message || JSON.stringify(st.data).slice(0, 300);
    return { state: "failed", vendorStatus: status, message: `Agnes 视频生成失败: ${reason}`, raw: st.data, httpStatus: st.status };
  }
  // queued / in_progress 等其余状态 -> 继续查询
  return { state: "running", vendorStatus: status || "unknown", raw: st.data, httpStatus: st.status };
}

// 「completed 但无视频地址」宽限记账：taskId -> 首次观测时刻（拿到 URL/失败即清除，仅内存态、重启即重置）
const agnesMissingUrlSince = new Map();
const AGNES_METADATA_GRACE_MS = 10 * 60 * 1000;

// Agnes 查询 URL：base_url 只截掉最后面的 /v1（其余路径保留）后拼 /agnesapi，兼容用户误带 /v1 后缀
// （实测 r#1905：查询端点不在 /v1 之下，带着 /v1 原样拼会 404/错误）
function agnesQueryUrl(cfg, videoId) {
  const base = String(cfg.base_url || "https://apihub.agnes-ai.com/v1").replace(/\/+$/, "").replace(/\/v1$/i, "");
  const origin = base || "https://apihub.agnes-ai.com";
  return `${origin}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(cfg.model || "agnes-video-2.5")}`;
}

// Agnes 提示词占位符转换：本实现统一以 @图片N/@音频N/@视频N 装配与英译（translate_prompt_en 的
// 占位符校验按 @ 形态），提交前转换为 Agnes 的 <Picture N>/<Audio N>/<Video N>（各素材数组从 1 编号，一一对应）
function toAgnesPromptTokens(text) {
  return String(text || "")
    .replace(/@图片(\d+)/g, "<Picture $1>")
    .replace(/@音频(\d+)/g, "<Audio $1>")
    .replace(/@视频(\d+)/g, "<Video $1>");
}

// Agnes 分辨率档位：720P/1080P/1K/2K；1K 固定 1024x1024 方形、与剧集画幅不符不选用；缺省/未知降 720P
function mapAgnesSize(r) {
  const v = String(r || "").toLowerCase();
  if (v === "1080p") return "1080P";
  if (v === "2k" || v === "4k") return "2K";
  return "720P";
}

/**
 * 万相3.0（wan3.0-video / wan3.0-video-prime）视频生成契约（千问AI平台 / 阿里云百炼同族协议）
 * 文档：https://platform.qianwenai.com/docs/api-reference/video-generation/wan30-video/create-task
 *       （使用指南：https://docs.bailian.console.aliyun.com/zh/model-studio/wan3-video-generation-guide）
 * POST {origin}/api/v1/services/aigc/video-generation/video-synthesis（头 X-DashScope-Async: enable，缺失报
 *   "current user api does not support synchronous calls"）
 *   -> 轮询 GET {origin}/api/v1/tasks/{task_id}（与 DashScope/HappyHorse 同族端点，复用 dashScopeUrl 取 origin；
 *      base_url 填千问AI平台 https://maas.qianwenaiapi.com/api/v1（默认，Key 从 platform.qianwenai.com 获取），
 *      或百炼 https://dashscope.aliyuncs.com/api/v1 / 业务空间 https://{ws}.{region}.maas.aliyuncs.com/api/v1）
 *
 * 全模态参考生视频（本实现主适配）：input.media 数组，提示词以 图1/图片1、视频1、音频1 指代素材
 * （图/视频/音频各类独立从 1 计数、按数组顺序编号——与本项目 @图片N/@音频N/@视频N 占位符约定同构，
 * 提交前经 toAliwanPromptTokens 去 @ 转换）：
 *   - reference_image（角色/场景/道具参考图，跨镜尾帧起始图亦按参考图延续口径加入）：≤10 张，单张≤20MB、单边[240,8000]px；
 *   - reference_video（视频资产本体）：≤5 段、单段[1,15]s、总时长≤15s、单文件≤100MB（mp4/mov、≥16fps）；
 *   - reference_audio（角色音色样本）：≤5 段、单段[1,15]s、总时长≤15s、单文件≤15MB（wav/mp3）；
 *   - 三类可自由组合；media 均不传即纯文生视频（prompt 单独即可）。媒体一律以公网 URL 提交
 *     （resolveMediaUrl/collectRef* 已规整，本实现全面禁用 Base64）；
 *   - 契约互斥：reference_* 与 first_frame/last_frame 不可混用（本实现恒走参考系，尾帧作参考图延续）。
 * parameters：resolution 480P/720P/1080P（厂商默认 1080P）/ ratio 21:9|16:9|4:3|1:1|3:4|9:16|adaptive /
 *   duration [2,30] 整数或 -1（智能时长，DB params 可覆盖）；⚠ 有视频输入时「输入视频总时长+输出时长≤30」，
 *   本实现按参考视频实际占用压低 duration（下限 2）；audio（默认 true，原生出台词/BGM/音效，开关同价）/
 *   seed / watermark（默认 false）/ prompt_extend（厂商默认 true；⚠ file/link 素材时必须为 true——本实现
 *   不装配 file/link，默认关安全：分镜提示词已含占位符引用/台词保护/起始帧备注等精细结构，避免厂商改写
 *   扰动，DB params 可覆盖为 true）。
 * 产出视频 URL 24h 失效——扫描器查到终态后由 downloadProviderOutputs 即时落盘，不落厂商地址。
 * 鉴权：Authorization: Bearer <API_KEY>（千问AI平台 / 百炼 Key 形如 sk-xxx，原样透传）
 */
async function viaAliwan(cfg, { prompt, duration, aspect, userId, refAssets, resolution, continuityFrame, continuitySource, genCtx }) {
  const durBase = clampInt(duration, 2, 30); // [2,30] 整数；-1 智能时长经 DB params 覆盖
  const promptText = String(prompt || "").trim();

  // ---- 参考素材装配（全模态参考）：跨镜尾帧+资产图 -> reference_image；视频资产 -> reference_video；角色音色 -> reference_audio ----
  const media = [];
  const assetToN = new Map(); // 资产 -> 图片序号 N（1 起），用于正文占位符替换
  let imageCount = 0;
  let startFrameN = 0;
  if (continuityFrame) {
    const encoded = resolveMediaUrl(continuityFrame);
    if (encoded) {
      imageCount += 1;
      startFrameN = imageCount;
      media.push({ type: "reference_image", url: encoded });
      logger.info(`[VIDEO→万相] 跨镜延续：上一镜尾帧作为起始帧参考图（图片${startFrameN}，来源 ${continuitySource || "ffmpeg/历史"}）`);
    }
  }
  // 参考视频（视频资产的文件本体）先按契约限档规整；命中者资产循环里跳过封面图
  const refVideos = await collectRefVideos(refAssets, REF_VIDEO_LIMITS.aliwan, "万相");
  const videoAssets = new Set(refVideos.map((x) => x.asset));
  for (const asset of refAssets || []) {
    if (imageCount >= 10) break; // 契约：reference_image 最多 10 张
    if (!asset || videoAssets.has(asset) || !asset.image_url) continue;
    const encoded = resolveMediaUrl(asset.image_url);
    if (!encoded) continue;
    imageCount += 1;
    media.push({ type: "reference_image", url: encoded });
    if (!assetToN.has(asset)) assetToN.set(asset, imageCount);
  }
  // 参考视频紧随参考图之后、参考音频最后（数组顺序即图/视频/音频各类的编号顺序）
  for (const x of refVideos) {
    media.push({ type: "reference_video", url: x.encoded });
  }
  const refAudios = await collectRefAudios(refAssets, REF_AUDIO_LIMITS.aliwan, "万相");
  for (const x of refAudios) {
    media.push({ type: "reference_audio", url: x.encoded });
  }
  // 契约：有视频输入时「输入视频总时长 + 输出时长 ≤ 30」——按参考视频实际占用压低输出时长（下限保 2；
  // 远程视频时长未知按 collectRefVideos 的预算份额计入，保守收口）
  const refVideoSeconds = refVideos.reduce((s, x) => s + (x.seconds || 0), 0);
  const dur = refVideoSeconds > 0 ? Math.max(2, Math.min(durBase, 30 - Math.ceil(refVideoSeconds))) : durBase;
  if (dur !== durBase) {
    logger.info(`[VIDEO→万相] 参考视频占用 ${refVideoSeconds.toFixed(1)}s，输出时长 ${durBase}s → ${dur}s（输入+输出≤30 契约）`);
  }

  // 起始帧备注 + 正文资产名批量替换为占位符（@形态）+ 声音样本说明 -> 英译开关 -> 去 @ 转万相形态
  const startNote = startFrameN ? startFrameNote(startFrameN) : "";
  const promptBody = replaceAssetNamesWithTokens(promptText, assetTokenRefs({ assetToN, refVideos, refAudios }));
  const translated = await translatePromptIfNeeded(
    cfg, userId,
    [promptBody, startNote, refAudioVoiceNote(refAudios, assetToN)].filter(Boolean).join("\n\n"),
    "万相",
  );
  const finalPrompt = toAliwanPromptTokens(translated);

  const parameters = {
    resolution: mapDashScopeResolution(resolution), // 480P/720P/1080P（4K 降 1080P）
    ratio: mapRatio(aspect), // 万相档位与 mapRatio 白名单一致（21:9/16:9/4:3/1:1/3:4/9:16）
    duration: dur,
    prompt_extend: false, // 默认关：分镜提示词含占位符/台词/起始帧备注等精细结构，避免厂商改写扰动（DB params 可覆盖）
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项（如 audio/seed/duration:-1 智能时长）
  };
  // resolution：用户所选 > cfg.params > 默认 720P（对齐 Seedance 口径；路由侧已按 resolutions 白名单校验入参）
  parameters.resolution = mapDashScopeResolution(resolution || parameters.resolution);

  const body = {
    model: cfg.model,
    input: {
      prompt: finalPrompt.slice(0, 20000), // 契约 ≤20000 字符（超长厂商侧亦自动截断，此处防御性规整）
      ...(media.length ? { media } : {}), // 无参考素材即纯文生视频（media 不传）
    },
    parameters,
  };

  // 提交（公共助手，常规生成与「去除字幕」编辑共用）→ 落 pending record → 等待厂商终态
  const { taskId, response } = await aliwanSubmit(cfg, {
    body, userId, genCtx,
    logCtx: {
      model: cfg.model,
      duration: parameters.duration,
      ratio: parameters.ratio,
      resolution: parameters.resolution,
      mediaTypes: media.map((m) => m.type),
      refImageCount: imageCount,
      refVideoCount: refVideos.length,
      refAudioCount: refAudios.length,
      continuityStart: !!startFrameN,
      promptChars: finalPrompt.length,
      promptHead: finalPrompt.slice(0, 150),
      promptTail: finalPrompt.length > 150 ? finalPrompt.slice(-150) : "",
    },
  });
  return submitAndTrack({ cfg, tag: "万相", taskId, response, params: body, genCtx });
}

// 万相 提交任务（viaAliwan 常规生成与「去除字幕」编辑共用）：
// POST {origin}/api/v1/services/aigc/video-generation/video-synthesis，返回 { taskId, response }；
// 提交失败（已触网）先落一条 failed 留档 record（参数/厂商错误响应可追溯）再抛原中文文案
async function aliwanSubmit(cfg, { body, userId, logCtx = {}, genCtx = {} }) {
  const submitUrl = dashScopeUrl(cfg.base_url, "/api/v1/services/aigc/video-generation/video-synthesis");
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  const headers = {
    "Content-Type": "application/json",
    "X-DashScope-Async": "enable", // 必填：HTTP 通道仅支持异步
    Authorization: `Bearer ${cfg.api_key}`,
  };
  logger.info(`[VIDEO→提交/万相] POST ${submitUrl}`, { userId, ...logCtx, key: maskKey(cfg.api_key) });
  logger.info(`[VIDEO→提交/万相] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "万相", userId, url: submitUrl, model: cfg.model, headers, body, logCtx, genCtx });
  const t0 = Date.now();

  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    // 捕获百炼 4xx/5xx 错误体，便于定位（鉴权/参数校验/限流/素材组合不合法）
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/万相] 请求失败 status=${status}`, {
      userId,
      model: cfg.model,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
      ...logCtx,
    });
    const msg = data?.message || data?.error?.message || (data ? JSON.stringify(data).slice(0, 300) : err.message);
    const hint = status === 400 ? "（多为参数/素材组合校验：reference_* 与 first_frame/last_frame 不可混用、图≤10/视频≤5/音频≤5、时长[2,30]等）" : "";
    const message = `万相视频提交失败 status=${status}${hint}${msg ? " :: " + msg : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }
  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "万相", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  const taskId = resp.data?.output?.task_id;
  if (!taskId) {
    const message = "万相视频未返回任务 id: " + JSON.stringify(resp.data).slice(0, 200);
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }
  return { taskId, response: resp.data };
}

// 万相 单次任务查询（扫描器 videoGenScanner 调用）：GET {origin}/api/v1/tasks/{task_id}
// 任务状态流转 PENDING → RUNNING → SUCCEEDED / FAILED；UNKNOWN 为任务不存在或查询过期（task_id 有效期 24h）。
// 返回归一化 { state, vendorStatus, videoUrl?, lastFrameUrl?, message?, raw, httpStatus }
export async function queryAliwanTask(cfg, taskId) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const statusUrl = dashScopeUrl(cfg.base_url, `/api/v1/tasks/${taskId}`);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const taskStatus = st.data?.output?.task_status;
  if (taskStatus === "SUCCEEDED") {
    const url = st.data?.output?.video_url;
    if (!url) {
      return { state: "failed", vendorStatus: taskStatus, message: "万相任务成功但未返回 video_url: " + JSON.stringify(st.data).slice(0, 200), raw: st.data, httpStatus: st.status };
    }
    return { state: "succeeded", vendorStatus: taskStatus, videoUrl: url, lastFrameUrl: null, raw: st.data, httpStatus: st.status };
  }
  if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "UNKNOWN") {
    const d = st.data?.output || {};
    const reason = d.message || d.code || taskStatus;
    return { state: "failed", vendorStatus: taskStatus, message: `万相视频生成${taskStatus === "UNKNOWN" ? "任务已过期" : "失败"}: ${taskStatus} ${reason}`, raw: st.data, httpStatus: st.status };
  }
  // PENDING / RUNNING -> 继续查询
  return { state: "running", vendorStatus: taskStatus || "unknown", raw: st.data, httpStatus: st.status };
}

// 万相 提示词占位符转换：本实现统一以 @图片N/@音频N/@视频N 装配与英译（translate_prompt_en 按 @ 形态
// 校验占位符与台词保护），提交前去 @ 转为万相的 图片N/音频N/视频N（全模态参考按类独立计数，一一对应）
function toAliwanPromptTokens(text) {
  return String(text || "")
    .replace(/@图片(\d+)/g, "图片$1")
    .replace(/@音频(\d+)/g, "音频$1")
    .replace(/@视频(\d+)/g, "视频$1");
}

// 去除字幕（万相视频编辑）：input 仅 文本 + 原视频(reference_video)，提示词含编辑意图（契约支持
// reference_video 编辑模式，ratio/duration 与其余厂商同口径固定/等长，不走引用资产/首帧装配）
async function viaAliwanErase(cfg, { prompt, editVideo, duration, aspect, userId, resolution, genCtx }) {
  // 输出尽量等长：入参已是原视频实测时长；契约约束「输入视频 + 输出时长 ≤ 30」——原片较长时输出
  // 被动压短为 30-输入（下限 2；常规 4~15s 分镜视频 2×15=30 恰好不触约束）
  const dur = Math.max(2, Math.min(clampInt(duration, 2, 30), 30 - Math.ceil(Number(duration) || 0)));
  const finalPrompt = toAliwanPromptTokens(String(prompt || "")); // 英译已在 eraseVideoSubtitles 完成，此处仅转占位符
  const parameters = {
    resolution: mapDashScopeResolution(resolution),
    ratio: mapRatio(aspect),
    duration: dur,
    prompt_extend: false, // 编辑指令须原样到达，不做厂商改写（DB params 可覆盖）
    ...vendorParams(cfg.params),
  };
  parameters.resolution = mapDashScopeResolution(resolution || parameters.resolution);
  const body = {
    model: cfg.model,
    input: {
      prompt: finalPrompt,
      media: [{ type: "reference_video", url: editVideo }], // 原视频为唯一输入（@视频1）
    },
    parameters,
  };

  const { taskId, response } = await aliwanSubmit(cfg, {
    body, userId, genCtx,
    logCtx: {
      model: cfg.model,
      duration: parameters.duration,
      ratio: parameters.ratio,
      resolution: parameters.resolution,
      mediaTypes: ["reference_video"],
      promptChars: finalPrompt.length,
      promptHead: finalPrompt.slice(0, 150),
      promptTail: finalPrompt.length > 150 ? finalPrompt.slice(-150) : "",
    },
  });
  return submitAndTrack({ cfg, tag: "万相", taskId, response, params: body, genCtx });
}

/**
 * 去除字幕：原视频规整为 provider 可消费的提交输入（与 collectRefVideos 单条视频同策略，一律以 URL 提交）：
 * - 本地 /files 且可映射公网 URL（PUBLIC_BASE_URL + 时效签名）：直传原片 URL，provider 自行拉取；
 * - 非 mp4 / 超 50MB：prepareReferenceVideo 转码为小体积 mp4 落 uploads（erasub_ 前缀，保留不删），
 *   再以 /files 公网 URL 提交（provider 拉取的是转码产物）；探测时长透传，供输出等长；
 * - 未配置 PUBLIC_BASE_URL 拿不到公网 URL：直接报错提示配置（本实现已全面禁用 Base64）；
 * - 远程 http(s) URL：原样透传（本就是 web URL）。
 * @returns {{ encoded: string, seconds: number }}
 */
async function prepareEraseSourceVideo(url, { tag = "Seedance" } = {}) {
  const src = String(url || "");
  const localPath = audioLocalPath(src);
  if (localPath && fs.existsSync(localPath)) {
    const seconds = (await probeMedia(localPath).catch(() => null))?.duration || 0;
    const byUrl = publicFilesUrl(src);
    if (!byUrl) {
      throw new Error("本地视频须以公网 URL 提交（本实现已全面禁用 Base64）：请在服务端配置 PUBLIC_BASE_URL 后重试");
    }
    const ext = (localPath.split(".").pop() || "").toLowerCase();
    const size = fs.statSync(localPath).size;
    const needsFix = ext !== "mp4" || size > 50 * 1024 * 1024;
    if (needsFix) {
      // 探测不到时长时按 30s 兜底（仅约束转码上限，不裁掉正常 4~15s 的分镜视频）；
      // 转码产物落 uploads（erasub_ 前缀）：以 /files 公网 URL 提交，保留给 provider 异步拉取
      const dest = genFilePath(config.uploadDir, "mp4", "erasub");
      await prepareReferenceVideo(localPath, Math.max(2, Math.ceil(seconds || 30)), dest.absPath);
      const fixedUrl = publicFilesUrl(toUrl(dest.absPath));
      logger.info(`[VIDEO→${tag}/擦除字幕] 原视频已转码为 mp4 并以 URL 提交: ${fixedUrl}`);
      return { encoded: fixedUrl, seconds };
    }
    return { encoded: byUrl, seconds }; // 外网 URL 直传，不做 Base64 编码
  }
  if (/^https?:\/\//i.test(src)) return { encoded: src, seconds: 0 }; // 远程视频：本就是 web URL
  throw new Error("原视频文件不存在且非 http(s) URL，无法提交去除字幕");
}

// 去除字幕（Seedance r2v）：content 仅 文本 + 原视频(reference_video)，不走引用资产/首帧装配
async function viaSeedanceErase(cfg, { prompt, editVideo, duration, aspect, userId, resolution, watermark, genCtx }) {
  const headers = { "Content-Type": "application/json" };
  const auth = arkAuthHeader(cfg.api_key);
  if (auth) headers.Authorization = auth;

  const dur = clampInt(duration, 4, 15); // 输出尽量等长：入参已是原视频实测时长
  const content = [
    { type: "text", text: String(prompt || "").trim() },
    { type: "video_url", video_url: { url: editVideo }, role: "reference_video" },
  ];
  const body = {
    model: cfg.model,
    content,
    ratio: mapRatio(aspect),
    duration: dur,
    watermark,
    generate_audio: true,
    return_last_frame: true, // 任务结果随带尾帧图 last_frame_url，原样保存（与常规生成一致）
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项
  };
  body.resolution = resolution || body.resolution || pickResolution(cfg.model);
  if (/mini|fast/i.test(cfg.model || "") && !["480p", "720p"].includes(body.resolution)) {
    logger.warn(`[VIDEO→Seedance] 模型 ${cfg.model} 不支持 resolution=${body.resolution}，降级 720p`);
    body.resolution = "720p";
  }
  const { taskId, response } = await seedanceSubmit(cfg, {
    body, headers, userId, genCtx,
    logCtx: {
      model: cfg.model,
      duration: dur,
      ratio: body.ratio,
      resolution: body.resolution,
      contentTypes: content.map((c) => c.type),
      edit: "erase-subtitle",
      promptChars: prompt.length,
      promptHead: String(prompt || "").slice(0, 150),
      hasImage: false,
      refVideoCount: 1,
    },
  });
  return submitAndTrack({ cfg, tag: "Seedance", taskId, response, params: body, genCtx });
}

// 去除字幕（MiniMax r2v）：content 仅 文本(必填) + 原视频(reference_video)
async function viaMiniMaxErase(cfg, { prompt, editVideo, duration, aspect, userId, resolution, genCtx }) {
  const dur = clampInt(duration, 4, 15); // [4,15] 整数，输出尽量等长
  const content = [
    { type: "text", text: String(prompt || "").trim() }, // text 必填；空文本会被 MiniMax 以 2013 拒绝
    { type: "video_url", video_url: { url: editVideo }, role: "reference_video" },
  ];
  const body = {
    model: cfg.model,
    content,
    duration: dur,
    ratio: (cfg.params && cfg.params.ratio) || mapRatio(aspect),
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项
  };
  body.resolution = mapMiniMaxResolution(body.resolution || resolution);
  const { taskId, response } = await minimaxSubmit(cfg, {
    body, userId, genCtx,
    logCtx: {
      model: cfg.model,
      duration: dur,
      ratio: body.ratio,
      resolution: body.resolution,
      contentTypes: content.map((c) => c.type),
      edit: "erase-subtitle",
      promptChars: prompt.length,
      promptHead: String(prompt || "").slice(0, 150),
      refVideoCount: 1,
    },
  });
  return submitAndTrack({ cfg, tag: "MiniMax", taskId, response, params: body, genCtx });
}

// ---- AutoDL ComfyUI 工作流入参规则（input_rules）拉取与装配助手 ----

// 工作流规则缓存（workflow_id -> { rules, at }）：提交前 GET /comfyui/workflows/{id} 是公开接口，
// 规则极少变动，10min 内复用；拉取失败返回 null，调用方退回「仅 prompt/duration/resolution」旧行为
const comfyWorkflowRulesCache = new Map();
const COMFY_RULES_TTL_MS = 10 * 60 * 1000;

async function loadComfyWorkflowRules(cfg) {
  const hit = comfyWorkflowRulesCache.get(cfg.model);
  if (hit && Date.now() - hit.at < COMFY_RULES_TTL_MS) return hit.rules;
  try {
    const url = comfyUrl(cfg.base_url, `/comfyui/workflows/${encodeURIComponent(cfg.model)}`);
    const resp = await axios.get(url, { headers: { Authorization: comfyAuthHeader(cfg.api_key) }, timeout: 15000 });
    const rules = resp.data?.data?.input_rules || {};
    comfyWorkflowRulesCache.set(cfg.model, { rules, at: Date.now() });
    return rules;
  } catch (e) {
    logger.warn(`[VIDEO→ComfyUI] 工作流入参规则拉取失败 workflow=${cfg.model}: ${e?.message || e}`);
    return null;
  }
}

// 统计工作流声明的媒体槽位数（input_rules 键形如 ref_image_0..N / ref_audio_0..N / ref_video_0..N，
// 如 H3 多图多音频工作流：9 图 + 3 音频；未声明该类槽位返回 0）
function comfySlotCount(rules, kind) {
  if (!rules) return 0;
  let max = -1;
  for (const k of Object.keys(rules)) {
    const m = k.match(new RegExp(`^ref_${kind}_(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ComfyUI 媒体槽位仅收 web URL（槽位默认值为占位 blank 文件的 URL，服务端自行下载注入节点）：
// 本地 /files 映射 PUBLIC_BASE_URL 公网 URL；远程 http(s) 原样透传；无法映射返回 null（调用方跳过）
function comfyMediaUrl(url) {
  const byBase = publicFilesUrl(url);
  if (byBase) return byBase;
  if (/^https?:\/\//i.test(String(url || ""))) return url;
  return null;
}

// 工作流 resolution 枚举匹配（input_rules.resolution.options 的 label，如「480p竖(720*1280)」「768p横」）：
// 精确命中原样透传；未命中按「同方向 + 前导档位数值」匹配（label 可带像素后缀，须剥后缀比档位，
// 裸值「480p横」才能命中「480p横(1280*720)」）；所选档不在枚举时钳位到同方向就近不高于所选的档
// （只降不升——计费按所选档收，回退升档会成本倒挂），低于全部枚举取最低档；
// 无同方向枚举回退工作流默认/首项；无规则原样透传
function matchComfyResolution(candidate, rule) {
  if (!rule) return candidate;
  const labels = (rule.options || []).map((o) => o && o.label).filter(Boolean);
  if (!labels.length) return candidate;
  if (labels.includes(candidate)) return candidate;
  const orient = /竖/.test(candidate) ? "竖" : /横/.test(candidate) ? "横" : "";
  const same = orient ? labels.filter((l) => l.includes(orient)) : [];
  if (!same.length) return rule.default && labels.includes(rule.default) ? rule.default : labels[0];
  // 档位解析：前导数字+单位（'480p横(1280*720)'→480，'4K竖'→4000）；K 按 1000 折算，
  // 否则 parseInt('2K…')=2 会把 K 档误判为最低档
  const tierOf = (s) => {
    const m = String(s).trim().match(/^(\d+)\s*(p|k)?/i);
    if (!m) return NaN;
    return Number(m[1]) * (m[2] && m[2].toLowerCase() === "k" ? 1000 : 1);
  };
  const want = tierOf(candidate);
  if (Number.isFinite(want)) {
    const hit = same.find((l) => tierOf(l) === want);
    if (hit) return hit;
    const ranked = same.map((l) => ({ l, t: tierOf(l) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
    if (ranked.length) return (ranked.filter((x) => x.t <= want).pop() || ranked[0]).l;
  }
  return rule.default && labels.includes(rule.default) ? rule.default : same[0];
}

/**
 * AutoDL ComfyUI 工作流视频生成契约（文档：https://autodl.art/docs/comfyui_api/）
 * POST {base}/comfyui/comfyui_workflow/{workflow_id}  ->  轮询 GET {base}/comfyui/comfyui_workflow/result/{task_id}
 * （base = base_url 规整为以 /api/v1 结尾，见 comfyUrl；两种填法均可）
 *
 * 与其余 provider 的关键差异：
 *   - 「模型」填 ComfyUI 工作流 ID（autodl.art 工作流页右侧抽屉可见，如 minimax_h3_image_audio_to_video_v2_15s）；
 *   - 提交前拉取工作流 input_rules（见 loadComfyWorkflowRules），据此把多模态素材映射进工作流媒体槽位：
 *       ref_image_0..N：跨镜尾帧（图片1，起始帧）+ 引用资产图顺延（如 H3 多图多音频工作流共 9 张）；
 *       ref_video_0..N：视频资产文件本体（工作流声明该槽位时才附加，collectRefVideos URL-only 规整）；
 *     ⚠ 音频刻意不挂载（即便工作流声明 ref_audio_N 槽位）：角色声音样本不提交，正文保留资产原名、
 *     不生成 @音频N 占位符与声音样本说明（占位符须指向已提交素材）；需要时可在 cfg.params
 *     静态指定 ref_audio_N 键覆盖；
 *     ⚠ 媒体槽位仅收 web URL：本地 /files 须映射 PUBLIC_BASE_URL 公网 URL（未配置时跳过并 warn，
 *       与 Seedance reference_video 同策略），需转码的视频产物落 uploads（refvideo_ 前缀）保留供拉取；
 *     提示词与 MiniMax 相同：正文资产名批量替换为 @图片N/@视频N 占位符（N 为同类素材提交序号，
 *     音频不挂载故无 @音频N），并附中文起始帧说明，此类工作流提示词门槛较高，模型按占位符把素材与
 *     人/物/景对应；prompt 超工作流 max_length 时截断；
 *   - duration/resolution 按工作流 input_rules 规整（min/max clamp、枚举匹配）；
 *     resolution 词汇随工作流（文档示例「480p竖」）：默认按所选档位+画幅方向拼「480p竖/横」，
 *     已含方向词（竖/横/方）的值原样透传；不在枚举内时按同方向就近不高于所选的档钳位
 *     （label 带像素后缀也能按前导档位命中，只降不升，如 1080p→768p；4K 请求遇
 *     「480p/768p/1440p横」枚举则钳到 1440p横），回退时 info 留痕；
 *   - cfg.params 原样并入且同名键以 params 为准（媒体槽位也可被静态覆盖）——工作流专属入参
 *     在「大模型配置」params 里补齐/覆盖；params 中置 null 的键会从提交体剔除（工作流不收某默认键时
 *     用它显式去掉，避免多余键被 400）；
 *   - 两段式异步：提交即返 task_id（status=QUEUED）；轮询 QUEUED/RUNNING -> SUCCESS/FAILED；
 *     SUCCESS 后 data.results[] 为产物 URL，⚠ 有效期很短，调用方须立即下载（generateVideo 已随即落盘）；
 *   - results 可能混有图片等产物：优先取视频扩展名项（mp4/mov/webm/m4v/avi/mkv），无则取首项；
 *   - 规则拉取失败时退回旧行为：仅提交 prompt/duration/resolution，参考素材跳过并日志留痕。
 * 鉴权：Authorization: <令牌>（autodl.art「令牌管理」创建、分组选 ComfyUI；原文透传，误带 Bearer 前缀会剥掉）
 */
async function viaComfyUI(cfg, { prompt, duration, aspect, userId, resolution, refAssets, continuityFrame, genCtx }) {
  const headers = { "Content-Type": "application/json", Authorization: comfyAuthHeader(cfg.api_key) };

  // 工作流入参规则：决定媒体槽位（ref_image_N/ref_audio_N/ref_video_N）与 duration/resolution/prompt 约束
  const rules = await loadComfyWorkflowRules(cfg);
  const imgSlots = comfySlotCount(rules, "image");
  const videoSlots = comfySlotCount(rules, "video");
  if (rules) {
    logger.info(`[VIDEO→ComfyUI] 工作流 ${cfg.model} 媒体槽位：参考图 ${imgSlots} / 参考视频 ${videoSlots}`);
  } else {
    // 规则拉取失败：无法判断媒体槽位，维持旧的「仅 prompt/duration/resolution」提交并留痕
    if (continuityFrame) logger.info(`[VIDEO→ComfyUI] 工作流入参规则拉取失败，跨镜尾帧无标准透传通道，已跳过`);
    if ((refAssets || []).some((a) => a && a.kind === "video" && a.video_url)) logger.info(`[VIDEO→ComfyUI] 分镜引用了视频资产，但工作流入参规则拉取失败，参考视频已跳过`);
    if ((refAssets || []).some((a) => a && a.image_url)) logger.info(`[VIDEO→ComfyUI] 引用资产参考图因入参规则拉取失败已跳过（也可在 params 指定字段静态指定）`);
  }

  // ---- 多模态素材装配（仅当工作流声明对应槽位；媒体仅收 web URL，本地文件须映射公网 URL）----
  let startFrameN = 0;
  const imageUrls = []; // 依次填充 ref_image_0..（图片N = 下标+1，与 @图片N 占位符编号一致）
  const assetToN = new Map(); // 资产 -> 图片序号 N（1 起），用于正文占位符替换
  let refVideos = [];
  let videoAssets = new Set(); // 已附加文件本体的视频资产（封面图刻意跳过，不计入参考图候选）
  // 音频不挂载：autodl-comfyui 刻意不提交 ref_audio_N（即便工作流声明该槽位），需要时可在 params 静态指定
  if ((refAssets || []).some((a) => a && a.voice_url)) {
    logger.info(`[VIDEO→ComfyUI] 已绑定角色音色，ComfyUI 契约音频不挂载（正文保留资产原名，可用 params 静态指定 ref_audio_N）`);
  }
  if (rules) {
    // 跨镜首尾帧延续：上一镜尾帧作为首张参考图（图片1），资产图顺延编号（与 Seedance/MiniMax 语义一致）
    if (continuityFrame && imgSlots > 0) {
      const url = comfyMediaUrl(continuityFrame);
      if (url) {
        imageUrls.push(url);
        startFrameN = imageUrls.length;
      } else {
        logger.warn(`[VIDEO→ComfyUI] 跨镜尾帧无法映射公网 URL（未配置 PUBLIC_BASE_URL？），已跳过`);
      }
    }
    // 视频素材：工作流声明 ref_video_N 槽位时按 URL-only 契约规整附加（限档沿用 MiniMax 契约）；未声明的回退封面图
    if (videoSlots > 0 && (refAssets || []).some((a) => a && a.kind === "video" && a.video_url)) {
      refVideos = (await collectRefVideos(refAssets, REF_VIDEO_LIMITS.minimax, "ComfyUI")).slice(0, videoSlots);
    } else if ((refAssets || []).some((a) => a && a.kind === "video" && a.video_url)) {
      logger.info(`[VIDEO→ComfyUI] 工作流未声明参考视频槽位，视频素材回退封面图作参考图`);
    }
    videoAssets = new Set(refVideos.map((x) => x.asset));
    // 引用资产图（角色/场景/道具参考图）：已附加本体的视频资产跳过封面图，未附加的回退封面图
    for (const asset of refAssets || []) {
      if (imageUrls.length >= imgSlots) break;
      if (!asset || videoAssets.has(asset) || !asset.image_url) continue;
      const url = comfyMediaUrl(asset.image_url);
      if (!url) continue;
      imageUrls.push(url);
      if (!assetToN.has(asset)) assetToN.set(asset, imageUrls.length);
    }
  }
  // 有图/音频候选但未全部附加（槽位不足/无法映射 URL）：warn 留痕，避免静默丢素材难排查
  const imgCandidates = (continuityFrame ? 1 : 0)
    + (refAssets || []).filter((a) => a && a.image_url && !videoAssets.has(a)).length;
  if (imgSlots > 0 && imgCandidates > imageUrls.length) {
    logger.warn(`[VIDEO→ComfyUI] ${imgCandidates - imageUrls.length} 个参考图候选未附加（槽位 ${imgSlots} 不足或无法映射公网 URL）`);
  }

  // 提示词：正文资产名批量替换为多模态占位符（@图片N/@视频N，N 为同类素材提交序号），
  // 附中文起始帧说明（此类工作流提示词门槛较高，模型按占位符把素材与人/物/景对应；
  // 音频不挂载故无 @音频N 占位符与声音样本说明，角色名保留原文）
  const promptText = String(prompt || "").trim();
  const startNote = startFrameN ? startFrameNote(startFrameN) : "";
  const promptBody = replaceAssetNamesWithTokens(promptText, assetTokenRefs({ assetToN, refVideos }));
  // 提示词英译开关（模型配置 translate_prompt_en）：占位符替换之后、按工作流 max_length 截断之前翻译
  let finalPrompt = await translatePromptIfNeeded(
    cfg, userId,
    [promptBody, startNote].filter(Boolean).join("\n\n"),
    "ComfyUI",
  );
  const maxLen = Number(rules?.prompt?.max_length) || 0;
  if (maxLen > 0 && finalPrompt.length > maxLen) finalPrompt = finalPrompt.slice(0, maxLen);

  // duration / resolution 按工作流规则规整；规则缺失时维持旧默认
  const durRule = rules?.duration || null;
  const durationValue = durRule
    ? clampInt(duration || durRule.default || 5, durRule.min ?? 1, durRule.max ?? 15)
    : Math.round(Number(duration) || 5);
  let resolutionValue;
  if (resolution) {
    const mapped = mapComfyUIResolution(resolution, aspect);
    resolutionValue = matchComfyResolution(mapped, rules?.resolution || null);
    // 回退留痕：所选档不在工作流枚举被钳位/换向时可见（排查「配置 480p 实出 1440p」一类问题）
    if (resolutionValue !== mapped) logger.info(`[VIDEO→ComfyUI] 分辨率 ${mapped} 不在工作流枚举，回退 ${resolutionValue}`);
  } else if (rules?.resolution?.default) {
    resolutionValue = matchComfyResolution(rules.resolution.default, rules.resolution); // 未选档位：用工作流默认（如 768p竖）
  } else {
    resolutionValue = mapComfyUIResolution(resolution, aspect);
  }

  const body = {
    prompt: finalPrompt,
    duration: durationValue,
    resolution: resolutionValue,
    // 媒体槽位（跨镜尾帧+资产图 / 视频素材；音频不挂载，ref_audio_N 仅可经 params 静态指定）；仍可被下方 cfg.params 静态覆盖
    ...Object.fromEntries(imageUrls.map((u, i) => [`ref_image_${i}`, u])),
    ...Object.fromEntries(refVideos.map((x, i) => [`ref_video_${i}`, x.encoded])),
    ...vendorParams(cfg.params), // DB params 可覆盖以上任意项，并可补工作流专属入参
  };
  // params 置 null 的键剔除：工作流不收的默认键（如无 resolution 概念的）显式去掉
  for (const k of Object.keys(body)) if (body[k] === null) delete body[k];

  const submitUrl = comfyUrl(cfg.base_url, `/comfyui/comfyui_workflow/${encodeURIComponent(cfg.model)}`);
  genCtx.submitUrl = submitUrl; // 带回留档：submitRecordFields 落 submit_url（详情展示完整厂商端点）
  logger.info(`[VIDEO→提交/ComfyUI] POST ${submitUrl}`, {
    userId,
    workflow: cfg.model,
    duration: body.duration,
    resolution: body.resolution,
    rulesLoaded: !!rules,
    refImageCount: imageUrls.length,
    refVideoCount: refVideos.length,
    continuityStart: !!startFrameN,
    paramKeys: Object.keys(cfg.params || {}),
    promptChars: finalPrompt.length,
    promptHead: finalPrompt.slice(0, 150),
    promptTail: finalPrompt.length > 150 ? finalPrompt.slice(-150) : "",
    key: maskKey(cfg.api_key),
  });
  logger.info(`[VIDEO→提交/ComfyUI] 完整提交数据: ${submitBodyLog(body)}`);
  const reqFile = writeVideoSubmitLog({ tag: "ComfyUI", userId, url: submitUrl, model: cfg.model, headers, body, genCtx });
  const t0 = Date.now();

  let resp;
  try {
    resp = await axios.post(submitUrl, body, { headers, timeout: 600000 });
  } catch (err) {
    // 捕获 AutoDL 4xx/5xx 错误体，便于定位（令牌无效/工作流入参不符/额度等）
    const status = err.response?.status || err.code;
    const data = err.response?.data;
    logger.warn(`[VIDEO→提交/ComfyUI] 请求失败 status=${status}`, {
      userId,
      workflow: cfg.model,
      respData: data ? JSON.stringify(data).slice(0, 800) : null,
      message: err.message,
    });
    const msg = data?.msg || data?.message || (data ? JSON.stringify(data).slice(0, 300) : err.message);
    const message = `ComfyUI 工作流提交失败 status=${status}${msg ? " :: " + msg : ""}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: data ?? { message: err.message }, error: message }));
    throw new Error(message);
  }
  // 提交返回留档：记录厂商即时返回（任务 id 形态；终态 raw 已由扫描器落库，不在此重复）
  writeVideoResponseLog({ tag: "ComfyUI", userId, url: submitUrl, model: cfg.model, resp: resp.data, reqFile, durationMs: Date.now() - t0, genCtx });
  if (resp.data?.code !== "Success" || !resp.data?.data?.task_id) {
    const message = `ComfyUI 工作流未返回 task_id: ${JSON.stringify(resp.data).slice(0, 300)}`;
    await createFailedSubmitRecord(submitRecordFields(cfg, genCtx, { params: body, submitResponse: resp.data, error: message }));
    throw new Error(message);
  }
  const taskId = resp.data.data.task_id;

  // 异步：落 pending record，等待厂商终态（查询由扫描器负责，无超时）。
  // ComfyUI 排队+执行普遍慢于专属 API（文档示例实测 196s），产物 URL 有效期很短——
  // 终态落库后 waitForGeneration（3s 间隔）随即感知并立即下载，仍属「立即下载」范畴
  return submitAndTrack({ cfg, tag: "ComfyUI", taskId, response: resp.data, params: body, genCtx });
}

// ComfyUI 单次任务查询（扫描器 videoGenScanner 调用）：GET {base}/comfyui/comfyui_workflow/result/{task_id}
export async function queryComfyUITask(cfg, taskId) {
  const headers = { "Content-Type": "application/json", Authorization: comfyAuthHeader(cfg.api_key) };
  const statusUrl = comfyUrl(cfg.base_url, `/comfyui/comfyui_workflow/result/${taskId}`);
  const st = await queryVendorGet(statusUrl, { headers, timeout: 30000 });
  const data = st.data?.data || {};
  if (data.status === "SUCCESS") {
    const results = Array.isArray(data.results) ? data.results.filter(Boolean) : [];
    if (!results.length) {
      return { state: "failed", vendorStatus: data.status, message: "ComfyUI 任务成功但未返回 results: " + JSON.stringify(st.data).slice(0, 300), raw: st.data, httpStatus: st.status };
    }
    // results 元素两种契约：纯 URL 字符串（旧）/ 对象 { type, url, file_type, alias, ... }（新），统一抽成 URL 串
    const entries = results
      .map((u) => ({ raw: typeof u === "object" ? u : null, url: typeof u === "string" ? u : String(u?.url || "") }))
      .filter((e) => e.url);
    if (!entries.length) {
      return { state: "failed", vendorStatus: data.status, message: "ComfyUI 任务 results 未含可用 url: " + JSON.stringify(st.data).slice(0, 300), raw: st.data, httpStatus: st.status };
    }
    // 优先视频项（type=video 或视频扩展名；results 可能混有图片等产物），无则取首项
    const url = entries.find((e) => e.raw?.type === "video" || /\.(mp4|mov|webm|m4v|avi|mkv)(?:\?|$)/i.test(e.url))?.url || entries[0].url;
    return { state: "succeeded", vendorStatus: data.status, videoUrl: url, lastFrameUrl: null, raw: st.data, httpStatus: st.status };
  }
  if (data.status === "FAILED") {
    const reason = data.message || st.data?.msg || JSON.stringify(st.data).slice(0, 300);
    return { state: "failed", vendorStatus: data.status, message: `ComfyUI 工作流执行失败: ${reason}`, raw: st.data, httpStatus: st.status };
  }
  // QUEUED / RUNNING -> 继续查询
  return { state: "running", vendorStatus: data.status || "unknown", raw: st.data, httpStatus: st.status };
}

// AutoDL ComfyUI 域名规整：base_url 去尾斜杠，未以 /api/v1 结尾的自动补上，再拼 path
// （厂商默认 base_url 已含 /api/v1；老配置填 https://autodl.art 裸域名的仍兼容）
function comfyUrl(base, p) {
  let b = String(base || "https://autodl.art/api/v1").replace(/\/+$/, "");
  if (!/\/api\/v1$/i.test(b)) b += "/api/v1";
  return b + p;
}

// ComfyUI 鉴权头：文档示例原文透传（Authorization: <token>，无 Bearer 前缀）；误带 Bearer 前缀剥掉
function comfyAuthHeader(rawKey) {
  return String(rawKey || "").trim().replace(/^Bearer\s+/i, "");
}

// ComfyUI 工作流分辨率词汇（文档示例「480p竖」）：档位+画幅方向；已含方向词（竖/横/方）的值原样透传；缺省 480p
// 画幅缺省按竖版（与 mapRatio 缺省 9:16 的取向一致）；竖版取值之外的（16:9 等）均视为横版
function mapComfyUIResolution(r, aspect) {
  const v = String(r || "").trim();
  if (/竖|横|方/.test(v)) return v;
  const a = String(aspect || "").replace(/\s/g, "");
  const vertical = !a || ["9:16", "3:4", "2:3", "1:2", "9:21"].includes(a);
  return `${v || "480p"}${vertical ? "竖" : "横"}`;
}

// MiniMax 视频分辨率档位：仅 768P / 2K；显式 768P 予以尊重，其余（含缺省/4K/1080p…）取最高画质 2K
function mapMiniMaxResolution(r) {
  const v = String(r || "").toUpperCase();
  if (v === "768P") return "768P";
  return "2K";
}

// MiniMax 接口位于 /v2：把 base_url 规整为 <host>/v2 再拼 path（兼容用户填写带/不带版本号、误填 /v1）
function minimaxUrl(base, path) {
  let b = String(base || "https://api.minimaxi.com").replace(/\/$/, "");
  if (/\/v1$/i.test(b)) b = b.replace(/\/v1$/i, "/v2");
  else if (!/\/v\d+$/i.test(b)) b += "/v2";
  return b + path;
}

// MiniMax 内容审核拦截识别（1026 敏感内容等）：返回面向用户的中文提示；非审核错误返回 null
function minimaxModerationMessage(data) {
  const err = (data && data.error) || {};
  const txt = `${err.code || ""} ${err.message || ""} ${data?.base_resp?.status_msg || ""}`;
  if (/sensitive|1026/i.test(txt)) {
    return "内容审核未通过：分镜内容可能包含敏感信息，请修改文案/图片后重试";
  }
  return null;
}

// 首帧图规整：本地文件路径 / 本机 app URL -> 公网 URL（PUBLIC_BASE_URL + 时效签名）；远程 URL -> 透传；不可用返回 null
function resolveFirstFrame(imagePath) {
  if (!imagePath) return null;
  if (fs.existsSync(imagePath)) return publicFilesUrl(toUrl(imagePath)); // 本地文件路径
  return resolveMediaUrl(imagePath); // app URL(->公网 URL) / 远程 URL(透传) / 不可用 null
}

// 百炼视频分辨率档位：480P/720P/1080P（大写 P）；4K 不受支持，降级 1080P；缺省 720P
function mapDashScopeResolution(r) {
  const v = String(r || "").toLowerCase();
  if (v === "480p") return "480P";
  if (v === "720p") return "720P";
  if (v === "1080p" || v === "4k") return "1080P";
  return "720P";
}

// 取 base_url 的 origin(协议+主机) 后拼接 path，兼容 /compatible-mode/v1 等兼容模式后缀
function dashScopeUrl(base, p) {
  if (!base) return p;
  const m = String(base).match(/^(https?:\/\/[^/]+)/i);
  const origin = m ? m[1] : base.replace(/\/$/, "");
  return origin + p;
}

// 厂商视频原样落盘：字节不加工、不做 faststart remux（保留厂商原始封装）
async function downloadVideo(remoteUrl) {
  if (fs.existsSync(remoteUrl)) return remoteUrl;
  const { absPath } = genFilePath(config.outputDir, "mp4", "seg");
  const resp = await axios.get(remoteUrl, { responseType: "arraybuffer", timeout: 300000 });
  fs.writeFileSync(absPath, resp.data);
  return absPath;
}

// 下载远端图片并「原样」落盘 uploads（字节不加工，扩展名取自 URL，缺省 png）：
// 供 Seedance return_last_frame 返回的尾帧图保存——不得经 ffmpeg 重抽/重编码
async function downloadImageAsIs(remoteUrl) {
  if (fs.existsSync(remoteUrl)) return remoteUrl;
  const m = String(remoteUrl).split("?")[0].match(/\.([a-zA-Z0-9]+)$/);
  const ext = (m && m[1].toLowerCase()) || "png";
  const { absPath } = genFilePath(config.uploadDir, ext, "seg");
  const resp = await axios.get(remoteUrl, { responseType: "arraybuffer", timeout: 600000 });
  fs.writeFileSync(absPath, resp.data);
  return absPath;
}

function clampInt(v, min, max) {
  v = Number(v) || min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

// 视频生成轮询无超时预算：厂商状态查询全部移交 videoGenScanner 独立线程周期扫描，
// 一直查到 succeeded/failed 终态为止（旧 pollLoops 按分辨率 10~60min 的预算制已废除——
// 预算耗尽会在厂商仍正常生成时误判「轮询超时」失败退款）；扫描间隔按任务耗时降频（见 pollIntervalMs）

function mapRatio(aspect) {
  const a = String(aspect || "").replace(/\s/g, "");
  return ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].includes(a) ? a : "9:16";
}

// 火山方舟 API Key 鉴权头：去除首尾空白与误带的 Bearer 前缀，原样以 Bearer 透传
function arkAuthHeader(rawKey) {
  if (!rawKey) return null;
  const k = String(rawKey)
    .trim()
    .replace(/^Bearer\s+/i, "");
  return k ? `Bearer ${k}` : null;
}

// 火山方舟内容审核拦截识别：返回面向用户的中文提示；非审核错误返回 null
// 覆盖 InputTextSensitiveContentDetected / InputImageSensitiveContentDetected 等 *SensitiveContentDetected 码
function arkModerationMessage(data) {
  // 打印方舟完整返回结构，便于定位非审核类错误（参数校验/鉴权/限流等），不抛给前端
  try {
    if (data !== undefined && data !== null) {
      logger.warn("[VIDEO→Seedance/arkModeration] 服务端返回结构", {
        raw: JSON.stringify(data).slice(0, 1500),
        error: data?.error ?? null,
        code: data?.error?.code ?? data?.code ?? null,
        message: data?.error?.message ?? data?.message ?? null,
        keys: data && typeof data === "object" ? Object.keys(data) : null,
      });
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
  const code = String(data?.error?.code || data?.code || "");
  if (!/SensitiveContentDetected/i.test(code)) return null;
  if (/Text/i.test(code)) return "内容审核未通过：分镜文案可能包含敏感信息，请修改文案后重试";
  if (/Image/i.test(code)) return "内容审核未通过：分镜图片可能包含敏感内容，请修改后重试";
  return "内容审核未通过：分镜内容可能包含敏感信息，请修改后重试";
}

// 按 Seedance 2.0 模型选取默认 resolution：Mini/Fast 仅 480p/720p，标准版 1080p
function pickResolution(model) {
  //return /mini|fast/i.test(model || '') ? '720p' : '1080p';
  return "480p"; //TODO:
}

function joinUrl(base, p) {
  if (!base) return p;
  const b = base.replace(/\/$/, "");
  if (/\/v\d+$/i.test(b)) return b + p;
  return b + "/v1" + p;
}

// 各厂商任务查询契约（扫描器 videoGenScanner 按 record.vendor 分发；键与 videoVendorOf 归位结果一致）
export const VIDEO_QUERY_HANDLERS = {
  seedance: querySeedanceTask,
  dashscope: queryDashScopeTask,
  minimax: queryMiniMaxTask,
  comfyui: queryComfyUITask,
  agnes: queryAgnesTask,
  aliwan: queryAliwanTask,
  generic: queryGenericTask,
};
