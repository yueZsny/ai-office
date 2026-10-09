/**
 * LLM 设置服务：读写「模型设置」页的供应商配置（PostgreSQL settings 表，key='llm'）
 * - backend 独占写入；ai-service 直读同一行实现动态切换（不重启生效，
 *   行键镜像见 ai-service/app/llm/config_store.py）
 * - apiKey 明文仅存 PostgreSQL，任何 HTTP 响应必须打码（toResponse 是唯一对外出口）
 * - PG 故障一律 503（设置不可降级，与 file.service 元信息同理）
 * - 读-改-写仍非事务（与旧 Redis 实现一致，单进程 MVP 可接受，见 docs/功能拓展指南.md 约定 2）
 */
import { eq } from 'drizzle-orm';
import { db, withDbError } from '../db';
import { settings } from '../db/schema';
import type { LlmSettingsFile, LlmSettingsResponse, LlmSlotsRequest } from '../types';
import { generateId } from '../utils/file.utils';
import { NotFoundError, ValidationError } from '../utils/errors';
import { settingsKeys } from './settings.keys';

/** 空设置（行不存在时的等价结构） */
function emptySettings(): LlmSettingsFile {
  return {
    version: 1,
    providers: [],
    mainProviderId: null,
    outlineProviderId: null,
    updatedAt: new Date().toISOString(),
  };
}

async function readSettings(): Promise<LlmSettingsFile> {
  const rows = await withDbError(
    db.select().from(settings).where(eq(settings.key, settingsKeys.llmRow)).limit(1),
    '设置存储不可用（PostgreSQL）'
  );
  if (!rows.length) return emptySettings();
  const value = rows[0].value;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`设置数据损坏（key: ${settingsKeys.llmRow}）`);
  }
  return value;
}

async function writeSettings(data: LlmSettingsFile): Promise<void> {
  await withDbError(
    db
      .insert(settings)
      .values({ key: settingsKeys.llmRow, value: data, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: data, updatedAt: new Date() } }),
    '设置存储不可用（PostgreSQL）'
  );
}

/** apiKey 打码：前 4 + **** + 后 4（短 key 全遮），规则与 ai-service config_store.mask_key 一致 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 打码后的全量响应（service 出口统一打码，路由层不得直接返回明文 provider） */
function toResponse(data: LlmSettingsFile): LlmSettingsResponse {
  return {
    providers: data.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKeyMasked: maskKey(p.apiKey),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    mainProviderId: data.mainProviderId,
    outlineProviderId: data.outlineProviderId,
  };
}

/** 校验 name/model：非空且 ≤64 字符 */
function validateLabel(field: string, value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new ValidationError(`${field} 不能为空`);
  if (s.length > 64) throw new ValidationError(`${field} 过长（最多 64 字符）`);
  return s;
}

/** 校验 baseUrl：http(s):// 开头且可被 URL 解析 */
function validateBaseUrl(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new ValidationError('baseUrl 不能为空');
  if (!/^https?:\/\//i.test(s)) throw new ValidationError('baseUrl 必须以 http:// 或 https:// 开头');
  try {
    const u = new URL(s);
    if (!u.host) throw new Error('no host');
  } catch {
    throw new ValidationError('baseUrl 不是合法的 URL');
  }
  return s;
}

function findProvider(data: LlmSettingsFile, id: string) {
  return data.providers.find((p) => p.id === id);
}

export const settingsService = {
  /** 全量设置（key 打码） */
  async getSettings(): Promise<LlmSettingsResponse> {
    return toResponse(await readSettings());
  },

  /** 添加供应商 */
  async createProvider(input: {
    name: unknown;
    apiKey: unknown;
    baseUrl: unknown;
    model: unknown;
  }): Promise<LlmSettingsResponse> {
    const name = validateLabel('名称', input.name);
    const baseUrl = validateBaseUrl(input.baseUrl);
    const model = validateLabel('模型名', input.model);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!apiKey) throw new ValidationError('API Key 不能为空');

    const data = await readSettings();
    const now = new Date().toISOString();
    data.providers.push({
      id: generateId(),
      name,
      apiKey,
      baseUrl,
      model,
      createdAt: now,
      updatedAt: now,
    });
    data.updatedAt = now;
    await writeSettings(data);
    return toResponse(data);
  },

  /** 更新供应商（apiKey 缺省或去空格后为空 = 不修改） */
  async updateProvider(
    id: string,
    input: { name?: unknown; apiKey?: unknown; baseUrl?: unknown; model?: unknown }
  ): Promise<LlmSettingsResponse> {
    const data = await readSettings();
    const provider = findProvider(data, id);
    if (!provider) throw new NotFoundError('供应商不存在');

    if (input.name !== undefined) provider.name = validateLabel('名称', input.name);
    if (input.model !== undefined) provider.model = validateLabel('模型名', input.model);
    if (input.baseUrl !== undefined) provider.baseUrl = validateBaseUrl(input.baseUrl);
    if (input.apiKey !== undefined) {
      const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      if (apiKey) provider.apiKey = apiKey; // 空白 = 保留已存 key
    }

    const now = new Date().toISOString();
    provider.updatedAt = now;
    data.updatedAt = now;
    await writeSettings(data);
    return toResponse(data);
  },

  /** 删除供应商，并清空引用它的槽位（回退语义） */
  async deleteProvider(id: string): Promise<LlmSettingsResponse> {
    const data = await readSettings();
    if (!findProvider(data, id)) throw new NotFoundError('供应商不存在');

    data.providers = data.providers.filter((p) => p.id !== id);
    if (data.mainProviderId === id) data.mainProviderId = null;
    if (data.outlineProviderId === id) data.outlineProviderId = null;
    data.updatedAt = new Date().toISOString();
    await writeSettings(data);
    return toResponse(data);
  },

  /** 设置主/大纲槽位（null = 回落环境变量 / 跟随主模型） */
  async updateSlots(input: LlmSlotsRequest): Promise<LlmSettingsResponse> {
    const data = await readSettings();
    for (const [slot, id] of [
      ['主模型', input.mainProviderId],
      ['大纲模型', input.outlineProviderId],
    ] as const) {
      if (id !== null && id !== undefined && !findProvider(data, id)) {
        throw new ValidationError(`${slot}指向的供应商不存在`);
      }
    }
    if (input.mainProviderId !== undefined) data.mainProviderId = input.mainProviderId;
    if (input.outlineProviderId !== undefined) data.outlineProviderId = input.outlineProviderId;
    data.updatedAt = new Date().toISOString();
    await writeSettings(data);
    return toResponse(data);
  },

  /** 取测试连接用的明文配置（body 字段 > 已存值；无 providerId 时由路由层校验三字段必填） */
  async resolveTestConfig(input: {
    providerId?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }): Promise<{ apiKey: string; baseUrl: string; model: string }> {
    const data = await readSettings();
    let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    let baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
    let model = typeof input.model === 'string' ? input.model.trim() : '';

    if (input.providerId) {
      const provider = findProvider(data, input.providerId);
      if (!provider) throw new NotFoundError('供应商不存在');
      apiKey = apiKey || provider.apiKey;
      baseUrl = baseUrl || provider.baseUrl;
      model = model || provider.model;
    }
    return { apiKey, baseUrl, model };
  },
};
