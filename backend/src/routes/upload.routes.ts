/**
 * 文件上传路由：POST /api/upload
 * 请求：multipart 文件（file 字段，支持 .pdf/.docx，≤20MB）
 * 响应：{ fileId, filename, size, type }
 */
import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { fileService } from '../services/file.service';
import { isValidExtension, isWithinSizeLimit } from '../utils/file.utils';
import { ValidationError } from '../utils/errors';

export const uploadRouter = Router();

// 内存存储：文件 buffer 交由 fileService 统一落盘（便于扩展名/大小校验在写盘前完成）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxFileSizeMb * 1024 * 1024 },
});

uploadRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ValidationError('缺少文件字段（file）');
    }

    // 扩展名校验（仅 .pdf/.docx）
    if (!isValidExtension(req.file.originalname)) {
      throw new ValidationError('仅支持 PDF / Word 文件');
    }

    // 大小校验（multer 已在 limits 拦截超限，这里兜底）
    if (!isWithinSizeLimit(req.file.size, env.maxFileSizeMb)) {
      throw new ValidationError(`文件不能超过 ${env.maxFileSizeMb}MB`);
    }

    const meta = await fileService.save(req.file);
    res.status(201).json({
      fileId: meta.fileId,
      filename: meta.filename,
      size: meta.size,
      type: meta.type,
    });
  } catch (err) {
    next(err);
  }
});
