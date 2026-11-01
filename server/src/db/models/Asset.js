export default (sequelize, DataTypes) => {
  const Asset = sequelize.define('Asset', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    project_id: { type: DataTypes.INTEGER, allowNull: false },
    episode_id: { type: DataTypes.INTEGER, allowNull: true },
    kind: {
      type: DataTypes.ENUM('character', 'scene', 'prop', 'material', 'video'),
      allowNull: false,
    },
    name: { type: DataTypes.STRING(128), allowNull: false },
    aliases: { type: DataTypes.JSON, allowNull: true }, // 别名列表（字符串数组）；用于 AI 匹配/去重与视频参考图映射
    description: { type: DataTypes.TEXT, allowNull: true },
    prompt: { type: DataTypes.TEXT, allowNull: true }, // 用于生图的提示词
    image_url: { type: DataTypes.STRING(512), allowNull: true },
    thumb_url: { type: DataTypes.STRING(512), allowNull: true }, // 卡片列表用 webp 缩略图（列表优选，缺失回退 image_url）
    role_tag: { type: DataTypes.STRING(32), allowNull: true }, // 主角/配角/...
    doubao_asset_id: { type: DataTypes.STRING(128), allowNull: true }, // 豆包数字资产 ID（视频生成角色一致性）
    meta: { type: DataTypes.JSON, allowNull: true },
    status: {
      type: DataTypes.ENUM('queued', 'generating', 'done', 'failed'),
      allowNull: false, defaultValue: 'queued',
    },
  }, { tableName: 'assets' });

  return Asset;
};
