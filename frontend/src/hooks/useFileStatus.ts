/**
 * useFileStatus：轮询文件解析状态
 * - 上传后文件处于 uploaded/parsing，2s 轮询 GET /files/:fileId 直至 parsed 或 failed
 * - 30s 上限后放弃轮询（status 保持 parsing，由页面自行提示）
 */
import { useEffect, useRef, useState } from 'react';
import { getFile } from '../api';
import type { FileInfo } from '../api';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 30000;

export default function useFileStatus(fileId?: string) {
  const [status, setStatus] = useState<FileInfo | null>(null);
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
      } catch {
        // 单次请求失败不中断轮询，等待下次
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

  return status;
}
