export default (sequelize, DataTypes) => {
  const UserOauth = sequelize.define('UserOauth', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // 提供商标识：google/facebook/github/twitter/microsoft/linkedin/amazon/apple/wechat...
    provider: { type: DataTypes.STRING(32), allowNull: false },
    // 该 provider 侧的用户唯一 ID（OIDC sub / github id / twitter id / apple sub ...）
    provider_user_id: { type: DataTypes.STRING(128), allowNull: false },
    // 第三方账号名（如 github login、twitter username），便于展示
    provider_account_name: { type: DataTypes.STRING(128), allowNull: true },
  }, {
    tableName: 'user_oauth',
    indexes: [
      { unique: true, fields: ['provider', 'provider_user_id'] },
      { fields: ['user_id'] },
    ],
  });

  return UserOauth;
};
