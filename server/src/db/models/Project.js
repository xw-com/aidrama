export default (sequelize, DataTypes) => {
  const Project = sequelize.define('Project', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false, validate: { len: [1, 128] } },
    cover: { type: DataTypes.STRING(255), allowNull: true },
    cover_thumb: { type: DataTypes.STRING(512), allowNull: true }, // 项目卡/展示中心卡片用 webp 缩略图
    producer: { type: DataTypes.STRING(128), allowNull: true },
    copyright: { type: DataTypes.STRING(255), allowNull: true },
    style: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '古偶唯美柔光' },
    narrative_type: { type: DataTypes.STRING(64), allowNull: true },
    aspect_ratio: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '9:16' },
    raw_script: { type: DataTypes.TEXT('long'), allowNull: true }, // 全量剧本文本，升 LONGTEXT(4GB)：20MB GBK 文本入库膨胀后 MEDIUMTEXT(16MB) 仍可能不够
    status: {
      type: DataTypes.ENUM('outline', 'assets', 'video', 'done'),
      allowNull: false, defaultValue: 'outline',
    },
    // 一键分享令牌：点分享时生成，公开播放页 /share/:token 按此查询（未生成即未对外分享）
    // 注意：不要在模型里声明唯一索引——sync() 对已存在的表会先于 ensureColumns 建索引导致启动失败；
    // 唯一索引用启动时的 ensureIndex(..., { unique: true }) 在补列之后创建
    share_token: { type: DataTypes.STRING(32), allowNull: true },
    // 令牌签发时间：分享链接 24 小时有效（Project.SHARE_TTL_MS），过期后一键分享会换发新令牌
    share_issued_at: { type: DataTypes.DATE, allowNull: true },
    // 项目级全局设置（JSON）：当前含 subtitle（字幕烧录样式）。
    // subtitle: { font?: string, fontSize?: number, marginV?: number }——数值为短边 1080 基准像素，
    // 烧录时按 min(宽,高)/1080 等比缩放；未设置的字段回退 subtitle.service.js 的公式默认。
    settings: { type: DataTypes.JSON, allowNull: true },
  }, { tableName: 'projects' });

  // 一键分享链接有效期（毫秒）：签发起 24 小时，过期后公开播放页拒绝访问、再次分享换发新令牌。
  // 挂在模型上供签发（project.routes）与校验（public.routes）两处共用，避免常量漂移。
  Project.SHARE_TTL_MS = 24 * 60 * 60 * 1000;

  return Project;
};
