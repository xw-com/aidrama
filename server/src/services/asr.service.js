import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveConfig, getConfig } from './modelConfig.service.js';
import { joinUrl } from './llm.service.js';
import { config } from '../config/index.js';
import { toUrl } from '../utils/fileUtil.js';
import { signMediaUrl, MEDIA_SIGN_PROVIDER_TTL_MS } from '../utils/mediaSign.js';
import { badRequest } from '../utils/response.js';
import { logger, maskKey } from '../utils/logger.js';

/**
 * 语音识别（ASR）：两条协议路径。
 * - OpenAI 兼容 POST {base_url}/audio/transcriptions（硅基流动/Groq/OpenAI 等）
 * - 火山豆包录音文件识别（provider=volcengine）：model 即 Resource ID——
 *   含 turbo（volc.bigasr.auc_turbo）走极速版 recognize/flash 一次请求 base64 直传；
 *   其余（volc.bigasr.auc / volc.seedasr.auc）走标准版 submit + query 轮询，音频须公网 URL。
 * 配置走 ModelConfig type='asr'（admin 配置全员共享，用户出积分）。
 * 返回归一化段落（带时间戳，秒），供字幕生成使用。
 */

/**
 * 转写本地音频文件。
 * @param {number} userId
 * @param {string} audioPath 本地音频文件路径（mp3）
 * @param {object} [opts] { modelConfigId } —— 确认弹窗选定的模型配置（透传）
 * @returns {Promise<{segments:Array<{start:number,end:number,text:string}>, text:string, duration:number, model:string}>}
 */
export async function transcribe(userId, audioPath, opts = {}) {
  const cfg = opts.modelConfigId ? await getConfig(userId, opts.modelConfigId) : await resolveConfig(userId, 'asr');
  if (!cfg.model) throw badRequest('video.asr_model_missing');
  if (isVolcengine(cfg)) return transcribeVolc(userId, cfg, audioPath);
  return transcribeOpenai(userId, cfg, audioPath);
}

const isVolcengine = (cfg) => cfg.provider === 'volcengine' || /openspeech\.bytedance\.com/.test(cfg.base_url || '');

/** 火山豆包协议 headers：X-Api-Resource-Id=model（Resource ID）；key 含 ':' 视为旧版控制台 appid:token 双键 */
function volcHeaders(cfg, requestId, withSequence = true) {
  const h = { 'Content-Type': 'application/json', 'X-Api-Resource-Id': cfg.model, 'X-Api-Request-Id': requestId };
  if (withSequence) h['X-Api-Sequence'] = '-1';
  const key = String(cfg.api_key || '').trim();
  if (key.includes(':')) {
    const idx = key.indexOf(':');
    h['X-Api-App-Key'] = key.slice(0, idx);
    h['X-Api-Access-Key'] = key.slice(idx + 1);
  } else if (key) {
    h['X-Api-Key'] = key;
  }
  return h;
}

/** 火山响应校验：状态码在响应头 X-Api-Status-Code，非 20000000 抛错 */
function assertVolcOk(resp, action) {
  const code = String(resp.headers?.['x-api-status-code'] || '');
  if (code && code !== '20000000') {
    const msg = resp.headers?.['x-api-message'] || '';
    throw new Error(`[ASR→火山] ${action} 失败：${code}${msg ? ` ${msg}` : ''}（logid=${resp.headers?.['x-tt-logid'] || '-'}）`);
  }
}

/** 火山响应体 → 归一化段落（毫秒转秒）+ 时长（秒） */
function parseVolcResult(data) {
  const raw = Array.isArray(data?.result?.utterances) ? data.result.utterances : [];
  const segments = raw
    .map((u) => ({
      start: (Number(u.start_time) || 0) / 1000,
      end: (Number(u.end_time) || 0) / 1000,
      text: String(u.text || ''),
    }))
    .filter((s) => s.text.trim() && Number.isFinite(s.start) && Number.isFinite(s.end));
  if (!segments.length) throw badRequest('video.asr_no_segments');
  return {
    segments,
    text: String(data?.result?.text || ''),
    duration: (Number(data?.audio_info?.duration) || 0) / 1000,
  };
}

async function transcribeVolc(userId, cfg, audioPath) {
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  const requestId = randomUUID();
  const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true };
  const user = { uid: `aidrama_${userId}` };
  const ext = (path.extname(audioPath) || '.mp3').slice(1).toLowerCase() || 'mp3';

  if (/turbo/.test(cfg.model)) {
    // 极速版：一次请求，audio.data base64 直传（无需公网地址）
    const url = `${base}/auc/bigmodel/recognize/flash`;
    logger.info(`[ASR→火山] POST ${url}`, { userId, resource: cfg.model, file: path.basename(audioPath), key: maskKey(cfg.api_key) });
    const resp = await axios.post(url, {
      user,
      audio: { data: fs.readFileSync(audioPath).toString('base64'), format: ext },
      request,
    }, { headers: volcHeaders(cfg, requestId), timeout: 600000, maxBodyLength: Infinity, maxContentLength: Infinity });
    assertVolcOk(resp, '识别');
    return { ...parseVolcResult(resp.data), model: cfg.model };
  }

  // 标准版：submit（音频公网 URL）+ query 轮询（同一 X-Api-Request-Id 关联任务）
  if (!config.publicBaseUrl) throw badRequest('video.asr_public_url_missing');
  // 公网音频 URL 做媒体时效签名（nginx secure_link 校验；厂商标准版为异步拉取，TTL 放长）
  const audioUrl = signMediaUrl(`${config.publicBaseUrl}${toUrl(audioPath)}`, MEDIA_SIGN_PROVIDER_TTL_MS);
  const submitUrl = `${base}/auc/bigmodel/submit`;
  logger.info(`[ASR→火山] POST ${submitUrl}`, { userId, resource: cfg.model, audio: audioUrl, key: maskKey(cfg.api_key) });
  const submitted = await axios.post(submitUrl, { user, audio: { url: audioUrl, format: ext }, request },
    { headers: volcHeaders(cfg, requestId), timeout: 60000 });
  assertVolcOk(submitted, '提交');

  const queryUrl = `${base}/auc/bigmodel/query`;
  const queryHeaders = volcHeaders(cfg, requestId, false);
  const deadline = Date.now() + 10 * 60 * 1000; // 轮询总上限 10 分钟
  await sleep(5000);
  for (;;) {
    const resp = await axios.post(queryUrl, {}, { headers: queryHeaders, timeout: 60000 });
    const code = String(resp.headers?.['x-api-status-code'] || '');
    if (code === '20000000') return { ...parseVolcResult(resp.data), model: cfg.model };
    if (code !== '20000001' && code !== '20000002') assertVolcOk(resp, '查询'); // 20000001 处理中 / 20000002 排队中，其余抛错
    if (Date.now() > deadline) throw new Error('[ASR→火山] 查询超时（10 分钟）');
    await sleep(3000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function transcribeOpenai(userId, cfg, audioPath) {
  const url = joinUrl(cfg.base_url, '/audio/transcriptions');

  // Node18+ 全局 FormData/Blob；文件名带 .mp3 扩展名（部分接口按扩展名嗅探格式）
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)], { type: 'audio/mpeg' }), path.basename(audioPath) || 'audio.mp3');
  form.append('model', cfg.model);
  form.append('response_format', 'verbose_json'); // 返回 segments[].start/end/text 时间戳
  const language = cfg.params?.language || process.env.ASR_LANGUAGE;
  if (language) form.append('language', String(language).slice(0, 8));

  const headers = {};
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  // 注意：不手动设 Content-Type，交给 axios/undici 带 multipart boundary

  logger.info(`[ASR→提交] POST ${url}`, { userId, model: cfg.model, file: path.basename(audioPath), key: maskKey(cfg.api_key) });

  const resp = await axios.post(url, form, {
    headers,
    timeout: 600000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const data = resp.data || {};
  const raw = Array.isArray(data.segments) ? data.segments : [];
  const segments = raw
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || '') }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
  if (!segments.length) throw badRequest('video.asr_no_segments');

  return {
    segments,
    text: String(data.text || ''),
    duration: Number(data.duration) || 0,
    model: cfg.model,
  };
}
