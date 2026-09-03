/**
 * 摘要页：上传文档 → 一键生成摘要 / 思维导图（markmap 渲染 markdown 大纲）
 * 脑图结果可一键跳转生成页（「用此大纲生成文档」，大纲预填）
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Spin } from 'antd';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import FileUpload from '../components/FileUpload';
import ParseStatus from '../components/ParseStatus';
import useFileStatus from '../hooks/useFileStatus';
import { qaMindmap, qaSummary } from '../api';
import { mindmapMarkdownToOutline } from '../utils/outline';
import type { UploadedFile } from '../components/FileUpload';

export default function SummaryPage() {
  const navigate = useNavigate();
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  // 上传后轮询解析状态，parsed 后才能生成摘要/脑图
  const { status: fileStatus, notFound } = useFileStatus(uploaded?.fileId);
  const [generating, setGenerating] = useState(false);
  const [summary, setSummary] = useState('');
  const [mindmapping, setMindmapping] = useState(false);
  const [mindmapMarkdown, setMindmapMarkdown] = useState('');
  // 结果卡片折叠状态（重新生成时自动展开）
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [mindmapCollapsed, setMindmapCollapsed] = useState(false);
  const mindmapSvgRef = useRef<SVGSVGElement | null>(null);
  const mindmapRef = useRef<Markmap | null>(null);

  // 解析完成可生成
  const ready = fileStatus?.status === 'parsed';

  const handleGenerate = async () => {
    if (!uploaded) return;
    setGenerating(true);
    setSummary('');
    setSummaryCollapsed(false);
    try {
      const res = await qaSummary(uploaded.fileId);
      setSummary(res.summary);
    } finally {
      setGenerating(false);
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

  // 新文件上传成功：替换 fileId 并清空旧结果（摘要/脑图针对旧文档已无意义）
  const handleUploaded = (file: UploadedFile) => {
    setUploaded(file);
    setSummary('');
    setMindmapMarkdown('');
    setSummaryCollapsed(false);
    setMindmapCollapsed(false);
  };

  const handleReset = () => {
    setUploaded(null);
    setSummary('');
    setMindmapMarkdown('');
    setSummaryCollapsed(false);
    setMindmapCollapsed(false);
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
            <p className="text-secondary">正在生成摘要，请稍候</p>
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

      {/* 摘要结果展示（标题栏可折叠） */}
      {summary && (
        <Card
          className="glass-card page-result"
          title="摘要结果"
          extra={
            <Button
              type="text"
              size="small"
              aria-label={summaryCollapsed ? '展开摘要' : '折叠摘要'}
              icon={summaryCollapsed ? <DownOutlined /> : <UpOutlined />}
              onClick={() => setSummaryCollapsed((c) => !c)}
            />
          }
        >
          <div className="result-text" style={{ display: summaryCollapsed ? 'none' : undefined }}>
            {summary}
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
                      title: (uploaded?.filename || '文档').replace(/\.\w+$/, ''),
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
