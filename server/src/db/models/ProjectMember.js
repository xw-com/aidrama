export default (sequelize, DataTypes) => {
  const ProjectMember = sequelize.define('ProjectMember', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    project_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // 成员权限（JSON 数组，元素 ∈ PERM_KEYS 六组权限）：空数组 = 只读；owner 隐式全有不存库
    permissions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
  }, {
    tableName: 'project_members',
    indexes: [
      { fields: ['user_id'] },
    ],
    // (project_id, user_id) 唯一索引不写在模型里（sync 对旧表建索引的时序坑），由启动时 ensureIndex 创建
  });

  return ProjectMember;
};
