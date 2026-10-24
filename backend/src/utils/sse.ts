/**
 * SSE 帧解析工具（backend 侧消费 ai-service 流时使用）
 * - 帧以空行分隔，data: 行携带 JSON
 * - 只解析完整帧，最后一段不完整的留在 rest 中，由调用方继续拼接
 * - 损坏帧忽略（上游异常由 done/error/流结束兜底）
 */
export interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

export function extractSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  let sep: number;

  while ((sep = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as SseEvent);
    } catch {
      // 忽略损坏帧
    }
  }
  return { events, rest };
}
