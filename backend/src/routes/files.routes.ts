/**
 * 文件路由：
 * - GET    /api/files      知识库列表（全部已解析文档，倒序）
 * - GET    /api/files/:fileId   文件状态查询（fileService 无该记录时抛 404）
 * - DELETE /api/files/:fileId   删除知识库文档（记录 + backend 文件 + ai-service 向量库）
 */
import { Router } from 'express';
import { fileService } from '../services/file.service';
import { aiClient } from '../services/ai-client.service';

export const filesRouter = Router();

/** 知识库列表：仅返回已解析完成的文档（status === 'parsed'），新上传的在前 */
filesRouter.get('/', async (_req, res, next) => {
  try {
    const all = await fileService.list();
    const parsed = all.filter((m) => m.status === 'parsed');
    res.json(
      parsed.map((m) => ({
        fileId: m.fileId,
        filename: m.filename,
        type: m.type,
        size: m.size,
        status: m.status,
        errorMessage: m.errorMessage ?? null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/** 删除知识库文档：先通知 ai-service 清理向量库与共享副本（尽力而为），再删记录与 backend 文件 */
filesRouter.delete('/:fileId', async (req, res, next) => {
  try {
    const meta = await fileService.getById(req.params.fileId);
    // AI 服务不可用时降级：不阻断删除，向量数据残留为孤儿 collection（files.json 是唯一事实源）
    if (meta.aiFileId) {
      try {
        await aiClient.deleteFile(meta.aiFileId);
      } catch (err) {
        console.warn('[files] ai-service 清理失败（忽略）:', err);
      }
    }
    await fileService.remove(req.params.fileId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

filesRouter.get('/:fileId', async (req, res, next) => {
  try {
    const meta = await fileService.getById(req.params.fileId);
    res.json({
      fileId: meta.fileId,
      filename: meta.filename,
      type: meta.type,
      size: meta.size,
      status: meta.status,
      errorMessage: meta.errorMessage ?? null,
    });
  } catch (err) {
    next(err);
  }
});
