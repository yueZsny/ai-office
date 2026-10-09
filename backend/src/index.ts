/**
 * 入口文件：连接 PostgreSQL（fail-fast）→ 执行迁移 → 一次性导入 Redis 元信息 → 恢复卡住任务 → 启动 Express
 * Redis 已降级为限流计数（fail-open），连不上只告警不退出
 */
import 'dotenv/config';
import { app } from './app';
import { env } from './config/env';
import { closeDatabase, connectDatabase } from './db';
import { runMigrations } from './db/migrate';
import { closeRedis, connectRedis } from './redis';
import { fileService } from './services/file.service';
import { importRedisDataToPg } from './services/redis-import.service';

async function main(): Promise<void> {
  // 1. PostgreSQL（元信息事实源，连不上直接退出，不做降级）
  await connectDatabase();

  // 2. 执行数据库迁移（幂等：已应用的自动跳过）
  await runMigrations();

  // 3. Redis（仅限流计数，fail-open：连不上只告警，ioredis 断线自愈）
  try {
    await connectRedis();
  } catch (err) {
    console.warn('[backend] Redis 不可用（仅限流计数受影响，进程继续）:', (err as Error).message);
  }

  // 4. 一次性迁移：Redis 元信息 → PostgreSQL（有迁移标记则跳过，见 redis-import.service）
  await importRedisDataToPg();

  // 5. 恢复卡住的解析任务（进程重启后 fire-and-forget 任务丢失）
  const recovered = await fileService.recoverStaleParsingTasks();
  if (recovered > 0) {
    console.log(`[backend] 已恢复 ${recovered} 条卡住的解析任务（parsing → failed）`);
  }

  app.listen(env.port, () => {
    console.log(`[backend] 服务已启动: http://localhost:${env.port}`);
  });
}

// 优雅关闭：断开 PG 连接池与 Redis，避免命令写到一半
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void Promise.allSettled([closeDatabase(), closeRedis()]).finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[backend] 启动失败:', err.message);
  process.exit(1);
});
