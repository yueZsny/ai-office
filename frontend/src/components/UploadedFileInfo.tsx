/**
 * UploadedFileInfo：已上传文件展示
 * - 文件图标 + 文件名 + 大小 + 重新上传按钮
 * - 供 FileUpload 上传成功后展示（页面能直观看到上传了什么文件）
 */
import { FileImageOutlined, FileOutlined, FilePdfOutlined, FileWordOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button } from 'antd';

interface UploadedFileInfoProps {
  filename: string;
  /** 文件大小（字节） */
  size: number;
  /** 点击重新上传（父组件清空已上传状态） */
  onReset: () => void;
}

/** 字节 → 可读大小（B/KB/MB） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 按扩展名选图标 */
function FileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return <FilePdfOutlined />;
  if (lower.endsWith('.docx')) return <FileWordOutlined />;
  if (/\.(jpe?g|png|bmp)$/.test(lower)) return <FileImageOutlined />;
  return <FileOutlined />;
}

export default function UploadedFileInfo({ filename, size, onReset }: UploadedFileInfoProps) {
  return (
    <div className="uploaded-file">
      <span className="uploaded-file__icon">
        <FileIcon name={filename} />
      </span>
      <span className="uploaded-file__name" title={filename}>
        {filename}
      </span>
      <span className="uploaded-file__size">{formatSize(size)}</span>
      <Button size="small" icon={<ReloadOutlined />} onClick={onReset}>
        重新上传
      </Button>
    </div>
  );
}
