/**
 * 问答业务逻辑：文档问答（单文件 / 多文件）与摘要
 * - 校验 fileId/fileIds / question 输入
 * - 校验文件已解析（规格 5.4：问答/摘要仅接受 parsed 状态，未解析返回 409，
 *   多文件时指名哪个文件未解析）
 * - 编排：调 ai-client.qa / ai-client.summary
 * - 维护对话历史（问答，由前端透传 history）
 *
 * 注：对外 fileId（backend 生成）与 ai-service 内部检索键（aiFileId）不同，
 * 转发时使用 meta.aiFileId，返回的 sources.fileId 再映射回对外 fileId（前端拼下载地址用）。
 */
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import type { ChatMessage, MindmapMode, MindmapResponse, SummaryResponse } from '../types';
import { ConflictError, ValidationError } from '../utils/errors';

/** 取文件并校验已解析，返回带 aiFileId 的元信息（未解析抛 409，指名文件名） */
async function requireParsed(fileId: string) {
  const meta = await fileService.getById(fileId);
  if (meta.status !== 'parsed') {
    throw new ConflictError(`文件「${meta.filename}」尚未解析，请等待解析完成`);
  }
  return meta;
}

export const qaService = {
  /**
   * 文档问答（流式）：校验输入 → 逐文件校验 parsed → 调 ai-client.qaStream
   * 返回 { stream, fileIdMap }：stream 为 ai-service 的 SSE 响应（透传给浏览器）；
   * fileIdMap 为 aiFileId → 对外 fileId 映射，流透传后无法在服务端改写
   * sources.fileId，改经响应头下发由前端翻译。
   */
  async askStream(
    fileId: string,
    question: string,
    history?: ChatMessage[],
    fileIds?: string[]
  ): Promise<{ stream: Response; fileIdMap: Record<string, string> }> {
    const ids = fileIds?.length ? fileIds : fileId ? [fileId] : [];
    if (!ids.length) throw new ValidationError('fileId 不能为空');
    if (!question.trim()) throw new ValidationError('问题不能为空');

    // 逐文件校验已解析（404 消息含 fileId，前端据此剔除被删项）
    const metas = await Promise.all(ids.map((id) => requireParsed(id)));

    // 对外 fileId → ai-service 检索键
    const toAiId = new Map(metas.map((m) => [m.fileId, m.aiFileId ?? m.fileId]));
    const stream = await aiClient.qaStream({
      fileIds: metas.map((m) => toAiId.get(m.fileId)!),
      question,
      history,
    });
    const fileIdMap = Object.fromEntries(
      metas.map((m) => [m.aiFileId ?? m.fileId, m.fileId])
    );
    return { stream, fileIdMap };
  },

  /** 生成摘要：校验 fileId → 调 ai-client.summary */
  async summarize(fileId: string): Promise<SummaryResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');

    const meta = await requireParsed(fileId);
    const result = await aiClient.summary({ fileId: meta.aiFileId ?? meta.fileId });
    return { summary: result.summary };
  },

  /** 生成思维导图：校验 fileId → 调 ai-client.mindmap（mode 默认 auto） */
  async mindmap(fileId: string, mode?: MindmapMode): Promise<MindmapResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');

    const meta = await requireParsed(fileId);
    const result = await aiClient.mindmap({
      fileId: meta.aiFileId ?? meta.fileId,
      mode: mode ?? 'auto',
    });
    return { markdown: result.markdown };
  },
};
