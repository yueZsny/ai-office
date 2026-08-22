/**
 * 问答/摘要路由
 * - POST /api/qa/ask      文档问答：{ fileId, question, history? } → { answer, sources }
 * - POST /api/qa/summary  生成摘要：{ fileId } → { summary }
 */
import { Router } from 'express';

export const qaRouter = Router();

// TODO(功能阶段): 实现问答（校验 fileId → 调 qa.service → 调 ai-client.qa）
qaRouter.post('/ask', (_req, res) => {
  res.status(501).json({ error: { message: '该功能尚未实现' } });
});

// TODO(功能阶段): 实现摘要（校验 fileId → 调 qa.service → 调 ai-client.summary）
qaRouter.post('/summary', (_req, res) => {
  res.status(501).json({ error: { message: '该功能尚未实现' } });
});
