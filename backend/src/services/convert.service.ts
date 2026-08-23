/**
 * 转换业务逻辑：PDF → Word
 * - 接收上传的 PDF 文件
 * - 编排：调 ai-client.convert，生成下载 URL
 * - 结果文件由 ai-service 写入共享 PROCESSED_DIR（共享挂载方案），
 *   后端直接登记 ai-service 返回的 filePath 供下载，不做复制
 *   （docker 下两端共享同一挂载目录，路径互通）
 */
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { extname } from '../utils/file.utils';
import { ValidationError } from '../utils/errors';

export const convertService = {
  /**
   * PDF → Word 转换
   * - 文件扩展名需为 .pdf
   * - 结果文件由 ai-service 写入共享目录，登记其 filePath 供下载
   */
  async convert(file: Express.Multer.File): Promise<{ fileId: string; downloadUrl: string }> {
    if (extname(file.originalname) !== '.pdf') {
      throw new ValidationError('仅支持 PDF 文件');
    }

    // 调 ai-service 转换，拿到结果文件路径（共享目录内）
    const result = await aiClient.convert(file);

    // 登记元信息：结果文件 + converted 状态
    const meta = await fileService.saveAsConverted(file, result.filePath);

    // 按规格 5.2 契约返回 fileId + downloadUrl（前端 ResultDownload 用 fileId 拼接下载）
    return { fileId: meta.fileId, downloadUrl: `/api/download/${meta.fileId}` };
  },
};
