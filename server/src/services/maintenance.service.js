import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const { Job } = db;

/**
 * 服务器维护模式：内存状态 + 维护期任务播报。
 * 状态只在进程内存中（同 job.service.js 的 queue/running 惯例），
 * 服务器重启 = 自动结束维护，无需建表持久化。
 */
const REPORT_INTERVAL_MS = 30 * 1000; // 维护期间隔：每 30 秒打印一次处理中任务
const MAX_TASKS_LOGGED = 50;          // 单次播报最多打印的任务条数，超出打省略行

let state = null;          // null = 未维护；开启后 { active, reason, expectedEndAt, startedAt, startedBy }
let reporterTimer = null;  // 任务播报定时器（仅维护期间存在）

export function isMaintenanceActive() {
  return !!(state && state.active);
}

export function getMaintenanceState() {
  return state ? { ...state } : { active: false };
}

/**
 * 开启维护：覆盖式写入（重复调用幂等，不会叠加定时器）。
 * @param {object} opts { reason?, expectedEndAt?(ISO 字符串), startedBy?(req.user) }
 */
export function enableMaintenance({ reason = '', expectedEndAt = null, startedBy = null } = {}) {
  state = {
    active: true,
    reason: String(reason || '').slice(0, 200), // 限长，防控制台刷屏
    expectedEndAt: expectedEndAt || null,
    startedAt: new Date().toISOString(),
    startedBy: startedBy ? { id: startedBy.id, username: startedBy.username } : null,
  };
  logger.info(
    `[MAINTENANCE] 维护模式已开启 by=${state.startedBy?.username ?? '?'} reason="${state.reason}" expectedEndAt=${state.expectedEndAt ?? '未设置'}`
  );
  startTaskReporter(); // 立即打一次 + 每 30 秒
  return getMaintenanceState();
}

export function disableMaintenance() {
  const had = isMaintenanceActive();
  stopTaskReporter();
  state = null;
  if (had) logger.info('[MAINTENANCE] 维护模式已结束，恢复正常服务');
  return getMaintenanceState();
}

/**
 * 当前 pending/running 任务（DB 是唯一事实来源：runOne 起跑即写 status='running'）。
 * 控制台播报与 GET /api/admin/maintenance/tasks 共用。
 */
export async function listActiveJobs() {
  return Job.findAll({
    where: { status: { [db.Sequelize.Op.in]: ['pending', 'running'] } },
    order: [['created_at', 'ASC']],
    attributes: [
      'id', 'type', 'status', 'stage', 'progress', 'user_id',
      'project_id', 'episode_id', 'meta', 'created_at', 'updated_at',
    ],
  });
}

function startTaskReporter() {
  if (reporterTimer) return;
  reportTasks(); // 开启瞬间先打一次，admin 立即有反馈
  reporterTimer = setInterval(reportTasks, REPORT_INTERVAL_MS);
}

export function stopTaskReporter() {
  if (reporterTimer) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
}

// 播报当前处理中任务；无任务时提示可安全重启。
// 整体 try/catch：async 定时回调抛错会成为 unhandled rejection 直接崩掉进程
async function reportTasks() {
  try {
    const jobs = await listActiveJobs();
    if (!jobs.length) {
      logger.info('[MAINTENANCE] 当前无进行中任务（pending=0, running=0）—— 可安全重启服务器');
      return;
    }
    const running = jobs.filter((j) => j.status === 'running').length;
    logger.info(`[MAINTENANCE] 进行中任务 ${jobs.length} 个（running=${running}, pending=${jobs.length - running}）：`);
    for (const j of jobs.slice(0, MAX_TASKS_LOGGED)) {
      logger.info(
        `[MAINTENANCE]   #${j.id} type=${j.type} [${j.status}] ${j.progress}% «${j.stage ?? ''}» user=${j.user_id} project=${j.project_id ?? '-'} ep=${j.episode_id ?? '-'} updated=${new Date(j.updated_at).toISOString()}`
      );
    }
    if (jobs.length > MAX_TASKS_LOGGED) {
      logger.info(`[MAINTENANCE]   ...其余 ${jobs.length - MAX_TASKS_LOGGED} 个略`);
    }
  } catch (e) {
    logger.warn('[MAINTENANCE] 任务查询失败:', e?.message || e);
  }
}
