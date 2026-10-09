/**
 * 解析服务：后台异步解析任务（上传与「生成文档加入知识库」共用）
 */
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';

/** 可提交给 ai-service /ai/parse 的文件形态 */
export interface ParseableFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * 后台解析（fire-and-forget）：
 * - 成功：记录 aiFileId 并置 parsed
 * - 失败：置 failed 并记录 errorMessage
 */
export async function parseFileInBackground(
  fileId: string,
  file: ParseableFile
): Promise<void> {
  try {
    const { fileId: aiFileId } = await aiClient.parseFromBuffer(file);
    await fileService.updateAiFileId(fileId, aiFileId);
    await fileService.updateStatus(fileId, 'parsed');
  } catch (err) {
    const message = (err as Error).message || '解析失败';
    try {
      await fileService.updateStatus(fileId, 'failed', undefined, message);
    } catch (updateErr) {
      // 解析期间文件被删除 → updateStatus 抛 NotFoundError；
      // 本函数 fire-and-forget（void 调用），异常会变成未处理拒绝杀死进程（Node 默认行为）
      console.warn(`[parse] 记录状态更新失败（文件可能已删除）: ${fileId}`, updateErr);
    }
  }
}
