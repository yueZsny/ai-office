/**
 * 问答业务逻辑：文档问答（单文件 / 多文件 / 全库）与摘要
 * - 校验 fileId/fileIds / question 输入
 * - 未传 fileId/fileIds 时进入「全库问答」：取最近 MAX_QA_FILES 篇已解析文档
 * - 校验文件已解析（问答/摘要仅接受 parsed 状态，未解析返回 409，多文件时指名哪个文件）
 * - 会话持久化（P0-4）：
 *   - 首次提问且 ai-service 流建立成功后创建会话，响应头返回 X-Conversation-Id
 *   - 边转发边解析 SSE；收到 done 后把本轮 user + assistant（含 sources）写入 PG
 *   - 带 conversationId 的后续提问从 DB 读取最近 HISTORY_LIMIT 条消息作为 history
 *   - 流中断/失败不写半截消息；新建会话若从未完成则清理
 *
 * 注：对外 fileId（backend 生成）与 ai-service 内部检索键（aiFileId）不同，
 * 转发时使用 meta.aiFileId，返回的 sources.fileId 再映射回对外 fileId（前端拼下载地址用）。
 */
import { Readable } from 'stream';
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { conversationService, HISTORY_LIMIT } from './conversation.service';
import type {
  ChatMessage,
  MindmapMode,
  MindmapResponse,
  SourceChunk,
  SummaryResponse,
} from '../types';
import { ConflictError, HttpError, ValidationError } from '../utils/errors';
import { extractSseEvents, type SseEvent } from '../utils/sse';

/** 无选中文档时，「全库问答」最多纳入的文档数（按创建时间倒序） */
const MAX_QA_FILES = 50;

/** 取文件并校验已解析，返回带 aiFileId 的元信息（未解析抛 409，指名文件名） */
export async function requireParsed(fileId: string) {
  const meta = await fileService.getById(fileId);
  if (meta.status !== 'parsed') {
    throw new ConflictError(`文件「${meta.filename}」尚未解析，请等待解析完成`);
  }
  return meta;
}

/** 边转发上游 SSE、边累积回答并在 done 后落库的流 */
function createPersistedQaStream(ctx: {
  upstream: Response;
  conversationId: string;
  question: string;
  fileIdMap: Record<string, string>;
  scopeFileIds: string[] | null;
  isNew: boolean;
}): Readable {
  const body = ctx.upstream.body;
  if (!body) throw new HttpError(502, 'AI 服务响应为空');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const stream = new Readable({ read() {} });

  let buffer = '';
  let answer = '';
  let sources: SourceChunk[] = [];
  let doneSeen = false;
  let errorSeen = false;
  let upstreamCancelled = false;

  const cancelUpstream = async () => {
    if (upstreamCancelled) return;
    upstreamCancelled = true;
    try {
      await reader.cancel();
    } catch {
      // 客户端已断开，忽略
    }
  };

  // 客户端中途关闭页面/请求：立即停止上游 LLM 读取；未完成的会话不落库
  stream.on('close', () => {
    if (!doneSeen) void cancelUpstream();
  });

  /** 累积 token / sources；sources 的 aiFileId 在此映射为对外 fileId 后落库 */
  const handleEvent = (event: SseEvent) => {
    if (event.type === 'token' && typeof event.content === 'string') {
      answer += event.content;
    } else if (event.type === 'sources' && Array.isArray(event.sources)) {
      sources = (event.sources as SourceChunk[]).map((source) => ({
        ...source,
        fileId: source.fileId
          ? (ctx.fileIdMap[source.fileId] ?? source.fileId)
          : source.fileId,
      }));
    } else if (event.type === 'done') {
      doneSeen = true;
    } else if (event.type === 'error') {
      errorSeen = true;
    }
  };

  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // 原样转发（前端 SSE 解析器不认识也不受影响），同时旁路解析用于落库
        if (!stream.destroyed) stream.push(Buffer.from(value));
        buffer += decoder.decode(value, { stream: true });
        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) handleEvent(event);
      }

      // 上游最后一帧可能没有空行结尾，补一次解析
      if (buffer.trim()) {
        const tail = extractSseEvents(`${buffer}\n\n`);
        for (const event of tail.events) handleEvent(event);
      }

      if (doneSeen) {
        try {
          await conversationService.appendTurn({
            conversationId: ctx.conversationId,
            question: ctx.question,
            answer,
            sources,
            fileIds: ctx.scopeFileIds,
          });
        } catch (err) {
          // 落库失败不破坏已完成的应答
          console.warn('[qa] 会话落库失败（应答不受影响）:', (err as Error).message);
        }
      } else if (ctx.isNew) {
        // 新会话从未完成：清掉空会话，避免列表里出现无效项
        await conversationService
          .removeIfEmpty(ctx.conversationId)
          .catch((err) => console.warn('[qa] 清理空会话失败:', (err as Error).message));
      }
    } catch (err) {
      console.warn('[qa] 问答流中断:', (err as Error).message);
      if (!errorSeen && !stream.destroyed) {
        stream.push(
          `data: ${JSON.stringify({
            type: 'error',
            message: (err as Error).message || '问答流中断',
          })}\n\n`
        );
      }
      if (ctx.isNew) {
        await conversationService.removeIfEmpty(ctx.conversationId).catch(() => {});
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 已 cancel/release
      }
      if (!stream.destroyed) stream.push(null);
    }
  })();

  return stream;
}

export const qaService = {
  /**
   * 文档问答（流式）：校验输入 → 逐文件校验 parsed → 创建/复用会话 → 调 ai-client.qaStream
   * 返回 { stream, fileIdMap, conversationId }：
   * - stream 为 Node Readable（已边转发边解析，done 后落库）
   * - fileIdMap 为 aiFileId → 对外 fileId 映射，经响应头下发给前端翻译 sources
   * - conversationId 经响应头下发（新建或复用）
   *
   * 范围优先级：请求显式传了 fileId/fileIds（空数组 = 全库）→ 用它；
   * 否则沿用会话保存的范围（fileIds=null = 全库）；新会话无显式范围则默认全库。
   */
  async askStream(input: {
    fileId?: string;
    fileIds?: string[];
    question: string;
    history?: ChatMessage[];
    conversationId?: string;
  }): Promise<{ stream: Readable; fileIdMap: Record<string, string>; conversationId: string }> {
    const question = input.question.trim();
    if (!question) throw new ValidationError('问题不能为空');

    // 1. 会话（若指定）：不存在直接 404
    const existing = input.conversationId
      ? await conversationService.get(input.conversationId)
      : null;

    // 2. 确定本轮范围：null = 请求未显式给范围；[] = 显式全库
    const requestedIds: string[] | null = Array.isArray(input.fileIds)
      ? input.fileIds.filter((id): id is string => typeof id === 'string' && !!id)
      : input.fileId && input.fileId.trim()
        ? [input.fileId]
        : null;

    let scopeGlobal: boolean;
    let publicIds: string[];
    if (requestedIds !== null) {
      scopeGlobal = requestedIds.length === 0;
      publicIds = requestedIds;
    } else if (existing) {
      scopeGlobal = !existing.fileIds || existing.fileIds.length === 0;
      publicIds = existing.fileIds ?? [];
    } else {
      scopeGlobal = true;
      publicIds = [];
    }

    if (scopeGlobal) {
      // 全库问答：list() 已按创建时间倒序，取最近 N 篇已解析文档
      const all = await fileService.list();
      publicIds = all
        .filter((m) => m.status === 'parsed')
        .slice(0, MAX_QA_FILES)
        .map((m) => m.fileId);
      if (publicIds.length === 0) {
        throw new ValidationError('知识库暂无已解析文档，请先上传文档');
      }
    }
    publicIds = [...new Set(publicIds)];

    // 3. 历史：已有会话以 DB 为准（忽略前端传的 history，避免重复/伪造）
    const history = existing
      ? await conversationService.history(existing.id, HISTORY_LIMIT)
      : input.history ?? [];

    // 4. 逐文件校验已解析（404 消息含 fileId，前端据此剔除被删项）
    const metas = await Promise.all(publicIds.map((id) => requireParsed(id)));

    // 对外 fileId → ai-service 检索键
    const toAiId = new Map(metas.map((m) => [m.fileId, m.aiFileId ?? m.fileId]));
    const aiFileIds = metas.map((m) => toAiId.get(m.fileId)!);
    const fileIdMap = Object.fromEntries(
      metas.map((m) => [m.aiFileId ?? m.fileId, m.fileId])
    );

    // 5. 先建立上游流（失败则不创建会话，避免空记录）
    const upstream = await aiClient.qaStream({ fileIds: aiFileIds, question, history });

    // 6. 新建会话（首次提问）
    let conversationId = existing?.id;
    let isNew = false;
    if (!conversationId) {
      try {
        const created = await conversationService.create(
          question,
          scopeGlobal ? null : publicIds
        );
        conversationId = created.id;
        isNew = true;
      } catch (err) {
        // 会话创建失败：取消已经建立的上游流，交给错误中间件（PG 503）
        try {
          await upstream.body?.cancel();
        } catch {
          // ignore
        }
        throw err;
      }
    }

    // 7. 边转发边落库
    const stream = createPersistedQaStream({
      upstream,
      conversationId,
      question,
      fileIdMap,
      // 全库存 null（下次提问重新解析当前知识库），指定文档存对外 fileId 数组
      scopeFileIds: scopeGlobal ? null : publicIds,
      isNew,
    });

    return { stream, fileIdMap, conversationId };
  },

  /** 生成摘要：校验 fileId → 调 ai-client.summary */
  async summarize(fileId: string): Promise<SummaryResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');

    const meta = await requireParsed(fileId);
    const result = await aiClient.summary({ fileId: meta.aiFileId ?? meta.fileId });
    return { summary: result.summary };
  },

  /** 生成思维导图：校验 fileId → 调 ai-client.mindmap（mode 默认 auto） */
  async mindmap(fileId: string, mode?: MindmapMode): Promise<MindmapResponse> {
    if (!fileId.trim()) throw new ValidationError('fileId 不能为空');

    const meta = await requireParsed(fileId);
    const result = await aiClient.mindmap({
      fileId: meta.aiFileId ?? meta.fileId,
      mode: mode ?? 'auto',
    });
    return { markdown: result.markdown };
  },
};
