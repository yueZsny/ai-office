/**
 * 生成页：输入标题 + 大纲 → 流式逐节生成 → 分节工作台 → 组装下载
 *
 * 大纲来源：手动输入（支持 # 前缀层级、> 行写作要求）/ AI 按主题生成 /
 *           知识库导入（参考文档提取大纲）/ 摘要页脑图跳转预填（路由 state）
 * 分节工作台（生成完成后）：
 * - 分节卡片：重新生成（可带修改要求）、编辑（标题/段落/要点）、删除
 * - 增量生成：大纲增改后点「生成文档」只生成新条目，已保留节注入前文概括（context）
 * - 阅读模式：全部节连成一篇滚动长文（react-markdown）
 * - 下载：内容有改动时先 assemble（不调 LLM）再下载
 * - 加入知识库：生成/组装后的 Word 解析入库，可继续问答
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, Modal, Popconfirm, Select, Spin, message } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  assembleDoc,
  downloadUrl,
  generateDocStream,
  generateOutline,
  importGeneratedToKb,
  listFiles,
  qaMindmap,
  regenSection,
} from '../api';
import useFileStatus from '../hooks/useFileStatus';
import { mindmapMarkdownToOutline } from '../utils/outline';
import type { FileInfo, SectionContent, TaskResult } from '../api';

/* ---------- 大纲解析（与 ai-service parse_outline_item 同规则，供 diff 使用） ---------- */

interface OutlineItem {
  level: number;
  title: string;
  requirement: string;
}

function parseOutlineItem(line: string): { level: number; title: string } | null {
  const m = /^(#{1,3})\s*(.+)$/.exec(line.trim());
  if (m) return { level: m[1].length, title: m[2].trim() };
  return { level: 1, title: line.trim() };
}

/** 解析大纲文本：条目 + 紧随其后的 > 要求行（空行/孤立要求行忽略） */
function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      const req = line.slice(1).trim();
      const last = items[items.length - 1];
      if (last && req) {
        last.requirement = last.requirement ? `${last.requirement}；${req}` : req;
      }
      continue;
    }
    const p = parseOutlineItem(line);
    if (p && p.title) items.push({ ...p, requirement: '' });
  }
  return items;
}

/** 按大纲条目顺序重排分节（缺失的节跳过）并同步层级 */
function orderSections(items: OutlineItem[], pool: SectionContent[]): SectionContent[] {
  const result: SectionContent[] = [];
  for (const item of items) {
    const found = pool.find((s) => s.title === item.title);
    if (found) result.push({ ...found, level: item.level });
  }
  return result;
}

/** 已保留节的前文概括（标题 + 首段前 60 字），注入新条目 Prompt 保持口径一致 */
function buildContext(sections: SectionContent[]): string {
  return sections
    .map((s) => `《${s.title}》${(s.paragraphs[0] || '').slice(0, 60)}`)
    .join('\n')
    .slice(0, 2000);
}

/** 从大纲文本中移除某条目的行（含其 > 要求行），与分节删除联动 */
function removeOutlineLines(outlineText: string, title: string): string {
  const out: string[] = [];
  let skipReq = false;
  for (const line of outlineText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) {
      if (skipReq) continue;
      out.push(line);
      continue;
    }
    const p = parseOutlineItem(trimmed);
    if (p && p.title === title) {
      skipReq = true;
      continue;
    }
    skipReq = false;
    out.push(line);
  }
  return out.join('\n');
}

/** 大纲文本中重命名某条目（标题编辑后联动） */
function renameOutlineLine(outlineText: string, oldTitle: string, newTitle: string): string {
  return outlineText
    .split('\n')
    .map((line) => {
      const p = parseOutlineItem(line.trim());
      if (p && p.title === oldTitle) return `${'#'.repeat(p.level)} ${newTitle}`;
      return line;
    })
    .join('\n');
}

/* ---------- 页面组件 ---------- */

export default function GeneratePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [outline, setOutline] = useState('');
  const [generating, setGenerating] = useState(false);
  const [outlining, setOutlining] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [regening, setRegening] = useState(false);

  // 知识库导入（参考文档 → 提取大纲）
  const [knowledgeFiles, setKnowledgeFiles] = useState<FileInfo[]>([]);
  const [knowledgeFileId, setKnowledgeFileId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // 分节工作台状态
  const [sections, setSections] = useState<SectionContent[]>([]);
  const [failed, setFailed] = useState<OutlineItem[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [readMode, setReadMode] = useState(false);

  // 加入知识库：解析入库后轮询状态
  const [kbImporting, setKbImporting] = useState(false);
  const [kbImported, setKbImported] = useState(false);
  const [importPollFileId, setImportPollFileId] = useState<string | undefined>();
  const { status: importKbStatus } = useFileStatus(importPollFileId);
  // 阅读模式：侧边目录滚动高亮（scrollspy）
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // 生成进度（当前节经 ref 中转，供失败时读取，避免闭包旧值）
  const [progress, setProgress] = useState<{ current: string | null; done: number }>({
    current: null,
    done: 0,
  });
  const currentRef = useRef<string | null>(null);

  // 单节重生成弹窗
  const [regenTarget, setRegenTarget] = useState<string | null>(null);
  const [regenRequirement, setRegenRequirement] = useState('');

  // 编辑状态（同一时刻只编辑一节）
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; paragraphs: string; bullets: string }>({
    title: '',
    paragraphs: '',
    bullets: '',
  });

  const outlineList = outline
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const canGenerate = title.trim() !== '' && outlineList.length > 0 && !generating && !outlining;
  const canOutline = topic.trim() !== '' && !outlining && !generating;

  // 进入页面时加载知识库（已解析文档）；摘要页「用此大纲生成文档」跳转带 state 预填
  useEffect(() => {
    void listFiles()
      .then((files) => setKnowledgeFiles(files))
      .catch(() => setKnowledgeFiles([])); // 列表加载失败不阻断页面，导入时再报错

    const state = location.state as { title?: string; outline?: string } | null;
    if (state?.title) setTitle(state.title);
    if (state?.outline) setOutline(state.outline);
  }, [location.state]);

  // 内容修改后需重新入库
  useEffect(() => {
    if (dirty) setKbImported(false);
  }, [dirty]);

  // 轮询加入知识库解析结果
  useEffect(() => {
    if (!importPollFileId || !importKbStatus) return;
    if (importKbStatus.status === 'parsed') {
      setKbImported(true);
      setKbImporting(false);
      setImportPollFileId(undefined);
      message.success('已加入知识库，可前往文档问答使用');
    } else if (importKbStatus.status === 'failed') {
      setKbImporting(false);
      setImportPollFileId(undefined);
      message.error(importKbStatus.errorMessage || '加入知识库失败');
    }
  }, [importPollFileId, importKbStatus]);

  /** 从知识库导入大纲：参考文档 → mindmap 提纲（titles 秒出 / PDF 回退 LLM）→ 填入编辑区 */
  const handleImportOutline = async () => {
    if (!knowledgeFileId || importing) return;
    if (outline.trim() && !window.confirm('导入将覆盖当前大纲内容，继续？')) return;

    setImporting(true);
    try {
      const res = await qaMindmap(knowledgeFileId);
      const converted = mindmapMarkdownToOutline(res.markdown);
      if (!converted) {
        message.warning('该文档未能提取出大纲结构');
        return;
      }
      setOutline(converted);
      if (!title.trim()) {
        const source = knowledgeFiles.find((f) => f.fileId === knowledgeFileId);
        setTitle((source?.filename || '文档').replace(/\.\w+$/, ''));
      }
      message.success('大纲已导入，可编辑后生成');
    } finally {
      setImporting(false);
    }
  };

  const handleAiOutline = async () => {
    if (!canOutline) return;
    setOutlining(true);
    try {
      const res = await generateOutline(topic.trim());
      setOutline(res.markdown);
      if (!title.trim()) setTitle(topic.trim());
    } finally {
      setOutlining(false);
    }
  };

  /** 生成（或增量生成）：diff 大纲，只生成新条目；已保留节注入 context 概括 */
  const handleGenerate = async () => {
    if (!canGenerate) return;
    const items = parseOutline(outline);
    if (!items.length) return;

    setGenerating(true);
    setResult(null);
    setKbImported(false);
    setImportPollFileId(undefined);
    setProgress({ current: null, done: 0 });

    try {
      // diff：标题一致的条目保留（不重复调用 LLM），只发送新条目（含其 > 要求行）
      const existingTitles = new Set(sections.map((s) => s.title));
      const newRaw: string[] = [];
      for (const item of items) {
        if (!existingTitles.has(item.title)) {
          newRaw.push(`${'#'.repeat(item.level)} ${item.title}`);
          if (item.requirement) newRaw.push(`> ${item.requirement}`);
        }
      }

      if (newRaw.length === 0) {
        // 无新增条目：仅按新顺序重排并同步层级
        setSections((prev) => orderSections(items, prev));
        message.info('大纲无新增条目，已按新顺序排列');
        return;
      }

      const context = buildContext(sections);
      const res = await generateDocStream(
        title.trim(),
        newRaw,
        {
          onSectionStart: (_index, sectionTitle) => {
            currentRef.current = sectionTitle;
            setProgress((p) => ({ ...p, current: sectionTitle }));
          },
          onSectionDone: (_index, section) => {
            currentRef.current = null;
            setProgress((p) => ({ current: null, done: p.done + 1 }));
            setSections((prev) => [...prev, section]);
          },
        },
        context
      );

      // 按大纲顺序重排（保留节 + 新生成节）；已补上的失败节清掉
      setSections((prev) => orderSections(items, prev));
      setFailed((prev) => prev.filter((f) => !items.some((it) => it.title === f.title)));
      setResult(res);
      setDirty(false);
    } catch {
      // 错误 toast 已由 api 层弹出；当前生成中的节记为失败（已收到的节保留）
      const failedTitle = currentRef.current;
      if (failedTitle) {
        const item = items.find((it) => it.title === failedTitle);
        setFailed((prev) => [
          ...prev.filter((f) => f.title !== failedTitle),
          { title: failedTitle, level: item?.level ?? 1, requirement: item?.requirement ?? '' },
        ]);
      }
    } finally {
      currentRef.current = null;
      setGenerating(false);
    }
  };

  /** 单节重新生成（弹窗确认，可带修改要求） */
  const handleRegen = async () => {
    if (!regenTarget || regening) return;
    const target = sections.find((s) => s.title === regenTarget);
    if (!target) return;
    setRegening(true);
    try {
      const others = sections.filter((s) => s.title !== regenTarget);
      const res = await regenSection({
        docTitle: title.trim(),
        sectionTitle: target.title,
        level: target.level,
        requirement: regenRequirement.trim() || undefined,
        context: buildContext(others),
      });
      setSections((prev) => prev.map((s) => (s.title === regenTarget ? res : s)));
      setDirty(true);
      setResult(null);
      setRegenTarget(null);
      setRegenRequirement('');
    } finally {
      setRegening(false);
    }
  };

  /** 失败节重试（按大纲里该条目的层级与要求） */
  const handleRetryFailed = async (failedItem: OutlineItem) => {
    if (regening) return;
    setRegening(true);
    try {
      const res = await regenSection({
        docTitle: title.trim(),
        sectionTitle: failedItem.title,
        level: failedItem.level,
        requirement: failedItem.requirement || undefined,
        context: buildContext(sections),
      });
      setSections((prev) => orderSections(parseOutline(outline), [...prev, res]));
      setFailed((prev) => prev.filter((f) => f.title !== failedItem.title));
      setDirty(true);
    } finally {
      setRegening(false);
    }
  };

  /* ---------- 编辑 ---------- */

  const startEdit = (s: SectionContent) => {
    setEditingTitle(s.title);
    setEditDraft({
      title: s.title,
      paragraphs: s.paragraphs.join('\n'),
      bullets: s.bullets.map((b) => `- ${b}`).join('\n'),
    });
  };

  const saveEdit = () => {
    const newTitle = editDraft.title.trim();
    if (!newTitle || !editingTitle) return;
    const paragraphs = editDraft.paragraphs
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const bullets = editDraft.bullets
      .split('\n')
      .map((l) => l.trim().replace(/^-\s*/, ''))
      .filter(Boolean);
    setSections((prev) =>
      prev.map((s) =>
        s.title === editingTitle ? { ...s, title: newTitle, paragraphs, bullets } : s
      )
    );
    if (newTitle !== editingTitle) {
      setOutline((prev) => renameOutlineLine(prev, editingTitle, newTitle));
    }
    setEditingTitle(null);
    setDirty(true);
    setResult(null);
  };

  const cancelEdit = () => setEditingTitle(null);

  /** 删除一节：移除分节卡片并联动清理大纲对应行 */
  const handleDelete = (sectionTitle: string) => {
    setSections((prev) => prev.filter((s) => s.title !== sectionTitle));
    setOutline((prev) => removeOutlineLines(prev, sectionTitle));
    setDirty(true);
    setResult(null);
  };

  /* ---------- 下载 ---------- */

  /** 下载 Word（统一入口）：内容有改动（或无现成文件）时先 assemble（不调 LLM，秒出），否则直接下载 */
  const handleDownloadClick = async () => {
    if (!sections.length || assembling) return;
    setAssembling(true);
    try {
      let r = result;
      if (dirty || !r) {
        r = await assembleDoc(title.trim(), sections);
        setResult(r);
        setDirty(false);
      }
      window.open(downloadUrl(r.fileId), '_blank');
    } finally {
      setAssembling(false);
    }
  };

  /** 加入知识库：先确保有最新 docx（必要时 assemble），再触发后台解析入库 */
  const handleImportToKb = async () => {
    if (kbImporting || kbImported || !sections.length) return;
    setKbImporting(true);
    try {
      let r = result;
      if (dirty || !r) {
        r = await assembleDoc(title.trim(), sections);
        setResult(r);
        setDirty(false);
      }
      await importGeneratedToKb(r.fileId);
      setImportPollFileId(r.fileId);
    } catch {
      setKbImporting(false);
    }
  };

  /** 阅读模式：全部节连成一篇 markdown 长文（供复制 Markdown 用） */
  const docMarkdown =
    `# ${title.trim() || '未命名文档'}\n\n` +
    sections
      .map((s) => {
        const head = `${'#'.repeat(Math.min(s.level + 1, 4))} ${s.title}`;
        const body = s.paragraphs.join('\n\n');
        const list = s.bullets.length ? `\n\n${s.bullets.map((b) => `- ${b}`).join('\n')}` : '';
        return `${head}\n\n${body}${list}`;
      })
      .join('\n\n');

  /** 纯文本版全文（供复制纯文本用）：标题 + 节标题 + 段落 + 要点 */
  const plainText = [title.trim() || '未命名文档']
    .concat(
      sections.map((s) =>
        [s.title, ...s.paragraphs, ...s.bullets.map((b) => `- ${b}`)].join('\n')
      )
    )
    .join('\n\n');

  /** 滚动到指定节（侧边目录点击定位） */
  const scrollToSection = (sectionTitle: string) => {
    sectionRefs.current[sectionTitle]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /** 复制全文（Markdown / 纯文本） */
  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制${label}`);
    } catch {
      message.error('复制失败，请手动选择复制');
    }
  };

  // 阅读模式滚动高亮：按节顶边位置判断当前节（scrollspy）
  useEffect(() => {
    if (!readMode) return;
    const onScroll = () => {
      let current = sections[0]?.title ?? null;
      for (const s of sections) {
        const el = sectionRefs.current[s.title];
        if (!el) continue;
        const top = el.getBoundingClientRect().top + window.scrollY;
        if (top - 140 <= window.scrollY) current = s.title;
      }
      setActiveTitle(current);
    };
    window.addEventListener('scroll', onScroll);
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [readMode, sections]);

  return (
    <div>
      <h2 className="page-title">大纲生成</h2>

      <Card className="glass-card">
        <div className="form-item">
          <label className="form-label">文档标题</label>
          <Input
            placeholder="请输入文档标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="form-item">
          <label className="form-label">文档主题（可选，AI 帮你想大纲）</label>
          <div className="generate-page__ai-row">
            <Input
              placeholder="例如：写一份《校园社团招新策划方案》"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onPressEnter={handleAiOutline}
            />
            <Button
              type="primary"
              loading={outlining}
              disabled={!canOutline}
              onClick={handleAiOutline}
            >
              AI 帮我想大纲
            </Button>
          </div>
        </div>

        <div className="form-item">
          <label className="form-label">大纲内容</label>
          <p className="text-secondary generate-page__hint">
            支持 # 表示层级；条目下一行用 &gt; 开头可写该节的写作要求，如「&gt; 要体现互相认识的目的」
          </p>
          <Input.TextArea
            rows={8}
            placeholder={'每行一条大纲，可用 # 表示层级，条目下一行可用 > 写要求，例如：\n# 活动背景分析\n> 要体现互相认识的目的\n## 活动时间与地点'}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
          />
        </div>

        <div className="form-item">
          <label className="form-label">从知识库导入大纲（可选，参考文档提取）</label>
          <div className="generate-page__ai-row">
            <Select
              style={{ flex: 1 }}
              placeholder={
                knowledgeFiles.length
                  ? '选择一篇已解析的文档'
                  : '知识库暂无已解析文档，请先在问答页上传解析'
              }
              value={knowledgeFileId ?? undefined}
              onChange={(v) => setKnowledgeFileId(v)}
              disabled={!knowledgeFiles.length || importing}
              options={knowledgeFiles.map((f) => ({ value: f.fileId, label: f.filename }))}
              showSearch
              optionFilterProp="label"
            />
            <Button
              loading={importing}
              disabled={!knowledgeFileId || importing || generating}
              onClick={handleImportOutline}
            >
              {importing ? '提取中…' : '导入大纲'}
            </Button>
          </div>
        </div>

        <div className="page-actions">
          <Button
            type="primary"
            size="large"
            disabled={!canGenerate}
            loading={generating}
            onClick={handleGenerate}
          >
            {generating ? '生成中…' : '生成文档'}
          </Button>
        </div>

        {generating && (
          <div className="page-loading">
            <Spin />
            <p className="text-secondary">
              {progress.current
                ? `正在生成：${progress.current}…`
                : '准备生成…'}
            </p>
            {progress.done > 0 && (
              <p className="text-secondary">已完成 {progress.done} 个新条目</p>
            )}
          </div>
        )}
      </Card>

      {/* 分节工作台 */}
      {sections.length > 0 && (
        <Card
          className="glass-card page-result"
          title="文档预览"
          extra={
            <div className="generate-page__toolbar">
              <Button size="small" onClick={() => setReadMode((v) => !v)}>
                {readMode ? '卡片模式' : '阅读模式'}
              </Button>
              <Button size="small" onClick={() => handleCopy(docMarkdown, '全文（Markdown）')}>
                复制 Markdown
              </Button>
              <Button size="small" onClick={() => handleCopy(plainText, '全文（纯文本）')}>
                复制纯文本
              </Button>
              {dirty && <span className="text-secondary">内容已修改，下载时将重新合成</span>}
              <Button
                size="small"
                type="primary"
                loading={assembling}
                disabled={sections.length === 0 || assembling}
                onClick={handleDownloadClick}
              >
                下载 Word
              </Button>
              <Button
                size="small"
                loading={kbImporting}
                disabled={
                  sections.length === 0 || kbImporting || kbImported || assembling
                }
                onClick={handleImportToKb}
              >
                {kbImported ? '已在知识库' : '加入知识库'}
              </Button>
              {kbImported && (
                <Button size="small" type="link" onClick={() => navigate('/qa')}>
                  前往问答
                </Button>
              )}
            </div>
          }
        >
          {readMode ? (
            <div className="generate-page__read-layout">
              {/* 侧边目录：由大纲层级生成，点击定位、滚动高亮 */}
              <aside className="generate-page__toc">
                <div className="generate-page__toc-title text-secondary">文档目录</div>
                {sections.map((s) => (
                  <a
                    key={s.title}
                    className={`generate-page__toc-item generate-page__toc-item--l${s.level}${
                      activeTitle === s.title ? ' generate-page__toc-item--active' : ''
                    }`}
                    onClick={() => scrollToSection(s.title)}
                  >
                    {s.title}
                  </a>
                ))}
              </aside>
              {/* 正文：结构化渲染，标题层级与 Word 三级标题对应 */}
              <div className="generate-page__read-content">
                <h1>{title.trim() || '未命名文档'}</h1>
                {sections.map((s) => (
                  <section
                    key={s.title}
                    ref={(el) => {
                      sectionRefs.current[s.title] = el;
                    }}
                  >
                    {s.level === 1 ? <h2>{s.title}</h2> : s.level === 2 ? <h3>{s.title}</h3> : <h4>{s.title}</h4>}
                    {s.paragraphs.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                    {s.bullets.length > 0 && (
                      <ul>
                        {s.bullets.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            </div>
          ) : (
            <>
              {sections.map((s) => (
                <div className="generate-page__section" key={s.title}>
                  <div className="generate-page__section-head">
                    {editingTitle === s.title ? (
                      <Input
                        value={editDraft.title}
                        onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                      />
                    ) : (
                      <span className={`generate-page__section-title generate-page__section-title--l${s.level}`}>
                        {s.title}
                      </span>
                    )}
                    <span className="generate-page__section-actions">
                      {editingTitle === s.title ? (
                        <>
                          <Button size="small" type="primary" onClick={saveEdit}>
                            保存
                          </Button>
                          <Button size="small" onClick={cancelEdit}>
                            取消
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="small" disabled={regening} onClick={() => setRegenTarget(s.title)}>
                            重新生成
                          </Button>
                          <Button size="small" disabled={regening} onClick={() => startEdit(s)}>
                            编辑
                          </Button>
                          <Popconfirm title="删除这一节？" onConfirm={() => handleDelete(s.title)}>
                            <Button size="small" danger>
                              删除
                            </Button>
                          </Popconfirm>
                        </>
                      )}
                    </span>
                  </div>
                  {editingTitle === s.title ? (
                    <div className="generate-page__section-edit">
                      <Input.TextArea
                        value={editDraft.paragraphs}
                        onChange={(e) => setEditDraft((d) => ({ ...d, paragraphs: e.target.value }))}
                        autoSize={{ minRows: 4 }}
                        placeholder="正文段落（每段一行）"
                      />
                      <Input.TextArea
                        value={editDraft.bullets}
                        onChange={(e) => setEditDraft((d) => ({ ...d, bullets: e.target.value }))}
                        autoSize={{ minRows: 2 }}
                        placeholder="要点（每行以 - 开头）"
                      />
                    </div>
                  ) : (
                    <div className="generate-page__section-body">
                      {s.paragraphs.map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                      {s.bullets.length > 0 && (
                        <ul>
                          {s.bullets.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* 失败节占位卡 */}
              {failed.map((f) => (
                <div className="generate-page__section generate-page__section--failed" key={f.title}>
                  <div className="generate-page__section-head">
                    <span className="generate-page__section-title">{f.title}</span>
                    <span className="generate-page__section-actions">
                      <Button size="small" type="primary" loading={regening} onClick={() => handleRetryFailed(f)}>
                        重试
                      </Button>
                      <Popconfirm title="移除这一节？" onConfirm={() => setFailed((prev) => prev.filter((x) => x.title !== f.title))}>
                        <Button size="small" danger>
                          移除
                        </Button>
                      </Popconfirm>
                    </span>
                  </div>
                  <p className="text-secondary">该节生成失败，可点击「重试」单独重新生成（不影响其他节）。</p>
                </div>
              ))}
            </>
          )}
        </Card>
      )}

      {/* 单节重生成弹窗 */}
      <Modal
        title={`重新生成「${regenTarget ?? ''}」`}
        open={!!regenTarget}
        onOk={handleRegen}
        onCancel={() => {
          setRegenTarget(null);
          setRegenRequirement('');
        }}
        confirmLoading={regening}
        okText="重新生成"
        cancelText="取消"
      >
        <p className="text-secondary">
          可选：填写修改要求（如「太短了，写详细一点」），留空则按原要求重新生成。
        </p>
        <Input.TextArea
          rows={3}
          value={regenRequirement}
          onChange={(e) => setRegenRequirement(e.target.value)}
          placeholder="修改要求（可选）"
        />
      </Modal>
    </div>
  );
}
