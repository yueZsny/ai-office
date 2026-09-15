/**
 * 后端全局类型定义
 * 约定所有跨模块的接口类型契约，与 API 契约（规格 5.2 节）保持一致
 */

/** 支持的文件类型 */
export type FileType = 'pdf' | 'docx' | 'image';

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
  /** 最后状态更新时间（ISO 字符串；进入 parsing 等状态变更时写入，用于孤儿任务检测） */
  updatedAt?: string;
}

/** 对话历史消息 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 问答请求体：POST /api/qa/ask（fileIds 用于多文件问答，单 fileId 旧契约保留） */
export interface QaAskRequest {
  fileId?: string;
  fileIds?: string[];
  question: string;
  history?: ChatMessage[];
}

/** 引用片段（RAG 命中） */
export interface SourceChunk {
  chunkIndex: number;
  /** 块起始页码（1-based；docx 为段序号；旧数据无此字段为 null） */
  page?: number | null;
  /** 来源文件名（旧数据为 null） */
  filename?: string | null;
  /** 来源文件 ID（backend 对外 fileId，前端拼下载地址用） */
  fileId?: string;
  text: string;
}

/** 问答已改为流式 SSE（POST /api/qa/ask），响应体事件契约见 ai-service app/api/qa.py */
/** 摘要响应体：POST /api/qa/summary */
export interface SummaryResponse {
  summary: string;
}

/** 思维导图生成模式：auto（标题优先，无标题回退 LLM）/ titles / llm */
export type MindmapMode = 'auto' | 'titles' | 'llm';

/** 思维导图响应体：POST /api/qa/mindmap */
export interface MindmapResponse {
  markdown: string;
}

/** 大纲生成请求体：POST /api/generate/doc */
export interface GenerateDocRequest {
  title: string;
  /** 大纲条目列表，条目支持 markdown 前缀（# / ## / ### 表示 1/2/3 级，无前缀视为 1 级） */
  outline: string[];
  /** 前文要点（增量生成时已保留节的概括，注入 Prompt 保持口径一致） */
  context?: string;
}

/** 主题生成大纲请求体：POST /api/generate/outline */
export interface GenerateOutlineRequest {
  topic: string;
  /** 一级章节数量（2-10，默认 5） */
  sectionCount?: number;
  /** 文档风格：报告 / 论文 / 方案 */
  style?: string;
}

/** 分节内容（section_done 帧 / 单节生成响应 / assemble 请求元素共用） */
export interface SectionContent {
  title: string;
  /** 节层级（1/2/3，对应 Word 标题字号） */
  level: number;
  /** 正文段落 */
  paragraphs: string[];
  /** 要点列表 */
  bullets: string[];
}

/** 单节生成请求体：POST /api/generate/section */
export interface GenerateSectionRequest {
  docTitle: string;
  sectionTitle: string;
  level?: number;
  /** 写作要求 / 修改意见 */
  requirement?: string;
  /** 前文要点（其余节的概括） */
  context?: string;
}

/** 组装渲染请求体：POST /api/generate/assemble */
export interface AssembleRequest {
  title: string;
  sections: SectionContent[];
}

/** 生成文档加入知识库响应：POST /api/generate/:fileId/import */
export interface ImportToKbResponse {
  fileId: string;
  status: 'parsing';
}

/** 统一错误响应格式 */
export interface ErrorResponse {
  error: { message: string };
}
