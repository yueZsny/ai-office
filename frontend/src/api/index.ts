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

/** 摘要篇幅：简短（约 150 字）/ 标准（300-500 字）/ 详细（800+ 字） */
export type SummaryLength = 'brief' | 'standard' | 'detailed';

/** 摘要风格：段落 / 要点列表 */
export type SummaryStyle = 'paragraph' | 'bullets';

/** 摘要选项（POST /qa/summary 可选参数） */
export interface SummaryOptions {
  length?: SummaryLength;
  style?: SummaryStyle;
  /** 重点关注主题（可选，≤200 字） */
  focus?: string;
}

/** 摘要结果（POST /qa/summary 响应；覆盖信息兼容旧 ai-service，均可缺省） */
export interface SummaryResult {
  summary: string;
  /** single = 单次调用；map_reduce = 长文档分段归纳 */
  mode?: 'single' | 'map_reduce';
  /** 文档非空块总数 */
  totalChunks?: number;
  /** 本次实际纳入摘要的块数（超长文档会抽样） */
  coveredChunks?: number;
  /** 是否因文档过长而抽样（true 时 UI 明确提示） */
  truncated?: boolean;
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

/** 知识库全局搜索命中项（POST /files/search） */
export interface KbSearchResult {
  fileId: string;
  filename: string;
  /** 块起始页（1-based；docx 为段序号；旧数据为 null） */
  page?: number | null;
  chunkIndex: number;
  text: string;
  /** 余弦相似度（-1 ~ 1），仅用于展示参考 */
  similarity: number;
}

export interface KbSearchResponse {
  results: KbSearchResult[];
  /** 实际参与检索的文档数 */
  searchedFileCount: number;
  /** 是否因文档过多截断了检索范围 */
  truncated: boolean;
}

/** 知识库全局语义搜索（不调 LLM）；fileIds 省略 = 检索全部已解析文档 */
export async function searchKnowledgeBase(
  query: string,
  fileIds?: string[]
): Promise<KbSearchResponse> {
  const { data } = await http.post<KbSearchResponse>('/files/search', { query, fileIds });
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
 * 文档问答（流式 SSE，单/多文件/全库，可携带历史实现连续问答）
 * - token 增量经 onToken 回调逐字下发；done 时 resolve { answer, sources, conversationId }
 * - conversationId 传入已有会话；首次提问不传，后端创建后经 X-Conversation-Id 返回
 * - 原生 fetch（axios 不适合流式）；错误提示复刻 http.ts 拦截器行为（toast + 带 status 的 Error）
 */
export async function qaAskStream(
  fileIds: string[],
  question: string,
  history: ChatMessage[] = [],
  callbacks: { onToken?: (chunk: string) => void; conversationId?: string } = {}
): Promise<QaResult & { conversationId?: string }> {
  const res = await fetch(`${http.defaults.baseURL}/qa/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      fileIds,
      question,
      history,
      conversationId: callbacks.conversationId,
    }),
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
  // 会话 ID 同样经响应头下发（CORS exposedHeaders 已放行）
  const conversationId = res.headers.get('X-Conversation-Id') ?? undefined;

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
      if (event.type === 'done') return { answer, sources, conversationId };
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
  return { answer, sources, conversationId };
}

/** 会话摘要（GET /conversations 列表项） */
export interface ConversationSummary {
  id: string;
  title: string;
  /** null = 全库；数组 = 指定文档（对外 fileId） */
  fileIds: string[] | null;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** 会话消息 */
export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: QaSource[] | null;
  createdAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}

/** 会话列表（最近活跃倒序） */
export async function listConversations(): Promise<ConversationSummary[]> {
  const { data } = await http.get<ConversationSummary[]>('/conversations');
  return data;
}

/** 会话详情（含全部消息） */
export async function getConversation(id: string): Promise<ConversationDetail> {
  const { data } = await http.get<ConversationDetail>(`/conversations/${encodeURIComponent(id)}`);
  return data;
}

/** 重命名会话 */
export async function renameConversation(
  id: string,
  title: string
): Promise<ConversationSummary> {
  const { data } = await http.patch<ConversationSummary>(
    `/conversations/${encodeURIComponent(id)}`,
    { title }
  );
  return data;
}

/** 删除会话（消息级联删除） */
export async function deleteConversation(id: string): Promise<void> {
  await http.delete(`/conversations/${encodeURIComponent(id)}`);
}

/** 生成摘要（可配置篇幅/风格/重点；长文档由后端自动分段归纳） */
export async function qaSummary(
  fileId: string,
  options: SummaryOptions = {}
): Promise<SummaryResult> {
  const { data } = await http.post<SummaryResult>('/qa/summary', {
    fileId,
    length: options.length ?? 'standard',
    style: options.style ?? 'paragraph',
    ...(options.focus ? { focus: options.focus } : {}),
  });
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

/** 生成文档加入知识库（后台解析，返回 202 + parsing 状态） */
export async function importGeneratedToKb(
  fileId: string
): Promise<{ fileId: string; status: 'parsing' }> {
  const { data } = await http.post<{ fileId: string; status: 'parsing' }>(
    `/generate/${fileId}/import`
  );
  return data;
}

/** 拼接结果下载地址（GET /download/:fileId，浏览器直接访问下载） */
export function downloadUrl(fileId: string): string {
  return `${http.defaults.baseURL}/download/${fileId}`;
}

/* ---------- LLM 模型设置（/api/settings/llm） ---------- */

/** 供应商配置（对外：apiKey 打码） */
export interface LlmProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** 打码后的 key（如 sk-1****cdef），仅用于展示「已保存」 */
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

/** 全量设置（所有变更端点统一返回，前端一次 setState） */
export interface LlmSettings {
  providers: LlmProviderPublic[];
  mainProviderId: string | null;
  outlineProviderId: string | null;
}

/** 测试连接结果：ok=false 是正常诊断结果（如 key 错误），非异常 */
export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

/** 生效配置查询（ai-service 不可用时 available=false） */
export interface LlmEffective {
  available: boolean;
  source?: 'db' | 'env';
  main?: {
    providerName: string | null;
    baseUrl: string;
    model: string;
    apiKeyMasked: string;
  };
  outline?: {
    providerName: string | null;
    baseUrl: string;
    model: string;
    apiKeyMasked: string;
    /** true = 大纲槽位未指定，跟随主模型 */
    fallbackToMain: boolean;
  };
  message?: string;
}

/** 全量设置（key 打码） */
export async function getLlmSettings(): Promise<LlmSettings> {
  const { data } = await http.get<LlmSettings>('/settings/llm');
  return data;
}

/** 添加供应商（apiKey 必填） */
export async function createLlmProvider(payload: {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<LlmSettings> {
  const { data } = await http.post<LlmSettings>('/settings/llm/providers', payload);
  return data;
}

/** 更新供应商（apiKey 留空 = 不修改） */
export async function updateLlmProvider(
  id: string,
  payload: { name?: string; apiKey?: string; baseUrl?: string; model?: string }
): Promise<LlmSettings> {
  const { data } = await http.put<LlmSettings>(`/settings/llm/providers/${id}`, payload);
  return data;
}

/** 删除供应商（后端联动清空引用它的槽位） */
export async function deleteLlmProvider(id: string): Promise<LlmSettings> {
  const { data } = await http.delete<LlmSettings>(`/settings/llm/providers/${id}`);
  return data;
}

/** 设置主/大纲槽位（null = 回落环境变量 / 跟随主模型） */
export async function updateLlmSlots(payload: {
  mainProviderId: string | null;
  outlineProviderId: string | null;
}): Promise<LlmSettings> {
  const { data } = await http.put<LlmSettings>('/settings/llm/slots', payload);
  return data;
}

/** 测试连接（providerId 给定时复用其已存值；或直接传 apiKey/baseUrl/model） */
export async function testLlmProvider(payload: {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<LlmTestResult> {
  const { data } = await http.post<LlmTestResult>('/settings/llm/test', payload);
  return data;
}

/** 生效配置查询（软失败：ai-service 不可用时返回 {available:false}，不弹错误 toast） */
export async function getLlmEffective(): Promise<LlmEffective> {
  try {
    const { data } = await http.get<LlmEffective>('/settings/llm/effective');
    return data;
  } catch {
    return { available: false, message: 'AI 服务不可用' };
  }
}
