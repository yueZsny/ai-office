/**
 * 通用上传组件（拖拽上传）
 * - 支持 .pdf/.docx，显示文件大小限制提示（≤20MB）
 * - 上传成功后展示已上传文件（文件名/大小/重新上传）
 * - 回调文件信息 { fileId, filename, file }
 */
import { useState } from 'react';
import { message, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { upload } from '../api';
import UploadedFileInfo from './UploadedFileInfo';

/** 允许的扩展名与大小限制（与后端一致；图片 OCR 入口暂不开放） */
const ACCEPT_EXTS = ['.pdf', '.docx'];
const MAX_SIZE_MB = 20;

/** 上传完成的文件信息（回调给父页面，file 供转换页等需要重传原始文件的场景使用） */
export interface UploadedFile {
  fileId: string;
  filename: string;
  /** 原始文件对象（转换接口需 multipart 重传） */
  file: File;
}

interface FileUploadProps {
  /** 上传成功回调（携带后端返回的 fileId 与文件名） */
  onSuccess: (file: UploadedFile) => void;
  /** 上传失败回调（便于页面清理自身状态，如清空旧文件） */
  onError?: () => void;
}

export default function FileUpload({ onSuccess, onError }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadedInfo, setUploadedInfo] = useState<UploadedFile | null>(null);

  const handleUpload: UploadProps['customRequest'] = async ({ file, onSuccess: antOnSuccess, onError: antOnError }) => {
    setUploading(true);
    try {
      // 网络瞬时故障自动重试一次（同一文件，幂等；避免用户手动重传产生多余记录）
      let info;
      try {
        info = await upload(file as File);
      } catch (err) {
        if ((err as Error).message.includes('timeout') || (err as Error).message.includes('网络异常')) {
          info = await upload(file as File);
        } else {
          throw err;
        }
      }
      const uploaded: UploadedFile = {
        fileId: info.fileId,
        filename: info.filename,
        file: file as File,
      };
      setUploadedInfo(uploaded);
      onSuccess(uploaded);
      antOnSuccess?.(info);
    } catch {
      antOnError?.(new Error('上传失败'));
      onError?.();
    } finally {
      setUploading(false);
    }
  };

  const handleReset = () => {
    setUploadedInfo(null);
    onError?.();
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
    <div>
      <Upload.Dragger
        accept={ACCEPT_EXTS.join(',')}
        multiple={false}
        maxCount={1}
        showUploadList={false}
        disabled={uploading}
        customRequest={handleUpload}
        beforeUpload={beforeUpload}
        // antd 的 disabled 只拦拖拽/点击不拦 input；未上传完成前禁止选新文件，
        // 否则可能同时有两次上传（本组件 state 只存一次结果，落后响应会丢）
        openFileDialogOnClick={!uploading}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽文件到此区域</p>
        <p className="ant-upload-hint">支持 .pdf / .docx 文件，大小不超过 20MB</p>
      </Upload.Dragger>

      {/* 已上传文件展示 */}
      {uploadedInfo && (
        <UploadedFileInfo
          filename={uploadedInfo.filename}
          size={uploadedInfo.file.size}
          onReset={handleReset}
        />
      )}
    </div>
  );
}
