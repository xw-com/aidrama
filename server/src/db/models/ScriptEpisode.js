export default (sequelize, DataTypes) => {
  const ScriptEpisode = sequelize.define('ScriptEpisode', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    script_id: { type: DataTypes.INTEGER, allowNull: false },
    idx: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    title: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    summary: { type: DataTypes.TEXT, allowNull: true },   // 第2步：分集概要
    content: { type: DataTypes.TEXT, allowNull: true },    // 第3步：逐集细化正文
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' }, // pending|done
  }, { tableName: 'script_episodes' });

  return ScriptEpisode;
};
