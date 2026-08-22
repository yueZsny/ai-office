/**
 * PDF→Word 转换路由：POST /api/convert/pdf2word
 * 请求：multipart 文件（file 字段，仅 .pdf）
 * 响应：{ downloadUrl }
 */
import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { convertService } from '../services/convert.service';
import { isValidExtension } from '../utils/file.utils';
import { ValidationError } from '../utils/errors';

export const convertRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxFileSizeMb * 1024 * 1024 },
});

convertRouter.post('/pdf2word', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ValidationError('缺少文件字段（file）');
    }
    // 仅接受 .pdf（大小与扩展名校验与上传接口保持一致）
    if (!isValidExtension(req.file.originalname) || !req.file.originalname.toLowerCase().endsWith('.pdf')) {
      throw new ValidationError('仅支持 PDF 文件');
    }

    const result = await convertService.convert(req.file);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
