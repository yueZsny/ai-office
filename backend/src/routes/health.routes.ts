/**
 * 健康检查路由：GET /api/health
 * 返回 { status: "ok", postgres: "ok"|"down", redis: "ok"|"down" }，用于探活
 * - status 恒为 "ok"（smoke-test 与部署探活断言它）
 * - postgres 是事实源（down 时业务端点返回 503）；redis 仅限流（down 不阻断业务）
 * - 两个字段仅反映探测瞬间的连通性，运行中断线会自动重连
 */
import { Router } from 'express';
import { pingDatabase } from '../db';
import { pingRedis } from '../redis';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  res.json({ status: 'ok', postgres: await pingDatabase(), redis: await pingRedis() });
});
