/**
 * ParseStatus：文件解析状态展示（解析中进度条 + 完成/失败标识）
 * - parsing：进度条动画 + 文案
 * - parsed：绿色对勾 + 提示
 * - failed：红色感叹号 + 失败原因
 * 用于问答页 / 摘要页（useFileStatus 轮询驱动）
 */
import { useEffect, useState } from 'react';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { Alert, Progress } from 'antd';
import type { FileInfo } from '../api';

interface ParseStatusProps {
  /** 轮询到的文件状态（null 表示尚未取到，视为解析中） */
  status: FileInfo | null;
  /** 已上传（status 为 null 且无失败时展示解析中） */
  uploaded: boolean;
  /** 文件名（展示在状态旁） */
  filename?: string;
  /** 当前文件 id：变化即视为新一轮上传/切换，重置成功提示 */
  fileId?: string;
}

export default function ParseStatus({ status, uploaded, filename, fileId }: ParseStatusProps) {
  // 已上传且未到终态 → 解析中（含首次轮询前 status 为 null 的空窗期）
  const parsing = uploaded && !status?.status;
  const parsingNow = parsing || status?.status === 'parsing';
  const parsed = status?.status === 'parsed';
  const failed = status?.status === 'failed';

  // 成功提示仅在本文件首次解析完成时展示一次，可手动关闭；关闭/切换文件后不再弹出
  const [successDismissed, setSuccessDismissed] = useState(true);
  // 切换或新上传文件：先隐藏，避免历史文件的成功状态残留展示
  useEffect(() => {
    setSuccessDismissed(true);
  }, [fileId]);
  // 真正进入解析流程：解析完成时展示一次成功提示
  useEffect(() => {
    if (parsingNow) setSuccessDismissed(false);
  }, [parsingNow]);

  if (parsingNow) {
    return (
      <div className="parse-status parse-status--parsing">
        <Progress
          percent={100}
          showInfo={false}
          status="active"
          strokeColor={{ from: '#1677ff', to: '#69b1ff' }}
          className="parse-status__bar"
        />
        <div className="parse-status__text">
          <span className="text-secondary">
            正在解析{filename ? `「${filename}」` : '文档'}
          </span>
        </div>
      </div>
    );
  }

  // 成功提示仅在本文件首次解析完成时展示一次（提交文件后），可手动关闭
  if (parsed && !successDismissed) {
    return (
      <Alert
        className="parse-status parse-status--done"
        type="success"
        showIcon
        closable
        icon={<CheckCircleFilled />}
        message={
          <span>
            解析完成，已可提问 / 生成摘要
            {filename ? `（${filename}）` : ''}
          </span>
        }
        onClose={() => setSuccessDismissed(true)}
      />
    );
  }

  if (failed) {
    return (
      <Alert
        className="parse-status parse-status--failed"
        type="error"
        showIcon
        icon={<CloseCircleFilled />}
        message="文件解析失败"
        description={status?.errorMessage || '未知错误，请重新上传'}
      />
    );
  }

  return null;
}
