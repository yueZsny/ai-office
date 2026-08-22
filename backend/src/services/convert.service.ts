/**
 * 转换业务逻辑：PDF → Word
 * - 接收上传的 PDF 文件
 * - 编排：调 ai-client.convert，生成下载 URL
 */
// TODO(功能阶段): 实现 convert，返回 { downloadUrl }
export const convertService = {
  convert(_file: Express.Multer.File): Promise<never> {
    throw new Error('未实现');
  },
};
