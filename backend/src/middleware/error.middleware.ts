/**
 * 统一错误处理中间件
 * 所有路由/服务抛出的异常最终在此捕获，返回 { error: { message } } 格式
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { HttpError } from '../utils/errors';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('[backend] 未捕获异常:', err);

  // 自定义业务错误：按构造时携带的状态码返回
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: { message: err.message } });
    return;
  }

  // multer 错误（文件超限等）→ 400
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: { message: err.message } });
    return;
  }

  res.status(500).json({ error: { message: err.message || '服务器内部错误' } });
}
