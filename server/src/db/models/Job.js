export default (sequelize, DataTypes) => {
  const Job = sequelize.define('Job', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    project_id: { type: DataTypes.INTEGER, allowNull: true },
    episode_id: { type: DataTypes.INTEGER, allowNull: true },
    // 通用目标实体 id：asset_id / segment_id 等，配合 type 一起用于去重与定位
    ref_id: { type: DataTypes.INTEGER, allowNull: true },
    type: { type: DataTypes.STRING(48), allowNull: false },
    status: {
      type: DataTypes.ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled'),
      allowNull: false, defaultValue: 'pending',
    },
    progress: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    stage: { type: DataTypes.STRING(160), allowNull: true },
    result: { type: DataTypes.JSON, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    credits_used: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 }, // 一位小数精度
    // 展示用元信息：{ label, feature, projectName, episodeTitle, targetName, estimate }
    // targetName = 任务具体事项目（资产名/片段标题/集标题等），前端拼进任务名用于区分同类任务
    meta: { type: DataTypes.JSON, allowNull: true },
  }, {
    tableName: 'jobs',
    indexes: [
      // 不声明单列 user_id 索引：jobs_user_created_idx 最左前缀已覆盖；保留它会与 jobs_status
      // 凑成 index_merge intersect（生产 ER_OUT_OF_SORTMEMORY 根因），旧库副本由启动迁移删除
      { fields: ['project_id'] },
      { fields: ['status'] },
      // 任务清理（按 user_id + created_at 范围筛删）走此复合索引；任务列表排序已改主键倒序
      // （job.service listJobs，免 filesort——大 JSON 行打包进 sort buffer 曾触发 ER_OUT_OF_SORTMEMORY）
      { name: 'jobs_user_created_idx', fields: ['user_id', 'created_at'] },
    ],
  });

  return Job;
};
