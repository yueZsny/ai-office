/**
 * 会话列表：历史问答会话（最近活跃倒序）
 * - 点击条目打开会话（恢复消息与文档范围）
 * - 新建对话 / 重命名 / 删除
 */
import { Button, Empty, Popconfirm, Spin } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ConversationSummary } from '../api';

interface ConversationListProps {
  conversations: ConversationSummary[];
  /** 当前打开的会话 id */
  activeId: string | null;
  loading: boolean;
  onOpen: (conversation: ConversationSummary) => void;
  onNew: () => void;
  onRename: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
}

/** 列表时间：M/D HH:mm（省略年份，MVP 足够） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

/** 会话范围标签：null/空数组 = 全库 */
function scopeLabel(fileIds: string[] | null): string {
  return !fileIds?.length ? '全库' : `${fileIds.length} 篇文档`;
}

export default function ConversationList({
  conversations,
  activeId,
  loading,
  onOpen,
  onNew,
  onRename,
  onDelete,
}: ConversationListProps) {
  return (
    <div className="conv-list">
      <div className="conv-list__toolbar">
        <span className="conv-list__title">历史会话</span>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={onNew}>
          新建
        </Button>
      </div>

      {loading ? (
        <div className="conv-list__loading">
          <Spin size="small" />
        </div>
      ) : conversations.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无历史会话，提问后自动保存"
        />
      ) : (
        conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`conv-item${activeId === conversation.id ? ' conv-item--active' : ''}`}
            onClick={() => onOpen(conversation)}
          >
            <div className="conv-item__main">
              <div className="conv-item__title" title={conversation.title}>
                {conversation.title}
              </div>
              <div className="conv-item__meta">
                <span>{formatTime(conversation.updatedAt)}</span>
                <span>{scopeLabel(conversation.fileIds)}</span>
                {!!conversation.messageCount && (
                  <span>{conversation.messageCount} 条</span>
                )}
              </div>
            </div>
            <span className="conv-item__actions">
              <Button
                type="text"
                size="small"
                aria-label="重命名会话"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onRename(conversation);
                }}
              />
              <Popconfirm
                title="删除该会话？"
                description="会话消息将一并删除，不可恢复"
                okText="删除"
                cancelText="取消"
                onConfirm={() => onDelete(conversation)}
              >
                <Button
                  type="text"
                  size="small"
                  aria-label="删除会话"
                  icon={<DeleteOutlined />}
                  onClick={(e) => e.stopPropagation()}
                />
              </Popconfirm>
            </span>
          </div>
        ))
      )}
    </div>
  );
}
