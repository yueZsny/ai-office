/**
 * 文件服务：负责文件存储与元信息管理
 * - 上传文件保存到 UPLOAD_DIR（uuid 重命名）
 * - 元信息读写 data/files.json（FileMeta 数组）
 */
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../config/env';
import type { FileMeta, FileStatus } from '../types';
import { extname, generateId } from '../utils/file.utils';
import { NotFoundError } from '../utils/errors';

/**
 * 读取全部文件元信息（files.json 不存在时返回空数组）
 */
async function readMeta(): Promise<FileMeta[]> {
  try {
    const raw = await fs.readFile(env.metaFile, 'utf-8');
    return JSON.parse(raw) as FileMeta[];
  } catch (err) {
    // 文件不存在 → 视为空；JSON 损坏则抛出（避免静默丢数据）
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * 原子写入全部元信息（先写临时文件再 rename，避免写入中断损坏数据）
 */
async function writeMeta(meta: FileMeta[]): Promise<void> {
  await fs.mkdir(path.dirname(env.metaFile), { recursive: true });
  const tmp = `${env.metaFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  await fs.rename(tmp, env.metaFile);
}

export const fileService = {
  /**
   * 保存上传文件并写入元信息
   * - 文件以 uuid + 原扩展名存入 UPLOAD_DIR
   * - 元信息（status=uploaded）追加到 files.json
   */
  async save(file: Express.Multer.File): Promise<FileMeta> {
    const fileId = generateId();
    const ext = extname(file.originalname);
    const storedName = `${fileId}${ext}`;

    await fs.mkdir(env.uploadDir, { recursive: true });
    await fs.writeFile(path.join(env.uploadDir, storedName), file.buffer);

    const meta: FileMeta = {
      fileId,
      filename: file.originalname,
      type: ext === '.docx' ? 'docx' : 'pdf',
      size: file.size,
      status: 'uploaded',
      originalPath: path.join(env.uploadDir, storedName),
      createdAt: new Date().toISOString(),
    };

    const all = await readMeta();
    all.push(meta);
    await writeMeta(all);

    return meta;
  },

  /** 按 fileId 查询元信息，不存在时抛 NotFoundError（404） */
  async getById(fileId: string): Promise<FileMeta> {
    const all = await readMeta();
    const meta = all.find((m) => m.fileId === fileId);
    if (!meta) throw new NotFoundError(`文件不存在: ${fileId}`);
    return meta;
  },

  /** 更新指定文件的处理状态，返回更新后的元信息 */
  async updateStatus(
    fileId: string,
    status: FileStatus,
    processedPath?: string
  ): Promise<FileMeta> {
    const all = await readMeta();
    const meta = all.find((m) => m.fileId === fileId);
    if (!meta) throw new NotFoundError(`文件不存在: ${fileId}`);

    meta.status = status;
    if (processedPath) meta.processedPath = processedPath;
    await writeMeta(all);

    return meta;
  },

  /** 列出全部文件元信息（倒序：新上传的在前） */
  async list(): Promise<FileMeta[]> {
    const all = await readMeta();
    return all.slice().reverse();
  },
};
