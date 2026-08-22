/**
 * 问答业务逻辑：文档问答与摘要
 * - 校验 fileId / question 输入
 * - 编排：调 ai-client.qa / ai-client.summary
 * - 维护对话历史（问答，由前端透传 history）
 *
 * 注：fileId 语义为 ai-service 解析生成的 fileId（RAG 按此检索）；
 * 文件是否已解析由 ai-service 校验（未解析返回 400）
 */
import { aiClient } from './ai-client.service';
import type { ChatMessage, QaAskResponse, SummaryResponse } from '../types';
import { ValidationError } from '../utils/errors';

export const qaService = {
  /** 文档问答：校验输入 → 透传 history → 调 ai-client.qa */
  async ask(
    fileId: string,
    question: string,
    history?: ChatMessage[]
  ): Promise<QaAskResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');
    if (!question.trim()) throw new ValidationError('问题不能为空');

    const result = await aiClient.qa({ fileId, question, history });
    return { answer: result.answer, sources: result.sources };
  },

  /** 生成摘要：校验 fileId → 调 ai-client.summary */
  async summarize(fileId: string): Promise<SummaryResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');

    const result = await aiClient.summary({ fileId });
    return { summary: result.summary };
  },
};
