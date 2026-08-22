/**
 * 接口定义：按功能模块导出所有 API 调用方法
 * 与后端 API 契约（规格 5.2 节）一一对应
 */
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

/** 问答结果（POST /qa/ask 响应） */
export interface QaResult {
  answer: string;
  sources: { chunkIndex: number; text: string }[];
}

/** 摘要结果（POST /qa/summary 响应） */
export interface SummaryResult {
  summary: string;
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

/** 文档问答（可携带历史实现连续问答） */
export async function qaAsk(
  fileId: string,
  question: string,
  history: ChatMessage[] = []
): Promise<QaResult> {
  const { data } = await http.post<QaResult>('/qa/ask', { fileId, question, history });
  return data;
}

/** 生成摘要 */
export async function qaSummary(fileId: string): Promise<SummaryResult> {
  const { data } = await http.post<SummaryResult>('/qa/summary', { fileId });
  return data;
}

/** PDF 转 Word（multipart，仅 .pdf） */
export async function convertPdf(file: File): Promise<TaskResult> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await http.post<TaskResult>('/convert/pdf2word', formData);
  return data;
}

/** 大纲生成文档 */
export async function generateDoc(title: string, outline: string[]): Promise<TaskResult> {
  const { data } = await http.post<TaskResult>('/generate/doc', { title, outline });
  return data;
}

/** 拼接结果下载地址（GET /download/:fileId，浏览器直接访问下载） */
export function downloadUrl(fileId: string): string {
  return `${http.defaults.baseURL}/download/${fileId}`;
}
