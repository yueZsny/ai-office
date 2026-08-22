/**
 * 问答/摘要路由
 * - POST /api/qa/ask      文档问答：{ fileId, question, history? } → { answer, sources }
 * - POST /api/qa/summary  生成摘要：{ fileId } → { summary }
 */
import { Router } from 'express';
import { qaService } from '../services/qa.service';
import type { ChatMessage } from '../types';

export const qaRouter = Router();

interface AskBody {
  fileId?: string;
  question?: string;
  history?: ChatMessage[];
}

qaRouter.post('/ask', async (req, res, next) => {
  try {
    const { fileId, question, history } = req.body as AskBody;
    const result = await qaService.ask(
      fileId ?? '',
      question ?? '',
      history
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

qaRouter.post('/summary', async (req, res, next) => {
  try {
    const { fileId } = req.body as { fileId?: string };
    const result = await qaService.summarize(fileId ?? '');
    res.json(result);
  } catch (err) {
    next(err);
  }
});
