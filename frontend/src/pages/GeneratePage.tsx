/**
 * 生成页：输入标题 + 大纲（多行文本）→ 生成 → 显示下载按钮
 * 无需上传文件，大纲由用户直接输入
 */
import { useState } from 'react';
import { Button, Card, Input, Spin } from 'antd';
import ResultDownload from '../components/ResultDownload';
import { generateDoc } from '../api';
import type { TaskResult } from '../api';

export default function GeneratePage() {
  const [title, setTitle] = useState('');
  const [outline, setOutline] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<TaskResult | null>(null);

  // 大纲按行拆分（空行忽略）
  const outlineList = outline
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const canGenerate = title.trim() !== '' && outlineList.length > 0 && !generating;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setResult(null);
    try {
      const res = await generateDoc(title.trim(), outlineList);
      setResult(res);
    } finally {
      setGenerating(false);
    }
  };

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
          <label className="form-label">大纲内容</label>
          <Input.TextArea
            rows={8}
            placeholder={'每行一条大纲，例如：\n1. 项目背景\n2. 技术方案\n3. 实施计划'}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
          />
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
            <p className="text-secondary">文档生成可能需要 1-2 分钟</p>
          </div>
        )}
      </Card>

      {/* 生成结果 */}
      {result && (
        <Card className="glass-card page-result">
          <ResultDownload fileId={result.fileId} filename={`${title.trim() || '文档'}.docx`} />
        </Card>
      )}
    </div>
  );
}
