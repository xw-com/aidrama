export default (sequelize, DataTypes) => {
  const ArtStyle = sequelize.define('ArtStyle', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 风格 key：即 skills/art_skills/<key>/ 目录名，建后不可改（改名盘目录会断引用）
    key: { type: DataTypes.STRING(128), allowNull: false },
    // 风格中文名（选择器展示）
    name: { type: DataTypes.STRING(128), allowNull: false },
    // 大类：realistic | anime（realpeople_* → realistic，2D/3D → anime）
    category: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'anime' },
    // 缩略图相对路径（相对 skills 根）：art_skills/<key>/images/preview.webp
    thumbnail: { type: DataTypes.STRING(255), allowNull: true },
    // 展示顺序（升序）
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 是否在选择器展示
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // 图片版本号：生成/替换图片后 +1，用于 URL 缓存破坏
    image_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  }, { tableName: 'art_styles' });

  return ArtStyle;
};
