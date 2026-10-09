/**
 * 固定窗口限流中间件（自研，无第三方依赖）
 * - 窗口号 = floor(now / window)，key = backend:ratelimit:{bucket}:{ip}:{window}
 * - INCR 后仅在返回 1 时 EXPIRE（避免每请求续期导致窗口永不过期）
 * - 超限 → 429 {error:{message}} + Retry-After（前端拦截器直接展示 message）
 * - fail-open：Redis 不可用时不限流，只告警（限流是保护措施，不能变成单点）
 * - 必须挂载在 multer 之前：429 时 req.resume() 排空请求体，
 *   避免大文件上传客户端看到连接重置而非 429
 *
 * 已知取舍：
 * - 固定窗口在边界处最坏放行 2 倍流量；跨窗口不做滑动统计（MVP 够用）
 * - SSE 问答按「请求数」计数，不限制同一 IP 的在途并发流（如需并发闸门另加在途计数）
 * - 校验失败的请求同样计数（smoke-test 的失败用例会消耗额度，本地自测可关 RATE_LIMIT_ENABLED）
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { redis } from '../redis';

const KEY_PREFIX = 'backend:ratelimit';

export function rateLimit(bucket: string, limitPerWindow: number): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!env.rateLimitEnabled || limitPerWindow <= 0) {
      next();
      return;
    }

    try {
      const windowSeconds = Math.max(1, env.rateLimitWindowSeconds);
      const win = Math.floor(Date.now() / (windowSeconds * 1000));
      const key = `${KEY_PREFIX}:${bucket}:${req.ip}:${win}`;

      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSeconds + 1); // 窗口外多留 1s，避免边界竞争
      }

      if (count > limitPerWindow) {
        const elapsed = Math.floor((Date.now() / 1000) % windowSeconds);
        res.setHeader('Retry-After', String(windowSeconds - elapsed));
        req.resume(); // 排空未读完的请求体（multer 之前拒绝大文件上传）
        res.status(429).json({
          error: { message: `请求过于频繁，请稍后重试（${bucket} 限流）` },
        });
        return;
      }
    } catch (err) {
      console.warn('[ratelimit] Redis 不可用，本次不限流:', (err as Error).message);
    }

    next();
  };
}
