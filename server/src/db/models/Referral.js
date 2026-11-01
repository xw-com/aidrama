export default (sequelize, DataTypes) => {
  const Referral = sequelize.define('Referral', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // 邀请人（奖励发放对象）
    referrer_id: { type: DataTypes.INTEGER, allowNull: false },
    // 被邀请人：一人一生只能被绑定一次（唯一索引 referrals_invitee_uidx 兜底并发）
    invitee_id: { type: DataTypes.INTEGER, allowNull: false },
    // 绑定时使用的邀请码（审计：追查码来源）
    code: { type: DataTypes.STRING(16), allowNull: false },
    // pending=已绑定待被邀请人消费达标 | rewarded=已发放 | rejected=防刷规则命中拒绝
    status: { type: DataTypes.ENUM('pending', 'rewarded', 'rejected'), allowNull: false, defaultValue: 'pending' },
    // 实发奖励快照（发放时点的配置值；rejected/pending 为 0）
    reward_credits: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 }, // 一位小数精度
    // 被邀请人绑定时来源 IP（防刷审计：同 IP 上限判定依据）
    invitee_ip: { type: DataTypes.STRING(64), allowNull: true },
    // 拒绝原因（self=自邀 / window=非新用户 / max_user=超单人上限 / max_ip=同 IP 超限 / daily_cap=当日发放达上限）
    reject_reason: { type: DataTypes.STRING(32), allowNull: true },
    // 奖励发放时间（当日发放上限计数依据）
    rewarded_at: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'referrals' });

  return Referral;
};
