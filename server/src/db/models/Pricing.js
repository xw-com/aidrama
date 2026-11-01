export default (sequelize, DataTypes) => {
  const Pricing = sequelize.define('Pricing', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    feature: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    // 计费维度描述，如 "每100字符"、"每秒"、"每张"
    unit_desc: { type: DataTypes.STRING(64), allowNull: false },
    // 每单位消耗的积分
    credits_per_unit: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 1 }, // 一位小数精度
    // 单位大小，便于估算（字符数/秒数/张数）。如 storyboard_script: unit=100 表示每100字
    unit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    // 关联的模型类型
    model_type: { type: DataTypes.STRING(16), allowNull: true }, // text/image/video/tts
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'pricings' });

  return Pricing;
};
