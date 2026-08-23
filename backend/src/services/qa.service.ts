/**
 * 问答业务逻辑：文档问答与摘要
 * - 校验 fileId / question 输入
 * - 校验文件已解析（规格 5.4：问答/摘要仅接受 parsed 状态，未解析返回 409）
 * - 编排：调 ai-client.qa / ai-client.summary
 * - 维护对话历史（问答，由前端透传 history）
 *
 * 注：对外 fileId（backend 生成）与 ai-service 内部检索键（aiFileId）不同，
 * 转发时使用 meta.aiFileId（见 upload.routes 解析流程）。
 */
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import type { ChatMessage, QaAskResponse, SummaryResponse } from '../types';
import { ConflictError, ValidationError } from '../utils/errors';

/** 取文件并校验已解析，返回带 aiFileId 的元信息（未解析抛 409） */
async function requireParsed(fileId: string) {
  const meta = await fileService.getById(fileId);
  if (meta.status !== 'parsed') {
    throw new ConflictError('该文件尚未解析，请等待解析完成');
  }
  return meta;
}

export const qaService = {
  /** 文档问答：校验输入 → 透传 history → 调 ai-client.qa */
  async ask(
    fileId: string,
    question: string,
    history?: ChatMessage[]
  ): Promise<QaAskResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');
    if (!question.trim()) throw new ValidationError('问题不能为空');

    const meta = await requireParsed(fileId);
    const result = await aiClient.qa({
      fileId: meta.aiFileId ?? meta.fileId,
      question,
      history,
    });
    return { answer: result.answer, sources: result.sources };
  },

  /** 生成摘要：校验 fileId → 调 ai-client.summary */
  async summarize(fileId: string): Promise<SummaryResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');

    const meta = await requireParsed(fileId);
    const result = await aiClient.summary({ fileId: meta.aiFileId ?? meta.fileId });
    return { summary: result.summary };
  },
};
