export default (sequelize, DataTypes) => {
  const AppConfig = sequelize.define('AppConfig', {
    // 配置键（如 referral:reward_credits）；字符串值由使用方按需 parse
    key: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    // 最后修改人（admin 审计）
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'app_configs' });

  return AppConfig;
};
