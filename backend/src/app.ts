/**
 * 应用装配：创建 Express 实例，注册中间件与全部路由
 * 分层约定：routes（路由）→ services（业务）→ ai-client（调用 Python AI 服务）
 */
import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { errorHandler } from './middleware/error.middleware';
import { healthRouter } from './routes/health.routes';
import { uploadRouter } from './routes/upload.routes';
import { downloadRouter } from './routes/download.routes';
import { qaRouter } from './routes/qa.routes';
import { convertRouter } from './routes/convert.routes';
import { generateRouter } from './routes/generate.routes';

export const app = express();

// CORS：允许来源从环境变量读取（默认 localhost:3000 / 127.0.0.1:3000），便于部署到 VPS/局域网
app.use(cors({ origin: env.corsOrigins }));
app.use(express.json());

// ---- 路由注册 ----
app.use('/api/health', healthRouter);

// ---- 业务路由 ----
app.use('/api/upload', uploadRouter);
app.use('/api/download', downloadRouter);
app.use('/api/qa', qaRouter);
app.use('/api/convert', convertRouter);
app.use('/api/generate', generateRouter);

// 统一错误处理（必须放在所有路由之后）
app.use(errorHandler);
