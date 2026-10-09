/**
 * 一次性迁移：Redis 元信息 → PostgreSQL
 *
 * 触发条件：PG app_meta 无标记（且 Redis 无兜底标记），每次启动检查一次
 * - 幂等：INSERT ... ON CONFLICT DO NOTHING，先导入全部数据、最后才写标记；
 *   半途失败下次启动重跑（已存在行跳过，绝不覆盖——DO UPDATE 会把割接后
 *   已更新的记录回滚到冻结态，故禁用）
 * - 双标记：PG app_meta（随数据同生共死）+ Redis pg-imported（兜底，
 *   防 PG 单独恢复后 Redis 数据还在导致重复导入；任一存在即跳过）
 * - Redis 不可用只告警不写标记（下次启动重试），绝不阻断启动
 * - 扫描 0 条时打显眼告警（防「旧版本从未跑过、files.json 有数据但 Redis 空」
 *   时错误写入标记；恢复方式 = 删除 app_meta 标记后重启）
 * - settings 键 backend:settings:llm 一并导入 settings 表（key='llm'）
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { parseDate } from '../db/mappers';
import { appMeta, files, settings } from '../db/schema';
import { redis } from '../redis';
import type { FileMeta, LlmSettingsFile } from '../types';
import { fileKeys } from './file.keys';
import { settingsKeys } from './settings.keys';

/** 每批插入的条数 */
const BATCH_SIZE = 100;

/** PG 迁移标记键 */
export const IMPORT_MARKERS = {
  files: 'redis_files_imported',
  settings: 'redis_settings_imported',
} as const;

/** 扫描 Redis 全部单条元信息键（排除保留键），返回解析出的 FileMeta 列表 */
async function scanRedisMetas(): Promise<FileMeta[]> {
  const metas: FileMeta[] = [];
  const reserved = new Set(fileKeys.reserved);

  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${fileKeys.prefix}:*`, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      if (reserved.has(key)) continue;
      const raw = await redis.get(key);
      if (raw === null) continue;
      try {
        metas.push(JSON.parse(raw) as FileMeta);
      } catch {
        console.warn(`[migrate] 跳过损坏的元信息记录: ${key}`);
      }
    }
  } while (cursor !== '0');

  // 确定性顺序（与 list() 一致），便于日志与调试
  metas.sort((a, b) => {
    const ta = parseDate(a.createdAt).getTime();
    const tb = parseDate(b.createdAt).getTime();
    return tb - ta || b.fileId.localeCompare(a.fileId);
  });
  return metas;
}

async function hasPgMarker(key: string): Promise<boolean> {
  const rows = await db.select().from(appMeta).where(eq(appMeta.key, key)).limit(1);
  return rows.length > 0;
}

async function writePgMarker(key: string, count: number): Promise<void> {
  await db.insert(appMeta).values({
    key,
    value: { at: new Date().toISOString(), count, source: 'redis' },
  });
}

/** 导入文件元信息；返回导入条数（0 = 已迁移过或跳过） */
async function importFiles(): Promise<number> {
  // Redis 未就绪：不写任何标记，下次启动重试（ioredis 离线队列可能挂起命令，先查状态）
  if (redis.status !== 'ready') {
    console.warn('[migrate] Redis 未连接，跳过元信息迁移（下次启动重试）');
    return 0;
  }
  // 双标记：PG 标记或 Redis 兜底标记任一存在即跳过
  if (await hasPgMarker(IMPORT_MARKERS.files)) return 0;
  if (await redis.get(fileKeys.pgImported)) return 0;

  const metas = await scanRedisMetas();
  if (metas.length === 0) {
    console.warn(
      '[migrate] ⚠ Redis 中未发现文件元信息（0 条）仍写入迁移标记。' +
        '如旧版本曾在本机运行（files.json 有数据），说明 Redis 数据缺失，' +
        '请勿直接删光文件；恢复方式：删除 app_meta 的 redis_files_imported 标记后重启'
    );
  }

  for (let i = 0; i < metas.length; i += BATCH_SIZE) {
    const batch = metas.slice(i, i + BATCH_SIZE);
    await db
      .insert(files)
      .values(
        batch.map((m) => ({
          fileId: m.fileId,
          filename: m.filename,
          type: m.type,
          size: m.size,
          status: m.status,
          aiFileId: m.aiFileId ?? null,
          errorMessage: m.errorMessage ?? null,
          originalPath: m.originalPath,
          processedPath: m.processedPath ?? null,
          sha256: m.sha256 ?? null,
          createdAt: parseDate(m.createdAt),
          updatedAt: parseDate(m.updatedAt ?? m.createdAt),
        }))
      )
      .onConflictDoNothing();
  }

  // 最后才写标记：半途失败下次启动重跑（DO NOTHING 幂等）
  await writePgMarker(IMPORT_MARKERS.files, metas.length);
  // Redis 兜底标记（尽力而为，失败不阻断——PG 标记已落）
  try {
    await redis.set(fileKeys.pgImported, new Date().toISOString());
  } catch (err) {
    console.warn('[migrate] Redis 兜底标记写入失败（忽略，PG 标记已落）:', (err as Error).message);
  }

  return metas.length;
}

/** 导入 LLM 设置（backend:settings:llm → settings 表 key='llm'）；返回 1/0 */
async function importSettings(): Promise<number> {
  if (redis.status !== 'ready') {
    console.warn('[migrate] Redis 未连接，跳过设置迁移（下次启动重试）');
    return 0;
  }
  if (await hasPgMarker(IMPORT_MARKERS.settings)) return 0;

  const raw = await redis.get(settingsKeys.llm);
  if (raw === null) {
    // 未配置过设置：写标记，此后由 PG 全权负责
    await writePgMarker(IMPORT_MARKERS.settings, 0);
    return 0;
  }

  let data: LlmSettingsFile;
  try {
    data = JSON.parse(raw) as LlmSettingsFile;
  } catch {
    console.warn('[migrate] 跳过损坏的设置数据（backend:settings:llm）');
    await writePgMarker(IMPORT_MARKERS.settings, 0);
    return 0;
  }

  await db
    .insert(settings)
    .values({ key: settingsKeys.llmRow, value: data, updatedAt: new Date() })
    .onConflictDoNothing();
  await writePgMarker(IMPORT_MARKERS.settings, 1);
  return 1;
}

/** 启动时调用（warn-only：Redis/任何异常都不阻断启动） */
export async function importRedisDataToPg(): Promise<void> {
  try {
    const filesCount = await importFiles();
    if (filesCount > 0) {
      console.log(`[migrate] 已从 Redis 导入 ${filesCount} 条文件元信息到 PostgreSQL`);
    }
    const settingsCount = await importSettings();
    if (settingsCount > 0) {
      console.log('[migrate] 已从 Redis 导入 LLM 设置到 PostgreSQL');
    }
  } catch (err) {
    console.warn('[migrate] Redis → PostgreSQL 迁移未完成（下次启动重试）:', (err as Error).message);
  }
}
