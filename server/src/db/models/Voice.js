export default (sequelize, DataTypes) => {
  const Voice = sequelize.define('Voice', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    // 男 / 女 / 中性
    gender: { type: DataTypes.STRING(16), allowNull: true },
    // 声音样本音频（落 data/uploads/，经 /files 静态服务）
    audio_url: { type: DataTypes.STRING(512), allowNull: true },
    // —— 供应商音色库目录字段（data/voice.json 导入的 preset 音色专用）——
    // 使用场景：影视解说 / 搞笑视频 / 角色扮演 / 多情感 / 方言口音 / 通用场景 / 视频配音 / 社交陪伴 / 多语言
    scene: { type: DataTypes.STRING(32), allowNull: true },
    // 年龄段编码：1儿童 2少年 3青年 4中年 5老年
    age_range: { type: DataTypes.INTEGER, allowNull: true },
    age_range_text: { type: DataTypes.STRING(16), allowNull: true },
    // 性别编码：1男 2女
    gender_code: { type: DataTypes.INTEGER, allowNull: true },
    // 情感类型：0单情感 1多情感
    emotion_type: { type: DataTypes.INTEGER, allowNull: true },
    // 支持的情感列表（多情感音色）：开心/悲伤/生气/惊讶/恐惧/厌恶/激动/冷漠/中性/沮丧
    emotion_list: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
  }, { tableName: 'voices' });

  return Voice;
};
