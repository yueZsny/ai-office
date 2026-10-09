/**
 * files 表行 ↔ FileMeta 映射：Date ⇄ ISO 字符串、NULL → undefined 双向转换
 * - 业务层（file.service 及路由）只接触 FileMeta，绝不接触表行结构
 * - 遗留数据容忍：旧记录可能缺 sha256 / updatedAt（files.json 时期数据实测如此）
 */
import type { FileMeta } from '../types';
import type { files } from './schema';

export type FileRow = typeof files.$inferSelect;
export type FileRowInsert = typeof files.$inferInsert;

/** 解析 ISO 时间串，无法解析时回退 now（复刻旧实现 Date.parse(x) || Date.now() 语义） */
export function parseDate(value: string | undefined | null, fallback: Date = new Date()): Date {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? fallback : new Date(ms);
}

export function rowToFileMeta(row: FileRow): FileMeta {
  return {
    fileId: row.fileId,
    filename: row.filename,
    type: row.type,
    size: row.size,
    status: row.status,
    aiFileId: row.aiFileId ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    originalPath: row.originalPath,
    processedPath: row.processedPath ?? undefined,
    sha256: row.sha256 ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 全量行字段（writeMeta 唯一写出口用） */
export function fileMetaToInsert(meta: FileMeta): FileRowInsert {
  return {
    fileId: meta.fileId,
    filename: meta.filename,
    type: meta.type,
    size: meta.size,
    status: meta.status,
    aiFileId: meta.aiFileId ?? null,
    errorMessage: meta.errorMessage ?? null,
    originalPath: meta.originalPath,
    processedPath: meta.processedPath ?? null,
    sha256: meta.sha256 ?? null,
    createdAt: parseDate(meta.createdAt),
    updatedAt: parseDate(meta.updatedAt ?? meta.createdAt),
  };
}
