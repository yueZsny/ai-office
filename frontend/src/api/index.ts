/**
 * 接口定义：按功能模块导出所有 API 调用方法
 * 与后端 API 契约（规格 5.2 节）一一对应
 */
import { message } from 'antd';
import http from './http';

/* ---------- 类型定义 ---------- */

/** 文件信息（GET /api/files/:fileId 响应） */
export interface FileInfo {
  fileId: string;
  filename: string;
  type: string;
  size: number;
  /** 状态机：uploaded → parsing → parsed / failed */
  status: 'uploaded' | 'parsing' | 'parsed' | 'failed';
  errorMessage?: string | null;
}

/** 问答消息（连续问答 history 单元） */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 引用片段（RAG 命中） */
export interface QaSource {
  chunkIndex: number;
  /** 块起始页码（1-based；docx 为段序号；旧数据为 null → 显示「未知页」） */
  page?: number | null;
  /** 来源文件名（旧数据为 null） */
  filename?: string | null;
  /** 来源文件 ID（backend 对外 fileId，拼下载地址用） */
  fileId?: string;
  text: string;
}

/** 问答结果（POST /qa/ask 响应） */
export interface QaResult {
  answer: string;
  sources: QaSource[];
}

/** 摘要结果（POST /qa/summary 响应） */
export interface SummaryResult {
  summary: string;
}

/** 思维导图结果（POST /qa/mindmap 响应，markdown 大纲为 markmap 原生输入格式） */
export interface MindmapResult {
  markdown: string;
}

/** 转换 / 生成结果（POST /convert/pdf2word、/generate/doc 响应） */
export interface TaskResult {
  fileId: string;
  downloadUrl: string;
}

/* ---------- 接口方法 ---------- */

/** 上传文档（multipart，支持 .pdf/.docx，≤20MB） */
export async function upload(file: File): Promise<FileInfo> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await http.post<FileInfo>('/upload', formData);
  return data;
}

/** 查询文件解析状态 */
export async function getFile(fileId: string): Promise<FileInfo> {
  const { data } = await http.get<FileInfo>(`/files/${fileId}`);
  return data;
}

/** 知识库列表：全部已解析文档（倒序，新上传的在前） */
export async function listFiles(): Promise<FileInfo[]> {
  const { data } = await http.get<FileInfo[]>('/files');
  return data;
}

/** 删除知识库文档（后端联动清理向量库与文件） */
export async function deleteFile(fileId: string): Promise<void> {
  await http.delete(`/files/${fileId}`);
}

/** 问答 SSE 事件契约（与 ai-service /ai/qa 一致） */
type QaStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'sources'; sources: QaResult['sources'] }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * 文档问答（流式 SSE，单/多文件，可携带历史实现连续问答）
 * - token 增量经 onToken 回调逐字下发；done 时 resolve { answer, sources }
 * - 原生 fetch（axios 不适合流式）；错误提示复刻 http.ts 拦截器行为（toast + 带 status 的 Error）
 */
export async function qaAskStream(
  fileIds: string[],
  question: string,
  history: ChatMessage[] = [],
  callbacks: { onToken?: (chunk: string) => void } = {}
): Promise<QaResult> {
  const res = await fetch(`${http.defaults.baseURL}/qa/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ fileIds, question, history }),
  });

  // 非 2xx：校验/未解析/不存在等错误仍是 JSON 响应
  if (!res.ok) {
    let msg = '网络异常，请稍后重试';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) msg = body.error.message;
    } catch {
      // 非 JSON 响应体，使用默认错误信息
    }
    message.error(msg);
    const e = new Error(msg) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }

  // 后端经响应头下发 aiFileId → 对外 fileId 映射（流透传后无法在服务端改写 sources.fileId）
  let fileIdMap: Record<string, string> = {};
  try {
    fileIdMap = JSON.parse(res.headers.get('X-Source-FileIds') ?? '{}');
  } catch {
    // 头缺失/损坏时保持原值（前端另有 filename 兜底）
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let sources: QaResult['sources'] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔，data: 行携带 JSON
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;

      let event: QaStreamEvent;
      try {
        event = JSON.parse(line.slice(6)) as QaStreamEvent;
      } catch {
        throw new Error('流式响应解析失败');
      }
      if (event.type === 'error') {
        message.error(event.message);
        throw new Error(event.message);
      }
      if (event.type === 'done') return { answer, sources };
      if (event.type === 'token') {
        answer += event.content;
        callbacks.onToken?.(event.content);
      } else {
        sources = event.sources.map((s) => ({
          ...s,
          fileId: s.fileId ? (fileIdMap[s.fileId] ?? s.fileId) : s.fileId,
        }));
      }
    }
  }
  return { answer, sources };
}

/** 生成摘要 */
export async function qaSummary(fileId: string): Promise<SummaryResult> {
  const { data } = await http.post<SummaryResult>('/qa/summary', { fileId });
  return data;
}

/** 生成思维导图（mode：auto 标题优先 / titles 仅标题 / llm 强制 LLM 提纲） */
export async function qaMindmap(
  fileId: string,
  mode: 'auto' | 'titles' | 'llm' = 'auto'
): Promise<MindmapResult> {
  const { data } = await http.post<MindmapResult>('/qa/mindmap', { fileId, mode });
  return data;
}

/** PDF 转 Word（multipart，仅 .pdf） */
export async function convertPdf(file: File): Promise<TaskResult> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await http.post<TaskResult>('/convert/pdf2word', formData);
  return data;
}

/** 分节内容（section_done 帧 / 单节生成响应 / assemble 请求元素共用） */
export interface SectionContent {
  title: string;
  level: number;
  paragraphs: string[];
  bullets: string[];
}

/** 生成事件帧（与 ai-service /ai/generate SSE 一致） */
type GenerateStreamEvent =
  | { type: 'section_start'; index: number; title: string }
  | { type: 'section_done'; index: number; title: string; level: number; paragraphs: string[]; bullets: string[] }
  | { type: 'done'; fileId: string; filename: string; filePath: string; downloadUrl: string }
  | { type: 'error'; message: string };

/**
 * 大纲生成文档（流式 SSE）：逐节进度经回调下发（含全文），done 时 resolve { fileId, downloadUrl }
 * - 增量生成时 outline 只传新增条目、context 传已保留节的概括
 * - 原生 fetch（axios 不适合流式）；非 2xx 仍是 JSON 错误（校验失败等）
 * - 错误提示复刻 http.ts 拦截器行为（toast + 抛 Error）
 */
export async function generateDocStream(
  title: string,
  outline: string[],
  callbacks: {
    onSectionStart?: (index: number, title: string) => void;
    onSectionDone?: (index: number, section: SectionContent) => void;
  } = {},
  context?: string
): Promise<TaskResult> {
  const res = await fetch(`${http.defaults.baseURL}/generate/doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ title, outline, context }),
  });

  // 非 2xx：校验/未解析等错误仍是 JSON 响应
  if (!res.ok) {
    let msg = '网络异常，请稍后重试';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) msg = body.error.message;
    } catch {
      // 非 JSON 响应体，使用默认错误信息
    }
    message.error(msg);
    throw new Error(msg);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔，data: 行携带 JSON
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;

      let event: GenerateStreamEvent;
      try {
        event = JSON.parse(line.slice(6)) as GenerateStreamEvent;
      } catch {
        throw new Error('流式响应解析失败');
      }
      if (event.type === 'error') {
        message.error(event.message);
        throw new Error(event.message);
      }
      if (event.type === 'done') {
        return { fileId: event.fileId, downloadUrl: event.downloadUrl };
      }
      if (event.type === 'section_start') {
        callbacks.onSectionStart?.(event.index, event.title);
      } else {
        callbacks.onSectionDone?.(event.index, {
          title: event.title,
          level: event.level,
          paragraphs: event.paragraphs,
          bullets: event.bullets,
        });
      }
    }
  }
  throw new Error('流式响应意外中断');
}

/** 单节生成/重生成（一次 LLM 调用）：requirement 为修改意见，context 为其余节的概括 */
export async function regenSection(payload: {
  docTitle: string;
  sectionTitle: string;
  level?: number;
  requirement?: string;
  context?: string;
}): Promise<SectionContent> {
  const { data } = await http.post<SectionContent>('/generate/section', payload);
  return data;
}

/** 组装渲染（不调 LLM，秒出）：把分节内容渲染成 Word */
export async function assembleDoc(title: string, sections: SectionContent[]): Promise<TaskResult> {
  const { data } = await http.post<TaskResult>('/generate/assemble', { title, sections });
  return data;
}

/** 主题生成大纲（生成页「AI 帮我想大纲」，返回 markdown 直接填入大纲编辑区） */
export async function generateOutline(
  topic: string,
  sectionCount?: number,
  style?: string
): Promise<MindmapResult> {
  const { data } = await http.post<MindmapResult>('/generate/outline', {
    topic,
    sectionCount,
    style,
  });
  return data;
}

/** 拼接结果下载地址（GET /download/:fileId，浏览器直接访问下载） */
export function downloadUrl(fileId: string): string {
  return `${http.defaults.baseURL}/download/${fileId}`;
}
