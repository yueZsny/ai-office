/**
 * 数据库迁移执行：启动时程序化跑 drizzle 迁移（单实例部署，无并发迁移问题）
 * - 幂等：drizzle 用 __drizzle_migrations 表记账，已应用的迁移自动跳过
 * - 路径用 __dirname 推导（src/db → backend/drizzle，dist/db → /app/drizzle），
 *   不依赖 cwd 和环境变量
 */
import path from 'path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './index';

export async function runMigrations(): Promise<void> {
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, '../../drizzle'),
  });
}
