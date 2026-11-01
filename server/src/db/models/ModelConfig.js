export default (sequelize, DataTypes) => {
  const ModelConfig = sequelize.define('ModelConfig', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 归属：真实用户 id = 该用户自带 Key 的私有模型（0 积分）；NULL = 共享模型
    // （admin 后台添加，全员可用、积分计费）。user_id 对 users.id 有外键，哨兵只能用 NULL 不能用 0
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    // text | image | video | tts | asr
    type: { type: DataTypes.ENUM('text', 'image', 'video', 'tts', 'asr'), allowNull: false },
    provider: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'openai' },
    base_url: { type: DataTypes.STRING(255), allowNull: false },
    api_key: { type: DataTypes.STRING(255), allowNull: true },
    model: { type: DataTypes.STRING(128), allowNull: true },
    // openai | custom  （决定请求/响应解析方式）
    api_style: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'openai' },
    params: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
    // 计费（积分）：text=每次调用 / image=每张 / video=默认每秒（所选分辨率无独立价时兜底）/ asr=每分钟
    price: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    // 支持的分辨率：仅 video 生效=[{value:'480p',price:5},...]（每个分辨率独立每秒价）；
    // 非空时强校验：生成/擦字幕等入口提交的分辨率必须命中列表，未命中 400
    // （assertResolutionAllowed）；空=未配置=不限，计费回退模型默认价。
    // image 的「支持尺寸」已下线（落库一律 []，生成统一按 max_size 档位换算）/ text=[]
    resolutions: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    // 最大支持尺寸（仅 image 生效）：1K/2K/3K/4K/8K，默认 2K。所有生图提交 size=该档位
    // 字符串（如 '2K'）+ ratio=画幅比例（1:1/3:4/4:3/16:9/9:16/3:2/2:3/21:9），
    // 像素由厂商按档位×比例换算，不生成高于该档的图（小图产物由调用方本地降采样）；
    // 模型不支持高档位时由 admin 调低，避免厂商 400（normalizeMaxSize 对未知/缺省回退 2K）
    max_size: { type: DataTypes.STRING(8), allowNull: false, defaultValue: '2K' },
    // 提示词翻译为英文（仅 video 生效）：提交前先用默认文本大模型把提示词翻译成英文
    // （双引号内的旁白/对话保持原文不翻译；翻译失败回退原文）
    translate_prompt_en: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // 视频模型输入上限（仅 video 消费）：NULL=不限（存量行保持原有行为，不加裁剪）；0=该类输入弃用。
    // 超限淘汰在 generateVideo 收口：图片优先丢起始帧（跨镜尾帧延续）、仍超限从参考资产末尾淘汰；
    // 音频/视频从末尾淘汰（仅空置对应槽位，资产卡与图片槽保留）
    max_input_images: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    max_input_audios: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    max_input_videos: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    // 模型级全局并发上限（仅 video 消费）：该模型上正在运行的任务跨所有用户计入同一总数；
    // NULL/0=不限。超限任务保持排队（pending），有任务结束即补位；服务重启按 DB running 行扫描重建计数
    max_concurrency: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    // 限时折扣活动（针对本模型）：promo_discount=计费百分比（1-99，85=付原价的 85%）+ 起止时间；
    // 活动期内该模型的估价与实扣均按折后价（ceil），前端确认页展示原价/折后价/优惠幅度
    promo_discount: { type: DataTypes.FLOAT, allowNull: true, defaultValue: null },
    promo_start_at: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    promo_end_at: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, { tableName: 'model_configs' });

  return ModelConfig;
};
