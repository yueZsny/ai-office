/**
 * 文件下载路由：GET /api/download/:fileId
 * 根据 fileId 返回处理结果文件流（无 processedPath 时回退返回原文件）
 */
import { Router } from 'express';
import { createReadStream } from 'fs';
import { fileService } from '../services/file.service';
import { NotFoundError } from '../utils/errors';

export const downloadRouter = Router();

downloadRouter.get('/:fileId', async (req, res, next) => {
  try {
    const meta = await fileService.getById(req.params.fileId);

    // 优先返回处理结果文件；尚未处理的文档返回原始上传文件
    const filePath = meta.processedPath ?? meta.originalPath;
    if (!filePath) {
      throw new NotFoundError('该文件尚无可用内容');
    }

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = createReadStream(filePath);
    stream.on('error', (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});
