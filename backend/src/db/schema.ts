/**
 * PostgreSQL 表结构定义（Drizzle pgTable）
 * - files   : 文件元信息（原 Redis backend:files:* 的事实源）
 * - settings: 键值配置（原 Redis backend:settings:llm；key='llm' 与 ai-service config_store.py 镜像）
 * - app_meta: 应用级元信息（一次性迁移标记等）
 *
 * 设计要点：
 * - file_id 用 text 而非 uuid：saveGenerated 原样存 ai-service 生成的 32 位 hex id，
 *   uuid 列会在读取时规范化格式，导致对外 fileId 失配（下载/导入 404）
 * - status/type 用 text+CHECK 而非 pgEnum：Drizzle 迁移在事务内执行，
 *   ALTER TYPE ADD VALUE 无法同事务使用，下期加状态会疼
 * - 去重索引 files_dedup_idx 非唯一：saveAsConverted 故意不去重，
 *   同一 (sha256, filename) 允许多条 dedup-active 记录（唯一索引会打断转换链路）
 * - user_id 为二期用户系统预留列，本期无写入
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { FileStatus, FileType, LlmSettingsFile } from '../types';

export const files = pgTable(
  'files',
  {
    fileId: text('file_id').primaryKey(),
    filename: text('filename').notNull(),
    type: text('type')
      .$type<FileType>()
      .notNull(),
    size: integer('size').notNull().default(0),
    status: text('status')
      .$type<FileStatus>()
      .notNull()
      .default('uploaded'),
    aiFileId: text('ai_file_id'),
    errorMessage: text('error_message'),
    originalPath: text('original_path').notNull(),
    processedPath: text('processed_path'),
    sha256: text('sha256'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 二期用户系统预留：本期无写入、无 FK */
    userId: text('user_id'),
  },
  (t) => [
    check('files_type_check', sql`${t.type} IN ('pdf','docx','image')`),
    check(
      'files_status_check',
      sql`${t.status} IN ('uploaded','parsing','parsed','converted','failed')`
    ),
    // list()：ORDER BY created_at DESC, file_id DESC
    index('files_created_at_idx').on(t.createdAt, t.fileId),
    // recoverStaleParsingTasks()：等价于旧 backend:files:parsing ZSET（只含 parsing，O(在途)）
    index('files_parsing_idx').on(t.updatedAt).where(sql`${t.status} = 'parsing'`),
    // 去重查询（非唯一！）：WHERE sha256 IS NOT NULL AND status <> 'failed'
    index('files_dedup_idx')
      .on(t.sha256, t.filename)
      .where(sql`${t.sha256} IS NOT NULL AND ${t.status} <> 'failed'`),
  ]
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<LlmSettingsFile>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
