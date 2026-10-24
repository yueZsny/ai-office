/**
 * 环境变量读取模块
 * 集中读取并校验所有环境变量，业务代码一律从 env 读取，禁止直接访问 process.env
 */
import 'dotenv/config';

export const env = {
  /** 服务端口 */
  port: Number(process.env.PORT || 3001),
  /** AI 服务地址（ai-service） */
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  /** 上传文件目录 */
  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  /** 处理结果目录 */
  processedDir: process.env.PROCESSED_DIR || './data/processed',
  /** PostgreSQL 连接串（文件元信息 + LLM 设置的事实源；本地开发 127.0.0.1:5432，compose 内 postgres:5432） */
  databaseUrl:
    process.env.DATABASE_URL || 'postgres://ai_office:ai_office@127.0.0.1:5432/ai_office',
  /** PG 连接超时（毫秒）：启动 fail-fast 与连接池 connectionTimeoutMillis 共用 */
  pgConnectTimeoutMs: Number(process.env.PG_CONNECT_TIMEOUT_MS || 3000),
  /** PG 连接池上限 */
  pgPoolMax: Number(process.env.PG_POOL_MAX || 10),
  /** 日志目录（request.log 等；原 dirname(META_FILE) 技巧随 META_FILE 移除） */
  logDir: process.env.LOG_DIR || './data',
  /** Redis 连接串（仅限流计数，fail-open；本地开发 127.0.0.1:6379，compose 内 redis://redis:6379） */
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  /** Redis 启动连接超时（毫秒）：超时仅告警不退出（Redis 已非事实源） */
  redisConnectTimeoutMs: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000),
  /** 反向代理（nginx）后必须开启，否则 req.ip 恒为代理地址 → 限流全站共享一桶 */
  trustProxy: process.env.TRUST_PROXY === 'true',
  /** 限流总开关（本地自测可临时关闭） */
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  /** 限流窗口长度（秒） */
  rateLimitWindowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60),
  /** 问答/摘要/思维导图 每窗口每 IP 上限（SSE 长连接也按请求数计数） */
  rateLimitQaPerWindow: Number(process.env.RATE_LIMIT_QA_PER_MINUTE || 30),
  /** 知识库全局搜索 每窗口每 IP 上限（向量检索，CPU 密集） */
  rateLimitSearchPerWindow: Number(process.env.RATE_LIMIT_SEARCH_PER_MINUTE || 60),
  /** 文档生成 每窗口每 IP 上限 */
  rateLimitGeneratePerWindow: Number(process.env.RATE_LIMIT_GENERATE_PER_MINUTE || 30),
  /** 上传/加入知识库 每窗口每 IP 上限 */
  rateLimitUploadPerWindow: Number(process.env.RATE_LIMIT_UPLOAD_PER_MINUTE || 10),
  /** PDF→Word 转换 每窗口每 IP 上限 */
  rateLimitConvertPerWindow: Number(process.env.RATE_LIMIT_CONVERT_PER_MINUTE || 10),
  /** 上传大小限制（MB） */
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 20),
  /** CORS 允许来源列表（逗号分隔） */
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim()),
  /** parsing 状态超时（分钟）：超过则启动时标记为 failed */
  parsingTimeoutMinutes: Number(process.env.PARSING_TIMEOUT_MINUTES || 5),
};
