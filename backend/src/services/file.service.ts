/**
 * 文件服务：负责文件存储与元信息管理
 * - 上传文件保存到 UPLOAD_DIR（uuid 重命名）
 * - 元信息存储于 PostgreSQL（事实源）：files 表 + created_at/parsing/dedup 三个索引
 *   （表结构见 db/schema.ts；旧 Redis 键仅作一次性迁移源，进程不再读写）
 * - 所有创建写入收口到 writeMeta()；PG 故障一律 503（元信息不可降级）
 */
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../config/env';
import { db, withDbError } from '../db';
import { fileMetaToInsert, rowToFileMeta } from '../db/mappers';
import { files } from '../db/schema';
import type { FileMeta, FileStatus } from '../types';
import { extname, generateId, resolveFileType } from '../utils/file.utils';
import { normalizeUploadName } from '../utils/filename';
import { NotFoundError } from '../utils/errors';

/** 计算文件内容指纹（幂等去重用） */
function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 单条读取元信息，不存在返回 null（内部用，不抛 404） */
async function readMeta(fileId: string): Promise<FileMeta | null> {
  const rows = await withDbError(
    db.select().from(files).where(eq(files.fileId, fileId)).limit(1)
  );
  return rows.length ? rowToFileMeta(rows[0]) : null;
}

/**
 * 单条创建元信息（唯一 INSERT 写出口，save/saveAsConverted/saveGenerated 三条创建路径收口于此）
 * 表上的 created_at/parsing/dedup 索引由数据库自动维护，无需（也不再可能）散落各处
 */
async function writeMeta(meta: FileMeta): Promise<FileMeta> {
  await withDbError(db.insert(files).values(fileMetaToInsert(meta)));
  return meta;
}

/**
 * 去重查询（复刻旧 dedup HASH 的 last-writer-wins 语义）：
 * - 命中条件 = 内容指纹 + 规范化文件名一致 且 记录非 failed（失败重试应重新解析）
 * - 同 (sha256, filename) 有多条时取最新创建的（HASH 只在插入时被覆盖指向最新者）
 * - 索引 files_dedup_idx 支撑（非唯一：saveAsConverted 故意不去重）
 */
async function findDedup(sha: string, filename: string): Promise<FileMeta | null> {
  const rows = await withDbError(
    db
      .select()
      .from(files)
      .where(and(eq(files.sha256, sha), eq(files.filename, filename), ne(files.status, 'failed')))
      .orderBy(desc(files.createdAt), desc(files.fileId))
      .limit(1)
  );
  return rows.length ? rowToFileMeta(rows[0]) : null;
}

export const fileService = {
  /**
   * 保存上传文件并写入元信息
   * - 文件以 uuid + 原扩展名存入 UPLOAD_DIR
   * - 元信息（status=uploaded）写入 PostgreSQL
   *
   * 幂等保护：内容 + 原文件名完全一致视为重复提交（如前端重复点击 / 失败重试），
   * 直接返回已存在的记录并清理本次落盘文件，避免同一次上传产生多余副本。
   */
  async save(file: Express.Multer.File): Promise<FileMeta> {
    const digest = sha256(file.buffer);
    const filename = normalizeUploadName(file.originalname);

    const dup = await findDedup(digest, filename);
    if (dup) {
      return dup; // 重复提交：返回既有记录，丢弃本次文件（不落盘）
    }

    const fileId = generateId();
    const ext = extname(file.originalname);
    const storedName = `${fileId}${ext}`;

    await fs.mkdir(env.uploadDir, { recursive: true });
    await fs.writeFile(path.join(env.uploadDir, storedName), file.buffer);

    const now = new Date().toISOString();
    const meta: FileMeta = {
      fileId,
      filename,
      type: resolveFileType(ext),
      size: file.size,
      status: 'uploaded',
      originalPath: path.join(env.uploadDir, storedName),
      sha256: digest,
      createdAt: now,
      updatedAt: now,
    };

    await writeMeta(meta);
    return meta;
  },

  /**
   * 转换/生成类流程：原始文件已由调用方（路由）落盘，这里登记一条带结果路径的元信息
   * - 原始文件与结果文件分别保存（保留原始文件供回退下载）
   * - status 直接置为 'converted'
   * 注：本路径故意不做去重检查——同一内容转换两次会登记两条记录
   * （上传一个曾转换过的同内容文件会命中去重，属已知怪行为，暂不动）。
   */
  async saveAsConverted(
    originalFile: Express.Multer.File,
    processedPath: string
  ): Promise<FileMeta> {
    const fileId = generateId();
    const ext = extname(originalFile.originalname);
    const storedName = `${fileId}${ext}`;
    const originalPath = path.join(env.uploadDir, storedName);

    await fs.mkdir(env.uploadDir, { recursive: true });
    await fs.writeFile(originalPath, originalFile.buffer);

    const now = new Date().toISOString();
    const meta: FileMeta = {
      fileId,
      filename: normalizeUploadName(originalFile.originalname),
      type: resolveFileType(ext),
      size: originalFile.size,
      status: 'converted',
      originalPath,
      processedPath,
      sha256: sha256(originalFile.buffer),
      createdAt: now,
      updatedAt: now,
    };

    await writeMeta(meta);
    return meta;
  },

  /**
   * 生成类流程（无原始上传文件）：直接登记一条含结果路径的元信息
   * - fileId 采用调用方传入的 id（与 ai-service 结果关联，注意其 32 位 hex 格式，
   *   files.file_id 因此必须用 text 而非 uuid 列）
   * - status 置为 'converted'（结果文件已就绪，可下载）
   * - 无 sha256 → 不参与去重（旧实现也不参与）
   */
  async saveGenerated(fileId: string, filename: string, processedPath: string): Promise<FileMeta> {
    const now = new Date().toISOString();
    const meta: FileMeta = {
      fileId,
      filename,
      type: 'docx',
      size: 0,
      status: 'converted',
      originalPath: processedPath,
      processedPath,
      createdAt: now,
      updatedAt: now,
    };

    await writeMeta(meta);
    return meta;
  },

  /** 按 fileId 查询元信息，不存在时抛 NotFoundError（404） */
  async getById(fileId: string): Promise<FileMeta> {
    const meta = await readMeta(fileId);
    if (!meta) throw new NotFoundError(`文件不存在: ${fileId}`);
    return meta;
  },

  /** 更新指定文件的处理状态，返回更新后的元信息 */
  async updateStatus(
    fileId: string,
    status: FileStatus,
    processedPath?: string,
    errorMessage?: string
  ): Promise<FileMeta> {
    // errorMessage 显式赋值（可清空）；processedPath 仅在有值时才覆盖（与旧语义一致）
    const updates: Record<string, unknown> = {
      status,
      errorMessage: errorMessage ?? null,
      updatedAt: new Date(),
    };
    if (processedPath) updates.processedPath = processedPath;

    const rows = await withDbError(
      db.update(files).set(updates).where(eq(files.fileId, fileId)).returning()
    );
    if (!rows.length) throw new NotFoundError(`文件不存在: ${fileId}`);
    return rowToFileMeta(rows[0]);
  },

  /** 记录 ai-service 返回的解析 fileId（问答/摘要转发用，见 qa.service） */
  async updateAiFileId(fileId: string, aiFileId: string): Promise<FileMeta> {
    const rows = await withDbError(
      db
        .update(files)
        .set({ aiFileId, updatedAt: new Date() })
        .where(eq(files.fileId, fileId))
        .returning()
    );
    if (!rows.length) throw new NotFoundError(`文件不存在: ${fileId}`);
    return rowToFileMeta(rows[0]);
  },

  /**
   * 列出全部文件元信息（倒序：新上传的在前）
   * - 直接按 created_at DESC, file_id DESC（file_id 兜底同毫秒的确定序）
   * - 无独立索引可悬空，自愈逻辑随 Redis 索引一起退役
   * - 状态过滤（仅 parsed）在路由层做，此处返回全量
   */
  async list(): Promise<FileMeta[]> {
    const rows = await withDbError(
      db.select().from(files).orderBy(desc(files.createdAt), desc(files.fileId))
    );
    return rows.map(rowToFileMeta);
  },

  /**
   * 删除文件：移除 PG 元信息并清理 backend 落盘的文件
   * - 记录不存在抛 NotFoundError（404）
   * - 去重索引随行删除自动清理，无需（也不再可能）条件维护
   * - 物理文件删除失败（ENOENT 等）不阻断，仅告警
   */
  async remove(fileId: string): Promise<FileMeta> {
    const rows = await withDbError(
      db.delete(files).where(eq(files.fileId, fileId)).returning()
    );
    if (!rows.length) throw new NotFoundError(`文件不存在: ${fileId}`);
    const meta = rowToFileMeta(rows[0]);

    // 清理物理文件：originalPath / processedPath 去重后逐个删除
    const paths = new Set<string>();
    for (const p of [meta.originalPath, meta.processedPath].filter(Boolean)) {
      paths.add(path.resolve(p!));
    }
    for (const abs of paths) {
      try {
        await fs.unlink(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[fileService] 删除文件失败（忽略）: ${abs}`, err);
        }
      }
    }

    return meta;
  },

  /**
   * 启动时恢复卡住的 parsing 任务（进程重启后 fire-and-forget 任务丢失）
   * - 只扫 status='parsing' 且 updated_at 超时的记录（files_parsing_idx 部分索引），
   *   O(在途) 而非 O(全量)
   * - 不续跑解析，仅将超时记录置为 failed，避免永久「解析中」
   * - 超时阈值见 env.parsingTimeoutMinutes；遗留行 updated_at 已按 created_at 导入
   */
  async recoverStaleParsingTasks(): Promise<number> {
    const timeoutMs = env.parsingTimeoutMinutes * 60 * 1000;
    const cutoff = new Date(Date.now() - timeoutMs);

    const rows = await withDbError(
      db
        .update(files)
        .set({
          status: 'failed',
          errorMessage: '解析中断（服务重启或超时），请重新上传',
          updatedAt: new Date(),
        })
        .where(and(eq(files.status, 'parsing'), lt(files.updatedAt, cutoff)))
        .returning({ fileId: files.fileId })
    );
    return rows.length;
  },
};
