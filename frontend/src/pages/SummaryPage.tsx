/**
 * 摘要页：上传文档 → 配置篇幅/风格/重点 → 生成摘要 / 思维导图
 * - 摘要结果可复制、导出 Markdown、导出 Word（复用 assemble 渲染）
 * - 长文档由后端自动 map-reduce；超长时均匀抽样并在结果区提示覆盖范围
 * - 脑图结果可一键跳转生成页（「用此大纲生成文档」，大纲预填）
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, Segmented, Spin, message } from 'antd';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import FileUpload from '../components/FileUpload';
import ParseStatus from '../components/ParseStatus';
import useFileStatus from '../hooks/useFileStatus';
import { assembleDoc, downloadUrl, qaMindmap, qaSummary } from '../api';
import type { SummaryLength, SummaryResult, SummaryStyle } from '../api';
import { mindmapMarkdownToOutline } from '../utils/outline';
import { downloadTextFile, sanitizeFilename } from '../utils/download';
import {
  buildSummaryBaseName,
  buildSummaryMarkdown,
  describeSummaryOptions,
  resolveSummaryOptions,
  splitSummaryForWord,
} from '../utils/summaryExport';
import type { ResolvedSummaryOptions } from '../utils/summaryExport';
import type { UploadedFile } from '../components/FileUpload';

/** 一次已生成摘要：结果 + 生成时的选项快照 + 来源文件名（导出不读取当前控件） */
interface GeneratedSummary {
  result: SummaryResult;
  options: ResolvedSummaryOptions;
  sourceName: string;
}

/** 去掉文件扩展名，得到展示/导出用的标题主名 */
function fileBaseName(filename: string | undefined): string {
  return (filename || '文档').replace(/\.\w+$/, '');
}

export default function SummaryPage() {
  const navigate = useNavigate();
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  // 上传后轮询解析状态，parsed 后才能生成摘要/脑图
  const { status: fileStatus, notFound } = useFileStatus(uploaded?.fileId);

  // 摘要选项（只影响下一次生成；导出使用结果里的快照）
  const [summaryLength, setSummaryLength] = useState<SummaryLength>('standard');
  const [summaryStyle, setSummaryStyle] = useState<SummaryStyle>('paragraph');
  const [summaryFocus, setSummaryFocus] = useState('');

  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedSummary | null>(null);
  const [exportingWord, setExportingWord] = useState(false);

  const [mindmapping, setMindmapping] = useState(false);
  const [mindmapMarkdown, setMindmapMarkdown] = useState('');
  // 结果卡片折叠状态（重新生成时自动展开）
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [mindmapCollapsed, setMindmapCollapsed] = useState(false);
  const mindmapSvgRef = useRef<SVGSVGElement | null>(null);
  const mindmapRef = useRef<Markmap | null>(null);
  // 摘要请求序号：上传/重置/重新生成后，旧请求的结果直接丢弃
  const summarySeq = useRef(0);

  // 解析完成可生成
  const ready = fileStatus?.status === 'parsed';

  const summarySourceBase = fileBaseName(generated?.sourceName);

  // 生成时选项与当前控件不一致 → 提示需重新生成
  const optionsChanged =
    !!generated &&
    (summaryLength !== generated.options.length ||
      summaryStyle !== generated.options.style ||
      summaryFocus.replace(/\s+/g, ' ').trim() !== generated.options.focus);

  /** 重新生成摘要：捕获当前选项快照，旧请求结果不回写 */
  const handleGenerate = async () => {
    if (!uploaded) return;
    const fileId = uploaded.fileId;
    const sourceName = uploaded.filename;
    const options = resolveSummaryOptions({
      length: summaryLength,
      style: summaryStyle,
      focus: summaryFocus,
    });
    const seq = ++summarySeq.current;

    setGenerating(true);
    setGenerated(null);
    setSummaryCollapsed(false);
    try {
      const result = await qaSummary(fileId, options);
      if (seq !== summarySeq.current) return;
      setGenerated({ result, options, sourceName });
    } catch {
      // http 拦截器已统一提示错误
    } finally {
      if (seq === summarySeq.current) setGenerating(false);
    }
  };

  const handleGenerateMindmap = async () => {
    if (!uploaded) return;
    setMindmapping(true);
    setMindmapMarkdown('');
    setMindmapCollapsed(false);
    try {
      const res = await qaMindmap(uploaded.fileId);
      setMindmapMarkdown(res.markdown);
    } finally {
      setMindmapping(false);
    }
  };

  /** 复制摘要正文 */
  const handleCopySummary = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.result.summary);
      message.success('已复制摘要');
    } catch {
      message.error('复制失败，请手动选择复制');
    }
  };

  /** 导出 Markdown：纯前端 Blob 下载，零后端成本 */
  const handleDownloadMarkdown = () => {
    if (!generated) return;
    const filename = `${buildSummaryBaseName(summarySourceBase, generated.options)}.md`;
    const markdown = buildSummaryMarkdown(
      summarySourceBase,
      generated.result.summary,
      generated.options
    );
    downloadTextFile(filename, markdown, 'text/markdown;charset=utf-8');
  };

  /** 导出 Word：复用 assemble 渲染（不调 LLM），下载走现有下载接口 */
  const handleDownloadWord = async () => {
    if (!generated || exportingWord) return;
    const content = splitSummaryForWord(generated.result.summary);
    if (!content.paragraphs.length && !content.bullets.length) {
      message.warning('摘要内容为空，无法导出 Word');
      return;
    }

    setExportingWord(true);
    try {
      const title = sanitizeFilename(
        buildSummaryBaseName(summarySourceBase, generated.options)
      );
      const result = await assembleDoc(title, [
        {
          title: '摘要',
          level: 1,
          paragraphs: content.paragraphs,
          bullets: content.bullets,
        },
      ]);
      window.open(downloadUrl(result.fileId), '_blank');
    } catch {
      // http 拦截器已统一提示错误
    } finally {
      setExportingWord(false);
    }
  };

  // 新文件上传成功：替换 fileId 并清空旧结果（摘要/脑图针对旧文档已无意义）
  const handleUploaded = (file: UploadedFile) => {
    summarySeq.current += 1;
    setUploaded(file);
    setGenerated(null);
    setSummaryFocus('');
    setMindmapMarkdown('');
    setSummaryCollapsed(false);
    setMindmapCollapsed(false);
    setGenerating(false);
  };

  const handleReset = () => {
    summarySeq.current += 1;
    setUploaded(null);
    setGenerated(null);
    setSummaryFocus('');
    setMindmapMarkdown('');
    setSummaryCollapsed(false);
    setMindmapCollapsed(false);
    setGenerating(false);
  };

  // 上传的文件已不存在（如被知识库删除）：重置上传区，停止无效轮询
  useEffect(() => {
    if (notFound) handleReset();
  }, [notFound]);

  // markdown 到位后渲染 markmap（清空/换图时销毁实例，避免残留节点）
  useEffect(() => {
    if (!mindmapMarkdown || !mindmapSvgRef.current) return;
    const { root } = new Transformer().transform(mindmapMarkdown);
    const mm = Markmap.create(mindmapSvgRef.current, undefined, root);
    mindmapRef.current = mm;
    return () => {
      mindmapRef.current = null;
      mm.destroy();
    };
  }, [mindmapMarkdown]);

  // 脑图卡片展开后容器恢复可见尺寸，重新 fit 使缩放适配当前宽度
  useEffect(() => {
    if (mindmapCollapsed) return;
    requestAnimationFrame(() => mindmapRef.current?.fit());
  }, [mindmapCollapsed]);

  return (
    <div>
      <h2 className="page-title">文档摘要</h2>

      <Card className="glass-card">
        <FileUpload onSuccess={handleUploaded} onError={handleReset} />

        {/* 解析状态：解析中进度条 / 完成 / 失败 */}
        <ParseStatus
          status={fileStatus}
          uploaded={!!uploaded}
          filename={uploaded?.filename}
          fileId={uploaded?.fileId}
        />

        {/* 摘要选项：上传后显示；生成中禁用，避免结果与控件不一致的误解 */}
        {uploaded && (
          <div className="summary-page__options">
            <div className="summary-page__option-row">
              <span className="form-label">摘要篇幅</span>
              <Segmented
                value={summaryLength}
                onChange={(value) => setSummaryLength(value as SummaryLength)}
                disabled={generating}
                options={[
                  { label: '简短', value: 'brief' },
                  { label: '标准', value: 'standard' },
                  { label: '详细', value: 'detailed' },
                ]}
              />
              <span className="text-secondary summary-page__option-hint">
                {summaryLength === 'brief'
                  ? '约 150 字'
                  : summaryLength === 'standard'
                    ? '300-500 字'
                    : '800 字以上'}
              </span>
            </div>

            <div className="summary-page__option-row">
              <span className="form-label">输出风格</span>
              <Segmented
                value={summaryStyle}
                onChange={(value) => setSummaryStyle(value as SummaryStyle)}
                disabled={generating}
                options={[
                  { label: '段落', value: 'paragraph' },
                  { label: '要点列表', value: 'bullets' },
                ]}
              />
            </div>

            <div className="summary-page__option-row">
              <span className="form-label">重点关注（可选）</span>
              <Input
                className="summary-page__focus-input"
                value={summaryFocus}
                onChange={(e) => setSummaryFocus(e.target.value)}
                placeholder="例如：实验部分、财务数据、风险点"
                maxLength={200}
                allowClear
                showCount
                disabled={generating}
              />
            </div>

            <p className="text-secondary summary-page__options-note">
              长文档会自动分段归纳；「详细」摘要耗时更长、消耗更多 token。
            </p>
          </div>
        )}

        <div className="page-actions">
          <Button
            type="primary"
            size="large"
            disabled={!ready || generating}
            loading={generating}
            onClick={handleGenerate}
          >
            {generating ? '生成中…' : '生成摘要'}
          </Button>
          <Button
            size="large"
            disabled={!ready || mindmapping}
            loading={mindmapping}
            onClick={handleGenerateMindmap}
          >
            {mindmapping ? '生成中…' : '生成思维导图'}
          </Button>
          {uploaded && !generating && !mindmapping && (
            <Button onClick={handleReset}>重新上传</Button>
          )}
        </div>

        {/* 生成中提示 */}
        {generating && (
          <div className="page-loading">
            <Spin />
            <p className="text-secondary">
              正在生成摘要，长文档会自动分段归纳，请稍候
            </p>
          </div>
        )}
        {mindmapping && (
          <div className="page-loading">
            <Spin />
            <p className="text-secondary">
              正在生成思维导图（AI 阅读文档中，约需 30-60 秒）
            </p>
          </div>
        )}
      </Card>

      {/* 摘要结果展示（标题栏可折叠；导出使用生成时的选项快照） */}
      {generated && (
        <Card
          className="glass-card page-result"
          title="摘要结果"
          extra={
            <div className="summary-page__result-actions">
              <Button size="small" onClick={handleCopySummary}>
                复制
              </Button>
              <Button size="small" onClick={handleDownloadMarkdown}>
                下载 Markdown
              </Button>
              <Button
                size="small"
                type="primary"
                loading={exportingWord}
                disabled={exportingWord}
                onClick={handleDownloadWord}
              >
                下载 Word
              </Button>
              <Button
                type="text"
                size="small"
                aria-label={summaryCollapsed ? '展开摘要' : '折叠摘要'}
                icon={summaryCollapsed ? <DownOutlined /> : <UpOutlined />}
                onClick={() => setSummaryCollapsed((c) => !c)}
              />
            </div>
          }
        >
          <div style={{ display: summaryCollapsed ? 'none' : undefined }}>
            <div className="summary-page__coverage">
              {generated.result.mode === 'map_reduce' && (
                <p className="text-secondary">
                  {generated.result.truncated
                    ? `文档较长，本次均匀抽取 ${generated.result.coveredChunks ?? '?'} / ${generated.result.totalChunks ?? '?'} 个片段进行归纳`
                    : `长文档已分段归纳（共 ${generated.result.totalChunks ?? '?'} 个片段）`}
                </p>
              )}
              <p className="text-secondary">
                生成选项：{describeSummaryOptions(generated.options)}
                {optionsChanged && '（上方选项已修改，重新生成后生效）'}
              </p>
            </div>
            <div className="result-text">{generated.result.summary}</div>
          </div>
        </Card>
      )}

      {/* 思维导图结果展示（标题栏可折叠；markmap：滚轮缩放、拖拽平移、点击节点折叠） */}
      {mindmapMarkdown && (
        <Card
          className="glass-card page-result"
          title="思维导图"
          extra={
            <span className="summary-page__mindmap-actions">
              <Button
                size="small"
                onClick={() =>
                  navigate('/generate', {
                    state: {
                      title: fileBaseName(uploaded?.filename),
                      outline: mindmapMarkdownToOutline(mindmapMarkdown),
                    },
                  })
                }
              >
                用此大纲生成文档
              </Button>
              <Button
                type="text"
                size="small"
                aria-label={mindmapCollapsed ? '展开思维导图' : '折叠思维导图'}
                icon={mindmapCollapsed ? <DownOutlined /> : <UpOutlined />}
                onClick={() => setMindmapCollapsed((c) => !c)}
              />
            </span>
          }
        >
          {/* 折叠用 display:none 隐藏而非卸载：svg 保持挂载，展开后 markmap 实例不丢 */}
          <svg
            ref={mindmapSvgRef}
            style={{
              width: '100%',
              height: 520,
              display: mindmapCollapsed ? 'none' : undefined,
            }}
          />
        </Card>
      )}
    </div>
  );
}
