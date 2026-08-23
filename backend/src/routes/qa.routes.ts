/**
 * 问答/摘要/思维导图路由
 * - POST /api/qa/ask      文档问答（流式 SSE）：{ fileId | fileIds, question, history? }
 *                          响应 text/event-stream：token* → sources → done
 * - POST /api/qa/summary  生成摘要：{ fileId } → { summary }
 * - POST /api/qa/mindmap  生成思维导图：{ fileId, mode? } → { markdown }
 */
import { Readable } from 'stream';
import { Router } from 'express';
import { qaService } from '../services/qa.service';
import type { ChatMessage, MindmapMode } from '../types';

export const qaRouter = Router();

interface AskBody {
  fileId?: string;
  fileIds?: string[];
  question?: string;
  history?: ChatMessage[];
}

qaRouter.post('/ask', async (req, res, next) => {
  try {
    const { fileId, fileIds, question, history } = req.body as AskBody;
    // 校验（含 parsed 状态）失败时仍走 JSON 错误中间件（400/404/409）
    const { stream, fileIdMap } = await qaService.askStream(
      fileId ?? '',
      question ?? '',
      history,
      fileIds
    );

    // SSE 透传：fileId 映射经响应头下发（前端据此翻译 sources.fileId），body 原样管道转发
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Source-FileIds', JSON.stringify(fileIdMap));
    Readable.fromWeb(stream.body as import('stream/web').ReadableStream).pipe(res);
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

qaRouter.post('/mindmap', async (req, res, next) => {
  try {
    const { fileId, mode } = req.body as { fileId?: string; mode?: MindmapMode };
    const result = await qaService.mindmap(fileId ?? '', mode);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
