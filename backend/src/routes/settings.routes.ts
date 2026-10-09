/**
 * LLM 设置路由（前端「模型设置」页后端）
 * - GET    /api/settings/llm                 全量设置（key 打码）
 * - POST   /api/settings/llm/providers       添加供应商 → 201 + 全量
 * - PUT    /api/settings/llm/providers/:id   更新供应商（apiKey 空白 = 不修改）→ 全量
 * - DELETE /api/settings/llm/providers/:id   删除供应商（联动清空引用槽位）→ 全量
 * - PUT    /api/settings/llm/slots           设置主/大纲槽位 → 全量
 * - POST   /api/settings/llm/test            测试连接（转发 ai-service /ai/llm/test）
 * - GET    /api/settings/llm/effective       生效配置查询（转发 /ai/llm/effective，软失败）
 * 变更端点统一返回全量设置，前端一次 setState 避免二次 GET 竞态
 */
import { Router } from 'express';
import { env } from '../config/env';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { aiClient } from '../services/ai-client.service';
import { settingsService } from '../services/settings.service';
import { HttpError, ValidationError } from '../utils/errors';

export const settingsRouter = Router();

// 设置接口低频但含 test 的小额 LLM 调用，复用 qa 配额做统一防护
const limiter = rateLimit('settings', env.rateLimitQaPerWindow);

settingsRouter.get('/llm', limiter, async (_req, res, next) => {
  try {
    res.json(await settingsService.getSettings());
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/llm/providers', limiter, async (req, res, next) => {
  try {
    const result = await settingsService.createProvider(req.body ?? {});
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/llm/providers/:id', limiter, async (req, res, next) => {
  try {
    const result = await settingsService.updateProvider(req.params.id, req.body ?? {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete('/llm/providers/:id', limiter, async (req, res, next) => {
  try {
    const result = await settingsService.deleteProvider(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/llm/slots', limiter, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      mainProviderId?: unknown;
      outlineProviderId?: unknown;
    };
    const normalize = (v: unknown, field: string): string | null => {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v !== 'string') throw new ValidationError(`${field} 必须是供应商 id（字符串）或 null`);
      return v;
    };
    const result = await settingsService.updateSlots({
      mainProviderId: normalize(body.mainProviderId, 'mainProviderId'),
      outlineProviderId: normalize(body.outlineProviderId, 'outlineProviderId'),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/llm/test', limiter, async (req, res, next) => {
  try {
    const { apiKey, baseUrl, model } = await settingsService.resolveTestConfig(req.body ?? {});
    if (!apiKey || !baseUrl || !model) {
      throw new ValidationError('未指定 providerId 时，apiKey / baseUrl / model 三者必填');
    }
    res.json(await aiClient.testLlm({ apiKey, baseUrl, model }));
  } catch (err) {
    next(err);
  }
});

settingsRouter.get('/llm/effective', limiter, async (_req, res, next) => {
  try {
    res.json(await aiClient.effectiveLlm());
  } catch (err) {
    // 软失败：ai-service 不可用不影响设置页渲染，返回 available=false 而非错误 toast
    if (err instanceof HttpError) {
      res.json({
        available: false,
        message: `AI 服务不可用: ${err.message}`,
      });
      return;
    }
    next(err);
  }
});
