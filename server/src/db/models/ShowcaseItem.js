export default (sequelize, DataTypes) => {
  const ShowcaseItem = sequelize.define('ShowcaseItem', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 展示的源项目（一项目一条展示记录；唯一索引用启动时 ensureIndex 建，勿放模型 indexes）
    project_id: { type: DataTypes.INTEGER, allowNull: false },
    // 发布者（= 发布时的项目 owner）；下架/改描述仅限此人
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // 展示简介（可选，搜索用）；剧名/封面/画幅实时取自项目
    description: { type: DataTypes.STRING(500), allowNull: true },
    // 发布时勾选的分集 id 快照（数组）；null = 存量记录，视为「全部可播分集」（跟随实时口径）
    episode_ids: { type: DataTypes.JSON, allowNull: true },
    // 审核状态：pending 待审 / approved 通过（公开可见）/ rejected 驳回。
    // 每次发布/修改都回到待审；存量行由启动 backfill 置 approved（已公开内容不受影响）
    status: {
      type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending',
      validate: { isIn: [['pending', 'approved', 'rejected']] },
    },
    // 驳回原因（驳回时必填，发布者可见）
    reject_reason: { type: DataTypes.STRING(255), allowNull: true },
    // 审核时间 / 审核人（admin id）
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    reviewer_id: { type: DataTypes.INTEGER, allowNull: true },
    view_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'showcase_items' });

  return ShowcaseItem;
};
