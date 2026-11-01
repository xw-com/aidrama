export default (sequelize, DataTypes) => {
  const EpisodeVideo = sequelize.define('EpisodeVideo', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 所属项目（成片列表/选版均按项目查；索引由启动时 ensureIndex 建，勿放模型 indexes）
    project_id: { type: DataTypes.INTEGER, allowNull: false },
    // 所属分集（合成/加字幕/剪辑导出的目标分集；可能为空）
    episode_id: { type: DataTypes.INTEGER, allowNull: true },
    // 操作者（发起合成/加字幕/剪辑导出的用户；删除权限判定用）
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    // 成片类型：compose 合成成片 / subtitle 字幕版（含未烧录的 srt 草稿）/ edit 剪辑导出版
    kind: {
      type: DataTypes.STRING(16), allowNull: false,
      validate: { isIn: [['compose', 'subtitle', 'edit']] },
    },
    // 产物（/files 相对路径）；字幕草稿行 video_url 为空（烧录后回填）
    video_url: { type: DataTypes.STRING(500), allowNull: true },
    // 成片封面（/files 相对路径）：合成/烧录/剪辑导出时抽第一帧出的 480P webp（长宽按项目画幅）；
    // 成片列表缩略图用，旧数据为 null 由缩略图扫描线程补齐，前端无封面回退视频预览
    cover_url: { type: DataTypes.STRING(500), allowNull: true },
    srt_url: { type: DataTypes.STRING(500), allowNull: true },
    ass_url: { type: DataTypes.STRING(500), allowNull: true },
    duration: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    resolution: { type: DataTypes.STRING(16), allowNull: true },
    segments_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 产生该成片的 Job id（compose/edit = 合成/导出 Job；subtitle = 提取 Job；
    // 字幕编辑器等下游流程按它定位任务上下文）
    job_id: { type: DataTypes.INTEGER, allowNull: true },
    // 源成片 Job id（subtitle/edit 行指向上游成片，供前端按源聚合展示；compose 行为 null）
    source_job_id: { type: DataTypes.INTEGER, allowNull: true },
    // —— 字幕草稿状态（kind='subtitle'；此前存于提取 Job 的 result.subtitle，Job 清理后字幕编辑会 404，故落档到行上）——
    // 草稿段落（[{start,end,text}]）：字幕编辑器的真正数据源（保存/校正/烧录都读写这里）
    segments: { type: DataTypes.JSON, allowNull: true },
    // 源成片 URL（重烧/行宽回探按它定位源视频，脱离源 Job）
    source_video_url: { type: DataTypes.STRING(500), allowNull: true },
    // 提取时源视频尺寸（字幕一行可容纳汉字当量的计算依据）
    width: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    height: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 已智能校正标记 + 改动条数（null=旧数据未知，读取时按未校正处理）
    corrected: { type: DataTypes.BOOLEAN, allowNull: true },
    corrected_count: { type: DataTypes.INTEGER, allowNull: true },
    // 软隐藏（删除成片只隐藏记录、删产物文件；行保留供追溯）
    hidden: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // 审阅标记：reviewed_at 非空即「已审」（审阅人 reviewer_id）；每条成片记录独立（新合成/导出的成片从头审）
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    reviewer_id: { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'episode_videos' });

  return EpisodeVideo;
};
