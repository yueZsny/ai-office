/**
 * 转换业务逻辑：PDF → Word
 * - 接收上传的 PDF 文件
 * - 编排：调 ai-client.convert，生成下载 URL
 */
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../config/env';
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { extname } from '../utils/file.utils';
import { ValidationError } from '../utils/errors';

export const convertService = {
  /**
   * PDF → Word 转换
   * - 文件扩展名需为 .pdf
   * - 结果文件从 ai-service 的 PROCESSED_DIR 复制到本端 PROCESSED_DIR
   *   （本地开发两端共享目录时复制是幂等的；docker 下路径不互通则必须复制）
   */
  async convert(file: Express.Multer.File): Promise<{ downloadUrl: string }> {
    if (extname(file.originalname) !== '.pdf') {
      throw new ValidationError('仅支持 PDF 文件');
    }

    // 调 ai-service 转换，拿到结果文件路径（ai-service 视角）
    const result = await aiClient.convert(file);

    // 复制结果文件到本端 PROCESSED_DIR，使用本端生成的文件名
    const storedName = path.basename(result.filePath);
    const dstPath = path.join(env.processedDir, storedName);
    await fs.mkdir(env.processedDir, { recursive: true });
    await fs.copyFile(result.filePath, dstPath);

    // 登记元信息：结果文件 + converted 状态
    const meta = await fileService.saveAsConverted(file, dstPath);

    return { downloadUrl: `/api/download/${meta.fileId}` };
  },
};
