/**
 * PDF→Word 转换路由：POST /api/convert/pdf2word
 * 请求：multipart 文件（file 字段，仅 .pdf）
 * 响应：{ downloadUrl }
 */
import { Router } from 'express';

export const convertRouter = Router();

// TODO(功能阶段): 实现转换（接收 PDF → 调 convert.service → 调 ai-client.convert）
convertRouter.post('/pdf2word', (_req, res) => {
  res.status(501).json({ error: { message: '该功能尚未实现' } });
});
