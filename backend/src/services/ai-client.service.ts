/**
 * AI 客户端服务：封装对 ai-service 的所有 HTTP 调用
 * - 统一超时（默认 120s）与错误处理
 * - 各方法与 ai-service 内部接口一一对应（parse / qa / summary / mindmap / convert / generate）
 *
 * 接口契约（ai-service 规格 6.2 节）：
 * - POST /ai/parse     multipart(file) → { fileId, text, chunks }
 * - POST /ai/qa        { fileId, question, history? } → { answer, sources }
 * - POST /ai/summary   { fileId } → { summary }
 * - POST /ai/mindmap   { fileId, mode? } → { markdown }
 * - POST /ai/convert   multipart(file) → { fileId, filePath, filename }
 * - POST /ai/generate  { title, outline, context? } → SSE: section_start → section_done*（含全文）→ done | error
 * - POST /ai/generate/outline { topic, sectionCount?, style? } → { markdown }
 * - POST /ai/generate/section { docTitle, sectionTitle, level?, requirement?, context? } → { title, level, paragraphs, bullets }
 * - POST /ai/generate/assemble { title, sections } → { fileId, filePath, filename }
 * 错误统一为 { error: { message } }
 */
import { env } from '../config/env';
import { AITimeoutError, HttpError } from '../utils/errors';
import { normalizeUploadName } from '../utils/filename';

/** AI 请求超时（毫秒） */
const AI_TIMEOUT_MS = 120_000;

/**
 * 发起对 ai-service 的请求，统一超时与错误处理
 * - 超时：AbortController 触发 AITimeoutError（504）
 * - 非 2xx：解析 ai-service 的 { error: { message } }，透传其状态码与错误信息
 */
async function request(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${env.aiServiceUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AITimeoutError();
    }
    // 连接失败（ai-service 未启动等）
    throw new HttpError(502, `AI 服务不可用: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `AI 服务错误 (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // 非 JSON 响应体，使用默认错误信息
    }
    throw new HttpError(res.status, message);
  }
  return res;
}

/**
 * 构造 multipart 表单（upload.single 用内存存储，buffer 为 Buffer）
 * - new Uint8Array 包装避免 Buffer<ArrayBufferLike> 与 BlobPart 的类型冲突
 * - 文件名经 normalizeUploadName 还原（multer 按 latin1 解码中文名会乱码，
 *   若直接用 originalname 会把乱码传给 ai-service 存入向量库）
 */
function buildFormData(file: Express.Multer.File): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
    normalizeUploadName(file.originalname)
  );
  return form;
}

export const aiClient = {
  /** 解析文档：multipart 上传 → { fileId, text, chunks } */
  async parse(file: Express.Multer.File): Promise<{
    fileId: string;
    text: string;
    chunks: { index: number; title: string; content: string }[];
  }> {
    const form = buildFormData(file);

    const res = await request('/ai/parse', { method: 'POST', body: form });
    return (await res.json()) as { fileId: string; text: string; chunks: { index: number; title: string; content: string }[] };
  },

  /** 文档问答（流式 SSE）：{ fileId | fileIds, question, history? } → text/event-stream
   * 返回原始 Response（body 为 SSE 帧序列），由路由层透传给浏览器 */
  async qaStream(payload: {
    fileId?: string;
    fileIds?: string[];
    question: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
  }): Promise<Response> {
    return request('/ai/qa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });
  },

  /** 生成摘要：{ fileId } → { summary } */
  async summary(payload: { fileId: string }): Promise<{ summary: string }> {
    const res = await request('/ai/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as { summary: string };
  },

  /** 生成思维导图：{ fileId, mode? } → { markdown }（mode 默认 auto） */
  async mindmap(payload: {
    fileId: string;
    mode?: 'auto' | 'titles' | 'llm';
  }): Promise<{ markdown: string }> {
    const res = await request('/ai/mindmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as { markdown: string };
  },

  /** PDF→Word 转换：multipart 上传 → { fileId, filePath, filename } */
  async convert(file: Express.Multer.File): Promise<{
    fileId: string;
    filePath: string;
    filename: string;
  }> {
    const form = buildFormData(file);

    const res = await request('/ai/convert', { method: 'POST', body: form });
    return (await res.json()) as { fileId: string; filePath: string; filename: string };
  },

  /** 大纲生成文档（流式 SSE）：{ title, outline, context? } → text/event-stream
   * 事件：section_start → section_done*（含全文）→ done（含 fileId/filePath）| error
   * 返回原始 Response（body 为 SSE 帧序列），由 service 层解析帧、登记元信息后透传 */
  async generateStream(payload: {
    title: string;
    outline: string[];
    context?: string;
  }): Promise<Response> {
    return request('/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });
  },

  /** 单节生成/重生成：{ docTitle, sectionTitle, level?, requirement?, context? } → SectionContent
   * 注意：ai-service 契约字段为 snake_case（doc_title/section_title），此处做边界映射 */
  async generateSection(payload: {
    docTitle: string;
    sectionTitle: string;
    level?: number;
    requirement?: string;
    context?: string;
  }): Promise<{ title: string; level: number; paragraphs: string[]; bullets: string[] }> {
    const res = await request('/ai/generate/section', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_title: payload.docTitle,
        section_title: payload.sectionTitle,
        level: payload.level,
        requirement: payload.requirement,
        context: payload.context,
      }),
    });
    return (await res.json()) as { title: string; level: number; paragraphs: string[]; bullets: string[] };
  },

  /** 组装渲染：{ title, sections } → { fileId, filePath, filename }（不调 LLM） */
  async assemble(payload: {
    title: string;
    sections: { title: string; level: number; paragraphs: string[]; bullets: string[] }[];
  }): Promise<{ fileId: string; filePath: string; filename: string }> {
    const res = await request('/ai/generate/assemble', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as { fileId: string; filePath: string; filename: string };
  },

  /** 主题生成大纲：{ topic, sectionCount?, style? } → { markdown }（生成页「AI 帮我想大纲」）
   * 注意：ai-service 契约字段为 snake_case（section_count），此处做边界映射 */
  async outline(payload: {
    topic: string;
    sectionCount?: number;
    style?: string;
  }): Promise<{ markdown: string }> {
    const res = await request('/ai/generate/outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: payload.topic,
        section_count: payload.sectionCount,
        style: payload.style,
      }),
    });
    return (await res.json()) as { markdown: string };
  },

  /** 删除已解析文件：ai-service 清理向量库与共享目录副本（204） */
  async deleteFile(aiFileId: string): Promise<void> {
    await request(`/ai/files/${aiFileId}`, { method: 'DELETE' });
  },
};
