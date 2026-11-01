export default (sequelize, DataTypes) => {
  const RechargeOrder = sequelize.define('RechargeOrder', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    order_no: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    amount_yuan: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    credits: { type: DataTypes.DOUBLE, allowNull: false }, // 一位小数精度
    pay_method: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'alipay' },
    status: {
      type: DataTypes.ENUM('pending', 'paid', 'failed', 'canceled'),
      allowNull: false, defaultValue: 'pending',
    },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    // 第三方支付流水号（如微信支付 transaction_id），便于对账
    transaction_id: { type: DataTypes.STRING(64), allowNull: true },
  }, { tableName: 'recharge_orders' });

  return RechargeOrder;
};
