// 模型关联定义
export default function setupAssociations(db) {
  const {
    User, Project, Episode, Asset, AssetImage, EpisodeAsset, StoryboardSegment,
    ModelConfig, CreditTransaction, RechargeOrder, Pricing, Job, UserOauth,
    Script, ScriptEpisode,
    ProjectMember, ProjectInvitation, ShowcaseItem, TaskOrder, OrderEvent,
    VideoGeneration, Referral, LoginLog,
  } = db;

  // User
  User.hasMany(Project, { foreignKey: 'user_id', as: 'projects' });
  User.hasMany(ModelConfig, { foreignKey: 'user_id', as: 'modelConfigs' });
  User.hasMany(CreditTransaction, { foreignKey: 'user_id', as: 'transactions' });
  User.hasMany(RechargeOrder, { foreignKey: 'user_id', as: 'orders' });
  User.hasMany(UserOauth, { foreignKey: 'user_id', as: 'oauthAccounts' });
  User.hasMany(Script, { foreignKey: 'user_id', as: 'scripts' });

  // UserOauth
  UserOauth.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // Project
  Project.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
  Project.hasMany(Episode, { foreignKey: 'project_id', as: 'episodes' });
  Project.hasMany(Asset, { foreignKey: 'project_id', as: 'assets' });

  // Episode
  Episode.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });
  Episode.hasMany(StoryboardSegment, { foreignKey: 'episode_id', as: 'segments', onDelete: 'CASCADE' });

  // Asset
  Asset.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });
  Asset.belongsTo(Episode, { foreignKey: 'episode_id', as: 'episode' });
  Asset.hasMany(AssetImage, { foreignKey: 'asset_id', as: 'images', onDelete: 'CASCADE' });

  // AssetImage（服饰：一套 = 一张图）
  AssetImage.belongsTo(Asset, { foreignKey: 'asset_id', as: 'asset' });

  // EpisodeAsset（按集覆盖角色服饰；costume_id 为空即用默认）
  Episode.hasMany(EpisodeAsset, { foreignKey: 'episode_id', as: 'episodeAssets', onDelete: 'CASCADE' });
  EpisodeAsset.belongsTo(Episode, { foreignKey: 'episode_id', as: 'episode' });
  EpisodeAsset.belongsTo(Asset, { foreignKey: 'asset_id', as: 'asset' });
  EpisodeAsset.belongsTo(AssetImage, { foreignKey: 'costume_id', as: 'costume' });

  // StoryboardSegment
  StoryboardSegment.belongsTo(Episode, { foreignKey: 'episode_id', as: 'episode' });

  // ModelConfig
  ModelConfig.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // Script（用户级剧本草稿）
  Script.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
  // Script 1—N ScriptEpisode（剧本工作台的分集草稿，导出时提升为项目的 Episode）
  Script.hasMany(ScriptEpisode, { foreignKey: 'script_id', as: 'episodes', onDelete: 'CASCADE' });
  ScriptEpisode.belongsTo(Script, { foreignKey: 'script_id', as: 'script' });

  // CreditTransaction
  CreditTransaction.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // RechargeOrder
  RechargeOrder.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // Job
  Job.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
  Job.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });
  User.hasMany(Job, { foreignKey: 'user_id', as: 'jobs' });

  // ProjectMember（团队项目共享：owner ∪ members 的成员行）
  ProjectMember.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });
  ProjectMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
  Project.hasMany(ProjectMember, { foreignKey: 'project_id', as: 'memberships' });
  User.hasMany(ProjectMember, { foreignKey: 'user_id', as: 'projectMemberships' });

  // ProjectInvitation（邀请：pending → accepted/rejected/revoked）
  ProjectInvitation.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });
  ProjectInvitation.belongsTo(User, { foreignKey: 'inviter_id', as: 'inviter' });
  ProjectInvitation.belongsTo(User, { foreignKey: 'invitee_id', as: 'invitee' });
  Project.hasMany(ProjectInvitation, { foreignKey: 'project_id', as: 'invitations' });

  // ShowcaseItem（展示中心：已发布项目一对一条记录，项目信息实时读取）
  ShowcaseItem.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });
  ShowcaseItem.belongsTo(User, { foreignKey: 'user_id', as: 'publisher' });

  // TaskOrder / OrderEvent（接单中心：订单 + 操作时间线）
  TaskOrder.belongsTo(User, { foreignKey: 'publisher_id', as: 'publisher' });
  TaskOrder.belongsTo(User, { foreignKey: 'worker_id', as: 'worker' });
  TaskOrder.hasMany(OrderEvent, { foreignKey: 'order_id', as: 'events' });
  OrderEvent.belongsTo(TaskOrder, { foreignKey: 'order_id', as: 'order' });

  // VideoGeneration（视频生成留档：轮询只更新 record 本身，查询明细表已废弃删除）
  // Job/分镜为软引用（constraints:false）：record 可能比 Job/段活得久（重启后扫描器仍查到终态），
  // 不因删除顺序受限
  VideoGeneration.belongsTo(User, { foreignKey: 'user_id', as: 'user', constraints: false });
  VideoGeneration.belongsTo(Job, { foreignKey: 'job_id', as: 'job', constraints: false });
  VideoGeneration.belongsTo(StoryboardSegment, { foreignKey: 'segment_id', as: 'segment', constraints: false });
  // admin 视频生成留档页回显用：模型配置（名称+私有/共享）、项目/分集名称。
  // 同为软引用——model_config/project/episode 被删后留档仍要可查（include 查不到即为 null）
  VideoGeneration.belongsTo(ModelConfig, { foreignKey: 'model_config_id', as: 'modelConfig', constraints: false });
  VideoGeneration.belongsTo(Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  VideoGeneration.belongsTo(Episode, { foreignKey: 'episode_id', as: 'episode', constraints: false });

  // Referral（邀请有礼：invitee 首次登录绑定，达到消费门槛后给 referrer 发积分）
  Referral.belongsTo(User, { foreignKey: 'referrer_id', as: 'referrer' });
  Referral.belongsTo(User, { foreignKey: 'invitee_id', as: 'invitee' });
  User.hasMany(Referral, { foreignKey: 'referrer_id', as: 'referrals' });

  // LoginLog（登录日志：admin 用户管理页查询）
  LoginLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
}
