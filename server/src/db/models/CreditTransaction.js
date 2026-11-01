export default (sequelize, DataTypes) => {
  const CreditTransaction = sequelize.define('CreditTransaction', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // recharge | consume | refund | settle | adjust（settle=接单中心验收结算给接单方；adjust=管理员人工调整）
    type: { type: DataTypes.ENUM('recharge', 'consume', 'refund', 'settle', 'adjust'), allowNull: false },
    // 积分一位小数精度（DOUBLE）；写入前须 utils/credits.js roundCredits 归一
    amount: { type: DataTypes.DOUBLE, allowNull: false }, // 正数=增加，负数=扣减
    balance_after: { type: DataTypes.DOUBLE, allowNull: false },
    feature: { type: DataTypes.STRING(64), allowNull: true }, // pricing.feature
    ref_id: { type: DataTypes.STRING(64), allowNull: true }, // 关联业务 id
    remark: { type: DataTypes.STRING(255), allowNull: true },
  }, { tableName: 'credit_transactions' });

  return CreditTransaction;
};
