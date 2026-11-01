export default (sequelize, DataTypes) => {
  const VideoGeneration = sequelize.define('VideoGeneration', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // 追溯冗余：关联 Job 与项目/分集/分镜（均可空——调用方上下文不全时仍可入库）
    job_id: { type: DataTypes.INTEGER, allowNull: true },
    project_id: { type: DataTypes.INTEGER, allowNull: true },
    episode_id: { type: DataTypes.INTEGER, allowNull: true },
    segment_id: { type: DataTypes.INTEGER, allowNull: true },
    // 业务场景（与积分流水 feature 对齐）：segment_generate / segment_video /
    // segment_video_batch / segment_video_batch_concurrent / segment_erase_subtitle
    feature: { type: DataTypes.STRING(48), allowNull: false, defaultValue: 'segment_video' },
    // 厂商归位结果（videoVendorOf）：seedance / dashscope / minimax / comfyui / agnes / aliwan / generic，
    // 决定扫描器用哪套查询契约
    vendor: { type: DataTypes.STRING(32), allowNull: false },
    // ModelConfig.provider 原值（volcengine / dashscope / minimax / autodl-comfyui / agnes / agnes_cn / aliwan / openai / custom…）
    provider: { type: DataTypes.STRING(64), allowNull: false },
    // 模型名（cfg.model；ComfyUI 为工作流 ID）——与 vendor/provider 一起区分不同厂商/模型
    model: { type: DataTypes.STRING(128), allowNull: false },
    // 扫描器按它重取 base_url/api_key（不冗余存密钥）
    model_config_id: { type: DataTypes.INTEGER, allowNull: true },
    // 提交时配置快照（配置被删/改后仍有留档）
    base_url: { type: DataTypes.STRING(255), allowNull: true },
    // 提交时的完整厂商端点（base_url + 各厂商提交路径；admin 留档详情展示，存量行为 NULL）
    submit_url: { type: DataTypes.STRING(512), allowNull: true },
    // pending=已提交待厂商终态；不设超时/取消态——扫描器一直查到 succeeded/failed 为止
    status: {
      type: DataTypes.ENUM('pending', 'succeeded', 'failed'),
      allowNull: false, defaultValue: 'pending',
    },
    // 厂商任务 id（generic 同步直出 URL 时为 NULL）
    task_id: { type: DataTypes.STRING(128), allowNull: true },
    // 提交参数（提交体，经 sanitizeDeep 脱敏——base64 参考图/音/视频可达 50MB）
    params: { type: DataTypes.JSON, allowNull: true },
    // 厂商提交返回（脱敏；提交失败时为错误响应体）
    submit_response: { type: DataTypes.JSON, allowNull: true },
    // 终态结果：{ videoUrl, lastFrameUrl, vendorStatus, message, raw }
    result: { type: DataTypes.JSON, allowNull: true },
    // 终态失败原因（面向用户的文案，含审核提示）
    error: { type: DataTypes.TEXT, allowNull: true },
    // 最近一次查询解析出的厂商原始状态（QUEUED / RUNNING / PENDING…）
    last_state: { type: DataTypes.STRING(64), allowNull: true },
    poll_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 连续查询失败次数（查询成功即清零；安全阀判定依据）
    error_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 最近查询时间（扫描调度依据：到期才查）
    last_polled_at: { type: DataTypes.DATE, allowNull: true },
    finished_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'video_generations',
    indexes: [
      // 扫描器主查询：WHERE status='pending' AND last_polled_at 到期 ORDER BY last_polled_at
      { name: 'video_generations_scan_idx', fields: ['status', 'last_polled_at'] },
      { fields: ['job_id'] },
      { fields: ['segment_id'] },
      // 与 jobs_user_created_idx 同理：用户追溯列表防大 JSON filesort
      { name: 'video_generations_user_created_idx', fields: ['user_id', 'created_at'] },
      { fields: ['vendor', 'task_id'] },
    ],
  });

  return VideoGeneration;
};
