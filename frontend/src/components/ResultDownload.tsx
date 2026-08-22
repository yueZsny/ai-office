/**
 * 结果下载组件：根据 fileId 生成下载链接（GET /api/download/:fileId）
 * 用于转换、生成页面的结果展示
 */
import { Button } from 'antd';
import { DownloadOutlined, FileWordOutlined } from '@ant-design/icons';
import { downloadUrl } from '../api';

interface ResultDownloadProps {
  fileId: string;
  /** 结果文件名（如 xx.docx） */
  filename: string;
}

export default function ResultDownload({ fileId, filename }: ResultDownloadProps) {
  // 打开新标签下载（后端返回文件流，浏览器自动触发下载）
  const handleDownload = () => {
    window.open(downloadUrl(fileId), '_blank');
  };

  return (
    <div className="result-download">
      <FileWordOutlined className="result-download__icon" />
      <div className="result-download__filename">{filename}</div>
      <Button type="primary" size="large" icon={<DownloadOutlined />} onClick={handleDownload}>
        下载文件
      </Button>
    </div>
  );
}
