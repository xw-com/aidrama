export default (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 外部身份标识：本地注册 local:<username>、第三方登录 <provider>:<sub>（令牌内 sub 据此关联本地账号）
    external_id: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    username: { type: DataTypes.STRING(64), allowNull: false, unique: true, validate: { len: [2, 64] } },
    email: { type: DataTypes.STRING(128), allowNull: true, unique: true, validate: { isEmail: true } },
    phone: { type: DataTypes.STRING(32), allowNull: true },
    nickname: { type: DataTypes.STRING(128), allowNull: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: true },
    credits: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0, validate: { min: 0 } }, // 一位小数精度
    role: { type: DataTypes.ENUM('user', 'admin'), allowNull: false, defaultValue: 'user' },
    avatar: { type: DataTypes.STRING(255), allowNull: true },
    // 账号状态：active 正常 / banned 已封禁（authRequired 每请求检查，封禁对已发 JWT 立即生效）
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'banned']] } },
    // 邀请有礼：专属邀请码（懒生成；唯一索引 users_referral_code_uidx 由 ensureIndex 补建，handler 预检+重试兜底）
    referral_code: { type: DataTypes.STRING(16), allowNull: true },
  }, { tableName: 'users' });

  return User;
};
