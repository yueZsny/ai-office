/**
 * 知识库全局搜索：跨文档向量检索（不调 LLM）
 * - 未指定 fileIds 时检索最近 MAX_SEARCH_FILES 篇已解析文档（truncated 标记截断）
 * - 校验显式传入的文件均已解析（复用 qaService.requireParsed，404/409 指名文件）
 * - ai-service 返回内部 aiFileId，这里反向映射为对外 fileId 并补文件名
 */
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { requireParsed } from './qa.service';
import { ValidationError } from '../utils/errors';
import type { FileMeta, SearchResponse, SearchResultItem } from '../types';

/** 「全部文档」搜索的文档上限：串行逐 collection 检索，避免请求随文档数线性变慢 */
const MAX_SEARCH_FILES = 50;

export const searchService = {
  async search(query: string, fileIds?: string[]): Promise<SearchResponse> {
    if (typeof query !== 'string' || !query.trim()) {
      throw new ValidationError('搜索内容不能为空');
    }

    let metas: FileMeta[];
    let truncated = false;

    const requestedIds = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
    if (requestedIds.length) {
      // 去重后逐文件校验已解析（未解析/不存在时抛 409/404，消息含文件名）
      const uniqueIds = [...new Set(requestedIds)];
      metas = await Promise.all(uniqueIds.map((id) => requireParsed(id)));
    } else {
      const parsed = (await fileService.list()).filter((m) => m.status === 'parsed');
      truncated = parsed.length > MAX_SEARCH_FILES;
      metas = parsed.slice(0, MAX_SEARCH_FILES);
    }

    if (metas.length === 0) {
      return { results: [], searchedFileCount: 0, truncated: false };
    }

    const toAiId = (m: FileMeta) => m.aiFileId ?? m.fileId;
    const aiToPublic = new Map(metas.map((m) => [toAiId(m), m.fileId]));
    const metaById = new Map(metas.map((m) => [m.fileId, m]));

    const result = await aiClient.search({
      fileIds: metas.map(toAiId),
      query: query.trim(),
    });

    const results: SearchResultItem[] = result.results.map((item) => {
      const fileId = aiToPublic.get(item.fileId) ?? item.fileId;
      const meta = metaById.get(fileId);
      return {
        fileId,
        filename: meta?.filename ?? item.filename ?? fileId,
        page: item.page ?? null,
        chunkIndex: item.chunkIndex,
        text: item.text,
        similarity: item.similarity,
      };
    });

    return { results, searchedFileCount: metas.length, truncated };
  },
};
