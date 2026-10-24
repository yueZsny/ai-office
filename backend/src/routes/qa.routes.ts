/**
 * 问答/摘要/思维导图路由
 * - POST /api/qa/ask      文档问答（流式 SSE）：
 *                          { fileId | fileIds, question, history?, conversationId? }
 *                          fileId/fileIds 均省略 = 全库问答（最近 50 篇已解析文档）
 *                          响应 text/event-stream：token* → sources → done
 *                          响应头：X-Conversation-Id（新建/复用会话）、X-Source-FileIds（引用映射）
 * - POST /api/qa/summary  生成摘要：{ fileId } → { summary }
 * - POST /api/qa/mindmap  生成思维导图：{ fileId, mode? } → { markdown }
 */
import { Router } from 'express';
import { env } from '../config/env';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { qaService } from '../services/qa.service';
import type { ChatMessage, MindmapMode } from '../types';

export const qaRouter = Router();

// 三个端点全走 LLM，是限流的最主要目标（per-IP 固定窗口）
const qaLimiter = rateLimit('qa', env.rateLimitQaPerWindow);

interface AskBody {
  fileId?: string;
  fileIds?: string[];
  question?: string;
  history?: ChatMessage[];
  conversationId?: string;
}

qaRouter.post('/ask', qaLimiter, async (req, res, next) => {
  try {
    const { fileId, fileIds, question, history, conversationId } = req.body as AskBody;
    // 校验（含 parsed 状态）失败时仍走 JSON 错误中间件（400/404/409/503）
    const result = await qaService.askStream({
      fileId,
      fileIds,
      question: question ?? '',
      history,
      conversationId,
    });

    // SSE 透传（service 已边转发边旁路解析落库）：
    // fileId 映射/会话 ID 经响应头下发，body 原样管道转发
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Source-FileIds', JSON.stringify(result.fileIdMap));
    res.setHeader('X-Conversation-Id', result.conversationId);
    // 浏览器断开时销毁源流，触发上游 reader.cancel（避免 LLM 继续空跑）
    res.on('close', () => {
      if (!res.writableEnded) result.stream.destroy();
    });
    result.stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

qaRouter.post('/summary', qaLimiter, async (req, res, next) => {
  try {
    const { fileId } = req.body as { fileId?: string };
    const result = await qaService.summarize(fileId ?? '');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

qaRouter.post('/mindmap', qaLimiter, async (req, res, next) => {
  try {
    const { fileId, mode } = req.body as { fileId?: string; mode?: MindmapMode };
    const result = await qaService.mindmap(fileId ?? '', mode);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
