export default (sequelize, DataTypes) => {
  const StoryboardSegment = sequelize.define('StoryboardSegment', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    episode_id: { type: DataTypes.INTEGER, allowNull: false },
    idx: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    title: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    // —— 分镜表扩展字段（对齐 分镜表.xlsx 结构）——
    scene_no: { type: DataTypes.INTEGER, allowNull: true },        // 镜头号（场景分组）
    shot_no: { type: DataTypes.STRING(16), allowNull: true },      // 分镜号，如 "1-1"
    scene_script: { type: DataTypes.TEXT('medium'), allowNull: true },       // 镜头剧本（场景级，首镜承载）
    video_prompt: { type: DataTypes.TEXT('medium'), allowNull: true },       // 镜头视频提示词
    // 引用的资产 id 列表 [{type,id,name}]
    asset_refs: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    // 语音配置 {gender:'male', timbre:'年轻', tone:'温和', ...}
    voice_config: { type: DataTypes.JSON, allowNull: true },
    keyframe_url: { type: DataTypes.STRING(512), allowNull: true },
    // 尾帧（视频生成后抽取最后一帧保存，备用：如作为下一镜图生视频的首帧延续参考）
    last_frame_url: { type: DataTypes.STRING(512), allowNull: true },
    // 尾帧来源：'seedance' = Seedance return_last_frame 原样返回的原图（原样保存、不得修改）；
    //           'ffmpeg' = 本地 ffmpeg 抽帧兜底；null = 无尾帧。
    // 下一镜跨镜延续：任一来源的尾帧均可作起始帧参考图（provider 间语义一致）
    last_frame_source: { type: DataTypes.STRING(16), allowNull: true },
    audio_url: { type: DataTypes.STRING(512), allowNull: true },
    video_url: { type: DataTypes.STRING(512), allowNull: true },
    // 本镜头到下一镜头的转场特效（仅手动设置生效）：null/'auto'（历史值，硬切）/ 'cut'（硬切）/ xfade 名称（fade/fadeblack/fadewhite/dissolve/...）
    transition: { type: DataTypes.STRING(32), allowNull: true },
    duration: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 }, // 秒
    status: {
      type: DataTypes.ENUM('pending', 'queued', 'generating', 'done', 'failed'),
      allowNull: false, defaultValue: 'pending',
    },
    selected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // 审阅标记：reviewed_at 非空即「已审」（审阅人 reviewer_id）；换视频（生成/上传/剪辑写回/擦字幕）时重置
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    reviewer_id: { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'storyboard_segments' });

  return StoryboardSegment;
};
