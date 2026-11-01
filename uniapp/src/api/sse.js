/**
 * SSE 流式请求（大纲对话 / AI 助理共用）。
 * - H5：fetch + ReadableStream（与 client 完全同构）
 * - 小程序 / App：uni.request enableChunked + onChunkReceived，
 *   自带增量 UTF-8 解码（无 TextDecoder 环境）
 * 返回 { run(): Promise<boolean>, abort() }，run() resolve true 表示正常完成。
 */
import { buildUrl } from './http';

export function createSSE({ url, body, headers = {}, onDelta, onError }) {
  let aborted = false;
  let abortFn = () => {};

  /* #ifdef H5 */
  async function run() {
    const controller = new AbortController();
    abortFn = () => controller.abort();
    try {
      const resp = await fetch(buildUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      if (aborted) return false;
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const b = await resp.json();
          msg = b.message || msg;
        } catch (e) {}
        onError?.(msg);
        return false;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done || aborted) break;
        buf += decoder.decode(value, { stream: true });
        buf = emit(buf, onDelta, onError);
      }
      return !aborted;
    } catch (e) {
      if (!aborted) onError?.(e?.message || String(e));
      return false;
    }
  }
  /* #endif */

  /* #ifndef H5 */
  function run() {
    return new Promise((resolve) => {
      let buf = '';
      const task = uni.request({
        url: buildUrl(url),
        method: 'POST',
        data: body || {},
        header: { 'Content-Type': 'application/json', ...headers },
        enableChunked: true,
        timeout: 320000,
        success: () => resolve(!aborted),
        fail: (e) => {
          if (!aborted) onError?.(e?.errMsg || 'network error');
          resolve(false);
        },
      });
      abortFn = () => {
        aborted = true;
        try {
          task.abort();
        } catch (e) {}
      };
      let pending = EMPTY_BYTES; // 上一 chunk 尾部截断的多字节序列，拼回下一 chunk 再解
      task.onChunkReceived((res) => {
        if (aborted) return;
        const dec = decodeChunk(res.arrayBuffer || res.data, pending);
        pending = dec.rest || EMPTY_BYTES;
        buf += dec.text;
        buf = emit(buf, onDelta, onError);
      });
    });
  }
  /* #endif */

  return {
    run,
    abort: () => {
      aborted = true;
      abortFn();
    },
  };
}

/** 消化缓冲：按空行切 SSE 事件，返回剩余尾巴 */
function emit(buf, onDelta, onError) {
  const parts = buf.split('\n\n');
  buf = parts.pop();
  for (const part of parts) {
    const line = part.replace(/^data:\s*/, '').trim();
    if (!line || line === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (obj.error) onError?.(obj.error);
    else if (obj.delta) onDelta?.(obj.delta);
  }
  return buf;
}

const EMPTY_BYTES = new Uint8Array(0);

/** 增量 UTF-8 解码：处理跨 chunk 截断的多字节序列。
 *  返回 { text, rest }——rest 是尾部不完整序列的字节，调用方必须拼回下一 chunk 再解，
 *  否则跨 chunk 的中文（3 字节）恰好被 chunk 边界切开时会永久丢失尾字节（乱码）。 */
function decodeChunk(data, pending = null) {
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (Array.isArray(data)) bytes = new Uint8Array(data);
  else return { text: String(data ?? ''), rest: null }; // 字符串场景无字节余量
  if (pending && pending.length) {
    const merged = new Uint8Array(pending.length + bytes.length);
    merged.set(pending, 0);
    merged.set(bytes, pending.length);
    bytes = merged;
  }
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let need = 0;
    if (b < 0x80) need = 0;
    else if ((b & 0xe0) === 0xc0) need = 1;
    else if ((b & 0xf0) === 0xe0) need = 2;
    else if ((b & 0xf8) === 0xf0) need = 3;
    if (need > 0 && i + need >= bytes.length) break; // 尾部截断：经 rest 返回，留给下一 chunk
    if (need === 0) {
      out += String.fromCharCode(b);
      i += 1;
    } else {
      let cp = b & (0x3f >> need);
      let ok = true;
      for (let k = 1; k <= need; k++) {
        const cb = bytes[i + k];
        if ((cb & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (cb & 0x3f);
      }
      if (!ok) {
        i += 1;
        continue;
      }
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
  }
  return { text: out, rest: i < bytes.length ? bytes.slice(i) : null };
}
