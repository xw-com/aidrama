export default (sequelize, DataTypes) => {
  const TaskOrder = sequelize.define('TaskOrder', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 发布方（需求提出人，发布时托管总价保证金）
    publisher_id: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(100), allowNull: false, validate: { len: [1, 100] } },
    // 需求描述（剧本梗概/风格/交付要求等）
    requirement: { type: DataTypes.TEXT, allowNull: false },
    // 期望成片时长（秒）——计价基数
    duration_seconds: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 7200 } },
    // 每秒价格（积分/秒）——发布方自报价
    price_per_second: { type: DataTypes.DOUBLE, allowNull: false, validate: { min: 0.1, max: 100000 } }, // 一位小数精度
    // 总价 = duration_seconds × price_per_second（服务端计算，发布时一次性托管）
    total_price: { type: DataTypes.DOUBLE, allowNull: false, validate: { min: 0.1 } }, // 一位小数精度
    // 交付分辨率：720p | 1080p | 4k
    resolution: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '1080p' },
    // 画幅（可选）：16:9 | 9:16 | 1:1，与项目画幅取值一致
    aspect_ratio: { type: DataTypes.STRING(16), allowNull: true },
    // open 待接单 → working 开发中 → delivered 待验收 ⇄(驳回) working
    // → completed 已完成（验收/仲裁放款）；disputed 仲裁中；cancelled 已取消（退款）
    status: {
      type: DataTypes.ENUM('open', 'working', 'delivered', 'disputed', 'completed', 'cancelled'),
      allowNull: false, defaultValue: 'open',
    },
    // 接单方（未接单为 null；放弃接单回 open 时清空）
    worker_id: { type: DataTypes.INTEGER, allowNull: true },
    delivered_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    // 扩展位：仲裁结论（{ arbitrated: 'release'|'refund', note }）等
    meta: { type: DataTypes.JSON, allowNull: true },
  }, { tableName: 'task_orders' });

  return TaskOrder;
};
