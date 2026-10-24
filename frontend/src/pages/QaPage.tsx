/**
 * 问答页：知识库侧边栏 + 对话区
 * - 左侧知识库：已解析文档列表（多选 / 可删除），多个文件组成问答上下文
 * - 右侧对话区：支持连续提问（保留对话上下文 history），回答内容用 Markdown 渲染
 * - 引用徽标：「文件名 · 第 X 页」/「第 X 段」，点击 PDF 来源弹窗预览定位到对应页
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Collapse, Empty, Input, Layout, Modal, Spin, Tabs, message } from 'antd';
import {
  FileSearchOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
  SendOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import FileUpload from '../components/FileUpload';
import KnowledgeBase from '../components/KnowledgeBase';
import ConversationList from '../components/ConversationList';
import ParseStatus from '../components/ParseStatus';
import PdfPreview from '../components/PdfPreview';
import useFileStatus from '../hooks/useFileStatus';
import {
  deleteConversation,
  deleteFile,
  getConversation,
  listConversations,
  listFiles,
  qaAskStream,
  renameConversation,
  searchKnowledgeBase,
} from '../api';
import type {
  ChatMessage,
  ConversationSummary,
  FileInfo,
  KbSearchResponse,
  KbSearchResult,
  QaResult,
} from '../api';
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

  // 知识库全局搜索（不调 LLM）：输入防抖 300ms，结果点击后选中该文档
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KbSearchResponse | null>(null);

  // 会话（P0-4）：conversationId 为当前打开的持久化会话；列表展示历史
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'docs' | 'conv'>('docs');
  // 重命名弹窗
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);

  // 未勾选任何文档 = 全库问答；勾选后只问所选文档
  // 与 backend MAX_QA_FILES 保持一致：全库模式最多检索最近 50 篇
  const scopeAll = activeFileIds.length === 0;
  const QA_SCOPE_LIMIT = 50;
  // 打开历史会话时，其来源文档可能已被删除：禁止继续追问（避免误切到全库）
  const scopeBroken =
    !scopeAll && activeFileIds.some((id) => !files.some((f) => f.fileId === id));
  // 知识库列表只含已解析文档：全库模式要求列表非空，选中模式要求选中项都在列表中
  const ready = scopeBroken ? false : scopeAll ? files.length > 0 : true;
  // 新上传文档尚未入列时回退到 uploaded 的文件名
  const activeFilename =
    files.find((f) => f.fileId === latestFileId)?.filename ??
    files.find((f) => activeFileIds.includes(f.fileId))?.filename ??
    uploaded?.filename;

  // 拉取知识库列表（返回最新列表，供打开会话时校验来源文档是否还在）
  const loadFiles = useCallback(async (): Promise<FileInfo[]> => {
    try {
      const list = await listFiles();
      setFiles(list);
      return list;
    } catch {
      // 失败提示已由 http 拦截器处理
      return [];
    }
  }, []);

  // 拉取历史会话列表
  const loadConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      setConversations(await listConversations());
    } catch {
      // 失败提示已由 http 拦截器处理
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  /** 开始一个新会话：清空当前消息与会话 ID（不改文档选择） */
  const resetChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setQuestion('');
  }, []);

  // 挂载时拉取知识库列表与会话列表
  useEffect(() => {
    void loadFiles();
    void loadConversations();
  }, [loadFiles, loadConversations]);

  // 知识库搜索：300ms 防抖；cancelled 防止旧请求覆盖新结果
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResult(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchKnowledgeBase(q)
        .then((res) => {
          if (!cancelled) setSearchResult(res);
        })
        .catch(() => {
          if (!cancelled) setSearchResult(null);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  // 新文档解析完成后自动加入知识库列表
  useEffect(() => {
    if (fileStatus?.status === 'parsed') loadFiles();
  }, [fileStatus?.status, loadFiles]);

  // 轮询目标（最新上传文档）已不存在：剔除该项并停止轮询；当前对话也可能引用它 → 重开
  useEffect(() => {
    if (notFound) {
      void loadFiles();
      setActiveFileIds((prev) => prev.filter((id) => id !== latestFileId));
      setLatestFileId(null);
      resetChat();
    }
  }, [notFound, latestFileId, loadFiles, resetChat]);

  // 新消息时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, asking]);

  /** 点击搜索结果：选中该文档（PDF 同时定位到命中页），清空搜索状态 */
  const handleOpenSearchResult = (result: KbSearchResult) => {
    if (asking) return; // 回答中切换目标会让流结果落到新对话，直接忽略
    const sameSelection =
      activeFileIds.length === 1 && activeFileIds[0] === result.fileId;
    if (!sameSelection) {
      setActiveFileIds([result.fileId]);
      resetChat();
    }
    setSearchQuery('');
    setSearchResult(null);
    const file = files.find((f) => f.fileId === result.fileId);
    if (file?.type === 'pdf' && result.page) {
      setPreview({ fileId: result.fileId, page: result.page });
    }
  };

  /** 打开历史会话：恢复消息与当时的文档范围 */
  const handleOpenConversation = async (conversation: ConversationSummary) => {
    if (asking) return;
    try {
      const detail = await getConversation(conversation.id);
      // 刷新列表以便准确判断来源文档是否还在
      const currentFiles = await loadFiles();
      setConversationId(detail.id);
      setMessages(
        detail.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
          sources: msg.sources ?? undefined,
        }))
      );
      setQuestion('');
      if (detail.fileIds === null) {
        setActiveFileIds([]);
      } else {
        const availableIds = detail.fileIds.filter((id) =>
          currentFiles.some((f) => f.fileId === id)
        );
        // 有剩余文档时按剩余范围继续（下次提问会把新范围写回会话）；
        // 全部被删则保持原范围（scopeBroken 禁用输入，引导新建会话）
        setActiveFileIds(availableIds.length ? availableIds : detail.fileIds);
        if (availableIds.length < detail.fileIds.length) {
          message.warning(
            availableIds.length
              ? '部分来源文档已被删除，本会话将仅使用剩余文档'
              : '该会话的全部来源文档已被删除，请新建会话或重新选择文档'
          );
        }
      }
      setSidebarTab('conv');
    } catch {
      // 404/网络错误提示已由拦截器处理
    }
  };

  /** 新建会话：清空右侧对话，保留当前文档选择（未选择 = 全库） */
  const handleNewChat = () => {
    if (asking) return;
    if (scopeBroken) {
      // 历史会话的来源文档全被删除：清空选择，回到可选状态（未选择 = 全库）
      setActiveFileIds([]);
      setSidebarTab('docs');
      message.info('来源文档已不存在，已清空选择；请重新选择文档或直接全库提问');
    }
    resetChat();
  };

  /** 重命名会话 */
  const handleRenameConversation = async () => {
    if (!renameTarget || renaming) return;
    const title = renameTitle.trim();
    if (!title) return;
    setRenaming(true);
    try {
      const updated = await renameConversation(renameTarget.id, title);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === updated.id ? { ...c, title: updated.title, updatedAt: updated.updatedAt } : c
        )
      );
      setRenameTarget(null);
    } catch {
      // 错误提示已由拦截器处理
    } finally {
      setRenaming(false);
    }
  };

  /** 删除会话：若删除的是当前会话，清空右侧对话 */
  const handleDeleteConversation = async (conversation: ConversationSummary) => {
    if (asking) return;
    try {
      await deleteConversation(conversation.id);
      setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
      if (conversationId === conversation.id) resetChat();
    } catch {
      // 错误提示已由拦截器处理
    }
  };

  const handleSend = async () => {
    const q = question.trim();
    if (!q || !ready || asking) return;
    // 追加用户消息
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setQuestion('');
    setAsking(true);
    try {
      // 已有会话时服务端从 DB 读历史；首次提问才由前端携带（兼容旧链路）
      const history = conversationId
        ? []
        : messages.map(({ role, content }) => ({ role, content }));
      const res = await qaAskStream(activeFileIds, q, history, {
        conversationId: conversationId ?? undefined,
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
      // 首次提问：后端创建会话后经 X-Conversation-Id 返回
      if (!conversationId && res.conversationId) setConversationId(res.conversationId);
      // 刷新历史会话列表（标题/时间/消息条数）
      void loadConversations();
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
      const errMsg = (err as Error).message;
      // 当前会话被其他端删除（404）：清空会话并刷新列表
      if (/会话不存在:/.test(errMsg)) {
        resetChat();
        void loadConversations();
        message.warning('该会话已被删除，已切换到新会话');
      }
      // 某选中文档已被删除（404 消息含 fileId）：剔除该项并重开对话，避免误切全库
      const deletedId = /文件不存在:\s*([\w-]+)/.exec(errMsg)?.[1];
      if (deletedId) {
        void loadFiles();
        setActiveFileIds((prev) => prev.filter((id) => id !== deletedId));
        resetChat();
        message.warning('来源文档已被删除，已切换到新会话');
      }
    } finally {
      setAsking(false);
    }
  };

  /** 上传成功：新文档加入选中集并成为轮询目标（解析完成后自动入列）；开始新会话 */
  const handleUploadSuccess = (file: UploadedFile) => {
    setUploaded(file);
    setLatestFileId(file.fileId);
    if (asking) {
      // 回答中不切换当前会话范围；文件解析完成后会出现在知识库列表
      message.warning('已上传文档，请等待当前回答完成后再开始新会话');
      void loadFiles();
      return;
    }
    setActiveFileIds((prev) => (prev.includes(file.fileId) ? prev : [...prev, file.fileId]));
    resetChat();
    setSidebarTab('docs');
    void loadFiles();
  };

  /** 删除知识库文档：从列表与选中集中移除；删除轮询目标时停止轮询 */
  const handleDelete = async (file: FileInfo) => {
    if (asking) return;
    const wasSelected = activeFileIds.includes(file.fileId);
    try {
      await deleteFile(file.fileId);
      setFiles(files.filter((f) => f.fileId !== file.fileId));
      setActiveFileIds((prev) => prev.filter((id) => id !== file.fileId));
      if (file.fileId === latestFileId) setLatestFileId(null);
      if (wasSelected) resetChat();
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
            <span className="qa-sidebar__title">知识库 / 会话</span>
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
          <Tabs
            size="small"
            className="qa-sidebar__tabs"
            activeKey={sidebarTab}
            onChange={(key) => setSidebarTab(key as 'docs' | 'conv')}
            items={[
              {
                key: 'docs',
                label: '文档',
                children: (
                  <div className="qa-sidebar__docs">
                    {/* 全局搜索：检索全部已解析文档，点击结果选中该文档 */}
                    <div className="qa-sidebar__search">
                      <Input
                        allowClear
                        size="small"
                        prefix={<SearchOutlined />}
                        placeholder="搜索全部文档内容"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      {searchQuery.trim() && (
                        <div className="kb-search">
                          {searching ? (
                            <div className="kb-search__hint">
                              <Spin size="small" /> 搜索中…
                            </div>
                          ) : searchResult?.results.length ? (
                            <>
                              {searchResult.truncated && (
                                <div className="kb-search__hint">
                                  仅检索最近 {searchResult.searchedFileCount} 篇文档
                                </div>
                              )}
                              {searchResult.results.map((result, i) => {
                                const file = files.find((f) => f.fileId === result.fileId);
                                const pageLabel = result.page
                                  ? `第 ${result.page} ${file?.type === 'pdf' ? '页' : '段'}`
                                  : '未知页';
                                return (
                                  <div
                                    key={`${result.fileId}-${result.chunkIndex}-${i}`}
                                    className="kb-search-item"
                                    title={result.text}
                                    onClick={() => handleOpenSearchResult(result)}
                                  >
                                    <div className="kb-search-item__meta">
                                      <span className="kb-search-item__name">
                                        {result.filename}
                                      </span>
                                      <span className="kb-search-item__page">{pageLabel}</span>
                                    </div>
                                    <div className="kb-search-item__text">{result.text}</div>
                                  </div>
                                );
                              })}
                            </>
                          ) : (
                            <div className="kb-search__hint">无匹配内容</div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="qa-sidebar__list">
                      <KnowledgeBase
                        files={files}
                        activeFileIds={activeFileIds}
                        onToggle={(f) => {
                          if (asking) return;
                          setActiveFileIds((prev) =>
                            prev.includes(f.fileId)
                              ? prev.filter((id) => id !== f.fileId)
                              : [...prev, f.fileId]
                          );
                          resetChat();
                        }}
                        onDelete={handleDelete}
                      />
                    </div>
                  </div>
                ),
              },
              {
                key: 'conv',
                label: '会话',
                children: (
                  <ConversationList
                    conversations={conversations}
                    activeId={conversationId}
                    loading={conversationsLoading}
                    onOpen={handleOpenConversation}
                    onNew={handleNewChat}
                    onRename={(conversation) => {
                      setRenameTarget(conversation);
                      setRenameTitle(conversation.title);
                    }}
                    onDelete={handleDeleteConversation}
                  />
                ),
              },
            ]}
          />
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
                    scopeBroken
                      ? '部分来源文档已被删除，请新建会话或重新选择文档'
                      : ready
                        ? scopeAll
                          ? `未选择文档，直接提问将检索全部知识库（${files.length} 篇）`
                          : '解析完成，输入问题开始提问'
                        : activeFileIds.length > 0 || latestFileId
                          ? '文件解析中，请稍候…'
                          : files.length === 0
                            ? '知识库为空，请先在左侧上传文档'
                            : '正在加载知识库…'
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

          {/* 提问输入区：未勾选文档时走全库问答 */}
          {(ready || activeFileIds.length > 0 || latestFileId) && (
            <Card className="glass-card">
              {ready && scopeAll && (
                <div className="qa-page__scope-hint text-secondary">
                  未选择文档，将在
                  {files.length > QA_SCOPE_LIMIT
                    ? `最近 ${QA_SCOPE_LIMIT} 篇（知识库共 ${files.length} 篇）`
                    : `全部 ${files.length} 篇`}
                  已解析文档中检索
                </div>
              )}
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 4 }}
                placeholder={
                  !ready
                    ? scopeBroken
                      ? '部分来源文档已被删除，请新建会话或重新选择文档'
                      : '文件解析中，请稍候…'
                    : scopeAll
                      ? '未选择文档：检索全部知识库。输入你的问题，Enter 发送'
                      : '输入你的问题，Enter 发送，Shift+Enter 换行'
                }
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

      {/* 重命名会话 */}
      <Modal
        title="重命名会话"
        open={!!renameTarget}
        onOk={handleRenameConversation}
        onCancel={() => setRenameTarget(null)}
        confirmLoading={renaming}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !renameTitle.trim() }}
      >
        <Input
          value={renameTitle}
          onChange={(e) => setRenameTitle(e.target.value)}
          onPressEnter={handleRenameConversation}
          maxLength={60}
          showCount
          placeholder="输入会话标题"
        />
      </Modal>
    </div>
  );
}
