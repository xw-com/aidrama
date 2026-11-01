export default (sequelize, DataTypes) => {
  const AssetImage = sequelize.define('AssetImage', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    asset_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },   // 服饰名称（如：战甲 / 便装）
    image_url: { type: DataTypes.STRING(512), allowNull: true },                 // 该套服饰的图片
    thumb_url: { type: DataTypes.STRING(512), allowNull: true },                 // 卡片列表用 webp 缩略图
    doubao_asset_id: { type: DataTypes.STRING(128), allowNull: true },           // 豆包数字资产 ID（跨镜角色一致性）
    prompt: { type: DataTypes.TEXT, allowNull: true },                           // 该套服饰的生图提示词
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // 是否默认服饰（默认服饰会镜像到 Asset.image_url）
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    meta: { type: DataTypes.JSON, allowNull: true },
  }, { tableName: 'asset_images' });

  return AssetImage;
};
