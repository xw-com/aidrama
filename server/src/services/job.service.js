import db from '../db/index.js';
import { ApiError, badRequest, forbidden, notFound } from '../utils/response.js';
import { logger } from '../utils/logger.js';
import { t as i18nT, DEFAULT_LOCALE } from '../i18n/index.js';
import { deleteUrlFiles } from '../utils/fileUtil.js';
import { refundJobHold } from './credits.service.js';
import { batchVideoWorkFn, batchVideoWorkFnConcurrent, segmentVideoResumeWorkFn, segmentEraseResumeWorkFn } from './segmentVideo.service.js';
import { isMaintenanceActive, getMaintenanceState } from './maintenance.service.js';

const { Job, User, VideoGeneration, ModelConfig } = db;

// 同类型任务并发上限（原会员最高档数值，会员体系已下线后固定）
const MAX_CONCURRENT_PER_TYPE = 99;

/**
 * 进程内任务运行器：FIFO 队列 + 并发上限。
 * 不依赖 Redis；任务在 Node 进程内执行，Job 行持久化到数据库。
 *
 * 并发上限按「同类型」计量：同一 type 最多 CONCURRENCY 个任务同时运行，
 * 不同 type 互不叠加（各自独占自己的名额）。例如脚本生成与视频合成可同时各跑满。
 */
const CONCURRENCY = 3; // 同类型任务并发上限（不同类型互不叠加）
const queue = [];          // [{ jobId, workFn, priority, type, modelConfigId }]
const running = new Set(); // 正在运行的 jobId（全局成员判断）
const runningByType = new Map(); // type -> Set<jobId>，按类型计数并发槽
const jobType = new Map(); // jobId -> type，releaseSlot 反查类型用
let pumping = false;

// ============ 模型级全局并发闸门（所有用户共享，admin 给视频模型配 max_concurrency） ============
// 该模型上「正在运行」的任务跨所有用户计入同一总数；NULL/0=不限。超限任务留在队列里
// 排队（pending），有任务结束（releaseSlot）即补位。计数以 jobId 幂等归位（Set 去重）：
// 服务重启时按 DB status=running 的行扫描重建（rebuildModelConcurrency），重启恢复重新
// 入队的同一 jobId 再次 track 不会重复计数。
const runningByModel = new Map(); // modelConfigId(number) -> Set<jobId>
const modelOfJob = new Map();     // jobId -> modelConfigId（幂等释放反查）

function trackModelJob(jobId, modelConfigId) {
  if (!modelConfigId) return;
  modelOfJob.set(jobId, modelConfigId);
  const set = runningByModel.get(modelConfigId) || new Set();
  set.add(jobId);
  runningByModel.set(modelConfigId, set);
}

function untrackModelJob(jobId) {
  const cfgId = modelOfJob.get(jobId);
  if (cfgId === undefined) return false;
  modelOfJob.delete(jobId);
  const set = runningByModel.get(cfgId);
  if (set) {
    set.delete(jobId);
    if (!set.size) runningByModel.delete(cfgId);
  }
  return true;
}

function runningCountOfModel(cfgId) {
  return (runningByModel.get(cfgId) || EMPTY_SET).size;
}

// 本次 pump 批量取一次各模型并发上限（max_concurrency>0 才限流；查不到/未配置=不限）
async function modelConcurrencyCaps(cfgIds) {
  const ids = [...new Set(cfgIds.filter(Boolean))].map(Number);
  if (!ids.length) return new Map();
  const rows = await ModelConfig.findAll({
    where: { id: { [db.Sequelize.Op.in]: ids }, type: 'video', max_concurrency: { [db.Sequelize.Op.gt]: 0 } },
    attributes: ['id', 'max_concurrency'],
  }).catch(() => []);
  return new Map(rows.map((r) => [r.id, Number(r.max_concurrency)]));
}

/**
 * 重启重建：扫描 DB 里 status=running 且 meta.modelConfigId 的任务，恢复进程内模型并发计数
 * （重启前在厂商侧仍跑着的任务继续占用模型并发名额）。须在恢复入队（resumeInterruptedJobs）
 * 之前调用，恢复任务重新 track 时靠 Set 去重不双计。
 */
export async function rebuildModelConcurrency() {
  const rows = await Job.findAll({ where: { status: 'running' }, attributes: ['id', 'meta'] });
  let n = 0;
  for (const j of rows) {
    const cfgId = Number(j.meta?.modelConfigId);
    if (Number.isFinite(cfgId) && cfgId > 0) { trackModelJob(j.id, cfgId); n += 1; }
  }
  if (n) logger.info(`[JOB] 模型并发计数重建：${n} 个运行中任务已计入各模型全局并发`);
  return n;
}

// 进程内互斥：串行化 createJob 的"查重 + 插入"，消除并发下的 check-then-act 竞态。
// 单进程部署下足以保证同一目标不会被重复建任务。
let _createChain = Promise.resolve();
function serialized(fn) {
  const next = _createChain.then(fn, fn);
  _createChain = next.catch(() => {});
  return next;
}

/**
 * 创建任务（含同目标去重护栏）。
 * 若同一 (user,type,project/episode/ref) 已有 pending/running 任务则拒绝。
 * 维护模式下拦截非 admin 用户（读取类请求不受影响，只拦「会产生任务」的请求；
 * 响应形状与原全局 guard 一致：503 + data.maintenance，前端走专门提示）。
 */
export async function createJob(userId, { type, projectId = null, episodeId = null, refId = null, meta = {} }) {
  if (isMaintenanceActive()) {
    const u = await User.findByPk(userId, { attributes: ['role'] });
    if (!u || u.role !== 'admin') {
      const st = getMaintenanceState();
      throw new ApiError(503, 'maintenance.active', {
        maintenance: true,
        reason: st.reason || '',
        expectedEndAt: st.expectedEndAt || null,
        startedAt: st.startedAt,
      });
    }
  }
  // 计费走个人余额（withCredits 预扣/结算/退款见 credits.service）
  return serialized(async () => {
    const where = { user_id: userId, type, status: { [db.Sequelize.Op.in]: ['pending', 'running'] } };
    if (projectId) where.project_id = projectId;
    if (episodeId) where.episode_id = episodeId;
    if (refId) where.ref_id = refId;
    const exists = await Job.count({ where });
    if (exists > 0) throw badRequest('该任务正在进行中，请等待完成');

    // 并发上限：限制该用户同类型 pending+running 任务数（不同类型互不叠加）
    const maxConcurrent = MAX_CONCURRENT_PER_TYPE;
    const activeCount = await Job.count({ where: { user_id: userId, type, status: { [db.Sequelize.Op.in]: ['pending', 'running'] } } });
    if (activeCount >= maxConcurrent) throw badRequest(`已达该类型并发上限（${maxConcurrent} 个任务），请等待任务完成`);

    return Job.create({
      user_id: userId,
      type, project_id: projectId, episode_id: episodeId, ref_id: refId,
      status: 'pending', progress: 0, stage: '排队中', meta,
    });
  });
}

/**
 * 提交任务到队列并尽快开始执行。workFn = async (ctx) => result；
 * ctx.reportProgress(progress, stage) 用于刷新进度。
 */
export function submit(jobId, workFn) {
  enqueueWithPriority(jobId, workFn);
}

// 入队（保留 priority 字段以兼容队列排序结构；FIFO：Node 排序稳定）
async function enqueueWithPriority(jobId, workFn) {
  let type = '';
  let modelConfigId = null;
  try {
    const job = await Job.findByPk(jobId, { attributes: ['type', 'meta'] });
    if (job) {
      type = job.type;
      const mc = Number(job.meta?.modelConfigId); // 视频任务提交时写入（storyboard 路由），模型并发闸门凭它归位
      if (Number.isFinite(mc) && mc > 0) modelConfigId = mc;
    }
  } catch { /* 查询失败不阻塞入队 */ }
  queue.push({ jobId, workFn, priority: 0, type, modelConfigId });
  queue.sort((a, b) => b.priority - a.priority);
  pump();
}

// 同类型正在运行的任务数
const EMPTY_SET = new Set();
function runningCountOfType(type) {
  return (runningByType.get(type) || EMPTY_SET).size;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    // 本次消化队列前批量取一次模型并发上限（admin 可配；NULL/未配置=不限）
    const caps = await modelConcurrencyCaps(queue.map((it) => it.modelConfigId));
    // 取出第一个「同类型 + 所属模型」槽位都未满的队首任务；不同类型/模型互不占名额
    while (queue.length) {
      const idx = queue.findIndex((it) => runningCountOfType(it.type) < CONCURRENCY
        && (!it.modelConfigId || runningCountOfModel(it.modelConfigId) < (caps.get(it.modelConfigId) ?? Infinity)));
      if (idx === -1) break; // 队列里所有任务的槽位（类型/模型）都已满
      const item = queue.splice(idx, 1)[0];
      running.add(item.jobId);
      trackModelJob(item.jobId, item.modelConfigId);
      const set = runningByType.get(item.type) || new Set();
      set.add(item.jobId);
      runningByType.set(item.type, set);
      jobType.set(item.jobId, item.type);
      // 不 await：让 pump 继续尝试填满并发槽。
      // .catch 必须在 .finally 之前：runOne 顶部 Job.findByPk 等裸露异常若无人接管，
      // 经 .finally 派生的 promise 变 unhandled rejection，node>=15 默认直接退出整个进程
      runOne(item.jobId, item.workFn)
        .catch((e) => logger.error(`Job ${item.jobId} runner fatal:`, e?.message || e))
        .finally(() => {
        releaseSlot(item.jobId);
      });
    }
  } finally {
    pumping = false;
  }
}

// job.error 面向任务中心/客户端直接展示：i18n 键形态的消息（如 script.pdf_no_text）
// 按默认语言翻译后入库；字面量消息 t() 未命中键原样返回，不受影响
function localizeJobError(e) {
  const msg = e?.message || String(e);
  try { return i18nT(DEFAULT_LOCALE, msg) || msg; } catch { return msg; }
}

async function runOne(jobId, workFn) {
  const job = await Job.findByPk(jobId);
  if (!job) return;
  if (job.status === 'cancelled') return; // 排队期间被取消
  try {
    await job.update({ status: 'running', stage: '准备数据', progress: 5 });
    const ctx = {
      jobId,
      async reportProgress(progress, stage) {
        try { await Job.update({ progress, stage }, { where: { id: jobId } }); } catch { /* ignore */ }
      },
    };
    const result = await workFn(ctx);
    // workFn 返回后，若运行期间已被协同取消（如批量串行任务取消），保持 cancelled 终态，
    // 仅回写结果/积分供查询，不覆盖为 succeeded。
    const after = await Job.findByPk(jobId, { attributes: ['status'] });
    if (after?.status === 'cancelled') {
      await job.update({ result: result ?? null, credits_used: result?.credits_used ?? 0 }).catch(() => {});
      return;
    }
    await job.update({
      status: 'succeeded', progress: 100, stage: '完成',
      result: result ?? null, credits_used: result?.credits_used ?? 0, error: null,
    });
  } catch (e) {
    // withCredits 已在抛出前完成退款（若有预扣）
    logger.warn(`Job ${jobId} (type=${job.type}) failed:`, e?.message || e);
    // 与成功路径对称：运行期间已被取消的保持 cancelled 终态，
    // 不被 workFn 迟到的异常覆盖为 failed（实锤：取消成功 4 分钟后状态被改成 failed）
    const after = await Job.findByPk(jobId, { attributes: ['status'] }).catch(() => null);
    if (after?.status === 'cancelled') return;
    await job.update({ status: 'failed', error: localizeJobError(e), stage: '失败' }).catch(() => {});
  }
}

const RUNNING_CANCEL_TIMEOUT_MS = 10 * 60 * 1000; // 运行中任务超过 10 分钟才可取消

/**
 * 取消运行中任务后立即归还进程并发槽并唤醒队列。
 * 运行中的 LLM/ffmpeg 调用无法安全中止，workFn 成为孤儿继续执行——其结果由
 * runOne 的终态检查丢弃（不会覆盖 cancelled）——但不能再占用机器槽位：
 * 否则超时取消的挂死调用永不返回，该类型的 CONCURRENCY 槽位泄漏，后续同类任务会一直排队。
 * （孤儿与顶上来的新任务短暂并存，同类型实际并发可能瞬时超 3，取消场景下可接受。）
 */
function releaseSlot(jobId) {
  const removed = running.delete(jobId);
  const t = jobType.get(jobId);
  if (t) {
    runningByType.get(t)?.delete(jobId);
    jobType.delete(jobId);
  }
  // 模型并发槽同步归还：正常运行结束（running 命中）与重启播种后被清理/取消的任务
  // （不在 running 里，仅 modelOfJob 命中）都要释放，唤醒同模型排队任务
  const mRemoved = untrackModelJob(jobId);
  if (removed || mRemoved) pump();
}

/**
 * 任务非正常终止（服务重启僵尸 / 孤儿取消 / 超时取消）后，复位其锁住的业务行状态：
 * workFn 死了没人再把行置回终态，行会永远卡在 generating（前端一直转圈、不可重试）。
 * 仅复位仍处 generating 的行（已是终态的不动）；复位失败不阻断取消/恢复主流程。
 */
async function resetStuckRefStatus(job) {
  try {
    const refId = Number(job.ref_id);
    if (!Number.isFinite(refId)) return;
    if (job.type === 'asset_image') {
      await db.Asset.update({ status: 'failed' }, { where: { id: refId, status: 'generating' } });
    } else if (job.type === 'segment_generate' || job.type === 'segment_video') {
      await db.StoryboardSegment.update({ status: 'failed' }, { where: { id: refId, status: 'generating' } });
    } else if (job.type === 'segment_erase_subtitle') {
      // 擦字幕中断不毁掉原视频：仍有成片回 done（可继续用），无片才 failed（与其 workFn catch 同口径）
      const seg = await db.StoryboardSegment.findByPk(refId, { attributes: ['id', 'status', 'video_url'] });
      if (seg && seg.status === 'generating') await seg.update({ status: seg.video_url ? 'done' : 'failed' });
    }
  } catch { /* 复位失败不阻断主流程 */ }
}

/**
 * 取消任务。
 *  - pending：直接出队取消
 *  - running(segment_video_batch)：可立即取消，仅翻转取消标志；workFn 下一段循环顶部
 *    检测到即停，当前段自然完成（成功计费/失败退款），不在此重复退款。
 *  - running(其它类型)：仅允许超过 10 分钟的超时任务取消，并退还已预扣积分
 *    （运行中的 LLM/ffmpeg 调用无法安全中止，仅丢弃结果并退款）
 * 两种 running 取消都会立即归还进程并发槽（releaseSlot），后续排队任务马上顶上；
 * 会员并发上限按 DB pending+running 计数，状态翻转后即自然恢复。
 * admin 选项（后台任务管理）：跳过属主校验，且 running 不等 10 分钟直接按超时口径强制取消；
 * 退款对象始终是任务属主 job.user_id（admin 代为取消时退给属主，而非 admin 自己）。
 */
export async function cancelJob(userId, jobId, { admin = false } = {}) {
  // 归一为 number：路由传入的 params.id 是 string，而进程内 queue/running/jobType
  // 集合都以 DB number 为键——Set.prototype.has 不做类型转换，string 永远查不中，
  // 会导致「运行中任务 10 分钟后才可取消」守卫整体失效（任意时刻取消+全额退款）。
  jobId = Number(jobId);
  if (!Number.isFinite(jobId)) throw notFound('任务不存在');
  const job = await Job.findByPk(jobId);
  if (!job) throw notFound('任务不存在');
  if (!admin && job.user_id !== userId) throw forbidden('无权操作该任务');

  if (job.status === 'pending') {
    const idx = queue.findIndex((q) => q.jobId === jobId);
    if (idx > -1) queue.splice(idx, 1);
    await job.update({ status: 'cancelled', stage: admin ? '已取消（管理员）' : '已取消' });
    return job;
  }

  if (job.status === 'running') {
    // 批量视频任务（串行 / 并发）：逐段在 workFn 内 consume/refund，可立即取消（无需等 10 分钟）。
    // workFn 下一段(或池中待跑段)顶部检测到 cancelled 即停止；当前在跑的那段会自然完成
    // （成功计费 / 失败其 catch 退款），故不在此单独退款，避免与 workFn 重复。
    if (job.type === 'segment_video_batch' || job.type === 'segment_video_batch_concurrent') {
      await job.update({ status: 'cancelled', stage: admin ? '已取消（管理员）' : '已取消' });
      releaseSlot(jobId); // 立即归还机器槽，排队任务马上顶上（workFn 下一段自会检测停止）
      return job;
    }
    // 进程内已无该任务的 workFn（服务重启后蒸发）：它永远不会自己结束，
    // 10 分钟保护毫无意义——立即按取消口径终止并退款，别让僵尸一直占着
    // 同目标去重/并发额度（表现为「该任务正在进行中，请等待完成」）。
    if (!running.has(jobId)) {
      await job.update({ status: 'cancelled', stage: '已取消（服务已重启）' });
      releaseSlot(jobId); // 重启播种的模型并发计数同步释放（若在）
      await resetStuckRefStatus(job); // 复位被该 job 置成 generating 的业务行（workFn 已蒸发，无人复位）
      const refund = await refundJobHold(job.user_id, jobId, job.meta?.feature, admin ? '管理员强制取消退款' : '僵尸任务取消退款');
      await job.update({ meta: { ...(job.meta || {}), cancel_reason: admin ? 'admin_force' : 'orphan', ...(refund ? { refunded_credits: refund } : {}) } });
      return job;
    }
    // 其余真在运行的任务：仅允许超过 10 分钟的超时任务取消（admin 强制取消不受此限），
    // 并退还已预扣积分（运行中的 LLM/ffmpeg 调用无法安全中止，仅丢弃结果并退款）
    const ranMs = Date.now() - new Date(job.updated_at).getTime();
    if (!admin && ranMs < RUNNING_CANCEL_TIMEOUT_MS) {
      throw badRequest('任务运行尚未超过 10 分钟，暂无法取消');
    }
    // 先标记取消（让进行中的 withCredits 结算时跳过自身退款，杜绝重复退款）
    await job.update({ status: 'cancelled', stage: admin ? '已取消（管理员强制）' : '已取消（超时）' });
    releaseSlot(jobId); // 挂死的调用可能永不返回，槽位必须在此刻归还，否则队列永久堵死
    await resetStuckRefStatus(job); // 复位被该 job 置成 generating 的业务行（孤儿 workFn 不再回头复位）
    const refund = await refundJobHold(job.user_id, jobId, job.meta?.feature, admin ? '管理员强制取消退款' : '任务超时取消退款');
    await job.update({ meta: { ...(job.meta || {}), cancel_reason: admin ? 'admin_force' : 'timeout', ...(refund ? { refunded_credits: refund } : {}) } });
    return job;
  }

  throw badRequest('运行中或已结束的任务无法取消');
}

// 历史任务清理的时间档位：before → 天数（白名单档位，不收任意时间参数）；all=0 不限时间
const CLEANUP_RANGES = { all: 0, week: 7, month: 30, year: 365 };

/**
 * 批量删除历史任务（任务中心「删除历史」）：
 * 仅允许删除终态 succeeded/failed 的任务（pending/running/cancelled 一律不删）。
 * 只删任务记录本身——产物文件（分镜视频/成片/剪辑导出等）仍被项目与 episode_videos
 * 引用，不做文件清理；video_generations 留档表独立于 jobs，同样不动。
 * @returns {{ deleted: number }} 实际删除条数
 */
export async function cleanupJobs(userId, { status = 'all', before } = {}) {
  const days = CLEANUP_RANGES[before];
  if (days === undefined) throw badRequest('无效的时间范围');
  const statuses = status === 'all' ? ['succeeded', 'failed', 'cancelled'] : [status];
  if (statuses.some((s) => !['succeeded', 'failed', 'cancelled'].includes(s))) {
    throw badRequest('只能删除已完成、失败或已取消的任务');
  }
  const where = {
    user_id: userId,
    status: { [db.Sequelize.Op.in]: statuses },
  };
  if (days > 0) {
    where.created_at = { [db.Sequelize.Op.lt]: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }
  const deleted = await Job.destroy({ where });
  return { deleted };
}

/**
 * 启动恢复：
 *  - 「批量视频」任务（pending/running，串行 / 并发皆可）：重新入队断点续跑。
 *    workFn 自身按 DB 段状态续跑——已成功段(done+video_url)跳过不重扣、
 *    崩溃段(meta.charged 孤儿)退款后重跑、崩溃时仍在跑的段由 generateVideo 命中已有
 *    厂商 record 续等（不重复提交），故直接重新 submit 即可。
 *  - 「单段厂商任务型」（segment_video / segment_generate / segment_erase_subtitle）且已有
 *    提交过的厂商任务（video_generations record）：**不清理**——厂商任务仍在生成、扫描线程
 *    会继续查询至终态，改挂恢复 workFn 继续等终态并完成原收尾（成功不重扣、失败按预扣退款）。
 *  - 其余类型（LLM/ffmpeg/同步图像等，无厂商任务可续查）：workFn 已随重启蒸发、永不返回，
 *    直接标 failed「服务重启中断」并退还预扣积分。否则僵尸行永远占用同目标去重/并发额度
 *    （表现为「该任务正在进行中，请等待完成」），且只能等 10 分钟后手动取消——
 *    历史上正是「取消后额度不恢复」的根因。
 * @returns {{ batch: number, resumed: number, cleaned: number }} 各类恢复/清理的数量
 */
export async function resumeInterruptedJobs() {
  const BATCH_TYPES = ['segment_video_batch', 'segment_video_batch_concurrent'];
  // 单段厂商任务型 → 恢复 workFn（segmentVideo.service）：继续查询任务状态并完成原收尾
  const RESUME_WORK_FNS = {
    segment_video: segmentVideoResumeWorkFn,
    segment_generate: segmentVideoResumeWorkFn,
    segment_erase_subtitle: segmentEraseResumeWorkFn,
  };
  const stuck = await Job.findAll({
    where: { type: { [db.Sequelize.Op.in]: BATCH_TYPES }, status: { [db.Sequelize.Op.in]: ['pending', 'running'] } },
  });
  for (const j of stuck) {
    const m = j.meta || {};
    const workFn = j.type === 'segment_video_batch_concurrent' ? batchVideoWorkFnConcurrent : batchVideoWorkFn;
    logger.info(`[JOB] 恢复中断的批量视频任务 job=${j.id} type=${j.type} (status=${j.status}, 进度=${m.index || m.done || 0}/${m.total || '?'})`);
    submit(j.id, workFn);
  }

  let resumed = 0;
  let cleaned = 0;
  const zombies = await Job.findAll({
    where: { status: { [db.Sequelize.Op.in]: ['pending', 'running'] }, type: { [db.Sequelize.Op.notIn]: BATCH_TYPES } },
  });
  for (const j of zombies) {
    // 有已提交的厂商任务（record pending=仍在生成 / 已终态=结果未被消费）→ 不清理，
    // 挂恢复 workFn 继续查询任务状态（终态由扫描线程写入，恢复方只等本地库）
    const resumeFn = RESUME_WORK_FNS[j.type];
    if (resumeFn && (await VideoGeneration.findOne({ where: { job_id: j.id }, attributes: ['id'] }))) {
      logger.info(`[JOB] 恢复中断的厂商任务型任务 job=${j.id} type=${j.type}（继续查询任务状态，不清理）`);
      submit(j.id, resumeFn);
      resumed += 1;
      continue;
    }
    await resetStuckRefStatus(j); // 复位被该 job 置成 generating 的业务行（资产卡「生成中」/分镜卡转圈）
    releaseSlot(j.id); // 重启播种的模型并发计数同步释放（无厂商任务可续的任务不再占用名额）
    const refund = await refundJobHold(j.user_id, j.id, j.meta?.feature, '服务重启中断退款');
    await j.update({
      status: 'failed', stage: '已中断（服务重启）', error: '服务重启，任务已中断，请重新发起',
      meta: { ...(j.meta || {}), interrupted_by_restart: true, ...(refund ? { refunded_credits: refund } : {}) },
    });
    logger.warn(`[JOB] 清理重启僵尸任务 job=${j.id} type=${j.type} 退款=${refund || 0}`);
    cleaned += 1;
  }
  return { batch: stuck.length, resumed, cleaned };
}

export async function listJobs(userId, { status, projectId, limit = 50, page, size } = {}) {
  const where = { user_id: userId };
  if (status) {
    // 支持逗号分隔的多状态（如 "进行中" = pending,running）
    const arr = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    where.status = arr.length > 1 ? { [db.Sequelize.Op.in]: arr } : arr[0];
  }
  if (projectId) where.project_id = projectId;

  // 大 JSON 行取数一律两段式（生产 MySQL 已两次 ER_OUT_OF_SORTMEMORY）：该库优化器在有
  // jobs_user_created_idx / 主键序可用时仍会弃索引序改走 filesort（连 ORDER BY id 都不放过），
  // 把含 result/meta 大 JSON 的整行打包进 sort buffer 直接报错。改为：第一步只取 id 列倒序
  // 分页（排序元组仅几字节，任何 sort buffer 都装得下），第二步按 id IN 走 PK 点查拉整行
  // （无排序参与），JS 内恢复倒序——查询计划再差也碰不到 sort buffer 上限。
  const fetchDesc = async (extraWhere, { limit: l, offset = 0 } = {}) => {
    const w = extraWhere ? { ...where, ...extraWhere } : where;
    const idRows = await Job.findAll({ where: w, attributes: ['id'], order: [['id', 'DESC']], limit: l, offset });
    const ids = idRows.map((r) => r.id);
    if (!ids.length) return [];
    const rows = await Job.findAll({ where: { id: { [db.Sequelize.Op.in]: ids } } });
    return rows.sort((a, b) => b.id - a.id);
  };

  // 分页模式（任务中心）：返回 { rows, total, page, size }
  if (page || size) {
    const ps = Math.min(Math.max(Number(size) || 10, 1), 100);
    const p = Math.max(Number(page) || 1, 1);
    const [rows, total] = await Promise.all([
      fetchDesc(null, { limit: ps, offset: (p - 1) * ps }),
      Job.count({ where }),
    ]);
    return { rows, total, page: p, size: ps };
  }

  // 列表模式（轮询活跃任务用）：返回数组。
  // 无筛选时除近期 limit 条外，始终并回该用户全部未终态任务：活跃任务一旦被新增任务挤出
  // limit 窗口，客户端就永远观察不到它的终态跃迁（列表里不再出现），会把「已完成」当
  // 「进行中」永久保留——角标虚高、轮询不停。并回后活跃任务必在回包里，跃迁必可达。
  const cap = Math.min(limit, 200);
  const recent = await fetchDesc(null, { limit: cap });
  if (status || projectId) return recent;
  const actives = await fetchDesc({ status: { [db.Sequelize.Op.in]: ['pending', 'running'] } }, { limit: cap });
  if (!actives.length) return recent;
  const byId = new Map(actives.map((j) => [j.id, j]));
  for (const j of recent) byId.set(j.id, j);
  return [...byId.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, cap);
}

export async function getJob(userId, jobId, { admin = false } = {}) {
  const job = await Job.findByPk(jobId);
  if (!job) throw notFound('任务不存在');
  if (!admin && job.user_id !== userId) throw forbidden('无权查看该任务');
  return job;
}

// ===== admin 任务管理（全员） =====

/**
 * admin 全员任务列表（分页 + 筛选）。
 * keyword 匹配属主用户（username/nickname/external_id 模糊，纯数字再 OR 任务 id/用户 id 精确）；
 * 列表剔除大 JSON 字段 result（详情接口单独取）；按 id 倒序（主键序，免大 JSON 行 filesort）。
 */
export async function adminListJobs({ status, type, userId, keyword, page = 1, size = 20 } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  size = Math.min(100, Math.max(1, parseInt(size, 10) || 20));
  const where = {};
  if (status) {
    const arr = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    if (arr.length) where.status = arr.length > 1 ? { [db.Sequelize.Op.in]: arr } : arr[0];
  }
  if (type) where.type = String(type).trim();
  if (userId) where.user_id = parseInt(userId, 10) || 0;
  const kw = String(keyword || '').trim();
  const userWhere = kw
    ? (/^\d+$/.test(kw)
        ? { [db.Sequelize.Op.or]: [{ id: parseInt(kw, 10) }, { username: { [db.Sequelize.Op.like]: `%${kw}%` } }] }
        : { [db.Sequelize.Op.or]: ['username', 'nickname', 'external_id'].map((f) => ({ [f]: { [db.Sequelize.Op.like]: `%${kw}%` } })) })
    : null;
  const include = [{
    model: User, as: 'user', attributes: ['id', 'username', 'nickname', 'external_id'],
    ...(userWhere ? { where: userWhere, required: true } : {}),
  }];
  // 与 listJobs 同款两段式取数（免大 JSON 行 filesort）：第一阶段仅取 id 列倒序分页，
  // 计数语义不变；第二阶段按 id IN 带属主信息拉整行（仍剔 result 大 JSON，详情接口单独取）。
  const idPage = await Job.findAndCountAll({
    where,
    include,
    attributes: ['id'],
    order: [['id', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
  });
  const ids = idPage.rows.map((j) => j.id);
  const rows = ids.length
    ? (await Job.findAll({
        where: { id: { [db.Sequelize.Op.in]: ids } },
        include,
        attributes: { exclude: ['result'] },
      })).sort((a, b) => b.id - a.id)
    : [];
  return { rows, total: idPage.count, page, size };
}

/** admin 任务详情（含属主信息；result 大 JSON 仅此接口下发） */
export async function adminGetJob(jobId) {
  const job = await Job.findByPk(jobId, {
    include: [{ model: User, as: 'user', attributes: ['id', 'username', 'nickname', 'external_id'] }],
  });
  if (!job) throw notFound('任务不存在');
  return job;
}

/**
 * admin 删除单条任务记录：仅终态（succeeded/failed/cancelled）可删，
 * 只删记录本身——产物文件仍被项目/episode_videos 引用，不做文件清理（同 cleanupJobs 口径）。
 */
export async function adminDeleteJob(jobId) {
  jobId = Number(jobId);
  if (!Number.isFinite(jobId)) throw notFound('任务不存在');
  const job = await Job.findByPk(jobId, { attributes: ['id', 'status'] });
  if (!job) throw notFound('任务不存在');
  if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
    throw badRequest('只能删除已完成、失败或已取消的任务');
  }
  await job.destroy();
  return { id: job.id };
}

/**
 * admin 批量清理终态任务记录（可选用户 id 收窄范围）。
 * 档位与状态白名单同 cleanupJobs：永不满删 pending/running。
 * @returns {{ deleted: number }} 实际删除条数
 */
export async function adminCleanupJobs({ status = 'all', before, userId } = {}) {
  const days = CLEANUP_RANGES[before];
  if (days === undefined) throw badRequest('无效的时间范围');
  const statuses = status === 'all' ? ['succeeded', 'failed', 'cancelled'] : [status];
  if (statuses.some((s) => !['succeeded', 'failed', 'cancelled'].includes(s))) {
    throw badRequest('只能删除已完成、失败或已取消的任务');
  }
  const where = { status: { [db.Sequelize.Op.in]: statuses } };
  if (userId) where.user_id = parseInt(userId, 10) || 0;
  if (days > 0) {
    where.created_at = { [db.Sequelize.Op.lt]: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }
  const deleted = await Job.destroy({ where });
  return { deleted };
}

/**
 * 删除分集/项目时同步清理成片、字幕与剪辑产物文件（含多次合成的历史成片、
 * 字幕版 mp4/srt/ass、剪辑导出 mp4——只删 episode.video_url 会漏掉这些 Job 产物）：
 * 收集这些分集下已完成的合成/字幕/剪辑 Job 产物 URL → 删磁盘文件 → 软隐藏 Job
 * （行保留用于任务中心/积分流水审计）。文件缺失不阻断。
 */
export async function deleteEpisodeArtifacts(episodeIds) {
  const ids = (episodeIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;
  const jobs = await Job.findAll({
    where: {
      episode_id: { [db.Sequelize.Op.in]: ids },
      type: { [db.Sequelize.Op.in]: ['video_synthesis', 'video_subtitle', 'video_edit'] },
      status: 'succeeded',
    },
  });
  for (const j of jobs) {
    const sub = j.type === 'video_subtitle' ? j.result?.subtitle : null;
    const edit = j.type === 'video_edit' ? j.result?.edit : null;
    deleteUrlFiles([sub ? sub.video_url : edit ? edit.video_url : j.result?.episode?.video_url, sub?.srt_url, sub?.ass_url]);
    await j.update({ meta: { ...(j.meta || {}), hidden: true } }).catch(() => {});
  }
  // 成片落档行（与 jobs 表解耦的另一份产物清单）：Job 记录被清理后仍能删净文件、隐藏行避免列表残留
  const films = await db.EpisodeVideo.findAll({ where: { episode_id: { [db.Sequelize.Op.in]: ids } } });
  for (const f of films) {
    const isSub = f.kind === 'subtitle';
    deleteUrlFiles([f.video_url, f.cover_url, isSub ? f.srt_url : null, isSub ? f.ass_url : null]);
    if (!f.hidden) await f.update({ hidden: true }).catch(() => {});
  }
}
