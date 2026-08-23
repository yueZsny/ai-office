/**
 * 摘要页：上传文档 → 一键生成摘要 → 显示摘要文本
 */
import { useEffect, useState } from 'react';
import { Button, Card, Spin } from 'antd';
import FileUpload from '../components/FileUpload';
import ParseStatus from '../components/ParseStatus';
import useFileStatus from '../hooks/useFileStatus';
import { qaSummary } from '../api';
import type { UploadedFile } from '../components/FileUpload';

export default function SummaryPage() {
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  // 上传后轮询解析状态，parsed 后才能生成摘要
  const { status: fileStatus, notFound } = useFileStatus(uploaded?.fileId);
  const [generating, setGenerating] = useState(false);
  const [summary, setSummary] = useState('');

  // 解析完成可生成
  const ready = fileStatus?.status === 'parsed';

  const handleGenerate = async () => {
    if (!uploaded) return;
    setGenerating(true);
    setSummary('');
    try {
      const res = await qaSummary(uploaded.fileId);
      setSummary(res.summary);
    } finally {
      setGenerating(false);
    }
  };

  const handleReset = () => {
    setUploaded(null);
    setSummary('');
  };

  // 上传的文件已不存在（如被知识库删除）：重置上传区，停止无效轮询
  useEffect(() => {
    if (notFound) handleReset();
  }, [notFound]);

  return (
    <div>
      <h2 className="page-title">文档摘要</h2>

      <Card className="glass-card">
        <FileUpload onSuccess={setUploaded} onError={handleReset} />

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
          {uploaded && !generating && (
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
      </Card>

      {/* 摘要结果展示 */}
      {summary && (
        <Card className="glass-card page-result">
          <div className="result-text">{summary}</div>
        </Card>
      )}
    </div>
  );
}
