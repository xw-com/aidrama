export default (sequelize, DataTypes) => {
  const OrderEvent = sequelize.define('OrderEvent', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    order_id: { type: DataTypes.INTEGER, allowNull: false },
    // 操作发起人（与 TaskOrder.publisher_id / worker_id 对应；保留 null 以备系统事件）
    actor_id: { type: DataTypes.INTEGER, allowNull: true },
    // publish | take | deliver | reject | accept | dispute | arbitrate | cancel | quit
    type: { type: DataTypes.STRING(16), allowNull: false },
    // 文字内容：驳回意见 / 争议原因 / 仲裁备注 / 放弃原因等
    content: { type: DataTypes.TEXT, allowNull: true },
    // 结构化内容：交付事件存成片快照
    // { video_url, duration, project_id, project_name, episode_id, episode_idx, episode_title }
    payload: { type: DataTypes.JSON, allowNull: true },
  }, { tableName: 'order_events' });

  return OrderEvent;
};
