/**
 * 大纲生成文档路由：POST /api/generate/doc
 * 请求：{ title, outline: string[] }
 * 响应：{ downloadUrl }
 */
import { Router } from 'express';

export const generateRouter = Router();

// TODO(功能阶段): 实现生成（校验 title/outline → 调 generate.service → 调 ai-client.generate）
generateRouter.post('/doc', (_req, res) => {
  res.status(501).json({ error: { message: '该功能尚未实现' } });
});
