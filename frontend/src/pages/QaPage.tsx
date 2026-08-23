/**
 * 问答页：知识库侧边栏 + 对话区
 * - 左侧知识库：已解析文档列表（多选 / 可删除），多个文件组成问答上下文
 * - 右侧对话区：支持连续提问（保留对话上下文 history），回答内容用 Markdown 渲染
 * - 引用徽标：「文件名 · 第 X 页」/「第 X 段」，点击 PDF 来源弹窗预览定位到对应页
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Collapse, Divider, Empty, Input, Layout, Spin } from 'antd';
import { FileSearchOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SendOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import FileUpload from '../components/FileUpload';
import KnowledgeBase from '../components/KnowledgeBase';
import ParseStatus from '../components/ParseStatus';
import PdfPreview from '../components/PdfPreview';
import useFileStatus from '../hooks/useFileStatus';
import { deleteFile, listFiles, qaAskStream } from '../api';
import type { ChatMessage, FileInfo, QaResult } from '../api';
import type { UploadedFile } from '../components/FileUpload';

/** 单条对话消息（含可选引用片段） */
interface Msg extends ChatMessage {
  sources?: QaResult['sources'];
}

export default function QaPage() {
  // 当前选中的问答目标文档集合；latestFileId 仅用于轮询新上传文档的解析状态
  const [activeFileIds, setActiveFileIds] = useState<string[]>([]);
  const [latestFileId, setLatestFileId] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  // 知识库列表（已解析文档）
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  // 只盯最新上传的那个文件（useFileStatus 单目标轮询，不改）
  const { status: fileStatus, notFound } = useFileStatus(latestFileId ?? undefined);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  // 引用预览：点击 PDF 来源徽标时打开
  const [preview, setPreview] = useState<{ fileId: string; page?: number | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 知识库列表只含已解析文档：选中项全部在列表中即视为就绪
  const ready =
    activeFileIds.length > 0 &&
    activeFileIds.every((id) => files.some((f) => f.fileId === id));
  // 新上传文档尚未入列时回退到 uploaded 的文件名
  const activeFilename =
    files.find((f) => f.fileId === latestFileId)?.filename ??
    files.find((f) => activeFileIds.includes(f.fileId))?.filename ??
    uploaded?.filename;

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

  // 轮询目标（最新上传文档）已不存在：仅剔除该项并停止轮询，其余选中文档继续可问
  useEffect(() => {
    if (notFound) {
      loadFiles();
      setActiveFileIds((prev) => prev.filter((id) => id !== latestFileId));
      setLatestFileId(null);
    }
  }, [notFound, latestFileId, loadFiles]);

  // 切换问答目标（选中集合变化）→ 新会话（清空历史）
  useEffect(() => {
    setMessages([]);
  }, [activeFileIds]);

  // 新消息时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, asking]);

  const handleSend = async () => {
    const q = question.trim();
    if (!q || activeFileIds.length === 0 || !ready || asking) return;
    // 追加用户消息
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setQuestion('');
    setAsking(true);
    try {
      // 携带历史实现连续问答（服务端用历史构建上下文）
      const history = messages.map(({ role, content }) => ({ role, content }));
      const res = await qaAskStream(activeFileIds, q, history, {
        // 流式渲染：逐 token 追加到最后一条 assistant 消息（无则新建）
        onToken: (chunk) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + chunk };
            } else {
              next.push({ role: 'assistant', content: chunk });
            }
            return next;
          });
        },
      });
      // 流结束：把引用合并到最后一条 assistant 消息（内容已由 token 累积，此处兜底）
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') {
          next[next.length - 1] = { ...last, content: res.answer, sources: res.sources };
        } else {
          next.push({ role: 'assistant', content: res.answer, sources: res.sources });
        }
        return next;
      });
    } catch (err) {
      // 某选中文档已被删除（404 消息含 fileId）：仅从选中集剔除该项，
      // 其余文档继续可问，不整场重置（错误提示已由 qaAskStream / 拦截器处理）
      const deletedId = /文件不存在:\s*([\w-]+)/.exec((err as Error).message)?.[1];
      if (deletedId) {
        loadFiles();
        setActiveFileIds((prev) => prev.filter((id) => id !== deletedId));
      }
    } finally {
      setAsking(false);
    }
  };

  /** 上传成功：新文档加入选中集并成为轮询目标（解析完成后自动入列） */
  const handleUploadSuccess = (file: UploadedFile) => {
    setUploaded(file);
    setLatestFileId(file.fileId);
    setActiveFileIds((prev) => (prev.includes(file.fileId) ? prev : [...prev, file.fileId]));
    loadFiles();
  };

  /** 删除知识库文档：从列表与选中集中移除；删除轮询目标时停止轮询 */
  const handleDelete = async (file: FileInfo) => {
    try {
      await deleteFile(file.fileId);
      setFiles(files.filter((f) => f.fileId !== file.fileId));
      setActiveFileIds((prev) => prev.filter((id) => id !== file.fileId));
      if (file.fileId === latestFileId) setLatestFileId(null);
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
            {/* key 随轮询目标变化：切换后上传区回到初始态，避免残留旧文件名 */}
            <FileUpload key={latestFileId ?? 'none'} onSuccess={handleUploadSuccess} />
          </div>
          <Divider style={{ margin: '12px 0' }} />
          <div className="qa-sidebar__list">
            <KnowledgeBase
              files={files}
              activeFileIds={activeFileIds}
              onToggle={(f) =>
                setActiveFileIds((prev) =>
                  prev.includes(f.fileId)
                    ? prev.filter((id) => id !== f.fileId)
                    : [...prev, f.fileId]
                )
              }
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
              uploaded={!!latestFileId}
              filename={activeFilename}
              fileId={latestFileId ?? undefined}
            />

            {/* 对话区 */}
            <div className="qa-page__chat">
              {messages.length === 0 ? (
                <Empty
                  description={
                    ready
                      ? '解析完成，输入问题开始提问'
                      : activeFileIds.length > 0
                        ? '文件解析中，请稍候…'
                        : '从左侧知识库勾选文档开始提问（可多选），或上传新文档'
                  }
                  style={{ padding: '40px 0' }}
                />
              ) : (
                messages.map((msg, i) => {
                  // 流式生成中：已有内容时显示内容（带闪烁光标），无内容时才显示 Spin
                  const isStreaming =
                    msg.role === 'assistant' && asking && i === messages.length - 1;
                  return (
                  <div key={i} className={`qa-page__msg qa-page__msg--${msg.role}`}>
                    {isStreaming && !msg.content ? (
                      <Spin />
                    ) : (
                      <div
                        className={`qa-page__content${isStreaming && msg.content ? ' qa-page__content--streaming' : ''}`}
                      >
                        {msg.role === 'user' ? (
                          msg.content
                        ) : (
                          <>
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                            {/* 引用片段：外层整块可折叠（默认展开），内层每条单独折叠（默认收起） */}
                            {!!msg.sources?.length && (
                              <Collapse
                                ghost
                                size="small"
                                className="qa-page__sources"
                                defaultActiveKey={['sources']}
                                items={[
                                  {
                                    key: 'sources',
                                    label: `引用片段（${msg.sources.length} 条）`,
                                    children: (
                                      <Collapse
                                        ghost
                                        size="small"
                                        defaultActiveKey={[]}
                                        items={msg.sources.map((s, j) => {
                                          const srcFile = files.find((f) => f.fileId === s.fileId);
                                          const isPdf = srcFile?.type === 'pdf';
                                          // 旧数据无 filename：从知识库列表按 fileId 兜底，避免显示 hash 文件名
                                          const name = s.filename ?? srcFile?.filename ?? s.fileId;
                                          // pdf 显示「第 X 页」、docx 显示「第 X 段」；旧数据无页码显示「未知页」
                                          const pageLabel = s.page
                                            ? `第 ${s.page} ${isPdf ? '页' : '段'}`
                                            : '未知页';
                                          // 仅 PDF 来源可定位预览（docx 无法内嵌渲染）
                                          const clickable = isPdf && !!s.fileId && !!s.page;
                                          return {
                                            key: String(j),
                                            label: (
                                              <span className="qa-page__source-label">
                                                {name} · {pageLabel}
                                              </span>
                                            ),
                                            // extra 区域点击不触发展开，用于 PDF 预览定位
                                            extra: clickable ? (
                                              <Button
                                                type="link"
                                                size="small"
                                                icon={<FileSearchOutlined />}
                                                onClick={() => setPreview({ fileId: s.fileId!, page: s.page })}
                                              >
                                                定位
                                              </Button>
                                            ) : undefined,
                                            children: <div className="qa-page__source-text">{s.text}</div>,
                                          };
                                        })}
                                      />
                                    ),
                                  },
                                ]}
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>
          </Card>

          {/* 提问输入区 */}
          {activeFileIds.length > 0 && (
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

      {/* 引用预览：内联渲染 PDF 并定位到引用页 */}
      {preview && (
        <PdfPreview
          fileId={preview.fileId}
          page={preview.page}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
