import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { VIDEO_QUERY_HANDLERS } from './video.service.js';
import { markPolled, finishGeneration, pollIntervalMs } from './videoGenTracking.service.js';

const { VideoGeneration, ModelConfig } = db;
const Op = db.Sequelize.Op;

/**
 * 视频生成留档扫描线程（独立的周期后台任务，与业务流程解耦）：
 * 每 5 秒扫描 video_generations 中 status='pending' 且到期的 record，按 record.vendor
 * 分发到对应厂商查询契约（VIDEO_QUERY_HANDLERS）单次查询厂商；轮询不落查询明细
 * （video_generation_queries 已废弃删除），只更新 video_generations 本身的轮询
 * 计数/最近状态/更新时间，查到终态时把结果写回 record。
 *
 * 轮询语义：没有超时预算——record 一直被查到厂商给出 succeeded/failed 终态为止；
 * 单次查询失败（网络抖动/HTTP 错误）只累加 error_count 并按降频重试，不影响 record。
 *
 * 安全阀（只对「查询层持续异常」生效，厂商正常返回 running 状态永不终止）：
 *  - 确定性 4xx（400/401/403/404：任务号不存在/鉴权失效等，重试不可能成功）连续 3 次；
 *  - 任意查询错误连续 60 次（降频后约 1 小时，防 Job 槽位被永久卡死）。
 * 触发即判 failed 终态留档。厂商侧仍在生成的任务不受影响（其查询返回的是正常状态而非错误）。
 *
 * 范式与 maintenance.service.js 一致：模块级 timer、start/stop、可重入保护、
 * async 定时回调整体 try/catch（防 unhandled rejection 崩进程）。
 */

const SCAN_INTERVAL_MS = 5 * 1000;      // 扫描周期（与旧内联轮询同节奏；单条 record 的实际查询间隔见 pollIntervalMs）
const MIN_DUE_MS = 5 * 1000;            // 候选粗筛：最近 5s 内查过的本轮直接跳过（再按 pollIntervalMs 精筛）
const QUERY_CONCURRENCY = 4;            // 单轮并发查询厂商的上限（防限流）
const SCAN_BATCH_LIMIT = 200;           // 单轮最多处理的候选数（超出下轮自然接续）
const HARD_ERROR_LIMIT = 60;            // 安全阀：任意查询错误连续次数（≈降频后 1 小时）
const CLIENT_ERROR_LIMIT = 3;           // 安全阀：确定性 4xx 连续次数
const CLIENT_ERROR_STATUSES = new Set([400, 401, 403, 404]);

let timer = null;          // 扫描定时器（null = 未启动）
let scanning = false;      // 可重入保护：单轮未结束时不叠加下一轮
const inFlight = new Set(); // 正在查询的 record id（进程内去重；单进程部署与 job.service 同前提）

/** 有界并发池（与 segmentVideo.service.js runPool 同范式）：最多同时 limit 个，完成一个补一个 */
async function runPool(items, limit, worker) {
  const executing = new Set();
  for (const item of items) {
    const p = worker(item);
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

// 单轮扫描：取到期候选 -> 精筛降频间隔 -> 并发查厂商
async function scanOnce() {
  const now = new Date();
  const candidates = await VideoGeneration.findAll({
    where: {
      status: 'pending',
      [Op.or]: [
        { last_polled_at: null },
        { last_polled_at: { [Op.lte]: new Date(now.getTime() - MIN_DUE_MS) } },
      ],
    },
    order: [['last_polled_at', 'ASC']], // NULL 在前（MySQL/SQLite 一致）：刚提交的最先查
    limit: SCAN_BATCH_LIMIT,
  });
  // 精筛：各 record 降频档不同（5s/15s/60s），不能只用统一 cutoff
  const due = candidates.filter((r) => !inFlight.has(r.id) && (!r.last_polled_at || now.getTime() - new Date(r.last_polled_at).getTime() >= pollIntervalMs(r)));
  if (due.length) await runPool(due, QUERY_CONCURRENCY, queryOne);
}

/**
 * 查询单条 record 的厂商状态并更新 record（轮询统计/终态结果）。
 * 抛错由 runPool 吞不了——内部全捕获（查询失败只影响本 record，不是扫描轮的失败）。
 */
async function queryOne(record) {
  inFlight.add(record.id);
  try {
    // 按 model_config_id 重取配置（含 api_key，不在 record 冗余存密钥）
    const cfg = record.model_config_id ? await ModelConfig.findByPk(record.model_config_id) : null;
    if (!cfg) {
      const message = '模型配置已删除，无法继续查询厂商任务状态';
      await markPolled(record, { state: 'error' });
      await finishGeneration(record.id, { status: 'failed', error: message });
      logger.warn(`[VIDEO→终态] record=#${record.id} vendor=${record.vendor} task=${record.task_id} ${message}`);
      return;
    }
    const handler = VIDEO_QUERY_HANDLERS[record.vendor] || VIDEO_QUERY_HANDLERS.generic;

    let q;
    try {
      q = await handler(cfg, record.task_id);
    } catch (err) {
      // 查询本身失败（网络/HTTP 层）：累加 error_count；瞬时错误保持 pending 按降频重试，
      // 连续异常达安全阀阈值才判 failed 终态（防 record/Job 永久挂起）
      const httpStatus = err.response?.status ?? null;
      await markPolled(record, { state: 'error' });
      // markPolled 已把实例的 error_count 原位更新为最新连续错误数，直接读即可（勿再 +1）
      const errors = record.error_count || 0;
      const clientErr = httpStatus != null && CLIENT_ERROR_STATUSES.has(httpStatus);
      if ((clientErr && errors >= CLIENT_ERROR_LIMIT) || errors >= HARD_ERROR_LIMIT) {
        const message = `连续 ${errors} 次查询厂商失败（status=${httpStatus ?? err.code ?? err.message}），任务判失败留档`;
        await finishGeneration(record.id, { status: 'failed', error: message });
        logger.warn(`[VIDEO→终态] record=#${record.id} vendor=${record.vendor} task=${record.task_id} ${message}`);
      } else {
        logger.warn(`[VIDEO→轮询/${record.vendor}] record=#${record.id} 查询失败 status=${httpStatus ?? err.code}（第 ${errors} 次，重试）`);
      }
      return;
    }

    await markPolled(record, { state: q.state, vendorState: q.vendorStatus });
    if (q.state === 'running') return; // 继续等下一轮

    // 终态：成功/失败的结果数据（含厂商原始返回）写入 record 留档
    const result = { videoUrl: q.videoUrl || null, lastFrameUrl: q.lastFrameUrl || null, vendorStatus: q.vendorStatus, message: q.message || null, raw: q.raw || null };
    await finishGeneration(record.id, { status: q.state, result, error: q.state === 'failed' ? (q.message || '视频生成失败') : null });
    const secs = ((Date.now() - new Date(record.created_at).getTime()) / 1000).toFixed(0);
    logger.info(`[VIDEO→终态/${record.vendor}] record=#${record.id} task=${record.task_id} ${q.state === 'succeeded' ? '成功' : '失败'} 耗时=${secs}s poll=${record.poll_count}${q.state === 'failed' ? ` :: ${q.message || ''}` : ''}`);
  } catch (e) {
    // 单条查询的意外异常不阻断本轮其他 record
    logger.warn(`[VIDEO→轮询] record=#${record.id} 处理异常: ${e?.message || e}`);
  } finally {
    inFlight.delete(record.id);
  }
}

// 单轮入口：可重入保护 + 整体 try/catch（async 定时回调抛错会成为 unhandled rejection 崩进程）
async function scanTick() {
  if (scanning) return;
  scanning = true;
  try {
    await scanOnce();
  } catch (e) {
    logger.warn(`[VIDEO→扫描] 本轮扫描失败: ${e?.message || e}`);
  } finally {
    scanning = false;
  }
}

export function startVideoGenScanner() {
  if (timer) return;
  logger.info(`[VIDEO→扫描] 视频生成留档扫描线程已启动（周期 ${SCAN_INTERVAL_MS / 1000}s，无超时：查到厂商成功/失败为止）`);
  timer = setInterval(scanTick, SCAN_INTERVAL_MS);
}

export function stopVideoGenScanner() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[VIDEO→扫描] 视频生成留档扫描线程已停止');
  }
}
