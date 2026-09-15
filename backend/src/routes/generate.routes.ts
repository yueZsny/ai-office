/**
 * 生成路由：
 * - POST /api/generate/doc      大纲生成文档（流式 SSE）：{ title, outline: string[], context? }
 *                               事件：section_start → section_done*（含全文）→ done（含 downloadUrl）| error
 * - POST /api/generate/outline  主题生成大纲：{ topic, sectionCount?, style? } → { markdown }
 * - POST /api/generate/section  单节生成/重生成：{ docTitle, sectionTitle, level?, requirement?, context? }
 *                               → { title, level, paragraphs, bullets }
 * - POST /api/generate/assemble 组装渲染：{ title, sections: [...] } → { fileId, downloadUrl }（不调 LLM）
 * - POST /api/generate/:fileId/import 生成文档加入知识库 → { fileId, status: 'parsing' }（202，后台解析）
 */
import { Router } from 'express';
import { generateService } from '../services/generate.service';
import type { SectionContent } from '../types';

export const generateRouter = Router();

generateRouter.post('/doc', async (req, res, next) => {
  try {
    const { title, outline, context } = req.body as {
      title?: string;
      outline?: string[];
      context?: string;
    };
    // 校验失败在 generate 内抛出 → JSON 错误中间件；成功则 SSE 透传
    const { stream } = generateService.generate(title ?? '', outline ?? [], context);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

generateRouter.post('/section', async (req, res, next) => {
  try {
    const { docTitle, sectionTitle, level, requirement, context } = req.body as {
      docTitle?: string;
      sectionTitle?: string;
      level?: number;
      requirement?: string;
      context?: string;
    };
    const result = await generateService.regenSection({
      docTitle: docTitle ?? '',
      sectionTitle: sectionTitle ?? '',
      level,
      requirement,
      context,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

generateRouter.post('/assemble', async (req, res, next) => {
  try {
    const { title, sections } = req.body as {
      title?: string;
      sections?: SectionContent[];
    };
    const result = await generateService.assemble(title ?? '', sections ?? []);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

generateRouter.post('/outline', async (req, res, next) => {
  try {
    const { topic, sectionCount, style } = req.body as {
      topic?: string;
      sectionCount?: number;
      style?: string;
    };
    const result = await generateService.outline(topic ?? '', sectionCount, style);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

generateRouter.post('/:fileId/import', async (req, res, next) => {
  try {
    const result = await generateService.importToKnowledgeBase(req.params.fileId);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});
