/**
 * Redis 客户端模块：统一管理连接生命周期
 * - 仅用于限流计数（fail-open）与健康检查；文件元信息/设置的事实源已迁 PostgreSQL
 * - 连接失败只告警不退出（由 index.ts 决定降级策略），运行时断线无限重连自愈
 * - 键名不在此定义（限流键见 middleware/rate-limit.middleware.ts；旧元信息键已冻结，
 *   仅 redis-import.service.ts 的迁移脚本还在读，见 services/file.keys.ts）
 */
import Redis from 'ioredis';
import { env } from './config/env';

export const redis = new Redis(env.redisUrl, {
  lazyConnect: true, // 连接时机由 connectRedis 控制（启动 fail-fast）
  connectTimeout: env.redisConnectTimeoutMs,
  maxRetriesPerRequest: 2, // 单条命令最多重试 2 次即抛错，请求不会挂死
  enableOfflineQueue: true, // 瞬时断线（重连抖动）期间命令短暂排队，好过立刻失败
  retryStrategy: (times) => Math.min(times * 200, 2000), // 运行时断线无限重连（Redis 恢复即自愈）
});

redis.on('error', (err) => {
  // ioredis 断线期间会持续 emit error（retryStrategy 负责重连），只告警不退出进程
  console.warn('[redis] 连接异常（进程继续，等待重连）:', err.message);
});

/**
 * 启动连接：连不上抛错，由调用方（index.ts）决定告警降级还是退出
 * - ioredis 断线会无限重连，connect() 可能永不 reject，故用超时 race 兜底
 */
export async function connectRedis(): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Redis 连接超时（${env.redisConnectTimeoutMs}ms）`)),
      env.redisConnectTimeoutMs
    );
  });

  try {
    await Promise.race([redis.connect(), timeout]);
    console.log(`[redis] 已连接: ${env.redisUrl}`);
  } catch (err) {
    throw new Error(
      `Redis 连接失败（${env.redisUrl}）: ${(err as Error).message}。` +
        '仅限流计数受影响（fail-open），文件元信息已存 PostgreSQL'
    );
  }
}

/** 健康探测（健康检查/限流前用），永不抛，500ms 超时 */
export async function pingRedis(timeoutMs = 500): Promise<'ok' | 'down'> {
  try {
    const p = redis.ping();
    const t = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs));
    await Promise.race([p, t]);
    return 'ok';
  } catch {
    return 'down';
  }
}

/** 优雅关闭（SIGINT/SIGTERM 时调用） */
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
