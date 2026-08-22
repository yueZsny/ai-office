/**
 * 生成业务逻辑：大纲 → Word 文档
 * - 校验 title / outline 输入
 * - 编排：调 ai-client.generate，生成下载 URL
 */
// TODO(功能阶段): 实现 generate，返回 { downloadUrl }
export const generateService = {
  generate(_title: string, _outline: string[]): Promise<never> {
    throw new Error('未实现');
  },
};
