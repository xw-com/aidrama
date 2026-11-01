import { sequelize } from '../db/index.js';
import { runSeed } from './seed.js';
import { logger } from '../utils/logger.js';

async function main() {
  await sequelize.authenticate();
  await sequelize.sync();
  const res = await runSeed();
  logger.info('Seed 完成:', res);
  await sequelize.close();
  process.exit(0);
}

main().catch((e) => {
  logger.error('Seed 失败:', e);
  process.exit(1);
});
