import axios from 'axios';
import { resolveConfig, getConfig, vendorParams } from './modelConfig.service.js';
import { logger, maskKey } from '../utils/logger.js';
import { writeSubmissionLog, writeResponseLog } from '../utils/submitLog.js';

/**
 * OpenAI 兼容的 Chat Completions 调用
 * @param {number} userId
 * @param {Array<{role,content}>} messages
 * @param {object} opts { type(默认text), model, temperature, maxTokens, json(强制JSON), raw(返回原始content) }
 */
export async function chat(userId, messages, opts = {}) {
  const cfg = opts.modelConfigId ? await getConfig(userId, opts.modelConfigId) : await resolveConfig(userId, opts.type || 'text');
  const url = joinUrl(cfg.base_url, '/chat/completions');

  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...vendorParams(cfg.params), // DB params 全覆盖（与视频线同语义）：同名键以 params 为准（temperature/top_p/max_tokens/…）
  };
  if (opts.json) {
    body.response_format = { type: 'json_object' }; // JSON 模式为代码路径硬依赖，params 不得关闭
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  const promptChars = messages.reduce((n, m) => n + (String(m.content || '').length), 0);
  // 打印向大模型提交的完整数据（不截断），便于排查提示词注入问题
  // headers 必须脱敏：logger 直落 stdout，明文 Bearer key 会随进程日志持久化（writeSubmissionLog 内部另有脱敏）
  logger.info(`[LLM→提交] POST ${url}`, {
    userId,
    apiStyle: cfg.api_style || null,
    msgs: messages.length,
    promptChars,
    key: maskKey(cfg.api_key),
    headers: maskHeaders(headers, cfg.api_key),
    body,
  });
  const reqFile = writeSubmissionLog({
    userId,
    type: opts.type || 'text',
    mode: 'req',
    url,
    model: body.model,
    apiStyle: cfg.api_style || null,
    msgs: messages.length,
    promptChars,
    headers,
    body,
  });
  const t0 = Date.now();
  const resp = await axios.post(url, body, { headers, timeout: opts.timeout || 1220000 });
  // 返回结果留档：与提交留档（reqFile）同目录配对，完整记录模型返回
  writeResponseLog({
    userId,
    type: opts.type || 'text',
    url,
    model: body.model,
    apiStyle: cfg.api_style || null,
    reqFile,
    durationMs: Date.now() - t0,
    resp: resp.data,
  });

  if (cfg.api_style === 'custom' && resp.data?.text) {
    return { content: resp.data.text, usage: resp.data.usage || {} };
  }

  const content = resp.data?.choices?.[0]?.message?.content ?? '';
  const usage = resp.data?.usage || {};
  return { content, usage };
}

/**
 * 流式 Chat Completions（async generator，逐段 yield 文本增量）
 * 与 chat() 同构：同样的 resolveConfig / joinUrl / header，仅增加 stream:true 与 responseType:'stream'。
 * resolveConfig 或上游建连失败会在首个 next() 时抛出，便于路由在写出 SSE 头之前返回标准 JSON 错误。
 * @param {number} userId
 * @param {Array<{role,content}>} messages
 * @param {object} opts { type(默认text), model, temperature, maxTokens, timeout }
 */
export async function* chatStream(userId, messages, opts = {}) {
  const cfg = opts.modelConfigId ? await getConfig(userId, opts.modelConfigId) : await resolveConfig(userId, opts.type || 'text');
  const url = joinUrl(cfg.base_url, '/chat/completions');

  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...vendorParams(cfg.params), // DB params 全覆盖（与视频线同语义）：同名键以 params 为准
    stream: true, // 流式为代码路径硬依赖，params 不得关闭
  };

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  const promptChars = messages.reduce((n, m) => n + (String(m.content || '').length), 0);
  // 打印向大模型提交的完整数据（不截断），便于排查提示词注入问题
  logger.info(`[LLM→流式提交] POST ${url}`, {
    userId,
    apiStyle: cfg.api_style || null,
    msgs: messages.length,
    promptChars,
    key: maskKey(cfg.api_key),
    headers: maskHeaders(headers, cfg.api_key),
    body,
  });
  const reqFile = writeSubmissionLog({
    userId,
    type: opts.type || 'text',
    mode: 'stream',
    url,
    model: body.model,
    apiStyle: cfg.api_style || null,
    msgs: messages.length,
    promptChars,
    headers,
    body,
  });

  const t0 = Date.now();
  const resp = await axios.post(url, body, { headers, responseType: 'stream', timeout: opts.timeout || 120000 });
  // custom 风格一般不支持 OpenAI 流式协议，这里按 OpenAI 兼容解析
  // 流式返回留档：增量累计，流正常结束/中途出错/消费方提前断开（finally 兜底）时写完整拼合文本
  let acc = '';
  let streamErr = null;
  try {
    for await (const obj of parseSSE(resp.data)) {
      if (obj === '[DONE]') return;
      // 上游以 200 + SSE 返回错误事件时不抛出会导致「静默空回复」，这里显式抛出让路由错误路径生效
      if (obj && typeof obj === 'object' && obj.error) {
        throw new Error(obj.error.message || obj.error.code || '上游模型返回错误');
      }
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) { acc += delta; yield delta; }
    }
  } catch (e) {
    streamErr = e;
    throw e;
  } finally {
    writeResponseLog({
      userId,
      type: opts.type || 'text',
      url,
      model: body.model,
      apiStyle: cfg.api_style || null,
      reqFile,
      durationMs: Date.now() - t0,
      resp: { content: acc, ...(streamErr ? { error: streamErr?.message || String(streamErr) } : {}) },
    });
  }
}

/** 日志用 headers 脱敏：Authorization 换成掩码 key（与 key 字段同口径），避免明文凭据落 stdout */
function maskHeaders(headers, apiKey) {
  return {
    ...headers,
    ...(headers.Authorization ? { Authorization: `Bearer ${maskKey(apiKey)}` } : {}),
  };
}

/**
 * 解析上游 OpenAI 兼容的 SSE 字节流，逐个 yield 出 data: 后的 JSON 对象（或字符串 '[DONE]'）。
 * 跨 chunk 缓冲半行，保证多段拼接的 data 行不丢。
 * @param {import('stream').Readable} stream
 */
async function* parseSSE(stream) {
  let buf = '';
  const dec = new TextDecoder('utf-8');
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    // SSE 事件以空行分隔；这里按行扫描 data: 即可
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      line = line.replace(/\r$/, '');
      if (!line) continue;
      if (line.startsWith(':')) continue; // 注释/心跳
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { yield '[DONE]'; return; }
      try { yield JSON.parse(data); } catch { /* 跳过无法解析的片段 */ }
    }
  }
}

/** 简单单轮 prompt 便捷封装 */
export async function complete(userId, prompt, opts = {}) {
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  // 支持追加多轮 assistant 内容（字符串或 {content} 对象），插在 user prompt 之前
  if (Array.isArray(opts.assistant)) {
    for (const item of opts.assistant) {
      if (item == null) continue;
      messages.push({
        role: 'assistant',
        content: typeof item === 'string' ? item : item.content,
      });
    }
  }
  messages.push({ role: 'user', content: prompt });
  return chat(userId, messages, opts);
}

/** 强制返回 JSON */
export async function chatJSON(userId, prompt, opts = {}) {
  const { content } = await complete(userId, prompt, { ...opts, json: true });
  return parseJSON(content);
}

function parseJSON(text) {
  if (!text) throw new Error('大模型返回为空');
  // 去掉 markdown ```json 包裹
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 尝试直接解析
  try { return JSON.parse(t); } catch { /* pass */ }
  // 从首个 {/[ 起逐个右边界尝试解析：贪婪取到最后一个 }/] 会把
  // 「裸 JSON + 尾注」(如 `...}\n注：以上{...}为格式`) 整段截出导致解析失败
  const extracted = extractJSON(t);
  if (extracted !== undefined) return extracted;
  throw new Error('无法解析大模型返回的 JSON：' + t.slice(0, 200));
}

/** 从文本中提取首个可完整解析的 JSON 值；失败返回 undefined */
function extractJSON(t) {
  const start = t.search(/[{[]/);
  if (start === -1) return undefined;
  for (let end = start + 1; end < t.length; end++) {
    const ch = t[end];
    if (ch !== '}' && ch !== ']') continue;
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* 收缩右边界重试 */ }
  }
  return undefined;
}

export function joinUrl(base, path) {
  if (!base) return path;
  const b = base.replace(/\/$/, '');
  // 若 base 已包含 /v1 等版本前缀，则不再补
  if (/\/v\d+$/i.test(b)) return b + path;
  // OpenAI 默认带 /v1
  return b + '/v1' + path;
}
