export default (sequelize, DataTypes) => {
  const Script = sequelize.define('Script', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '未命名剧本' },
    content: { type: DataTypes.TEXT('medium'), allowNull: true, defaultValue: '' },
    // —— 剧本工作台（4 步向导）——
    outline: { type: DataTypes.TEXT('medium'), allowNull: true },                          // 第1步产出的大纲
    stage: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'chat' }, // chat|outline|episodes|detail|done
    narrative_type: { type: DataTypes.STRING(64), allowNull: true },             // 题材（运行时加载 story_skills md 作风味）
    chat: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },           // 对话历史 [{role,content}]
  }, { tableName: 'scripts' });

  return Script;
};
