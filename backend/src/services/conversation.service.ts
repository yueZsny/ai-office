/**
 * 会话服务：问答会话与消息的持久化（PostgreSQL）
 * - conversations：会话元信息（标题、问答范围 fileIds；null = 全库）
 * - conversation_messages：逐条消息（assistant 消息带 sources）
 * - 问答流在 done 帧后调用 appendTurn 落库；失败/中断不写半截消息
 * - 历史读取只取最近 HISTORY_LIMIT 条，防止 Prompt 无限增长
 */
import { randomUUID } from 'crypto';
import { asc, count, desc, eq } from 'drizzle-orm';
import { db, withDbError } from '../db';
import { conversationMessages, conversations } from '../db/schema';
import type {
  ChatMessage,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  SourceChunk,
} from '../types';
import { NotFoundError, ValidationError } from '../utils/errors';

/** 输入给 LLM 的历史窗口（message 条数，约 10 轮） */
export const HISTORY_LIMIT = 20;
/** 用户重命名时的标题长度上限 */
const MAX_TITLE_LENGTH = 60;
/** 首问自动生成标题的长度 */
const AUTO_TITLE_LENGTH = 40;

type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof conversationMessages.$inferSelect;
/** 列表联查只取摘要字段（不含 userId），toSummary 接受其公共子集 */
type ConversationSummaryRow = Pick<
  ConversationRow,
  'id' | 'title' | 'fileIds' | 'createdAt' | 'updatedAt'
>;

/** 用首个问题生成会话标题（压缩空白、截断） */
function makeTitle(question: string): string {
  const title = question.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, AUTO_TITLE_LENGTH) : '新对话';
}

function toSummary(row: ConversationSummaryRow, messageCount?: number): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    fileIds: row.fileIds ?? null,
    ...(messageCount === undefined ? {} : { messageCount }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    sources: row.sources ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 读取会话行（不存在抛 404） */
async function getRow(id: string): Promise<ConversationRow> {
  const rows = await withDbError(
    db.select().from(conversations).where(eq(conversations.id, id)).limit(1)
  );
  if (!rows.length) throw new NotFoundError(`会话不存在: ${id}`);
  return rows[0];
}

export const conversationService = {
  /** 会话列表（按最近活跃倒序，带消息条数） */
  async list(): Promise<ConversationSummary[]> {
    const rows = await withDbError(
      db
        .select({
          id: conversations.id,
          title: conversations.title,
          fileIds: conversations.fileIds,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
          messageCount: count(conversationMessages.id),
        })
        .from(conversations)
        .leftJoin(
          conversationMessages,
          eq(conversationMessages.conversationId, conversations.id)
        )
        .groupBy(conversations.id)
        .orderBy(desc(conversations.updatedAt))
        .limit(200)
    );
    return rows.map((row) => toSummary(row, Number(row.messageCount)));
  },

  /** 单条会话（不含消息） */
  async get(id: string): Promise<ConversationSummary> {
    return toSummary(await getRow(id));
  },

  /** 会话详情：元信息 + 消息（按时间正序） */
  async detail(id: string): Promise<ConversationDetail> {
    const row = await getRow(id);
    const messages = await withDbError(
      db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
        .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id))
    );
    return {
      ...toSummary(row, messages.length),
      messages: messages.map(toMessage),
    };
  },

  /** 创建会话：fileIds=null 表示全库，数组表示固定文档范围 */
  async create(question: string, fileIds: string[] | null): Promise<ConversationSummary> {
    const now = new Date();
    const row: ConversationRow = {
      id: randomUUID(),
      title: makeTitle(question),
      fileIds,
      userId: null,
      createdAt: now,
      updatedAt: now,
    };
    await withDbError(db.insert(conversations).values(row));
    return toSummary(row, 0);
  },

  /** 重命名会话 */
  async rename(id: string, title: string): Promise<ConversationSummary> {
    if (typeof title !== 'string' || !title.trim()) {
      throw new ValidationError('会话标题不能为空');
    }
    const trimmed = title.replace(/\s+/g, ' ').trim();
    if (trimmed.length > MAX_TITLE_LENGTH) {
      throw new ValidationError(`会话标题不能超过 ${MAX_TITLE_LENGTH} 个字符`);
    }
    const rows = await withDbError(
      db
        .update(conversations)
        .set({ title: trimmed, updatedAt: new Date() })
        .where(eq(conversations.id, id))
        .returning()
    );
    if (!rows.length) throw new NotFoundError(`会话不存在: ${id}`);
    return toSummary(rows[0]);
  },

  /** 删除会话（消息由 FK ON DELETE CASCADE 清理） */
  async remove(id: string): Promise<void> {
    const rows = await withDbError(
      db.delete(conversations).where(eq(conversations.id, id)).returning({ id: conversations.id })
    );
    if (!rows.length) throw new NotFoundError(`会话不存在: ${id}`);
  },

  /**
   * 读取最近 HISTORY_LIMIT 条消息作为 LLM 历史（按时间正序）。
   * 仅保留 role/content，sources 不回灌 Prompt。
   */
  async history(id: string, limit = HISTORY_LIMIT): Promise<ChatMessage[]> {
    const rows = await withDbError(
      db
        .select({ role: conversationMessages.role, content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
        .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
        .limit(limit)
    );
    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  },

  /**
   * 持久化一轮问答（done 帧后调用）：user + assistant 两条消息 + 更新会话活跃时间/范围。
   * - 使用事务，避免只写入半轮
   * - assistant 时间 +1ms，保证展示顺序固定为用户在前
   */
  async appendTurn(turn: {
    conversationId: string;
    question: string;
    answer: string;
    sources: SourceChunk[];
    fileIds: string[] | null;
  }): Promise<void> {
    const now = new Date();
    const answerAt = new Date(now.getTime() + 1);
    await withDbError(
      db.transaction(async (tx) => {
        await tx.insert(conversationMessages).values([
          {
            id: randomUUID(),
            conversationId: turn.conversationId,
            role: 'user',
            content: turn.question,
            sources: null,
            createdAt: now,
          },
          {
            id: randomUUID(),
            conversationId: turn.conversationId,
            role: 'assistant',
            content: turn.answer,
            sources: turn.sources.length ? turn.sources : null,
            createdAt: answerAt,
          },
        ]);
        await tx
          .update(conversations)
          .set({ fileIds: turn.fileIds, updatedAt: answerAt })
          .where(eq(conversations.id, turn.conversationId));
      })
    );
  },

  /**
   * 清理空会话（新会话在流中断/失败时使用）。
   * 已存在且有消息的会话不会被删除；并发场景下仅做尽力而为。
   */
  async removeIfEmpty(id: string): Promise<void> {
    const rows = await withDbError(
      db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
        .limit(1)
    );
    if (rows.length) return;
    await withDbError(db.delete(conversations).where(eq(conversations.id, id)));
  },
};
