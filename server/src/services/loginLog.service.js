// 登录日志：记录每次登录事件（密码/第三方/管理台等），admin 用户管理页查询。
// 刻意不在 resolveUserByToken（每请求）写 —— 只记"登录动作"，token 解析不是登录。
import db from '../db/index.js';
import { Op } from 'sequelize';

const { LoginLog, User } = db;

/** 记录一条登录日志（调用方 fire-and-forget：recordLoginLog(...).catch(logger.warn)） */
export function recordLoginLog({ userId, method, ip, userAgent }) {
  return LoginLog.create({
    user_id: userId,
    method,
    ip: ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
  });
}

/** admin 分页查询：user_id / method / 起止日期过滤，附用户基本信息 */
export async function listLoginLogs({ page = 1, size = 20, user_id, method, start, end } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  size = Math.min(100, Math.max(1, parseInt(size, 10) || 20));
  const where = {};
  if (user_id) where.user_id = parseInt(user_id, 10) || 0;
  if (method) where.method = method;
  if (start || end) {
    where.created_at = {};
    if (start) where.created_at[Op.gte] = new Date(`${start}T00:00:00`);
    if (end) where.created_at[Op.lte] = new Date(`${end}T23:59:59.999`);
  }
  const { rows, count } = await LoginLog.findAndCountAll({
    where,
    include: [{ model: User, as: 'user', attributes: ['id', 'username', 'nickname'] }],
    order: [['id', 'DESC']],
    offset: (page - 1) * size,
    limit: size,
  });
  return { list: rows, total: count, page, size };
}
