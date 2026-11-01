import router from '../router';
import i18n from '../i18n';

const BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * 星网助理流式对话：直接用 fetch + ReadableStream 读 SSE（不经过 http.js 的 axios，避免缓冲）。
 *
 * @param {object} params
 * @param {Array<{role,content}>} params.messages  历史对话（不含 system，后端会注入星网助理人设）
 * @param {(text:string)=>void} [params.onDelta]    收到文本增量
 * @param {(msg:string)=>void} [params.onError]     收到错误
 * @param {AbortSignal} [params.signal]             用于中止
 * @returns {Promise<void>}
 */
export async function streamAssistantChat({ messages, onDelta, onError, signal }) {
  const resp = await fetch(BASE + '/assistant/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (localStorage.getItem('aidrama-token') || ''),
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!resp.ok) {
    // 401：与 http.js 一致，清 token 并跳登录
    if (resp.status === 401) {
      localStorage.removeItem('aidrama-token');
      router.push('/login');
    }
    let msg = i18n.global.t('errors.requestFailedStatus', { status: resp.status });
    try { const body = await resp.json(); msg = body.message || msg; } catch { /* ignore */ }
    onError?.(msg);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  while (true) {
    const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const parts = buf.split('\n\n');
    buf = parts.pop(); // 保留最后可能不完整的一段

    for (const part of parts) {
      const line = part.replace(/^data:\s*/, '').trim();
      if (!line || line === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) onError?.(obj.error);
      else if (obj.done) return;
      else if (obj.delta) onDelta?.(obj.delta);
    }
  }
}
