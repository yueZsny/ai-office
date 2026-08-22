/**
 * 生成业务逻辑：大纲 → Word 文档
 * - 校验 title / outline 输入
 * - 编排：调 ai-client.generate，生成下载 URL
 */
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../config/env';
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { ValidationError } from '../utils/errors';

/** 生成结果对应的原始文件名（下载时展示用） */
const RESULT_FILENAME = '生成文档.docx';

export const generateService = {
  /**
   * 大纲 → Word 文档
   * - title 非空、outline 为非空数组且每项非空
   * - 结果文件从 ai-service 的 PROCESSED_DIR 复制到本端 PROCESSED_DIR
   * - 登记元信息（无原始上传文件，用 ai-service 返回的 fileId 占位）
   */
  async generate(title: string, outline: string[]): Promise<{ downloadUrl: string }> {
    if (!title.trim()) throw new ValidationError('标题不能为空');
    if (!Array.isArray(outline) || outline.length === 0) {
      throw new ValidationError('大纲不能为空');
    }
    if (outline.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new ValidationError('大纲每项不能为空');
    }

    // 调 ai-service 生成，拿到结果文件路径（ai-service 视角）
    const result = await aiClient.generate({ title, outline });

    // 复制结果文件到本端 PROCESSED_DIR
    const storedName = path.basename(result.filePath);
    const dstPath = path.join(env.processedDir, storedName);
    await fs.mkdir(env.processedDir, { recursive: true });
    await fs.copyFile(result.filePath, dstPath);

    // 登记元信息（ai-service 的 fileId 与处理结果关联）
    const meta = await fileService.saveGenerated(
      result.fileId,
      RESULT_FILENAME,
      dstPath
    );

    return { downloadUrl: `/api/download/${meta.fileId}` };
  },
};
