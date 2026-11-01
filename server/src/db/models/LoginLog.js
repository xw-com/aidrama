export default (sequelize, DataTypes) => {
  const LoginLog = sequelize.define('LoginLog', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // 登录方式（password / apple / google / profile_sync / admin_password…；STRING 免枚举迁移，后续登录方式可直接追加）
    method: { type: DataTypes.STRING(32), allowNull: false },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
  }, { tableName: 'login_logs' });

  return LoginLog;
};
