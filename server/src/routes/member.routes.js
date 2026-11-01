// 团队项目共享：成员管理 + 邀请 + 用户精确查找
import { Router } from "express";
import db from "../db/index.js";
import { asyncHandler, ok, badRequest, notFound, forbidden, ApiError } from "../utils/index.js";
import { rateLimit } from "../utils/rateLimit.js";
import { authRequired } from "../middleware/auth.js";
import { loadOwnerProject } from "../utils/ownership.js";
import { isValidPermissions } from "../utils/access.js";

const router = Router();
const { User, Project, ProjectMember, ProjectInvitation } = db;

// 邀请有效期（毫秒）：7 天，惰性判过期（无定时任务，过期即不可接受，owner 可 revoke 清理）
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// —— 展示名与脱敏（成员/邀请列表只回脱敏联系方式，避免拉通完整账号信息）——
const displayName = (u) => u?.nickname || u?.email || u?.phone || u?.username || "";
const maskEmail = (e) => {
  if (!e || !e.includes("@")) return e || "";
  const [name, domain] = e.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
};
const maskPhone = (p) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p || "");
const publicUser = (u) =>
  u && {
    id: u.id,
    nickname: u.nickname || null,
    display_name: displayName(u),
    email: maskEmail(u.email),
    phone: maskPhone(u.phone),
    avatar: u.avatar || null,
  };

// 用户查找限频：进程内滑动窗口（每 userId 60s 内最多 30 次），超限 429；统一走 rateLimit 工厂
// （key 本就是登录用户 id、非可伪造来源，不做容量淘汰；须挂在 authRequired 之后取 req.user）
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => (req.user?.id != null ? `u:${req.user.id}` : null),
  message: "member.lookup_rate_limited",
});

// 按 email 或 phone 精确等值查用户（不做模糊搜索，避免暴露用户列表）
async function findUserByIdentifier(identifier) {
  const id = String(identifier || "").trim();
  if (!id) return null;
  return User.findOne({
    where: { [db.Sequelize.Op.or]: [{ email: id }, { phone: id }] },
  });
}

// ===== 项目成员（owner 专属）=====

// 成员列表（owner 概要 + 全部成员及权限）
router.get(
  "/projects/:id/members",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnerProject(req.user.id, req.params.id);
    const rows = await ProjectMember.findAll({
      where: { project_id: project.id },
      order: [["created_at", "ASC"]],
    });
    const users = rows.length ? await User.findAll({ where: { id: { [db.Sequelize.Op.in]: rows.map((r) => r.user_id) } } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const owner = await User.findByPk(project.user_id);
    return ok(res, {
      owner: publicUser(owner),
      members: rows.map((r) => ({
        ...publicUser(byId.get(r.user_id)),
        permissions: Array.isArray(r.permissions) ? r.permissions : [],
        joined_at: r.created_at,
      })),
    });
  })
);

// ===== 用户查找（邀请用，登录即可用）=====

// 邮箱/手机号精确查找：返回脱敏档案；限频防爬库
router.get(
  "/users/lookup",
  authRequired,
  lookupLimiter,
  asyncHandler(async (req, res) => {
    const user = await findUserByIdentifier(req.query.identifier);
    if (!user) throw notFound("member.user_not_found");
    return ok(res, publicUser(user));
  })
);

// ===== 邀请（发起：owner；接受/拒绝：被邀请人）=====

// 发出邀请：body { identifier, permissions? }（permissions 默认 [] 只读，可入团后再调整）
router.post(
  "/projects/:id/members/invitations",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnerProject(req.user.id, req.params.id);
    const permissions = req.body?.permissions === undefined ? [] : req.body.permissions;
    if (!isValidPermissions(permissions)) throw badRequest("member.perm_invalid");

    const invitee = await findUserByIdentifier(req.body?.identifier);
    if (!invitee) throw notFound("member.user_not_found");
    if (invitee.id === project.user_id) throw badRequest("member.cannot_invite_self");

    const isMember = await ProjectMember.findOne({
      where: { project_id: project.id, user_id: invitee.id },
      attributes: ["id"],
    });
    if (isMember) throw badRequest("member.already_member");

    // 同项目同人已有待处理邀请：未过期 → 拒绝重复；已过期 → 置 revoked 后允许重发
    const pending = await ProjectInvitation.findOne({
      where: { project_id: project.id, invitee_id: invitee.id, status: "pending" },
      order: [["id", "DESC"]],
    });
    if (pending) {
      if (new Date(pending.expires_at).getTime() > Date.now()) throw badRequest("member.invite_duplicate");
      await pending.update({ status: "revoked" });
    }

    const invitation = await ProjectInvitation.create({
      project_id: project.id,
      inviter_id: req.user.id,
      invitee_id: invitee.id,
      permissions,
      status: "pending",
      expires_at: new Date(Date.now() + INVITE_TTL_MS),
    });
    return ok(res, { id: invitation.id, invitee: publicUser(invitee) }, "member.invited");
  })
);

// 待处理邀请列表（owner 视角，可撤销）
router.get(
  "/projects/:id/members/invitations",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnerProject(req.user.id, req.params.id);
    const rows = await ProjectInvitation.findAll({
      where: { project_id: project.id, status: "pending" },
      order: [["created_at", "DESC"]],
    });
    const users = rows.length ? await User.findAll({ where: { id: { [db.Sequelize.Op.in]: rows.map((r) => r.invitee_id) } } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return ok(
      res,
      rows.map((r) => ({
        id: r.id,
        invitee: publicUser(byId.get(r.invitee_id)),
        permissions: Array.isArray(r.permissions) ? r.permissions : [],
        expires_at: r.expires_at,
        created_at: r.created_at,
        expired: new Date(r.expires_at).getTime() <= Date.now(),
      }))
    );
  })
);

// 我的待处理邀请（受邀者视角 = 前端邀请中心轮询端点；过期的不返回）
router.get(
  "/invitations",
  authRequired,
  asyncHandler(async (req, res) => {
    const rows = await ProjectInvitation.findAll({
      where: { invitee_id: req.user.id, status: "pending", expires_at: { [db.Sequelize.Op.gt]: new Date() } },
      order: [["created_at", "DESC"]],
    });
    if (!rows.length) return ok(res, []);
    const [projects, users] = await Promise.all([
      Project.findAll({
        where: { id: { [db.Sequelize.Op.in]: rows.map((r) => r.project_id) } },
        attributes: { exclude: ["raw_script"] },
      }),
      User.findAll({ where: { id: { [db.Sequelize.Op.in]: [...new Set(rows.map((r) => r.inviter_id))] } } }),
    ]);
    const projById = new Map(projects.map((p) => [p.id, p]));
    const userById = new Map(users.map((u) => [u.id, u]));
    return ok(
      res,
      rows.map((r) => {
        const p = projById.get(r.project_id);
        return {
          id: r.id,
          project_id: r.project_id,
          project_name: p?.name || "",
          project_cover: p?.cover || null,
          inviter_name: displayName(userById.get(r.inviter_id)),
          permissions: Array.isArray(r.permissions) ? r.permissions : [],
          expires_at: r.expires_at,
          created_at: r.created_at,
        };
      })
    );
  })
);

// 条件接受：仅待处理且未过期可接受；并发双接受靠「条件 UPDATE 抢占 + 成员表唯一索引」双保险
router.post(
  "/invitations/:id/accept",
  authRequired,
  asyncHandler(async (req, res) => {
    const invitation = await ProjectInvitation.findByPk(req.params.id);
    if (!invitation) throw notFound("common.not_found");
    if (invitation.invitee_id !== req.user.id) throw forbidden("common.forbidden");
    if (invitation.status !== "pending") throw new ApiError(409, "member.invite_handled");
    if (new Date(invitation.expires_at).getTime() <= Date.now()) throw badRequest("member.invite_expired");

    const [affected] = await ProjectInvitation.update(
      { status: "accepted" },
      { where: { id: invitation.id, invitee_id: req.user.id, status: "pending" } }
    );
    if (!affected) throw new ApiError(409, "member.invite_handled");

    try {
      await ProjectMember.create({
        project_id: invitation.project_id,
        user_id: req.user.id,
        permissions: Array.isArray(invitation.permissions) ? invitation.permissions : [],
      });
    } catch (e) {
      // 已是成员（并发/历史数据）：唯一索引兜底，幂等视为成功
      if (e?.name !== "SequelizeUniqueConstraintError") throw e;
    }
    return ok(res, { project_id: invitation.project_id }, "member.accepted");
  })
);

// 拒绝邀请
router.post(
  "/invitations/:id/reject",
  authRequired,
  asyncHandler(async (req, res) => {
    const [affected] = await ProjectInvitation.update(
      { status: "rejected" },
      { where: { id: req.params.id, invitee_id: req.user.id, status: "pending" } }
    );
    if (!affected) throw new ApiError(409, "member.invite_handled");
    return ok(res, null, "member.rejected");
  })
);

// 撤销邀请（发起人或项目 owner）
router.post(
  "/invitations/:id/revoke",
  authRequired,
  asyncHandler(async (req, res) => {
    const invitation = await ProjectInvitation.findByPk(req.params.id);
    if (!invitation) throw notFound("common.not_found");
    const project = await Project.findByPk(invitation.project_id, { attributes: ["id", "user_id"] });
    const isOwner = project && project.user_id === req.user.id;
    if (invitation.inviter_id !== req.user.id && !isOwner) throw forbidden("common.forbidden");
    const [affected] = await ProjectInvitation.update({ status: "revoked" }, { where: { id: invitation.id, status: "pending" } });
    if (!affected) throw badRequest("member.invite_revoked");
    return ok(res, null, "member.revoked");
  })
);

// ===== 成员权限管理（owner 专属）=====

// 调整成员权限（可回 [] 只读）
router.put(
  "/projects/:id/members/:uid",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnerProject(req.user.id, req.params.id);
    const uid = Number(req.params.uid);
    if (!Number.isFinite(uid) || uid === project.user_id) throw badRequest("member.cannot_remove_owner");
    if (!isValidPermissions(req.body?.permissions)) throw badRequest("member.perm_invalid");
    const membership = await ProjectMember.findOne({ where: { project_id: project.id, user_id: uid } });
    if (!membership) throw notFound("member.not_in_project");
    await membership.update({ permissions: req.body.permissions });
    return ok(res, { user_id: uid, permissions: req.body.permissions }, "member.permissions_updated");
  })
);

// 移除成员：只删成员关系行；其历史 Job/产物文件不动（Job 永挂操作者本人）
router.delete(
  "/projects/:id/members/:uid",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await loadOwnerProject(req.user.id, req.params.id);
    const uid = Number(req.params.uid);
    if (!Number.isFinite(uid) || uid === project.user_id) throw badRequest("member.cannot_remove_owner");
    const membership = await ProjectMember.findOne({ where: { project_id: project.id, user_id: uid } });
    if (!membership) throw notFound("member.not_in_project");
    await membership.destroy();
    return ok(res, null, "member.removed");
  })
);

// 成员自助退出（owner 不可退出自己的项目）
router.post(
  "/projects/:id/leave",
  authRequired,
  asyncHandler(async (req, res) => {
    const project = await Project.findByPk(req.params.id);
    if (!project) throw notFound("项目不存在");
    if (project.user_id === req.user.id) throw badRequest("member.owner_cannot_leave");
    const membership = await ProjectMember.findOne({ where: { project_id: project.id, user_id: req.user.id } });
    if (!membership) throw notFound("member.not_in_project");
    await membership.destroy();
    return ok(res, null, "member.left");
  })
);

export default router;
