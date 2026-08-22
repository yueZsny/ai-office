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
  /** 文件元信息存储路径 */
  metaFile: process.env.META_FILE || './data/files.json',
  /** 上传大小限制（MB） */
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 20),
  /** CORS 允许来源列表（逗号分隔） */
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim()),
};
