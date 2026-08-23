/**
 * 自定义业务错误：携带 HTTP 状态码，errorHandler 据此映射响应
 * - HttpError      通用（携带状态码）
 * - ValidationError 400 参数/文件校验失败
 * - NotFoundError   404 文件不存在
 * - AITimeoutError  504 AI 服务超时
 */

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = 'ConflictError';
  }
}

export class AITimeoutError extends HttpError {
  constructor(message = 'AI 服务响应超时') {
    super(504, message);
    this.name = 'AITimeoutError';
  }
}
