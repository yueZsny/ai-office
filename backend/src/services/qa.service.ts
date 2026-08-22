/**
 * 问答业务逻辑：文档问答与摘要
 * - 校验 fileId 存在且已解析
 * - 编排：调 ai-client.qa / ai-client.summary
 * - 维护对话历史（问答）
 */
// TODO(功能阶段): 实现 ask（问答，含历史传递）与 summarize（摘要）业务编排
export const qaService = {
  ask(_fileId: string, _question: string, _history?: unknown[]): Promise<never> {
    throw new Error('未实现');
  },
  summarize(_fileId: string): Promise<never> {
    throw new Error('未实现');
  },
};
