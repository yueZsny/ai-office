/**
 * 知识库组件：展示全部已解析文档，支持多选（checkbox）与删除
 * - 点击条目切换选中（activeFileIds 高亮），多个文件组成问答上下文
 * - 删除带 Popconfirm 二次确认
 * - 折叠态由 CSS 祖先选择器 .ant-layout-sider-collapsed 控制，组件内部无需感知
 */
import { Button, Checkbox, Empty, Popconfirm } from 'antd';
import { DeleteOutlined, FilePdfOutlined, FileWordOutlined } from '@ant-design/icons';
import type { FileInfo } from '../api';

interface KnowledgeBaseProps {
  /** 知识库文档列表（已解析） */
  files: FileInfo[];
  /** 当前选中的问答目标文档 fileId 集合 */
  activeFileIds: string[];
  /** 点击条目：切换该文档的选中状态 */
  onToggle: (file: FileInfo) => void;
  /** 确认删除 */
  onDelete: (file: FileInfo) => void;
}

export default function KnowledgeBase({
  files,
  activeFileIds,
  onToggle,
  onDelete,
}: KnowledgeBaseProps) {
  if (files.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="知识库为空，上传文档解析完成后自动加入"
      />
    );
  }

  return (
    <div className="kb">
      {files.map((file) => (
        <div
          key={file.fileId}
          className={`kb-item${activeFileIds.includes(file.fileId) ? ' kb-item--active' : ''}`}
          onClick={() => onToggle(file)}
        >
          <Checkbox
            checked={activeFileIds.includes(file.fileId)}
            className="kb-item__checkbox"
          />
          <span className="kb-item__icon">
            {file.type === 'pdf' ? <FilePdfOutlined /> : <FileWordOutlined />}
          </span>
          <span className="kb-item__name" title={file.filename}>
            {file.filename}
          </span>
          <Popconfirm
            title="确认删除该文档？"
            description="将同时清除已入库的问答数据，不可恢复"
            okText="删除"
            cancelText="取消"
            onConfirm={() => onDelete(file)}
          >
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              className="kb-item__delete"
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </div>
      ))}
    </div>
  );
}
