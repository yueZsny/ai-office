/**
 * 文件服务：负责文件存储与元信息管理
 * - 上传文件保存到 UPLOAD_DIR（uuid 重命名）
 * - 元信息读写 data/files.json（FileMeta 数组）
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../config/env';
import type { FileMeta, FileStatus } from '../types';
import { extname, generateId } from '../utils/file.utils';
import { normalizeUploadName } from '../utils/filename';
import { NotFoundError } from '../utils/errors';

/** 计算文件内容指纹（幂等去重用） */
function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

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
   *
   * 幂等保护：内容 + 原文件名完全一致视为重复提交（如前端重复点击 / 失败重试），
   * 直接返回已存在的记录并清理本次落盘文件，避免同一次上传产生多余副本。
   */
  async save(file: Express.Multer.File): Promise<FileMeta> {
    const fileId = generateId();
    const ext = extname(file.originalname);
    const storedName = `${fileId}${ext}`;

    const all = await readMeta();
    const digest = sha256(file.buffer);
    const filename = normalizeUploadName(file.originalname);
    const dup = all.find(
      (m) => m.status !== 'failed' && m.filename === filename && m.sha256 === digest
    );

    // 重复提交：返回既有记录，丢弃本次文件（不落盘）
    if (dup) {
      return dup;
    }

    await fs.mkdir(env.uploadDir, { recursive: true });
    await fs.writeFile(path.join(env.uploadDir, storedName), file.buffer);

    const meta: FileMeta = {
      fileId,
      filename,
      type: ext === '.docx' ? 'docx' : 'pdf',
      size: file.size,
      status: 'uploaded',
      originalPath: path.join(env.uploadDir, storedName),
      sha256: digest,
      createdAt: new Date().toISOString(),
    };

    all.push(meta);
    await writeMeta(all);

    return meta;
  },

  /**
   * 转换/生成类流程：原始文件已由调用方（路由）落盘，这里登记一条带结果路径的元信息
   * - 原始文件与结果文件分别保存（保留原始文件供回退下载）
   * - status 直接置为 'converted'
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

    const meta: FileMeta = {
      fileId,
      filename: normalizeUploadName(originalFile.originalname),
      type: ext === '.docx' ? 'docx' : 'pdf',
      size: originalFile.size,
      status: 'converted',
      originalPath,
      processedPath,
      sha256: sha256(originalFile.buffer),
      createdAt: new Date().toISOString(),
    };

    const all = await readMeta();
    all.push(meta);
    await writeMeta(all);

    return meta;
  },

  /**
   * 生成类流程（无原始上传文件）：直接登记一条含结果路径的元信息
   * - fileId 采用调用方传入的 id（与 ai-service 结果关联）
   * - status 置为 'converted'（结果文件已就绪，可下载）
   */
  async saveGenerated(
    fileId: string,
    filename: string,
    processedPath: string
  ): Promise<FileMeta> {
    const meta: FileMeta = {
      fileId,
      filename,
      type: 'docx',
      size: 0,
      status: 'converted',
      originalPath: processedPath,
      processedPath,
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
    processedPath?: string,
    errorMessage?: string
  ): Promise<FileMeta> {
    const all = await readMeta();
    const meta = all.find((m) => m.fileId === fileId);
    if (!meta) throw new NotFoundError(`文件不存在: ${fileId}`);

    meta.status = status;
    if (processedPath) meta.processedPath = processedPath;
    meta.errorMessage = errorMessage ?? null;
    await writeMeta(all);

    return meta;
  },

  /** 记录 ai-service 返回的解析 fileId（问答/摘要转发用，见 qa.service） */
  async updateAiFileId(fileId: string, aiFileId: string): Promise<FileMeta> {
    const all = await readMeta();
    const meta = all.find((m) => m.fileId === fileId);
    if (!meta) throw new NotFoundError(`文件不存在: ${fileId}`);

    meta.aiFileId = aiFileId;
    await writeMeta(all);

    return meta;
  },

  /** 列出全部文件元信息（倒序：新上传的在前） */
  async list(): Promise<FileMeta[]> {
    const all = await readMeta();
    return all.slice().reverse();
  },

  /**
   * 删除文件：移除元信息记录并清理 backend 落盘的文件
   * - 记录不存在抛 NotFoundError（404）
   * - 物理文件删除失败（ENOENT 等）不阻断，仅告警
   */
  async remove(fileId: string): Promise<FileMeta> {
    const all = await readMeta();
    const meta = all.find((m) => m.fileId === fileId);
    if (!meta) throw new NotFoundError(`文件不存在: ${fileId}`);

    // 1. 写回元信息（原子写入，先移除记录）
    await writeMeta(all.filter((m) => m.fileId !== fileId));

    // 2. 清理物理文件：originalPath / processedPath 去重后逐个删除
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
};
