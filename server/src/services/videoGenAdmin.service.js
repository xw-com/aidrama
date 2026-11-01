// admin 视频生成留档（video_generations）查询：全员列表/详情，只读不写。
// 大 JSON（params/submit_response/result）列表不下发，详情接口单独取（同 adminListJobs 口径）。
import db from '../db/index.js';
import { notFound } from '../utils/response.js';

const { VideoGeneration, User, ModelConfig, Project, Episode, Job, StoryboardSegment } = db;

// 列表回显的属主/关联字段（与 adminListJobs 的 user attributes 一致）
const USER_ATTRS = ['id', 'username', 'nickname', 'external_id'];
// 模型配置只回显名称与归属（user_id=NULL=共享模型，非空=该用户自带 Key 的私有模型），不回显密钥
const MODEL_CONFIG_ATTRS = ['id', 'name', 'user_id', 'provider', 'model'];
const PROJECT_ATTRS = ['id', 'name'];
const EPISODE_ATTRS = ['id', 'title', 'idx'];
const SEGMENT_ATTRS = ['id', 'idx', 'title', 'shot_no'];
const JOB_ATTRS = ['id', 'type', 'status'];

// 大 JSON 列表剔除；详情接口才下发
const LIST_EXCLUDE = ['params', 'submit_response', 'result'];

function listIncludes(extraWhere) {
  return [
    { model: User, as: 'user', attributes: USER_ATTRS, ...(extraWhere?.user || {}) },
    { model: ModelConfig, as: 'modelConfig', attributes: MODEL_CONFIG_ATTRS },
    { model: Project, as: 'project', attributes: PROJECT_ATTRS },
    { model: Episode, as: 'episode', attributes: EPISODE_ATTRS },
    { model: StoryboardSegment, as: 'segment', attributes: SEGMENT_ATTRS },
  ];
}

/**
 * admin 全员视频生成留档列表（分页 + 筛选）。
 * keyword 匹配属主用户（username/nickname/external_id 模糊，纯数字再 OR 留档 id/用户 id 精确）；
 * 按 id 倒序（主键序，免大 JSON 行 filesort，同 adminListJobs 口径）。
 */
export async function adminListVideoGenerations({
  status, vendor, feature, userId, keyword, page = 1, size = 20,
} = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  size = Math.min(100, Math.max(1, parseInt(size, 10) || 20));
  const where = {};
  if (status) where.status = String(status).trim();
  if (vendor) where.vendor = String(vendor).trim();
  if (feature) where.feature = String(feature).trim();
  if (userId) where.user_id = parseInt(userId, 10) || 0;
  const kw = String(keyword || '').trim();
  const userWhere = kw
    ? (/^\d+$/.test(kw)
        ? { [db.Sequelize.Op.or]: [{ id: parseInt(kw, 10) }, { username: { [db.Sequelize.Op.like]: `%${kw}%` } }] }
        : { [db.Sequelize.Op.or]: ['username', 'nickname', 'external_id'].map((f) => ({ [f]: { [db.Sequelize.Op.like]: `%${kw}%` } })) })
    : null;
  const { rows, count } = await VideoGeneration.findAndCountAll({
    where,
    include: listIncludes({ user: userWhere ? { where: userWhere, required: true } : {} }),
    attributes: { exclude: LIST_EXCLUDE },
    order: [['id', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
  });
  return { rows, total: count, page, size };
}

/** admin 视频生成留档详情：全字段（含大 JSON）+ 关联对象（模型配置/项目/分集/分镜/任务） */
export async function adminGetVideoGeneration(id) {
  const record = await VideoGeneration.findByPk(parseInt(id, 10), {
    include: [
      ...listIncludes(),
      { model: Job, as: 'job', attributes: JOB_ATTRS },
    ],
  });
  if (!record) throw notFound('留档不存在');
  return record;
}
