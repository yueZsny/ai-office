/**
 * 生成业务逻辑：大纲 → Word 文档（流式 SSE）/ 主题 → 大纲 / 单节重生成 / 组装渲染
 * - 校验 title / outline / topic / sections 输入
 * - 流式编排：调 ai-client.generateStream，逐帧解析 ai-service SSE 事件
 *   - done 帧：登记元信息（saveGenerated，文件名带标题）并附 downloadUrl
 *   - 其余帧原样透传给浏览器（逐节进度展示，section_done 含全文供前端分节编辑）
 * - 单节重生成（generateSection）与组装渲染（assemble）：同步转发 + 元信息登记
 * - 结果文件由 ai-service 写入共享 PROCESSED_DIR，后端登记 filePath 供下载
 */
import { Readable } from 'stream';
import { aiClient } from './ai-client.service';
import { fileService } from './file.service';
import { ValidationError } from '../utils/errors';
import type { MindmapResponse, SectionContent } from '../types';

/** ai-service 生成流事件（与 /ai/generate SSE 契约一致；downloadUrl 由 backend 在 done 帧附加） */
interface GenerateStreamEvent {
  type: 'section_start' | 'section_done' | 'done' | 'error';
  index?: number;
  title?: string;
  level?: number;
  paragraphs?: string[];
  bullets?: string[];
  fileId?: string;
  filePath?: string;
  filename?: string;
  downloadUrl?: string;
  message?: string;
}

/**
 * 解析 SSE 帧序列（body 为 web ReadableStream，帧以空行分隔，data: 行携带 JSON），
 * 逐帧产出 JSON 事件
 */
async function* sseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<GenerateStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      yield JSON.parse(line.slice(6)) as GenerateStreamEvent;
    }
  }
}

export const generateService = {
  /**
   * 大纲 → Word 文档（流式）：校验输入 → 逐帧转发 ai-service 事件
   * - done 帧登记元信息并附 downloadUrl
   * - 上游连接失败 / 帧解析失败 → 补发 error 帧后结束（前端 message.error 提示）
   * - 已知限制：客户端中途断开时上游生成仍会跑完（LLM 调用无法中止），
   *   落盘结果成为无元信息记录的文件（MVP 接受，后续做任务队列时一并解决）
   */
  generate(title: string, outline: string[], context?: string): { stream: Readable } {
    // 校验在流开始前执行（失败抛错 → 路由 catch → JSON 错误中间件）
    if (!title.trim()) throw new ValidationError('标题不能为空');
    if (!Array.isArray(outline) || outline.length === 0) {
      throw new ValidationError('大纲不能为空');
    }
    if (outline.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new ValidationError('大纲每项不能为空');
    }

    const nodeStream = new Readable({ read() {} });

    void (async () => {
      try {
        const upstream = await aiClient.generateStream({
          title,
          outline,
          ...(context ? { context } : {}),
        });
        for await (const evt of sseEvents(upstream.body as ReadableStream<Uint8Array>)) {
          if (evt.type === 'done' && evt.fileId && evt.filePath) {
            // 登记元信息（对外 fileId 沿用 ai-service 的 fileId，文件名带标题）
            const meta = await fileService.saveGenerated(
              evt.fileId,
              `${title.trim()}.docx`,
              evt.filePath
            );
            evt.downloadUrl = `/api/download/${meta.fileId}`;
          }
          nodeStream.push(`data: ${JSON.stringify(evt)}\n\n`);
        }
      } catch (err) {
        const message = (err as Error).message || '文档生成失败';
        nodeStream.push(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      } finally {
        nodeStream.push(null);
      }
    })();

    return { stream: nodeStream };
  },

  /** 单节生成/重生成：校验输入 → 转发 ai-client.generateSection */
  async regenSection(payload: {
    docTitle: string;
    sectionTitle: string;
    level?: number;
    requirement?: string;
    context?: string;
  }): Promise<SectionContent> {
    if (!payload.docTitle.trim()) throw new ValidationError('文档标题不能为空');
    if (!payload.sectionTitle.trim()) throw new ValidationError('节标题不能为空');

    const result = await aiClient.generateSection({
      docTitle: payload.docTitle.trim(),
      sectionTitle: payload.sectionTitle.trim(),
      ...(payload.level ? { level: payload.level } : {}),
      ...(payload.requirement ? { requirement: payload.requirement } : {}),
      ...(payload.context ? { context: payload.context } : {}),
    });
    return {
      title: result.title,
      level: result.level,
      paragraphs: result.paragraphs,
      bullets: result.bullets,
    };
  },

  /** 组装渲染（不调 LLM）：校验输入 → 转发 ai-client.assemble → 登记元信息 */
  async assemble(
    title: string,
    sections: SectionContent[]
  ): Promise<{ fileId: string; downloadUrl: string }> {
    if (!title.trim()) throw new ValidationError('标题不能为空');
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new ValidationError('分节内容不能为空');
    }
    if (
      sections.some(
        (s) => !s || typeof s.title !== 'string' || !s.title.trim()
      )
    ) {
      throw new ValidationError('分节内容每项的标题不能为空');
    }

    const result = await aiClient.assemble({
      title: title.trim(),
      sections: sections.map((s) => ({
        title: s.title,
        level: s.level ?? 1,
        paragraphs: s.paragraphs ?? [],
        bullets: s.bullets ?? [],
      })),
    });

    const meta = await fileService.saveGenerated(
      result.fileId,
      `${title.trim()}.docx`,
      result.filePath
    );
    return { fileId: meta.fileId, downloadUrl: `/api/download/${meta.fileId}` };
  },

  /**
   * 主题 → markdown 大纲（前端「AI 帮我想大纲」）
   * - topic 非空；sectionCount / style 可选透传
   */
  async outline(
    topic: string,
    sectionCount?: number,
    style?: string
  ): Promise<MindmapResponse> {
    if (!topic.trim()) throw new ValidationError('主题不能为空');

    const result = await aiClient.outline({
      topic: topic.trim(),
      ...(sectionCount ? { sectionCount } : {}),
      ...(style ? { style } : {}),
    });
    return { markdown: result.markdown };
  },
};
