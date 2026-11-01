import axios from 'axios';
import fs from 'fs';
import { resolveConfig, getConfig, normalizeMaxSize, vendorParams } from './modelConfig.service.js';
import { genFilePath, toUrl, urlToPath } from '../utils/fileUtil.js';
import { config } from '../config/index.js';
import { logger, maskKey } from '../utils/logger.js';
import { writeSubmissionLog, writeResponseLog } from '../utils/submitLog.js';

/**
 * 该图像配置是否支持参考图输入。
 * OpenAI 兼容线（generateImage）走 image 底图；DashScope 线（wan2.x）走 reference_images。
 * dall-e-3 等纯文生图模型不支持；custom 端点由调用方自行适配。
 */
export function supportsReferenceImages(cfg) {
  if (!cfg) return false;
  if (cfg.api_style === 'custom') return true;
  // 显式标记优先：模型名不匹配下方关键词、但确属支持参考图的兼容端点，
  // 可在模型配置 params.supportsReferenceImages=true 强制开启（避免被静默丢弃）
  if (cfg.params?.supportsReferenceImages === true) return true;
  return /seedream|doubao|nanobanana|gemini/i.test(String(cfg.model || ''));
}

// 生图 ratio 参数支持的画幅比例（提交 size=档位字符串 + ratio=画幅，像素由厂商按档位×比例换算）
export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', '21:9'];

/**
 * 画幅归一化：把任意 aspect 字符串收敛到 IMAGE_RATIOS 中的最近比例（对数距离，横竖对称），
 * 非法/缺省回退 fallback（默认 16:9）。项目画幅域为 9:16/16:9/1:1，均在列表内，此处兜底脏数据。
 */
export function normalizeRatio(aspect, fallback = '16:9') {
  const parts = String(aspect || '').split(':').map(Number);
  const v = parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : NaN;
  if (!Number.isFinite(v)) return fallback;
  let best = fallback, bestDiff = Infinity;
  for (const r of IMAGE_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const d = Math.abs(Math.log(w / h / v));
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return best;
}

/**
 * 文生图（OpenAI 兼容 /images/generations 或自定义端点）
 * 提交形态：size=模型 max_size 档位字符串（如 '2K'）+ ratio=画幅比例（如 '16:9'），
 * 不再本地换算像素宽高；小图产物（如 480p 封面）也按档位提交后由调用方 sharp 本地降采样。
 * @returns 本地图片 URL
 */
export async function generateImage(userId, prompt, opts = {}) {
  const cfg = opts.modelConfigId ? await getConfig(userId, opts.modelConfigId) : await resolveConfig(userId, 'image');
  // 不带水印（会员体系已下线，全员同权益；仅 DashScope 图像接口使用该参数）
  opts = { ...opts, watermark: false };
  // wan2.x-image 系列（wan2.7-image-pro 等）是阿里云 DashScope 多模态接口模型，
  // 不走 OpenAI 兼容 /images/generations，需走 DashScope /api/v1 多模态生成接口
  if (isDashScopeImageModel(cfg)) return generateViaDashScope(userId, prompt, cfg, opts);
  const url = joinUrl(cfg.base_url, '/images/generations');
  // 画幅按情景由调用方传入（opts.ratio，如项目 aspect_ratio；资产类固定 16:9、换装图 1:1），
  // 归一到支持的画幅比例后提交（r345 教训：勿擅自统一画幅，按情景传值）
  const ratio = normalizeRatio(opts.ratio || opts.aspect);
  const size = normalizeMaxSize(cfg.max_size); // 档位字符串，不生成高于该档的图

  // /images/generations 无独立 system 字段：把 system 指令前置拼入 prompt（仅在有值时）
  const systemPrompt = typeof opts.system === 'string' ? opts.system.trim() : '';
  const fullPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : String(prompt || '');

  const body = {
    model: opts.model || cfg.model,
    prompt: fullPrompt,
    n: 1,
    size,
    ratio,
    response_format: cfg.api_style === 'custom' ? undefined : 'url',
  };

  // 参考图：本地 /files 图片编码为 base64 data URL，远程 URL 透传。
  // 改用 image 参数（单张底图，图生图式输入），不再使用 reference_images 引用绑定。
  if (Array.isArray(opts.referenceImages) && opts.referenceImages[0]) {
    const encoded = encodeReferenceImage(opts.referenceImages[0]);
    if (encoded) body.image = encoded;
  }
  // DB params 全覆盖（与视频线同语义）：不再仅限 custom 风格，同名键以 params 为准
  // （model/size/ratio/response_format/image 均可覆盖；内部开关已由 vendorParams 剔除）
  Object.assign(body, vendorParams(cfg.params));

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  const promptStr = String(fullPrompt || '');
  logger.info(`[IMAGE→提交] POST ${url}`, {
    userId, model: body.model, size, ratio, promptChars: promptStr.length,
    promptHead: promptStr.slice(0, 50), promptTail: promptStr.length > 50 ? promptStr.slice(-50) : '',
    system: systemPrompt || undefined, referenceImages: body.image ? 1 : 0, key: maskKey(cfg.api_key),
  });
  // 与文本/视频提交同机制：完整提交数据落 server/logs 留档（admin 日志管理可查），headers 密钥由 writeSubmissionLog 脱敏
  const reqFile = writeSubmissionLog({
    userId, type: 'image', mode: 'req', provider: 'Generic',
    url, model: body.model, headers, body,
    extra: { size, ratio, refs: body.image ? 1 : 0, ...(opts.logCtx || {}) },
  });
  const t0 = Date.now();
  let resp;
  try {
    resp = await axios.post(url, body, { headers, timeout: 180000 });
  } catch (e) {
    const status = e.response?.status || e.code;
    const data = e.response?.data;
    logger.warn(`[IMAGE→提交] 请求失败 status=${status}`, { userId, model: body.model, respData: data ? JSON.stringify(data).slice(0, 800) : null, message: e.message });
    const msg = (data && (data.message || data.error?.message)) || e.message;
    throw new Error(`图像生成失败(${status}): ${msg}`);
  }
  // 返回结果留档：与提交留档（reqFile）配对，b64_json 等大产物由 writeResponseLog 折叠
  writeResponseLog({
    userId, type: 'image', provider: 'Generic',
    url, model: body.model, reqFile, durationMs: Date.now() - t0, resp: resp.data,
  });

  // 兼容多种返回结构
  let imageUrl = resp.data?.data?.[0]?.url
    || resp.data?.data?.[0]?.b64_json
    || resp.data?.image_url
    || resp.data?.url
    || resp.data?.output?.[0]
    || resp.data?.result;

  if (!imageUrl) throw new Error('图像生成接口未返回图片地址');

  // b64 直接落盘
  if (/^data:/.test(imageUrl) || /^[A-Za-z0-9+/=]{100,}$/.test(imageUrl)) {
    const raw = imageUrl.startsWith('data:') ? imageUrl.split(',')[1] : imageUrl;
    return saveBase64(raw);
  }

  // 下载到本地
  return downloadImage(imageUrl);
}

/**
 * 图生图（Seedream doubao「图像改写」）：以单张底图 image 为输入按 prompt 改写，
 * 走火山 ARK OpenAI 兼容 /images/generations，body 用顶层 image 字段（区别于 reference_images 参考绑定）。
 * 适配 doubao-seedream-4-5（seedream 4.5）图生图格式：
 *   { model, prompt, image, response_format:'url', size:'2K', ratio:'1:1', stream:false, watermark:true }
 * 用于「换装」等"以原图为底、仅局部改写"的场景——image=底图(原图)，prompt=改写要求，system 经 opts.system 前置拼入。
 * 换装图 ratio 固定 1:1（输出跟底图方画幅；可经 opts.ratio 覆盖，非法值归一）。
 * @returns 本地图片 URL
 */
export async function generateImageToImage(userId, prompt, opts = {}) {
  const cfg = opts.modelConfigId ? await getConfig(userId, opts.modelConfigId) : await resolveConfig(userId, 'image');
  // 图生图必须有底图：本机 /files 图编码为 base64 data URL，远程 URL 透传；缺失即直接报错（不可降级为文生图）
  const rawImage = Array.isArray(opts.image) ? opts.image[0] : opts.image;
  const encodedImage = rawImage ? encodeReferenceImage(rawImage) : null;
  if (!encodedImage) throw new Error('换装图生图缺少可用的底图');

  const url = joinUrl(cfg.base_url, '/images/generations');
  // /images/generations 无独立 system 字段：把 system 指令前置拼入 prompt（仅在有值时）
  const systemPrompt = typeof opts.system === 'string' ? opts.system.trim() : '';
  const fullPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : String(prompt || '');

  const body = {
    model: opts.model || cfg.model,
    prompt: fullPrompt,
    image: encodedImage,
    //sequential_image_generation: 'disabled',
    response_format: cfg.api_style === 'custom' ? undefined : 'url',
    // 图生图一律按模型 max_size 档位字符串提交 + ratio 画幅（换装图默认 1:1），
    // 不存在更低档位（opts.size 已废弃，防止调用方传小档生成低于最大支持尺寸的图）
    size: normalizeMaxSize(cfg.max_size),
    ratio: normalizeRatio(opts.ratio || '1:1', '1:1'),
    stream: false,
    watermark: typeof opts.watermark === 'boolean' ? opts.watermark : true,
    n: 1,
  };
  // DB params 全覆盖（与视频线同语义）：不再仅限 custom 风格，同名键以 params 为准
  Object.assign(body, vendorParams(cfg.params));

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  logger.info(`[IMAGE-EDIT→提交] POST ${url}`, {
    userId, model: body.model, size: body.size, ratio: body.ratio, promptChars: fullPrompt.length,
    promptHead: fullPrompt.slice(0, 50), promptTail: fullPrompt.length > 50 ? fullPrompt.slice(-50) : '',
    system: systemPrompt || undefined, image: 'set', key: maskKey(cfg.api_key),
  });

  // 与文本/视频提交同机制：完整提交数据落 server/logs 留档（type=image_edit 单独归档，便于筛出换装/图生图）
  const reqFile = writeSubmissionLog({
    userId, type: 'image_edit', mode: 'req', provider: 'Generic',
    url, model: body.model, headers, body,
    extra: { size: body.size, ratio: body.ratio, refs: 1, ...(opts.logCtx || {}) },
  });

  const t0 = Date.now();
  let resp;
  try {
    resp = await axios.post(url, body, { headers, timeout: 180000 });
  } catch (e) {
    const status = e.response?.status || e.code;
    const data = e.response?.data;
    logger.warn(`[IMAGE-EDIT→提交] 请求失败 status=${status}`, { userId, model: body.model, respData: data ? JSON.stringify(data).slice(0, 800) : null, message: e.message });
    const msg = (data && (data.message || data.error?.message)) || e.message;
    throw new Error(`换装图生图失败(${status}): ${msg}`);
  }
  // 返回结果留档：与提交留档（reqFile）配对
  writeResponseLog({
    userId, type: 'image_edit', provider: 'Generic',
    url, model: body.model, reqFile, durationMs: Date.now() - t0, resp: resp.data,
  });

  // 兼容多种返回结构
  let imageUrl = resp.data?.data?.[0]?.url
    || resp.data?.data?.[0]?.b64_json
    || resp.data?.image_url
    || resp.data?.url
    || resp.data?.output?.[0]
    || resp.data?.result;

  if (!imageUrl) throw new Error('换装图生图接口未返回图片地址');

  // b64 直接落盘
  if (/^data:/.test(imageUrl) || /^[A-Za-z0-9+/=]{100,}$/.test(imageUrl)) {
    const raw = imageUrl.startsWith('data:') ? imageUrl.split(',')[1] : imageUrl;
    return saveBase64(raw);
  }

  // 下载到本地
  return downloadImage(imageUrl);
}

/**
 * 阿里云 DashScope 多模态图像模型（wan2.x-image 系列）判断。
 * 这类模型不走 OpenAI 兼容 /images/generations，需走 DashScope /api/v1 多模态生成接口。
 */
function isDashScopeImageModel(cfg) {
  return /wan\d+(\.\d+)?-?image/i.test(String(cfg?.model || ''));
}

/**
 * 从 base_url 提取 origin（scheme://host），用于拼接 DashScope 原生端点。
 * base_url 可能填成 https://{ws}.maas.aliyuncs.com/compatible-mode/v1，去掉路径部分。
 */
function dashscopeOrigin(baseUrl) {
  if (!baseUrl) return '';
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/^(https?:\/\/[^/]+).*/i, '$1');
  }
}

/**
 * 文生图/图生图（DashScope 多模态接口）——适配 wan2.7-image-pro 等。
 * 同步调用 {origin}/api/v1/services/aigc/multimodal-generation/generation。
 * 提交形态与通用线一致：parameters.size=max_size 档位字符串 + parameters.ratio=画幅
 * （wan 系列模型请把 max_size 配成厂商实际上限，如 wan2.7 仅支持到 2K 则配 2K）。
 * @returns 本地图片 URL
 */
async function generateViaDashScope(userId, prompt, cfg, opts) {
  const url = dashscopeOrigin(cfg.base_url) + '/api/v1/services/aigc/multimodal-generation/generation';
  const hasRef = Array.isArray(opts.referenceImages) && opts.referenceImages.length > 0;
  // 与通用线同口径：size=档位字符串 + ratio=画幅比例（按情景传入，缺省 16:9）
  const size = normalizeMaxSize(cfg.max_size);
  const ratio = normalizeRatio(opts.ratio || opts.aspect);

  // content: 先 text，再参考图 image 项（最多 9 张）
  const text = String(prompt || '');
  const content = [{ text }];
  if (hasRef) {
    for (const u of opts.referenceImages.slice(0, 9)) {
      const enc = encodeReferenceImage(u);
      if (enc) content.push({ image: enc });
    }
  }

  // messages：有 system 指令时前置 system 消息（DashScope 多模态支持 system 角色）
  const systemPrompt = typeof opts.system === 'string' ? opts.system.trim() : '';
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: [{ text: systemPrompt }] });
  messages.push({ role: 'user', content });

  const body = {
    model: opts.model || cfg.model,
    input: { messages },
    parameters: { size, ratio, n: 1, watermark: opts.watermark, thinking_mode: !hasRef },
  };
  // DB params 全覆盖（与视频线同语义）：同名键以 params 为准；内部开关已剔除，不原样下发
  Object.assign(body.parameters, vendorParams(cfg.params));

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  logger.info(`[IMAGE→提交] POST ${url}`, {
    userId, model: body.model, size, ratio, promptChars: text.length,
    promptHead: text.slice(0, 50), promptTail: text.length > 50 ? text.slice(-50) : '',
    system: systemPrompt || undefined, referenceImages: hasRef ? opts.referenceImages.length : 0, key: maskKey(cfg.api_key),
  });

  // 与文本/视频提交同机制：完整提交数据落 server/logs 留档（admin 日志管理可查）
  const reqFile = writeSubmissionLog({
    userId, type: 'image', mode: 'req', provider: 'DashScope',
    url, model: body.model, headers, body,
    extra: { size, ratio, refs: content.length - 1, ...(opts.logCtx || {}) },
  });

  const t0 = Date.now();
  let resp;
  try {
    resp = await axios.post(url, body, { headers, timeout: 300000 });
  } catch (e) {
    const status = e.response?.status || e.code;
    const data = e.response?.data;
    logger.warn(`[IMAGE→提交] 请求失败 status=${status}`, {
      userId, model: body.model,
      respData: data ? JSON.stringify(data).slice(0, 800) : null, message: e.message,
    });
    const msg = (data && (data.message || data.code)) || e.message;
    throw new Error(`wan2.7 图像生成失败(${status}): ${msg}`);
  }
  // 返回结果留档：与提交留档（reqFile）配对
  writeResponseLog({
    userId, type: 'image', provider: 'DashScope',
    url, model: body.model, reqFile, durationMs: Date.now() - t0, resp: resp.data,
  });

  // 解析 output.choices[].message.content[] 中 type==='image' 的 image URL
  const choices = resp.data?.output?.choices || [];
  let imageUrl;
  for (const c of choices) {
    const items = c?.message?.content || [];
    for (const it of items) {
      if (it && (it.type === 'image' || it.image)) { imageUrl = it.image; break; }
    }
    if (imageUrl) break;
  }
  if (!imageUrl) imageUrl = resp.data?.output?.image_url || resp.data?.data?.[0]?.url;

  if (!imageUrl) {
    logger.warn(`[IMAGE→提交] 未解析到图片地址`, { userId, respBody: JSON.stringify(resp.data).slice(0, 800) });
    throw new Error('wan2.7 图像生成接口未返回图片地址');
  }

  if (/^data:/.test(imageUrl) || /^[A-Za-z0-9+/=]{100,}$/.test(imageUrl)) {
    const raw = imageUrl.startsWith('data:') ? imageUrl.split(',')[1] : imageUrl;
    return saveBase64(raw);
  }
  return downloadImage(imageUrl);
}

async function downloadImage(remoteUrl) {
  const { absPath } = genFilePath(config.uploadDir, 'png', 'asset');
  const resp = await axios.get(remoteUrl, { responseType: 'arraybuffer', timeout: 120000 });
  fs.writeFileSync(absPath, resp.data);
  return toUrl(absPath);
}

function saveBase64(b64) {
  const { absPath } = genFilePath(config.uploadDir, 'png', 'asset');
  fs.writeFileSync(absPath, Buffer.from(b64, 'base64'));
  return toUrl(absPath);
}

/**
 * 参考图编码：本机 URL（相对 /files 或指向 localhost / 本机 baseUrl）读为 base64 data URL；
 * 真正的远程 http(s) 图（CDN 等）直接透传。读取失败返回 null（由调用方决定是否整体放弃参考图）。
 */
export function encodeReferenceImage(url) {
  if (!url) return null;
  const isLocal = url.startsWith('/files/')
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/files\//i.test(url)
    || (config.publicBaseUrl && url.startsWith(config.publicBaseUrl));
  if (!isLocal && /^https?:\/\//i.test(url)) return url;
  try {
    const abs = urlToPath(url);
    const buf = fs.readFileSync(abs);
    const ext = (abs.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    logger.warn(`[IMAGE] 参考图读取失败，已跳过：${url}`);
    return null;
  }
}

const AUDIO_MIME = {
  // mp3/mpeg 统一 audio/mp3：视频生成方（MiniMax/Seedance）按 MIME 子类型推断扩展名，
  // audio/mpeg 会被判为 ".mpeg" 拒收；wav 推断为 ".wav" 无需处理
  mp3: 'audio/mp3', mpeg: 'audio/mp3', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  flac: 'audio/flac', webm: 'audio/webm',
};

/**
 * 声音样本编码：与 encodeReferenceImage 同策略——本机 URL 读为 base64 data URL，
 * 真正的远程 http(s) 音频直接透传。读取失败返回 null。
 */
export function encodeAudio(url) {
  if (!url) return null;
  const isLocal = url.startsWith('/files/')
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/files\//i.test(url)
    || (config.publicBaseUrl && url.startsWith(config.publicBaseUrl));
  if (!isLocal && /^https?:\/\//i.test(url)) return url;
  try {
    const abs = urlToPath(url);
    const buf = fs.readFileSync(abs);
    const ext = (abs.split('.').pop() || 'mp3').toLowerCase();
    const mime = AUDIO_MIME[ext] || 'audio/mp3';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    logger.warn(`[AUDIO] 声音样本读取失败，已跳过：${url}`);
    return null;
  }
}

function joinUrl(base, path) {
  if (!base) return path;
  const b = base.replace(/\/$/, '');
  if (/\/v\d+$/i.test(b)) return b + path;
  return b + '/v1' + path;
}
