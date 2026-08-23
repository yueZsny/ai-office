/**
 * 后端全局类型定义
 * 约定所有跨模块的接口类型契约，与 API 契约（规格 5.2 节）保持一致
 */

/** 支持的文件类型 */
export type FileType = 'pdf' | 'docx';

/** 文件处理状态 */
export type FileStatus = 'uploaded' | 'parsing' | 'parsed' | 'converted' | 'failed';

/** 文件元信息（持久化到 data/files.json） */
export interface FileMeta {
  /** 文件唯一 ID（uuid） */
  fileId: string;
  /** 原始文件名 */
  filename: string;
  /** 文件类型 */
  type: FileType;
  /** 文件大小（字节） */
  size: number;
  /** 处理状态 */
  status: FileStatus;
  /** ai-service 侧的解析 fileId（RAG 检索键，与对外 fileId 不同，规格 6.2） */
  aiFileId?: string;
  /** 失败原因（status=failed 时存在，规格 5.3） */
  errorMessage?: string | null;
  /** 原始文件存储路径 */
  originalPath: string;
  /** 处理结果文件路径（可选） */
  processedPath?: string;
  /** 文件内容指纹（sha256，上传幂等去重用） */
  sha256?: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
}

/** 对话历史消息 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 问答请求体：POST /api/qa/ask */
export interface QaAskRequest {
  fileId: string;
  question: string;
  history?: ChatMessage[];
}

/** 引用片段（RAG 命中） */
export interface SourceChunk {
  chunkIndex: number;
  text: string;
}

/** 问答响应体 */
export interface QaAskResponse {
  answer: string;
  sources: SourceChunk[];
}

/** 摘要响应体：POST /api/qa/summary */
export interface SummaryResponse {
  summary: string;
}

/** 大纲生成请求体：POST /api/generate/doc */
export interface GenerateDocRequest {
  title: string;
  outline: string[];
}

/** 统一错误响应格式 */
export interface ErrorResponse {
  error: { message: string };
}
