/**
 * 问答页：知识库侧边栏 + 对话区
 * - 左侧知识库：已解析文档列表（可折叠 / 可删除），点击切换问答目标
 * - 右侧对话区：支持连续提问（保留对话上下文 history），回答内容用 Markdown 渲染
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Divider, Empty, Input, Layout, Spin } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined, SendOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import FileUpload from '../components/FileUpload';
import KnowledgeBase from '../components/KnowledgeBase';
import ParseStatus from '../components/ParseStatus';
import useFileStatus from '../hooks/useFileStatus';
import { deleteFile, listFiles, qaAsk } from '../api';
import type { ChatMessage, FileInfo, QaResult } from '../api';
import type { UploadedFile } from '../components/FileUpload';

/** 单条对话消息（含可选引用片段） */
interface Msg extends ChatMessage {
  sources?: QaResult['sources'];
}

export default function QaPage() {
  // 当前问答目标文档（单一事实源）；uploaded 仅保留 FileUpload 展示需要的文件名回退
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  // 知识库列表（已解析文档）
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  // 上传后轮询解析状态，parsed 后才能提问
  const { status: fileStatus, notFound } = useFileStatus(activeFileId ?? undefined);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const ready = fileStatus?.status === 'parsed';
  // 新上传文档尚未入列时回退到 uploaded 的文件名
  const activeFilename =
    files.find((f) => f.fileId === activeFileId)?.filename ?? uploaded?.filename;

  // 拉取知识库列表
  const loadFiles = useCallback(async () => {
    try {
      setFiles(await listFiles());
    } catch {
      // 失败提示已由 http 拦截器处理
    }
  }, []);

  // 挂载时拉取知识库列表
  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // 新文档解析完成后自动加入知识库列表
  useEffect(() => {
    if (fileStatus?.status === 'parsed') loadFiles();
  }, [fileStatus?.status, loadFiles]);

  // 当前问答目标已不存在（如被其他入口删除）：刷新列表并清空会话，停止无效轮询
  useEffect(() => {
    if (notFound) {
      loadFiles();
      setActiveFileId(null);
      setMessages([]);
    }
  }, [notFound, loadFiles]);

  // 切换问答目标 → 新会话（清空历史）
  useEffect(() => {
    setMessages([]);
  }, [activeFileId]);

  // 新消息时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, asking]);

  const handleSend = async () => {
    const q = question.trim();
    if (!q || !activeFileId || !ready || asking) return;
    // 追加用户消息
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setQuestion('');
    setAsking(true);
    try {
      // 携带历史实现连续问答（服务端用历史构建上下文）
      const history = messages.map(({ role, content }) => ({ role, content }));
      const res = await qaAsk(activeFileId, q, history);
      setMessages((prev) => [...prev, { role: 'assistant', content: res.answer, sources: res.sources }]);
    } catch (err) {
      // 文档已被删除 → 刷新列表并重置会话（错误提示已由拦截器处理）
      if ((err as Error).message.includes('文件不存在')) {
        loadFiles();
        setActiveFileId(null);
        setMessages([]);
      }
    } finally {
      setAsking(false);
    }
  };

  /** 上传成功：新文档立即成为问答目标（解析完成后自动入列） */
  const handleUploadSuccess = (file: UploadedFile) => {
    setUploaded(file);
    setActiveFileId(file.fileId);
    loadFiles();
  };

  /** 删除知识库文档；删除当前文档时自动切到剩余第一项 */
  const handleDelete = async (file: FileInfo) => {
    try {
      await deleteFile(file.fileId);
      const remaining = files.filter((f) => f.fileId !== file.fileId);
      setFiles(remaining);
      if (file.fileId === activeFileId) {
        setActiveFileId(remaining[0]?.fileId ?? null);
        setMessages([]);
      }
    } catch {
      // 删除失败提示已由拦截器处理
    }
  };

  return (
    <div>
      <h2 className="page-title">文档问答</h2>

      <Layout className="qa-page__layout">
        {/* 左侧：知识库（可折叠） */}
        <Layout.Sider
          width={280}
          collapsedWidth={64}
          collapsed={collapsed}
          trigger={null}
          theme="light"
          className="qa-sidebar"
        >
          <div className="qa-sidebar__header">
            <span className="qa-sidebar__title">知识库</span>
            <Button
              type="text"
              size="small"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
          </div>
          <div className="qa-sidebar__upload">
            {/* key 随目标变化：切换文档后上传区回到初始态，避免残留旧文件名 */}
            <FileUpload key={activeFileId ?? 'none'} onSuccess={handleUploadSuccess} />
          </div>
          <Divider style={{ margin: '12px 0' }} />
          <div className="qa-sidebar__list">
            <KnowledgeBase
              files={files}
              activeFileId={activeFileId}
              onSelect={(f) => setActiveFileId(f.fileId)}
              onDelete={handleDelete}
            />
          </div>
        </Layout.Sider>

        {/* 右侧：对话区 */}
        <Layout.Content className="qa-page__main">
          <Card className="glass-card">
            {/* 解析状态：解析中进度条 / 完成 / 失败（规格 5.4 状态机） */}
            <ParseStatus
              status={fileStatus}
              uploaded={!!activeFileId}
              filename={activeFilename}
              fileId={activeFileId ?? undefined}
            />

            {/* 对话区 */}
            <div className="qa-page__chat">
              {messages.length === 0 ? (
                <Empty
                  description={
                    ready
                      ? '解析完成，输入问题开始提问'
                      : activeFileId
                        ? '文件解析中，请稍候…'
                        : '从左侧知识库选择文档开始提问，或上传新文档'
                  }
                  style={{ padding: '40px 0' }}
                />
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`qa-page__msg qa-page__msg--${msg.role}`}>
                    {msg.role === 'assistant' && asking && i === messages.length - 1 ? (
                      <Spin />
                    ) : (
                      <div className="qa-page__content">
                        {msg.role === 'user' ? (
                          msg.content
                        ) : (
                          <>
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                            {/* 引用片段 */}
                            {!!msg.sources?.length && (
                              <>
                                <Divider plain style={{ fontSize: 12 }}>
                                  引用片段
                                </Divider>
                                {msg.sources.map((s, j) => (
                                  <div key={j} className="qa-page__source">
                                    <div className="qa-page__source-label">
                                      第 {s.chunkIndex} 段
                                    </div>
                                    <div className="qa-page__source-text">{s.text}</div>
                                  </div>
                                ))}
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>
          </Card>

          {/* 提问输入区 */}
          {activeFileId && (
            <Card className="glass-card">
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 4 }}
                placeholder={ready ? '输入你的问题，Enter 发送，Shift+Enter 换行' : '文件解析中，请稍候…'}
                value={question}
                disabled={!ready || asking}
                onChange={(e) => setQuestion(e.target.value)}
                onPressEnter={(e) => {
                  // Enter 发送，Shift+Enter 换行
                  if (!e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="page-actions" style={{ justifyContent: 'flex-end' }}>
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  disabled={!ready || !question.trim() || asking}
                  loading={asking}
                  onClick={handleSend}
                >
                  发送
                </Button>
              </div>
            </Card>
          )}
        </Layout.Content>
      </Layout>
    </div>
  );
}
