export default (sequelize, DataTypes) => {
  const EpisodeAsset = sequelize.define('EpisodeAsset', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    episode_id: { type: DataTypes.INTEGER, allowNull: false },
    asset_id: { type: DataTypes.INTEGER, allowNull: false },       // 角色（Asset kind=character）
    costume_id: { type: DataTypes.INTEGER, allowNull: true },      // 指定使用的服饰（AssetImage.id）；null=用默认
  }, {
    tableName: 'episode_assets',
    indexes: [{ unique: true, fields: ['episode_id', 'asset_id'] }], // 每集每角色至多一条覆盖
  });

  return EpisodeAsset;
};
