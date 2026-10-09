/**
 * 迁移 CLI：手动执行数据库迁移（npm run db:migrate）
 * 运行时启动也会自动执行（index.ts），本脚本供手动/CI 场景使用
 */
import 'dotenv/config';
import { closeDatabase } from './index';
import { runMigrations } from './migrate';

runMigrations()
  .then(() => console.log('[db] 迁移完成'))
  .catch((err) => {
    console.error('[db] 迁移失败:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
