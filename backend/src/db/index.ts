/**
 * PostgreSQL 连接模块：统一管理连接池生命周期
 * - 文件元信息 + LLM 设置的事实源（file.service / settings.service 读写），
 *   启动时必须连上（fail-fast），运行时故障统一翻译成 503（不可降级）
 * - 限流与 ai 缓存仍走 Redis（见 ../redis.ts），本模块只管 PG
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import { StorageUnavailableError } from '../utils/errors';
import * as schema from './schema';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.pgPoolMax,
  connectionTimeoutMillis: env.pgConnectTimeoutMs,
  idleTimeoutMillis: 30_000,
});

// 空闲连接出错（PG 重启等）必须接住，否则 Node 进程直接崩
pool.on('error', (err) => {
  console.warn('[pg] 连接池空闲连接异常（进程继续，后续请求自动重连）:', err.message);
});

export const db = drizzle(pool, { schema });

/** 启动连接：连不上直接抛错（元信息是事实源，不做降级） */
export async function connectDatabase(): Promise<void> {
  try {
    await pool.query('select 1');
    console.log(`[pg] 已连接: ${env.databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
  } catch (err) {
    throw new Error(
      `PostgreSQL 连接失败（${env.databaseUrl.replace(/:[^:@/]+@/, ':***@')}）: ${(err as Error).message}。` +
        '文件元信息与设置存储在 PostgreSQL，请先启动 PG（本机 PG16 服务 / docker compose up postgres）'
    );
  }
}

/** 健康探测（健康检查用），永不抛，500ms 超时 */
export async function pingDatabase(timeoutMs = 500): Promise<'ok' | 'down'> {
  const p = pool.query('select 1').then(() => 'ok' as const);
  p.catch(() => {}); // race 输掉时不产生未处理拒绝
  const t = new Promise<'down'>((resolve) => setTimeout(() => resolve('down'), timeoutMs));
  return Promise.race([p, t]);
}

/** 优雅关闭（SIGINT/SIGTERM 时调用） */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/**
 * 统一把 PG 错误翻译成 503（元信息/设置不可降级，不静默吞错）
 * 取代旧 Redis 版 r()/runMulti()：PG 事务失败无需逐命令检查
 */
export async function withDbError<T>(p: Promise<T>, label = '元信息存储不可用（PostgreSQL）'): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new StorageUnavailableError(`${label}: ${(err as Error).message}`);
  }
}
