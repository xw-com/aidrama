import { Sequelize } from 'sequelize';
import { config } from '../config/index.js';
import path from 'path';
import fs from 'fs';

// 确保本地存储目录存在（sqlite 文件所在目录）
const dbStorageAbs = path.resolve(process.cwd(), config.db.storage);
fs.mkdirSync(path.dirname(dbStorageAbs), { recursive: true });

const isMysql = config.db.dialect === 'mysql';

/**
 * 字符长度 SQL（方言差异）：MySQL 用 CHAR_LENGTH（字符数，中文安全）；
 * SQLite 无该函数，其 LENGTH() 本身即返回字符数（非字节），语义一致。
 */
export const charLenSql = (expr) => (isMysql ? `CHAR_LENGTH(${expr})` : `LENGTH(${expr})`);

export const sequelize = new Sequelize(
  isMysql ? config.db.name : config.db.storage,
  isMysql ? config.db.user : undefined,
  isMysql ? config.db.password : undefined,
  {
    dialect: isMysql ? 'mysql' : 'sqlite',
    host: isMysql ? config.db.host : undefined,
    port: isMysql ? config.db.port : undefined,
    storage: isMysql ? undefined : dbStorageAbs,
    // MySQL 建表统一 utf8mb4（emoji/中文安全）
    charset: isMysql ? 'utf8mb4' : undefined,
    collation: isMysql ? 'utf8mb4_unicode_ci' : undefined,
    // 连接池主动回收空闲连接：避免连接被 MySQL wait_timeout / 中间代理掐死后，
    // 池里残留死连接导致下一次查询 500（凌晨低峰期高发）
    pool: isMysql ? { max: 10, min: 0, acquire: 30000, idle: 10000 } : undefined,
    // 连接类瞬时错误自动重试（Sequelize 默认只重试 SQLITE_BUSY，对 MySQL 等于不重试）。
    // regex 同时匹配 err.message 与 err.toString()，message 为空的连接错误也能按错误名命中
    retry: isMysql ? {
      max: 3,
      match: [
        Sequelize.ConnectionError,
        Sequelize.ConnectionTimedOutError,
        Sequelize.TimeoutError,
        /Connection lost/i, /PROTOCOL_CONNECTION_LOST/i,
        /ECONNRESET/i, /ETIMEDOUT/i, /Deadlock/i,
      ],
    } : undefined,
    dialectOptions: isMysql ? {
      connectTimeout: 10000,
      // TCP keepalive：防 NAT/代理静默断链
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    } : undefined,
    logging: false,
    define: {
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

// SQL 执行日志：所有查询（模型 CRUD 与原生 SQL）都收敛到 sequelize.query()，
// 在此统一包装，打印 SQL、耗时与返回行数/列数；DB_SQL_LOG=0 可关闭
if (config.db.sqlLog) {
  const origQuery = sequelize.query;
  // 写语句（INSERT/UPDATE/DELETE/DDL）没有"返回列"，走 affected 分支
  const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i;
  sequelize.query = async function wrappedQuery(sql, options) {
    const start = process.hrtime.bigint();
    const text = typeof sql === 'string' ? sql : sql?.query || String(sql);
    try {
      const result = await origQuery.call(this, sql, options);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // 无 type 的原生查询（[rows, fields]）与 INSERT（[data, metadata]）都是二元组，统一拆包
      const isTuple = (!options?.type || options.type === Sequelize.QueryTypes.INSERT)
        && Array.isArray(result) && result.length === 2;
      const [data, meta] = isTuple ? result : [result, null];
      if (WRITE_RE.test(text)) {
        // 写语句没有"返回列"，改打印影响行数
        const affected = meta?.affectedRows ?? (Array.isArray(data) ? data.length : data ? 1 : 0);
        console.log(`[sql] ${ms.toFixed(1)}ms affected=${affected} :: ${text}`);
      } else {
        const rows = Array.isArray(data) ? data.length : data == null ? 0 : 1;
        // 列数优先取驱动元数据（mysql2 的 fields，空结果也有列数），否则取首行字段数
        let cols;
        if (Array.isArray(meta)) cols = meta.length;
        else {
          const sample = Array.isArray(data) ? data[0] : data;
          cols = sample && typeof sample === 'object' ? Object.keys(sample.dataValues || sample).length : 0;
        }
        console.log(`[sql] ${ms.toFixed(1)}ms rows=${rows} cols=${cols} :: ${text}`);
      }
      return result;
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.error(`[sql] ${ms.toFixed(1)}ms FAILED :: ${text} :: ${err.message}`);
      throw err;
    }
  };
}

const db = { sequelize, Sequelize };

// 注册模型
const modelFiles = [
  'User.js', 'Project.js', 'Episode.js', 'Asset.js', 'AssetImage.js', 'EpisodeAsset.js',
  'StoryboardSegment.js', 'ModelConfig.js', 'ModelVendor.js', 'CreditTransaction.js',
  'RechargeOrder.js', 'Pricing.js', 'Job.js', 'UserOauth.js',
  'Voice.js', 'Script.js', 'ScriptEpisode.js',
  'ProjectMember.js', 'ProjectInvitation.js',
  'ArtStyle.js',
  'ShowcaseItem.js',   // 展示中心（showcase_items）
  'TaskOrder.js', 'OrderEvent.js', // 接单中心（task_orders / order_events）
  'VideoGeneration.js', // 视频生成留档（video_generations；查询明细表 video_generation_queries 已废弃删除）
  'AppConfig.js',   // 全局 KV 配置（app_configs；admin 后台可改的运行时参数）
  'Referral.js',    // 邀请有礼绑定记录（referrals）
  'LoginLog.js',    // 登录日志（login_logs；admin 用户管理页查询）
  'EpisodeVideo.js', // 成片落档（episode_videos；成片查询与 jobs 表解耦，Job 清理不影响历史成片）
];

for (const file of modelFiles) {
  const mod = await import(`./models/${file}`);
  const model = mod.default(sequelize, Sequelize.DataTypes);
  db[model.name] = model;
}

// 建立关联
const { default: setupAssociations } = await import('./associations.js');
setupAssociations(db);

export default db;
