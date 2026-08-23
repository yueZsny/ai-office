/**
 * useFileStatus：轮询文件解析状态
 * - 上传后文件处于 uploaded/parsing，2s 轮询 GET /files/:fileId 直至 parsed 或 failed
 * - 3min 上限后放弃轮询（status 保持 parsing，由页面自行提示）
 * - 目标文件不存在（404，如已被删除）：停止轮询并置 notFound，由页面清理选中状态
 */
import { useEffect, useRef, useState } from 'react';
import { getFile } from '../api';
import type { FileInfo } from '../api';

const POLL_INTERVAL_MS = 2000;
// 解析含首次 embedding 模型加载 + 向量化，大文档可能 1-2 分钟，上限放宽到 3 分钟
const POLL_MAX_MS = 180000;

export default function useFileStatus(fileId?: string): {
  status: FileInfo | null;
  /** 目标文件已不存在（被删除等），应停止使用该 fileId */
  notFound: boolean;
} {
  const [status, setStatus] = useState<FileInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 停止轮询（清除定时器）
  const stopPolling = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // fileId 变化时启动轮询；组件卸载或 fileId 变为空时停止
  useEffect(() => {
    if (!fileId) {
      stopPolling();
      setStatus(null);
      return;
    }
    setNotFound(false);

    const startedAt = Date.now();
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      // 超过 30s 上限：放弃轮询，保持当前状态
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stopPolling();
        return;
      }
      try {
        const info = await getFile(fileId);
        if (stopped) return;
        setStatus(info);
        // 到达终态（parsed / failed）后停止轮询
        if (info.status === 'parsed' || info.status === 'failed') {
          stopPolling();
        }
      } catch (err) {
        // 文件已不存在：停止轮询并标记，避免 404 无限重试（页面据此自愈）
        if ((err as Error & { status?: number }).status === 404) {
          stopPolling();
          setStatus(null);
          setNotFound(true);
        }
        // 其他错误：单次请求失败不中断轮询，等待下次
      }
    };

    // 立即查询一次（可能已解析完成），再定时轮询
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      stopPolling();
    };
  }, [fileId]);

  return { status, notFound };
}
