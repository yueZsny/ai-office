/**
 * PDF 预览弹窗：内联渲染下载接口（?inline=1 预览模式），按页定位（#page=N）
 * - 预览模式返回 Content-Disposition: inline + application/pdf，可直接嵌入
 *   （默认 attachment 头在 iframe/embed 中会直接触发下载）
 * - #page= URL fragment 由 Chrome/Edge 内建 PDF 查看器定位；
 *   Firefox/Safari 需 PDF.js 精确渲染（后续 v2）
 */
import { Modal } from 'antd';
import { downloadUrl } from '../api';

interface PdfPreviewProps {
  /** 来源文件 fileId（backend 对外 fileId） */
  fileId: string;
  /** 定位页码（1-based；缺省时打开第一页） */
  page?: number | null;
  onClose: () => void;
}

export default function PdfPreview({ fileId, page, onClose }: PdfPreviewProps) {
  const src = `${downloadUrl(fileId)}?inline=1${page ? `#page=${page}` : ''}`;

  return (
    <Modal
      open
      title="文档预览"
      footer={null}
      width={860}
      onCancel={onClose}
      destroyOnClose
    >
      <embed src={src} type="application/pdf" className="pdf-preview__embed" />
    </Modal>
  );
}
