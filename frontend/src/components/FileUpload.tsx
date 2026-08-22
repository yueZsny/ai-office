/**
 * 通用上传组件（拖拽上传）
 * - 支持 .pdf/.docx，显示文件大小限制提示（≤20MB）
 * - 上传后回调文件信息 { fileId, filename }
 */
import { useState } from 'react';
import { message, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { upload } from '../api';

/** 允许的扩展名与大小限制（与后端一致） */
const ACCEPT_EXTS = ['.pdf', '.docx'];
const MAX_SIZE_MB = 20;

/** 上传完成的文件信息（回调给父页面） */
export interface UploadedFile {
  fileId: string;
  filename: string;
}

interface FileUploadProps {
  /** 上传成功回调（携带后端返回的 fileId 与文件名） */
  onSuccess: (file: UploadedFile) => void;
  /** 上传失败回调（便于页面清理自身状态，如清空旧文件） */
  onError?: () => void;
}

export default function FileUpload({ onSuccess, onError }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);

  const handleUpload: UploadProps['customRequest'] = async ({ file, onSuccess: antOnSuccess, onError: antOnError }) => {
    setUploading(true);
    try {
      const info = await upload(file as File);
      onSuccess({ fileId: info.fileId, filename: info.filename });
      antOnSuccess?.(info);
    } catch {
      antOnError?.(new Error('上传失败'));
      onError?.();
    } finally {
      setUploading(false);
    }
  };

  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    // 校验扩展名
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!ACCEPT_EXTS.includes(ext)) {
      message.error(`仅支持 ${ACCEPT_EXTS.join(' / ')} 文件`);
      return Upload.LIST_IGNORE;
    }
    // 校验大小（≤20MB）
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      message.error('文件大小不能超过 20MB');
      return Upload.LIST_IGNORE;
    }
    return true;
  };

  return (
    <Upload.Dragger
      accept={ACCEPT_EXTS.join(',')}
      multiple={false}
      maxCount={1}
      showUploadList={false}
      disabled={uploading}
      customRequest={handleUpload}
      beforeUpload={beforeUpload}
    >
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text">点击或拖拽文件到此区域</p>
      <p className="ant-upload-hint">支持 .pdf / .docx 文件，大小不超过 20MB</p>
    </Upload.Dragger>
  );
}
