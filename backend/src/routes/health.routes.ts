/**
 * 健康检查路由：GET /api/health
 * 返回 { status: "ok" }，用于探活
 */
import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok' });
});
