import { Router } from 'express';
import { asyncHandler, badRequest } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { chatStream } from '../services/llm.service.js';
import { buildMessages } from '../services/ai/assistant.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * 星网助理对话（SSE 流式）
 * POST /api/assistant/chat  body: { messages: [{role:'user'|'assistant', content}] }
 *
 * 免费、不接入积分。先 prime 一次（使 resolveConfig / 上游建连错误在写 SSE 头之前
 * 作为标准 JSON 抛出），再以 text/event-stream 逐段推送 {delta}，结束推送 [DONE]。
 */
router.post('/chat', authRequired, asyncHandler(async (req, res) => {
  const history = req.body?.messages;
  if (!Array.isArray(history) || !history.length) throw badRequest('assistant.messages_required');

  const messages = buildMessages(history);
  const gen = chatStream(req.user.id, messages);

  // prime：让 resolveConfig / axios 建连 / 上游 4xx-5xx 在写 SSE 头之前抛出 → 标准 JSON 错误
  let first;
  try {
    first = await gen.next();
  } catch (e) {
    throw badRequest(e.message || 'assistant.unavailable');
  }

  // 监听客户端断开，停止消耗上游
  let aborted = false;
  const onClose = () => { aborted = true; try { gen.return(); } catch { /* ignore */ } };
  req.on('close', onClose);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 代理缓冲
  res.flushHeaders();

  const write = (obj) => {
    if (aborted || res.writableEnded) return false;
    return res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    if (!first.done && first.value) write({ delta: first.value });
    while (true) {
      const { value, done } = await gen.next(); // eslint-disable-line no-await-in-loop
      if (done) break;
      if (value) write({ delta: value });
    }
    write({ done: true });
  } catch (e) {
    logger.error('[星网助理→流式异常]', e.message);
    write({ error: e.message || '生成失败，请稍后重试' });
  } finally {
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}));

export default router;
