/**
 * 转换页：上传 PDF → 转换 → 显示下载按钮
 */
import { useState } from 'react';
import { Button, Card, Spin } from 'antd';
import FileUpload from '../components/FileUpload';
import ResultDownload from '../components/ResultDownload';
import { convertPdf } from '../api';
import type { TaskResult } from '../api';
import type { UploadedFile } from '../components/FileUpload';

export default function ConvertPage() {
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<TaskResult | null>(null);

  const handleConvert = async () => {
    if (!uploaded) return;
    setConverting(true);
    setResult(null);
    try {
      // 转换接口接收原始文件（multipart），返回结果 fileId 用于下载
      const res = await convertPdf(uploaded.file);
      setResult(res);
    } finally {
      setConverting(false);
    }
  };

  // 重置：清空上传与结果，回到初始状态
  const handleReset = () => {
    setUploaded(null);
    setResult(null);
  };

  return (
    <div>
      <h2 className="page-title">PDF 转 Word</h2>

      <Card className="glass-card">
        {!result ? (
          <>
            <FileUpload onSuccess={setUploaded} onError={handleReset} />

            <div className="page-actions">
              <Button
                type="primary"
                size="large"
                disabled={!uploaded || converting}
                loading={converting}
                onClick={handleConvert}
              >
                {converting ? '转换中…' : '开始转换'}
              </Button>
              {uploaded && !converting && (
                <Button onClick={handleReset}>重新上传</Button>
              )}
            </div>

            {converting && (
              <div className="page-loading">
                <Spin />
                <p className="text-secondary">PDF 较大时可能需要一分钟</p>
              </div>
            )}
          </>
        ) : (
          <>
            <ResultDownload
              fileId={result.fileId}
              // 转换结果文件名：原文件名扩展名换成 .docx
              filename={uploaded?.filename.replace(/\.\w+$/, '.docx') || 'result.docx'}
            />
            <div className="page-actions" style={{ justifyContent: 'center' }}>
              <Button onClick={handleReset}>重新上传</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
