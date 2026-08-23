/**
 * 生成业务逻辑：大纲 → Word 文档
 * - 校验 title / outline 输入
 * - 编排：调 ai-client.generate，生成下载 URL
 * - 结果文件由 ai-service 写入共享 PROCESSED_DIR，后端直接登记 filePath 供下载
 */
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { ValidationError } from '../utils/errors';

/** 生成结果对应的原始文件名（下载时展示用） */
const RESULT_FILENAME = '生成文档.docx';

export const generateService = {
  /**
   * 大纲 → Word 文档
   * - title 非空、outline 为非空数组且每项非空
   * - 登记元信息（无原始上传文件，用 ai-service 返回的 fileId 占位）
   */
  async generate(title: string, outline: string[]): Promise<{ fileId: string; downloadUrl: string }> {
    if (!title.trim()) throw new ValidationError('标题不能为空');
    if (!Array.isArray(outline) || outline.length === 0) {
      throw new ValidationError('大纲不能为空');
    }
    if (outline.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new ValidationError('大纲每项不能为空');
    }

    // 调 ai-service 生成，拿到结果文件路径（共享目录内）
    const result = await aiClient.generate({ title, outline });

    // 登记元信息（ai-service 的 fileId 与处理结果关联）
    const meta = await fileService.saveGenerated(
      result.fileId,
      RESULT_FILENAME,
      result.filePath
    );

    // 按规格 5.2 契约返回 fileId + downloadUrl（前端 ResultDownload 用 fileId 拼接下载）
    return { fileId: meta.fileId, downloadUrl: `/api/download/${meta.fileId}` };
  },
};
