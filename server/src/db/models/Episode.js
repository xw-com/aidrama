export default (sequelize, DataTypes) => {
  const Episode = sequelize.define('Episode', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    project_id: { type: DataTypes.INTEGER, allowNull: false },
    idx: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    title: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    content: { type: DataTypes.TEXT('medium'), allowNull: true },
    summary: { type: DataTypes.TEXT('medium'), allowNull: true },
    director_requirements: { type: DataTypes.TEXT('medium'), allowNull: true }, // 导演要求（分镜提示词生成的上下文约束）
    video_url: { type: DataTypes.STRING(512), allowNull: true },
    duration: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // 总时长(秒)
    status: {
      type: DataTypes.ENUM('draft', 'outline', 'assets', 'storyboard', 'video', 'done'),
      allowNull: false, defaultValue: 'draft',
    },
  }, { tableName: 'episodes' });

  return Episode;
};
