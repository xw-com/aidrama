import { DataTypes } from 'sequelize';

/**
 * 幂等补列：为已存在的表追加模型中新增的列。
 * 背景：sequelize.sync() 采用安全模式（不 alter 已有表），新增列不会自动应用到
 * 现有 SQLite/MySQL 库。这里在启动时按需 ALTER TABLE ADD COLUMN，保证旧库平滑升级、不丢数据。
 *
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 * @param {Record<string, import('sequelize').DataType>} columns 列名 -> Sequelize 数据类型
 */
export async function ensureColumns(sequelize, tableName, columns) {
  const qi = sequelize.getQueryInterface();
  let attrs;
  try {
    attrs = await qi.describeTable(tableName);
  } catch {
    // 表尚不存在（sync 未建表），跳过；sync 后会按模型定义建出全部列
    return;
  }
  for (const [name, type] of Object.entries(columns)) {
    if (!attrs[name]) {
      await qi.addColumn(tableName, name, { type, allowNull: true });
    }
  }
}

/**
 * 幂等删列：移除表中已废弃的列，与 ensureColumns 对称。
 * 背景：sync() 安全模式不会删列，模型里删掉的字段在旧库里仍残留；
 * 这里在启动时按需 ALTER TABLE DROP COLUMN（removeColumn 自动适配 SQLite/MySQL 方言），
 * 保持库结构与模型一致，不丢其它数据。
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 * @param {string[]} columnNames 待删除的列名列表
 */
export async function dropColumns(sequelize, tableName, columnNames) {
  const qi = sequelize.getQueryInterface();
  let attrs;
  try {
    attrs = await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过
  }
  for (const name of columnNames) {
    if (attrs[name]) {
      await qi.removeColumn(tableName, name);
    }
  }
}

/**
 * 幂等删表：移除已废弃的整张表，与 dropColumns 同理。
 * 背景：sync() 安全模式不会删表，模型里删掉的表在旧库里仍残留；
 * 这里在启动时按需 DROP TABLE（表不存在则跳过）。
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 */
export async function dropTableIfExists(sequelize, tableName) {
  const qi = sequelize.getQueryInterface();
  try {
    await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过
  }
  await qi.dropTable(tableName);
}

/**
 * 幂等补索引：为已存在的表追加模型中新增的索引。
 * 背景：与 ensureColumns 同理，sync() 安全模式不会给已有表建新索引。
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 * @param {string} indexName 索引名（与模型定义中一致，按名判断是否已存在）
 * @param {string[]} fields 索引列
 * @param {{ unique?: boolean }} [opts] 附加索引选项（如 unique: true；多 NULL 值不冲突，可安全用于可空列）
 */
export async function ensureIndex(sequelize, tableName, indexName, fields, opts = {}) {
  const qi = sequelize.getQueryInterface();
  try {
    await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过；sync 后会按模型定义建出
  }
  // 注意：SQLite 下 showIndex 对不存在的表不报错，故先以 describeTable 探测
  const indexes = await qi.showIndex(tableName);
  if (!indexes.some((i) => i.name === indexName)) {
    await qi.addIndex(tableName, fields, { name: indexName, ...opts });
  }
}

/**
 * 幂等删索引：清冗余索引用（如 jobs_user_id 被 jobs_user_created_idx 最左前缀覆盖）。
 * 同 ensureIndex 口径：表不存在跳过；索引名不存在则视为已删，幂等可重复执行。
 */
export async function dropIndexIfExists(sequelize, tableName, indexName) {
  const qi = sequelize.getQueryInterface();
  try {
    await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过
  }
  const indexes = await qi.showIndex(tableName);
  if (indexes.some((i) => i.name === indexName)) {
    await qi.removeIndex(tableName, indexName);
  }
}

/**
 * 幂等积分列精度升级：把已有表中的整型积分列升级为 DOUBLE（积分支持一位小数，步进 0.1）。
 * 背景：积分精度从整数改为 0.1 后，模型列类型已改 DOUBLE；sync() 安全模式不会改已有列类型，
 * 旧库的 INTEGER 列会静默截断小数（MySQL 下 12.5 → 12），须在此 changeColumn 升宽。
 * 仅当现类型仍为整型（int/bigint/…）时执行；已迁移过则跳过。SQLite 无强类型，跳过即可。
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 * @param {string[]} columnNames 待升级的积分列名列表
 */
export async function ensureDecimalColumns(sequelize, tableName, columnNames) {
  if (sequelize.getDialect() !== 'mysql') return;
  const qi = sequelize.getQueryInterface();
  let attrs;
  try {
    attrs = await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过；sync 后会按模型定义建出
  }
  for (const name of columnNames) {
    const col = attrs[name];
    if (!col || !/int/i.test(String(col.type || ''))) continue;
    // 保留原列的可空性；DB 级默认值不迁移（应用层模型 defaultValue 生效）
    await qi.changeColumn(tableName, name, { type: DataTypes.DOUBLE, allowNull: !!col.allowNull });
  }
}

/**
 * 幂等扩 ENUM 值：为已存在的表扩宽某 ENUM 列的取值集合。
 * 背景：与补列同理，sync() 安全模式不会改已有列的 ENUM 定义；模型里给 ENUM 加了新值时，
 * 旧 MySQL 库需 ALTER ... MODIFY 才接受新值插入。仅在缺失期望值时执行 changeColumn（传全量值，非增量）。
 * SQLite 方言下 ENUM 实为 TEXT（无约束），跳过即可（dev/生产均为 MySQL）。
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 * @param {string} columnName ENUM 列名
 * @param {string[]} desiredValues 期望的全量 ENUM 值（必须包含现有全部值，否则会被收窄丢数据）
 */
export async function ensureEnumValues(sequelize, tableName, columnName, desiredValues) {
  if (sequelize.getDialect() !== 'mysql') return;
  const qi = sequelize.getQueryInterface();
  let attrs;
  try {
    attrs = await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过；sync 后会按模型定义建出
  }
  const col = attrs[columnName];
  if (!col) return;
  // MySQL describeTable 返回形如 "enum('text','image','video','tts')"
  const current = String(col.type || '').match(/'([^']*)'/g)?.map((s) => s.slice(1, -1)) || [];
  if (!current.length) return; // 非 ENUM 列（如 SQLite 迁移来的 TEXT），不动
  const missing = desiredValues.filter((v) => !current.includes(v));
  // 收窄保护：期望值必须涵盖现有全部值，避免误删正在使用的枚举项
  const narrowed = current.filter((v) => !desiredValues.includes(v));
  if (!missing.length || narrowed.length) return;
  await qi.changeColumn(tableName, columnName, { type: DataTypes.ENUM(...desiredValues), allowNull: false });
}

/**
 * 幂等扩长文本列：把较短的 TEXT 家族列升级为更大的类型（默认 MEDIUMTEXT 16MB，可选 LONGTEXT 4GB）。
 * 背景：剧本导入等场景会把长文写进 projects.raw_script / episodes.content 等列，短于目标的类型
 * 会报 ER_DATA_TOO_LONG；模型已改大类型，这里为存量库平滑升级（含 TEXT→MEDIUMTEXT→LONGTEXT 逐级升）。
 * 仅当现类型比目标小时才 changeColumn（等于/大于目标跳过；VARCHAR 等其它类型不动）。
 * @param {object} sequelize Sequelize 实例
 * @param {string} tableName 物理表名
 * @param {Record<string, object|null>} columns 列名 -> changeColumn 附加属性（如 { defaultValue: '' }）
 * @param {'medium'|'long'} [to] 目标类型：'medium'=MEDIUMTEXT(16MB)，'long'=LONGTEXT(4GB)；默认 'medium'
 */
const TEXT_TYPE_RANKS = { TINYTEXT: 1, TEXT: 2, MEDIUMTEXT: 3, LONGTEXT: 4 };
export async function widenTextColumns(sequelize, tableName, columns, to = 'medium') {
  if (sequelize.getDialect() !== 'mysql') return; // SQLite 无长度限制
  const qi = sequelize.getQueryInterface();
  let attrs;
  try {
    attrs = await qi.describeTable(tableName);
  } catch {
    return; // 表不存在，跳过
  }
  for (const [name, extra] of Object.entries(columns)) {
    const col = attrs[name];
    if (!col) continue;
    const rank = TEXT_TYPE_RANKS[String(col.type || '').toUpperCase()];
    if (!rank || rank >= TEXT_TYPE_RANKS[to === 'long' ? 'LONGTEXT' : 'MEDIUMTEXT']) continue;
    await qi.changeColumn(tableName, name, { type: DataTypes.TEXT(to), allowNull: true, ...(extra || {}) });
  }
}

/** StoryboardSegment 新增的分镜表字段（对齐 分镜表.xlsx） */
export const STORYBOARD_NEW_COLUMNS = {
  scene_no: DataTypes.INTEGER,
  shot_no: DataTypes.STRING(16),
  scene_script: DataTypes.TEXT,
  video_prompt: DataTypes.TEXT,
  // 尾帧（视频生成后保存，供后续镜头图生视频首帧延续等备用）
  last_frame_url: DataTypes.STRING(512),
};

/** StoryboardSegment 已废弃的旧分镜字段（景别/构图/运镜/光影/场景/站位/音效/画面描述/旁白），从库结构中移除 */
export const STORYBOARD_DROPPED_COLUMNS = [
  'shot_size', 'composition', 'camera_move', 'lighting', 'scene', 'blocking', 'sound_effect',
  'prompt', 'narration',
];

/** Episode 新增字段 */
export const EPISODE_NEW_COLUMNS = {
  director_requirements: DataTypes.TEXT,
};

/** Project 新增字段（cover 已存在，仅补制作人 / 版权 / 叙事类型） */
export const PROJECT_NEW_COLUMNS = {
  producer: DataTypes.STRING(128),
  copyright: DataTypes.STRING(255),
  narrative_type: DataTypes.STRING(64),
};

/** Project 新增字段：公开分享令牌（一键分享，免登录播放页 /share/:token 用；唯一性由 handler 预检+重试兜底） */
export const PROJECT_SHARE_COLUMNS = {
  share_token: DataTypes.STRING(32),
};

/** Project 新增字段：分享令牌签发时间（链接 24 小时有效，过期换发新令牌） */
export const PROJECT_SHARE_TTL_COLUMNS = {
  share_issued_at: DataTypes.DATE,
};

/** ModelConfig 新增字段：按模型计费价格 + 支持的分辨率 + 提示词英译开关（仅 video 生效） */
export const MODEL_CONFIG_NEW_COLUMNS = {
  price: DataTypes.FLOAT,
  resolutions: DataTypes.JSON,
  translate_prompt_en: DataTypes.BOOLEAN,
};

/** ModelConfig 新增字段：限时折扣活动（计费百分比 1-99 + 起止时间；期内估价/实扣按折后价） */
export const MODEL_CONFIG_PROMO_COLUMNS = {
  promo_discount: DataTypes.FLOAT,
  promo_start_at: DataTypes.DATE,
  promo_end_at: DataTypes.DATE,
};

/** ModelConfig 新增字段：最大支持尺寸（仅 image 生效；生图按画幅比例收敛到该档位长边再提交） */
export const MODEL_CONFIG_MAX_SIZE_COLUMNS = {
  max_size: DataTypes.STRING(8),
};

/**
 * ModelConfig 新增字段：视频模型输入上限 + 全局并发（仅 video 消费）。
 * NULL = 不限（存量行保持原有行为，不加裁剪）；0 = 该类输入整体弃用。
 * 上限裁剪在 generateVideo 收口（占位符替换之前）；并发闸门在 job 运行器（全用户共享）。
 */
export const MODEL_CONFIG_INPUT_LIMIT_COLUMNS = {
  max_input_images: DataTypes.INTEGER,
  max_input_audios: DataTypes.INTEGER,
  max_input_videos: DataTypes.INTEGER,
  max_concurrency: DataTypes.INTEGER,
};

/** ModelVendor 新增字段：模型清单（admin 维护的模型 id 列表，用户私有模型配置页下拉用） */
export const VENDOR_MODELS_COLUMNS = {
  models: DataTypes.JSON,
};

/** User 新增字段：外部账号体系（external_id 关联外部身份；phone/nickname 档案字段） */
export const USER_XWORLD_COLUMNS = {
  external_id: DataTypes.STRING(64),
  phone: DataTypes.STRING(32),
  nickname: DataTypes.STRING(128),
};

/** RechargeOrder 新增字段：第三方支付流水号（微信支付 transaction_id 等） */
export const RECHARGE_NEW_COLUMNS = {
  transaction_id: DataTypes.STRING(64),
};

/** Asset 新增字段：豆包数字资产 ID（用于视频生成角色一致性，asset:// 引用） */
export const ASSET_NEW_COLUMNS = {
  doubao_asset_id: DataTypes.STRING(128),
};

/** Asset 新增字段：别名列表（JSON 字符串数组，用于 AI 匹配/去重与视频参考图映射） */
export const ASSET_ALIASES_COLUMNS = {
  aliases: DataTypes.JSON,
};

/** Asset/AssetImage 新增字段：卡片列表用 webp 缩略图（短边 480；存量由 thumbnail 扫描线程补齐） */
export const ASSET_THUMB_COLUMNS = {
  thumb_url: DataTypes.STRING(512),
};

export const ASSET_IMAGE_THUMB_COLUMNS = {
  thumb_url: DataTypes.STRING(512),
};

/** Project 新增字段：项目封面缩略图（项目卡/展示中心卡片用；原图可能是未压缩的用户上传） */
export const PROJECT_COVER_THUMB_COLUMNS = {
  cover_thumb: DataTypes.STRING(512),
};

/** StoryboardSegment 新增字段：本镜头到下一镜头的转场特效（用户可选） */
export const SEGMENT_TRANSITION_COLUMNS = {
  transition: DataTypes.STRING(32),
};

/** StoryboardSegment 新增字段：尾帧来源（'seedance'=provider return_last_frame 原图 / 'ffmpeg'=本地抽帧兜底） */
export const SEGMENT_LAST_FRAME_SOURCE_COLUMNS = {
  last_frame_source: DataTypes.STRING(16),
};

/** StoryboardSegment 新增字段：视频审阅标记（reviewed_at 非空即已审 + 审阅人；换视频时由写点重置） */
export const SEGMENT_REVIEW_COLUMNS = {
  reviewed_at: DataTypes.DATE,
  reviewer_id: DataTypes.INTEGER,
};

/** Script（剧本草稿）新增字段：剧本工作台 4 步向导（大纲 / 当前步骤 / 题材 / 对话历史） */
export const SCRIPT_NEW_COLUMNS = {
  outline: DataTypes.TEXT,
  stage: DataTypes.STRING(16),
  narrative_type: DataTypes.STRING(64),
  chat: DataTypes.JSON,
};

/** Voice 新增字段：供应商音色库目录（data/voice.json 导入的 preset 音色） */
export const VOICE_CATALOG_COLUMNS = {
  scene: DataTypes.STRING(32),
  age_range: DataTypes.INTEGER,
  age_range_text: DataTypes.STRING(16),
  gender_code: DataTypes.INTEGER,
  emotion_type: DataTypes.INTEGER,
  emotion_list: DataTypes.JSON,
};

/** Project 新增字段：项目级全局设置（首个子项 subtitle 字幕烧录样式：字体/字号/底距） */
export const PROJECT_SETTINGS_COLUMNS = {
  settings: DataTypes.JSON,
};

/** ShowcaseItem 新增字段：发布时勾选的分集 id 快照（null=存量记录，视为全部可播分集） */
export const SHOWCASE_EPISODE_COLUMNS = {
  episode_ids: DataTypes.JSON,
};

/** ShowcaseItem 新增字段：发布审核（状态/驳回原因/审核时间/审核人）；存量行由 backfillShowcaseStatus 置 approved */
export const SHOWCASE_REVIEW_COLUMNS = {
  status: DataTypes.STRING(16),
  reject_reason: DataTypes.STRING(255),
  reviewed_at: DataTypes.DATE,
  reviewer_id: DataTypes.INTEGER,
};

/**
 * 存量展示记录视为已通过审核（列是新补的、全为 NULL；ensureColumns 补列不带 DB 默认值）。
 * 幂等：每次启动执行一次 UPDATE，此后 WHERE status IS NULL 恒空集，代价可忽略。
 * @param {object} sequelize Sequelize 实例
 */
export async function backfillShowcaseStatus(sequelize) {
  try {
    await sequelize.query("UPDATE showcase_items SET status = 'approved' WHERE status IS NULL");
  } catch {
    // 表未建等场景：由 sync 建表后模型默认值生效，无需处理
  }
}

/**
 * 共享模型归属归 NULL（模型归属改造）：存量共享模型原记在 admin 账号名下（靠 role='admin'
 * 识别共享语义），现统一改写为 user_id IS NULL 哨兵值——admin 名下从此只有自己的私有模型，
 * admin 也能像普通用户一样在前台添加私有模型。user_id 有外键约束不能写 0，NULL 即
 * 「无属主/共享」的原生语义。
 * 只执行一次（app_configs 打标）：改造上线后 admin 名下的新行都是其私有模型，
 * 若每次启动都改写会把 admin 的私有模型错转成共享模型（自带 Key 泄漏给全员）。
 * @param {object} sequelize Sequelize 实例
 */
export async function backfillAdminModelsToShared(sequelize) {
  const FLAG_KEY = 'model_config:shared_backfill_done';
  try {
    // 标记已打过 → 跳过（启动后新建的 admin 私有模型不在改写范围）
    const [rows] = await sequelize.query(
      "SELECT value FROM app_configs WHERE `key` = ? LIMIT 1",
      { replacements: [FLAG_KEY] }
    );
    if (rows.length) return false;
    await sequelize.query(
      "UPDATE model_configs SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE role = 'admin')"
    );
    await sequelize.query(
      "INSERT INTO app_configs (`key`, value, created_at, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      { replacements: [FLAG_KEY] }
    );
    return true;
  } catch {
    // 表未建等场景：跳过，由后续启动重试
  }
}

/** Voice 已废弃字段（音色库转为全局共享，用户归属/来源/描述/时长/试听外链/供应商 ID/扩展参数一并移除） */
export const VOICE_DROPPED_COLUMNS = [
  'user_id', 'description', 'duration', 'demo_url', 'provider_voice_id', 'params', 'source',
];

/** User 新增字段：邀请码（邀请有礼；唯一索引 users_referral_code_uidx 由 ensureIndex 幂等补建，handler 预检+重试兜底） */
export const USER_REFERRAL_COLUMNS = {
  referral_code: DataTypes.STRING(16),
};

/** User 新增字段：账号状态（active/banned；封禁拦截在 authRequired，老库 NULL 行按放行处理无需回填） */
export const USER_STATUS_COLUMNS = {
  status: DataTypes.STRING(16),
};

/** EpisodeVideo 新增字段：字幕草稿状态落档（段落/源成片 URL/尺寸/校正标记）——字幕编辑与 jobs 表解耦，Job 清理后仍可编辑/重烧 */
export const EPISODE_VIDEO_SUBTITLE_COLUMNS = {
  segments: DataTypes.JSON,
  source_video_url: DataTypes.STRING(500),
  width: DataTypes.INTEGER,
  height: DataTypes.INTEGER,
  corrected: DataTypes.BOOLEAN,
  corrected_count: DataTypes.INTEGER,
};

/** EpisodeVideo 新增字段：成片封面（合成/烧录/剪辑导出时抽第一帧出的 480P webp；存量行由缩略图扫描线程补齐） */
export const EPISODE_VIDEO_COVER_COLUMNS = {
  cover_url: DataTypes.STRING(500),
};

/** EpisodeVideo 新增字段：成片审阅标记（reviewed_at 非空即已审 + 审阅人；每条成片记录独立） */
export const EPISODE_VIDEO_REVIEW_COLUMNS = {
  reviewed_at: DataTypes.DATE,
  reviewer_id: DataTypes.INTEGER,
};

/** VideoGeneration 新增字段：提交时的完整厂商端点 URL（base_url + 厂商提交路径，admin 留档详情展示） */
export const VIDEO_GENERATION_SUBMIT_URL_COLUMNS = {
  submit_url: DataTypes.STRING(512),
};

/**
 * 视频生成留档 submit_url 存量回填：submit_url 列晚于留档功能上线（此前只存 base_url），
 * 存量行按 vendor + base_url/model（均为提交时快照）反推完整端点——各厂商提交路径是固定契约，
 * 用与提交侧一字不差的 URL 规整规则即可精确重建。base_url 为空的行无法重建（保持 NULL，详情回退显示 base_url）；
 * 未知 vendor 的行同样跳过。幂等：只扫 submit_url IS NULL 且 base_url 非空的行，补完即收敛为空集。
 * @param {object} sequelize Sequelize 实例
 * @returns {number} 回填行数
 */
export async function backfillVideoGenerationSubmitUrls(sequelize) {
  // ⚠ 以下四个规整函数与 video.service 的 joinUrl/dashScopeUrl/minimaxUrl/comfyUrl 逐字一致
  //  （含尾斜杠剥离次数等细节），那边改动须这边同步，否则重建出的 URL 与真实提交端点有出入
  const joinUrl = (base, p) => {
    if (!base) return p;
    const b = String(base).replace(/\/$/, '');
    if (/\/v\d+$/i.test(b)) return b + p;
    return b + '/v1' + p;
  };
  const dashScopeUrl = (base, p) => {
    if (!base) return p;
    const m = String(base).match(/^(https?:\/\/[^/]+)/i);
    const origin = m ? m[1] : base.replace(/\/$/, '');
    return origin + p;
  };
  const minimaxUrl = (base, path) => {
    let b = String(base || 'https://api.minimaxi.com').replace(/\/$/, '');
    if (/\/v1$/i.test(b)) b = b.replace(/\/v1$/i, '/v2');
    else if (!/\/v\d+$/i.test(b)) b += '/v2';
    return b + path;
  };
  const comfyUrl = (base, p) => {
    let b = String(base || 'https://autodl.art/api/v1').replace(/\/+$/, '');
    if (!/\/api\/v1$/i.test(b)) b += '/api/v1';
    return b + p;
  };
  // 各 vendor 的提交端点构造 = video.service 各提交 helper 的 submitUrl（同步维护）
  const SUBMIT_URL_BY_VENDOR = {
    seedance: (r) => joinUrl(r.base_url, '/contents/generations/tasks'),
    generic: (r) => joinUrl(r.base_url, '/videos/generations'),
    dashscope: (r) => dashScopeUrl(r.base_url, '/api/v1/services/aigc/video-generation/video-synthesis'),
    aliwan: (r) => dashScopeUrl(r.base_url, '/api/v1/services/aigc/video-generation/video-synthesis'),
    minimax: (r) => minimaxUrl(r.base_url, '/video_generation'),
    agnes: (r) => joinUrl(r.base_url, '/videos'),
    comfyui: (r) => comfyUrl(r.base_url, `/comfyui/comfyui_workflow/${encodeURIComponent(r.model)}`),
  };
  try {
    const [rows] = await sequelize.query(
      "SELECT id, vendor, model, base_url FROM video_generations WHERE submit_url IS NULL AND base_url IS NOT NULL AND base_url != ''"
    );
    let n = 0;
    for (const r of rows) {
      const build = SUBMIT_URL_BY_VENDOR[r.vendor];
      if (!build) continue;
      await sequelize.query('UPDATE video_generations SET submit_url = ? WHERE id = ?', { replacements: [build(r), r.id] });
      n += 1;
    }
    return n;
  } catch {
    // 表未建等场景：跳过，由后续启动重试
    return 0;
  }
}

/**
 * 成片落档（episode_videos）存量回填：从历史成功 Job（合成/字幕/剪辑）导入成片记录，
 * 使成片查询与 jobs 表解耦（Job 清理/删除后成片历史仍可查）。幂等：按 (kind, job_id) 查重跳过。
 * 与成片列表旧口径一致：跳过软隐藏（meta.hidden）与分镜源剪辑（editSource='segment'，产物已写回分镜）。
 * @returns {Promise<number>} 新插入的成片记录数
 */
export async function backfillEpisodeVideos() {
  // 函数内动态 import：避免与 db/index.js 的启动加载顺序产生耦合
  const db = (await import('./index.js')).default;
  const { Job, EpisodeVideo } = db;
  const jobs = await Job.findAll({
    where: {
      status: 'succeeded',
      type: { [db.Sequelize.Op.in]: ['video_synthesis', 'video_subtitle', 'video_edit'] },
    },
  });
  let inserted = 0;
  // 字幕校正历史（草稿 Job id -> 最近一次成功校正）：打标前的老草稿补「已智能校正」标志，
  // 不再把回填行写死 corrected=false（标志只增不回退，有成功校正史即视为已校正）
  const correctJobs = await Job.findAll({ where: { status: 'succeeded', type: 'subtitle_correct' }, attributes: ['id', 'ref_id', 'result', 'created_at'] });
  const correctedHist = new Map();
  for (const r of correctJobs) {
    if (!r.ref_id) continue;
    const prev = correctedHist.get(r.ref_id);
    if (!prev || String(r.created_at) > String(prev.created_at)) correctedHist.set(r.ref_id, r);
  }
  for (const j of jobs) {
    if (j.meta?.hidden) continue; // 软隐藏（已删除）的成片不回填
    if (j.type === 'video_edit' && j.meta?.editSource === 'segment') continue; // 分镜源剪辑已写回分镜，不算成片
    let row = null;
    if (j.type === 'video_synthesis') {
      const ep = j.result?.episode || {};
      if (!ep.video_url) continue;
      row = { kind: 'compose', video_url: ep.video_url, duration: ep.duration || 0, resolution: j.meta?.resolution || j.result?.resolution || null, segments_count: 0, source_job_id: null };
    } else if (j.type === 'video_subtitle') {
      const s = j.result?.subtitle || {};
      if (!s.video_url && !s.srt_url) continue;
      const hist = correctedHist.get(j.id);
      const correctedCount = Number.isFinite(s.corrected_count)
        ? s.corrected_count
        : (hist ? (Number(hist.result?.subtitle?.changed_count) || 0) : null);
      row = {
        kind: 'subtitle', video_url: s.video_url || null, srt_url: s.srt_url || null, duration: s.duration || 0, segments_count: s.segments_count || 0,
        // 草稿状态一并落档（段落/源成片/尺寸/校正标记）：字幕编辑与 jobs 表解耦
        segments: Array.isArray(s.segments) ? s.segments : [], source_video_url: s.source_video_url || null,
        width: Math.round(s.width) || 0, height: Math.round(s.height) || 0,
        corrected: s.corrected === true || !!hist, corrected_count: correctedCount,
        source_job_id: s.source_job_id ?? j.ref_id ?? null,
      };
    } else {
      const e = j.result?.edit || {};
      if (!e.video_url) continue;
      row = { kind: 'edit', video_url: e.video_url, duration: e.duration || 0, resolution: e.resolution || null, segments_count: e.segments_count || 0, source_job_id: e.source_job_id ?? j.ref_id ?? null };
    }
    if (!j.project_id) continue; // 与旧列表口径一致（按项目查询），无主 Job 不回填
    // 幂等：同一 Job 的同类成片只回填一次
    // eslint-disable-next-line no-await-in-loop
    const dup = await EpisodeVideo.findOne({ where: { kind: row.kind, job_id: j.id } });
    if (dup) continue;
    // eslint-disable-next-line no-await-in-loop
    await EpisodeVideo.create({
      project_id: j.project_id, episode_id: j.episode_id, user_id: j.user_id, job_id: j.id, ...row,
    });
    inserted += 1;
  }
  return inserted;
}

/**
 * 定位 jobs 备份表：环境变量 JOBS_BACKUP_TABLE 优先（显式指定即直接采信，只验列齐全）；
 * 缺省在同库找 jobs% 备份表（排除 jobs 本身，jobs_backup 优先），
 * 要求具备 id/type/status/result 列，避免误认无关表。
 */
async function detectJobsBackupTable(sequelize) {
  const qi = sequelize.getQueryInterface();
  const hasJobCols = async (name) => {
    const attrs = await qi.describeTable(name).catch(() => null);
    return !!(attrs?.id && attrs?.type && attrs?.status && attrs?.result);
  };
  const wanted = process.env.JOBS_BACKUP_TABLE;
  if (wanted) return (await hasJobCols(wanted)) ? wanted : null;
  const dialect = sequelize.getDialect();
  let names = [];
  if (dialect === 'mysql') {
    const [rows] = await sequelize.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'jobs%' AND table_name <> 'jobs'");
    names = rows.map((r) => Object.values(r)[0]);
  } else {
    const [rows] = await sequelize.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'jobs%' AND name <> 'jobs'");
    names = rows.map((r) => r.name);
  }
  names.sort((a, b) => (a === 'jobs_backup' ? -1 : b === 'jobs_backup' ? 1 : 0)); // jobs_backup 优先
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    if (await hasJobCols(name)) return name;
  }
  return null;
}

/**
 * 字幕草稿灾备回填：jobs 表被清后，从同库备份表找回 video_subtitle 成功任务的草稿，
 * 重建/补齐 episode_videos（kind='subtitle'）行——与 backfillEpisodeVideos 同范式，数据源换成备份表。
 * 同时按备份里的 subtitle_correct 成功任务回溯「已智能校正」标记（对应运行时 hydrateSubtitleFilm 的兜底）。
 * 无备份表自动跳过；行已存在只补缺失字段（段落为空才回填），幂等可重复执行，返回 { table, created, patched }。
 */
export async function backfillSubtitleDraftsFromBackup(sequelize) {
  const raw = await detectJobsBackupTable(sequelize);
  if (!raw) return null;
  const table = String(raw).replace(/[^A-Za-z0-9_]/g, ''); // 表名白名单化（来源含环境变量，防注入）
  if (!table) return null;
  // 函数内动态 import：避免与 db/index.js 的启动加载顺序产生耦合（同 backfillEpisodeVideos）
  const db = (await import('./index.js')).default;
  const { EpisodeVideo } = db;
  const q = sequelize.getDialect() === 'mysql' ? '`' : '"';
  const asObj = (v) => { // 备份表 result/meta 可能是 JSON 列（驱动已解）也可能是 dump 进来的字符串
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  };
  // eslint-disable-next-line no-await-in-loop
  const [subRows] = await sequelize.query(`SELECT * FROM ${q}${table}${q} WHERE ${q}type${q} = 'video_subtitle' AND ${q}status${q} = 'succeeded'`);
  // eslint-disable-next-line no-await-in-loop
  const [correctRows] = await sequelize.query(`SELECT * FROM ${q}${table}${q} WHERE ${q}type${q} = 'subtitle_correct' AND ${q}status${q} = 'succeeded'`);
  // 校正历史索引：草稿 Job id -> 最近一次成功校正（老草稿回填「已智能校正」标记用）
  const correctedHist = new Map();
  for (const r of correctRows) {
    if (!r.ref_id) continue;
    const prev = correctedHist.get(r.ref_id);
    if (!prev || String(r.created_at) > String(prev.created_at)) correctedHist.set(r.ref_id, r);
  }
  let created = 0;
  let patched = 0;
  for (const j of subRows) {
    const sub = asObj(j.result)?.subtitle;
    if (!sub) continue;
    if (asObj(j.meta)?.hidden) continue; // 软隐藏（已删除）的成片不复活
    if (!j.project_id) continue; // 与 backfillEpisodeVideos 同口径，无主 Job 不回填
    const segments = Array.isArray(sub.segments) ? sub.segments : [];
    if (!segments.length && !sub.srt_url) continue; // 无可恢复内容
    let corrected = sub.corrected === true;
    let correctedCount = Number.isFinite(sub.corrected_count) ? sub.corrected_count : null;
    if (!corrected) {
      const hist = correctedHist.get(j.id);
      if (hist) { corrected = true; correctedCount = correctedCount ?? (Number(asObj(hist.result)?.subtitle?.changed_count) || 0); }
    }
    const base = {
      srt_url: sub.srt_url || null, duration: sub.duration || 0,
      ...(segments.length ? { segments, segments_count: segments.length } : {}),
      source_video_url: sub.source_video_url || null,
      width: Math.round(sub.width) || 0, height: Math.round(sub.height) || 0,
      source_job_id: sub.source_job_id ?? j.ref_id ?? null,
    };
    // eslint-disable-next-line no-await-in-loop
    const film = await EpisodeVideo.findOne({ where: { kind: 'subtitle', job_id: j.id } });
    if (!film) {
      // eslint-disable-next-line no-await-in-loop
      await EpisodeVideo.create({
        project_id: j.project_id, episode_id: j.episode_id, user_id: j.user_id, job_id: j.id, kind: 'subtitle',
        ...base, corrected, corrected_count: correctedCount,
      });
      created += 1;
      continue;
    }
    // 幂等补齐：行已存在只补缺失字段，不覆盖存量（用户可能已编辑过）
    const upd = {};
    if (!Array.isArray(film.segments) || !film.segments.length) {
      if (segments.length) { upd.segments = segments; upd.segments_count = segments.length; }
    }
    if (!film.srt_url && base.srt_url) upd.srt_url = base.srt_url;
    if (!film.source_video_url && base.source_video_url) upd.source_video_url = base.source_video_url;
    if (!(Number(film.width) > 0) && base.width > 0) upd.width = base.width;
    if (!(Number(film.height) > 0) && base.height > 0) upd.height = base.height;
    // 已校正标志只增不回退：行上 false/null 都允许按备份史补标（旧回填写死的 false 同样修得回）
    if (!film.corrected && corrected) { upd.corrected = true; upd.corrected_count = correctedCount; }
    if (Object.keys(upd).length) {
      // eslint-disable-next-line no-await-in-loop
      await film.update(upd);
      patched += 1;
    }
  }
  return { table, created, patched };
}
