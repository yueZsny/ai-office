/**
 * 应用装配：创建 Express 实例，注册中间件与全部路由
 * 分层约定：routes（路由）→ services（业务）→ ai-client（调用 Python AI 服务）
 */
import { appendFileSync } from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { errorHandler } from './middleware/error.middleware';
import { healthRouter } from './routes/health.routes';
import { uploadRouter } from './routes/upload.routes';
import { filesRouter } from './routes/files.routes';
import { downloadRouter } from './routes/download.routes';
import { qaRouter } from './routes/qa.routes';
import { convertRouter } from './routes/convert.routes';
import { generateRouter } from './routes/generate.routes';

export const app = express();

// CORS：允许来源从环境变量读取（默认 localhost:3000 / 127.0.0.1:3000），便于部署到 VPS/局域网
app.use(cors({ origin: env.corsOrigins }));
// json limit 调大：assemble 接口回传全部分节内容（默认 100kb 会截断长文档）
app.use(express.json({ limit: '5mb' }));

// 请求日志（调试用）：追加写入 data/request.log，便于排查前端轮询等行为
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const line = `[req] ${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`;
    console.log(line);
    try {
      appendFileSync(path.join(path.dirname(env.metaFile), 'request.log'), line + '\n');
    } catch {
      /* 日志写入失败不阻断请求 */
    }
  });
  next();
});

// ---- 路由注册 ----
app.use('/api/health', healthRouter);

// ---- 业务路由 ----
app.use('/api/upload', uploadRouter);
app.use('/api/files', filesRouter);
app.use('/api/download', downloadRouter);
app.use('/api/qa', qaRouter);
app.use('/api/convert', convertRouter);
app.use('/api/generate', generateRouter);

// 统一错误处理（必须放在所有路由之后）
app.use(errorHandler);
