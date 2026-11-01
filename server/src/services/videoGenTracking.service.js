import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const { VideoGeneration } = db;

/**
 * 视频生成留档（video_generations）的读写与等待层。
 * video.service（提交侧）与 videoGenScanner（扫描查询侧）共用，本模块不 import
 * video.service（避免循环依赖）。
 *
 * 轮询语义：没有超时预算——record 由扫描器一直查到厂商给出 succeeded/failed 终态为止；
 * 等待侧 waitForGeneration 同样无超时，只做本地库轮询。轮询过程不落查询明细
 * （video_generation_queries 已废弃删除），只更新 video_generations 本身。
 */

const WAIT_POLL_INTERVAL_MS = 3000;   // workFn 本地等待终态的轮询间隔（查本地库，开销极小）
const WAIT_HEARTBEAT_LOOPS = 200;     // 每约 200 次（10 分钟）打一条防呆日志

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 递归脱敏/压缩任意结构（提交体、厂商响应落库前必经）：
 *  - data:<mime>;base64,xxx → data:<mime>;base64,<N 字符略>（参考图/音/视频 base64 可达 50MB，
 *    不脱敏会打爆 MySQL max_allowed_packet）
 *  - 其它超长字符串截断，尾注原始长度
 *  - 超 maxDepth 的嵌套丢弃为 '[深度截断]'
 */
export function sanitizeDeep(value, { maxStr = 600, maxDepth = 6 } = {}) {
  const walk = (v, depth) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      const m = /^data:([^;,]+);base64,/.exec(v);
      if (m) return `data:${m[1]};base64,<${v.length} 字符略>`;
      if (v.length > maxStr) return `${v.slice(0, maxStr)}…(共 ${v.length} 字符)`;
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) {
      if (depth >= maxDepth) return '[深度截断]';
      return v.map((x) => walk(x, depth + 1));
    }
    if (typeof v === 'object') {
      if (depth >= maxDepth) return '[深度截断]';
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, depth + 1);
      return out;
    }
    return String(v); // bigint/symbol 等少见类型兜底为字符串
  };
  return walk(value, 0);
}

/**
 * 扫描器对单条 record 的查询间隔（随任务耗时降频，无超时上限）：
 * 提交后 2 分钟内 5s（首屏响应快）→ 15 分钟内 15s → 此后 60s（长任务省查询）。
 */
export function pollIntervalMs(record) {
  const age = Date.now() - new Date(record.created_at).getTime();
  if (age < 2 * 60 * 1000) return 5 * 1000;
  if (age < 15 * 60 * 1000) return 15 * 1000;
  return 60 * 1000;
}

/** 提交成功后建 pending record（参数与厂商返回均脱敏落库） */
export async function createGenerationRecord({
  userId, jobId = null, projectId = null, episodeId = null, segmentId = null,
  feature = 'segment_video', vendor, provider, model, modelConfigId = null, baseUrl = null,
  submitUrl = null, taskId, params, submitResponse,
}) {
  return VideoGeneration.create({
    user_id: userId,
    job_id: jobId ?? null,
    project_id: projectId ?? null,
    episode_id: episodeId ?? null,
    segment_id: segmentId ?? null,
    feature,
    vendor,
    provider,
    model,
    model_config_id: modelConfigId ?? null,
    base_url: baseUrl ?? null,
    submit_url: submitUrl ?? null,
    status: 'pending',
    task_id: taskId ?? null,
    params: sanitizeDeep(params ?? null),
    submit_response: sanitizeDeep(submitResponse ?? null),
  });
}

/** generic 等同步直出 URL 的契约：无异步任务可查，直接落 succeeded record（无查询明细行） */
export async function createSyncSuccessRecord({ videoUrl, ...fields }) {
  return VideoGeneration.create({
    user_id: fields.userId,
    job_id: fields.jobId ?? null,
    project_id: fields.projectId ?? null,
    episode_id: fields.episodeId ?? null,
    segment_id: fields.segmentId ?? null,
    feature: fields.feature || 'segment_video',
    vendor: fields.vendor,
    provider: fields.provider,
    model: fields.model,
    model_config_id: fields.modelConfigId ?? null,
    base_url: fields.baseUrl ?? null,
    submit_url: fields.submitUrl ?? null,
    status: 'succeeded',
    task_id: null,
    params: sanitizeDeep(fields.params ?? null),
    submit_response: sanitizeDeep(fields.submitResponse ?? null),
    result: { videoUrl, vendorStatus: 'succeeded', message: '同步直出，无异步任务' },
    finished_at: new Date(),
  });
}

/** 已触网的提交失败留档（status='failed'：提交体/错误响应可追溯；本地前置校验失败不建 record） */
export async function createFailedSubmitRecord({ error, submitResponse, ...fields }) {
  return VideoGeneration.create({
    user_id: fields.userId,
    job_id: fields.jobId ?? null,
    project_id: fields.projectId ?? null,
    episode_id: fields.episodeId ?? null,
    segment_id: fields.segmentId ?? null,
    feature: fields.feature || 'segment_video',
    vendor: fields.vendor,
    provider: fields.provider,
    model: fields.model,
    model_config_id: fields.modelConfigId ?? null,
    base_url: fields.baseUrl ?? null,
    submit_url: fields.submitUrl ?? null,
    status: 'failed',
    task_id: fields.taskId ?? null,
    params: sanitizeDeep(fields.params ?? null),
    submit_response: sanitizeDeep(submitResponse ?? null),
    error: String(error || '').slice(0, 2000),
    finished_at: new Date(),
  });
}

/**
 * 找该 Job（可叠加 segment 精确匹配）最近一次提交的厂商任务（重启恢复用）：
 * 返回最新一条 record（不限状态），无则 null。服务重启后 job 的 workFn 虽已蒸发，
 * 但厂商任务仍在生成、扫描线程仍会把它查到终态——恢复方据此刻意「不清理、继续等」。
 * 不限状态是刻意的：启动检查时 pending 的任务，到 workFn 真正执行时可能已被扫描线程
 * 查成 succeeded/failed 终态，按 pending 过滤会误判「无任务」而重新提交（双跑双扣厂商额度）。
 * 同一 (job,segment) 每个任务只提交一次厂商任务，故「最新一条」即本任务自己的提交。
 */
export async function findJobGeneration(jobId, segmentId = null) {
  if (!jobId) return null;
  const where = { job_id: jobId };
  if (segmentId) where.segment_id = segmentId;
  return VideoGeneration.findOne({ where, order: [['id', 'DESC']] });
}

/**
 * 记一次厂商查询到 record 本身（轮询计数/最近状态/最近查询时间；updated_at 随之刷新）。
 * 查询明细表 video_generation_queries 已废弃删除，不再逐次落明细行。
 * state='error'（查询本身失败）时 error_count 累加，否则清零。
 * @param {object} q { state, vendorState }
 */
export async function markPolled(record, { state, vendorState = null }) {
  await record.update({
    poll_count: (record.poll_count || 0) + 1,
    last_polled_at: new Date(),
    last_state: vendorState != null ? String(vendorState).slice(0, 64) : (record.last_state ?? null),
    error_count: state === 'error' ? (record.error_count || 0) + 1 : 0,
  });
}

/** 写终态（succeeded/failed）+ finished_at */
export async function finishGeneration(id, { status, result = null, error = null }) {
  await VideoGeneration.update(
    // result.raw（厂商查询原始响应）落库前须 sanitizeDeep：部分厂商终态回传内嵌 base64/超长字段
    // （如审核截图），原样落 JSON 列会撑爆行——扫描线程对同批 record 连环写失败。
    // 只脱敏 raw：result.videoUrl/lastFrameUrl 是功能字段（下载/恢复链路消费），
    // 厂商签名 URL 可超 600 字符，整包过 sanitizeDeep 会被截断损坏
    { status, result: result ? { ...result, raw: sanitizeDeep(result.raw ?? null) } : null, error: error ? String(error).slice(0, 2000) : null, finished_at: new Date() },
    { where: { id } },
  );
}

/**
 * 等待 record 到终态（本地库轮询，无超时——厂商侧由扫描器一直查到成功/失败为止）。
 * failed 时抛 record.error（已是面向用户的文案，含审核提示，退款链路与原内联轮询一致）。
 * @returns 终态 record（含 result）
 */
export async function waitForGeneration(id, { tag = 'VIDEO', intervalMs = WAIT_POLL_INTERVAL_MS } = {}) {
  const startedAt = Date.now();
  let loops = 0;
  for (;;) {
    await sleep(intervalMs);
    const record = await VideoGeneration.findByPk(id);
    if (!record) throw new Error(`视频生成记录 #${id} 不存在（等待终态期间被删除）`);
    if (record.status === 'succeeded') return record;
    if (record.status === 'failed') throw new Error(record.error || '视频生成失败');
    loops += 1;
    if (loops % WAIT_HEARTBEAT_LOOPS === 0) {
      logger.info(`[VIDEO→等待/${tag}] record=#${id} 仍在等待厂商终态（已 ${Math.round((Date.now() - startedAt) / 1000)}s, poll=${record.poll_count}, last=${record.last_state ?? '-'}）`);
    }
  }
}
