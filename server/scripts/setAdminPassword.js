/**
 * 管理台密码设置/重置（一次性维护工具）。
 *
 * 背景：经 xworld 晋级的 admin 本地密码为随机占位哈希，compare 必然失败，
 * 无法登录 /admin 管理台；而重置入口「用户管理」又在管理台内——首个 admin
 * 存在先有鸡还是先有蛋的死锁，须用本脚本直接落库设置密码（等价于
 * PUT /admin/users/:id/password，含同样的 8-64 位校验）。
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/setAdminPassword.js <用户名或邮箱> <新密码8-64位>
 */
import db from '../src/db/index.js';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';

const [identifier, password] = process.argv.slice(2);
if (!identifier || !password) {
  console.error('用法: node scripts/setAdminPassword.js <用户名或邮箱> <新密码8-64位>');
  process.exit(1);
}
if (password.length < 8 || password.length > 64) {
  console.error('密码长度须为 8-64 位');
  process.exit(1);
}

const { User } = db;
const user = await User.findOne({
  where: identifier.includes('@')
    ? { [Op.or]: [{ username: identifier }, { email: identifier }] }
    : { username: identifier },
});
if (!user) {
  console.error(`账号不存在: ${identifier}`);
  process.exit(1);
}

user.password_hash = await bcrypt.hash(password, 10);
await user.save();
console.log(`已设置密码: id=${user.id} username=${user.username} role=${user.role}`);
process.exit(0);
