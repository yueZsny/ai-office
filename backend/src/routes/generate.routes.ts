/**
 * 大纲生成文档路由：POST /api/generate/doc
 * 请求：{ title, outline: string[] }
 * 响应：{ downloadUrl }
 */
import { Router } from 'express';
import { generateService } from '../services/generate.service';

export const generateRouter = Router();

generateRouter.post('/doc', async (req, res, next) => {
  try {
    const { title, outline } = req.body as {
      title?: string;
      outline?: string[];
    };
    const result = await generateService.generate(title ?? '', outline ?? []);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
