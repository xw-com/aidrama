export default (sequelize, DataTypes) => {
  const ModelVendor = sequelize.define('ModelVendor', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(128), allowNull: false }, // 展示名，如「OpenAI」
    code: { type: DataTypes.STRING(64), allowNull: false }, // 唯一键，作为 ModelConfig.provider 的值
    base_url: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    // openai | custom  （决定请求/响应解析方式）
    api_style: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'openai' },
    // 支持的模型类型子集 text|image|video|tts
    supported_types: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    // 模型清单（admin 维护，如 ['gpt-4o','gpt-4o-mini']）：用户私有模型配置页据此下拉选择；
    // OpenAI 兼容厂商还可由用户密钥实时拉取 /models 合并
    models: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    logo_url: { type: DataTypes.STRING(255), allowNull: true },
    website: { type: DataTypes.STRING(255), allowNull: true },
    description: { type: DataTypes.STRING(255), allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'model_vendors' });

  return ModelVendor;
};
