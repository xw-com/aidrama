export default (sequelize, DataTypes) => {
  const ProjectInvitation = sequelize.define('ProjectInvitation', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    project_id: { type: DataTypes.INTEGER, allowNull: false },
    inviter_id: { type: DataTypes.INTEGER, allowNull: false },
    invitee_id: { type: DataTypes.INTEGER, allowNull: false },
    // 邀请时预置的权限快照（接受时落到成员行；默认 [] 只读，入团后再由 owner 调整）
    permissions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    status: {
      type: DataTypes.ENUM('pending', 'accepted', 'rejected', 'revoked'),
      allowNull: false, defaultValue: 'pending',
    },
    // 过期时间（默认创建时写 now+7d）：惰性判定，无定时任务清理；过期即视同不可接受
    expires_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'project_invitations',
    indexes: [
      { fields: ['invitee_id', 'status'] },
      { fields: ['project_id'] },
    ],
  });

  return ProjectInvitation;
};
