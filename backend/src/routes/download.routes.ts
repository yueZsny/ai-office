/**
 * 文件下载路由：GET /api/download/:fileId
 * 根据 fileId 返回处理结果文件流（无 processedPath 时回退返回原文件）
 */
import { Router } from 'express';
import { createReadStream } from 'fs';
import path from 'path';
import { fileService } from '../services/file.service';
import { extname } from '../utils/file.utils';
import { NotFoundError } from '../utils/errors';

export const downloadRouter = Router();

/** 组装下载文件名：转换/生成结果（有 processedPath）取结果扩展名，替换原文件名扩展名 */
function buildDownloadName(filename: string, filePath: string): string {
  const resultExt = extname(filePath); // .docx 等
  const base = filename.replace(/\.\w+$/, '');
  return resultExt ? `${base}${resultExt}` : filename;
}

downloadRouter.get('/:fileId', async (req, res, next) => {
  try {
    const meta = await fileService.getById(req.params.fileId);

    // 优先返回处理结果文件；尚未处理的文档返回原始上传文件
    const filePath = meta.processedPath ?? meta.originalPath;
    if (!filePath) {
      throw new NotFoundError('该文件尚无可用内容');
    }

    // 路径可能为共享目录相对路径（如 ../shared-data/processed/xxx.docx），统一解析为绝对路径
    const absPath = path.resolve(filePath);

    const downloadName = meta.processedPath
      ? buildDownloadName(meta.filename, absPath)
      : meta.filename;

    // RFC 5987 编码中文名（filename*）；ASCII 兜底名需去掉非 ASCII 字符，
    // 否则 Node 的 HTTP 头会因非法字符抛错（历史 500 根因）
    const asciiFallback = downloadName
      .replace(/["\\]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = createReadStream(absPath);
    stream.on('error', (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});
