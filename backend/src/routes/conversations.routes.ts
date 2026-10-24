/**
 * 会话路由（问答历史持久化）：
 * - GET    /api/conversations        会话列表（最近活跃倒序，带消息条数）
 * - GET    /api/conversations/:id    会话详情（元信息 + 全部消息）
 * - PATCH  /api/conversations/:id    重命名：{ title }
 * - DELETE /api/conversations/:id    删除（消息级联删除）
 *
 * 会话本身由 POST /api/qa/ask 首次提问时自动创建，不提供手动建空会话接口。
 */
import { Router } from 'express';
import { conversationService } from '../services/conversation.service';

export const conversationsRouter = Router();

conversationsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await conversationService.list());
  } catch (err) {
    next(err);
  }
});

conversationsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(await conversationService.detail(req.params.id));
  } catch (err) {
    next(err);
  }
});

conversationsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { title } = req.body as { title?: string };
    res.json(await conversationService.rename(req.params.id, title ?? ''));
  } catch (err) {
    next(err);
  }
});

conversationsRouter.delete('/:id', async (req, res, next) => {
  try {
    await conversationService.remove(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
