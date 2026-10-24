/**
 * 摘要导出工具：选项快照、Markdown 文本、Word 段落/要点拆分
 */
import type { SummaryLength, SummaryOptions, SummaryStyle } from '../api';

export const SUMMARY_LENGTH_LABELS: Record<SummaryLength, string> = {
  brief: '简短',
  standard: '标准',
  detailed: '详细',
};

export const SUMMARY_STYLE_LABELS: Record<SummaryStyle, string> = {
  paragraph: '段落',
  bullets: '要点',
};

/** 解析后的选项（length/style 必填，focus 可为空） */
export interface ResolvedSummaryOptions {
  length: SummaryLength;
  style: SummaryStyle;
  focus: string;
}

/** 把 UI 选项收敛成生成/导出用的快照 */
export function resolveSummaryOptions(options: SummaryOptions): ResolvedSummaryOptions {
  return {
    length: options.length ?? 'standard',
    style: options.style ?? 'paragraph',
    focus: (options.focus ?? '').replace(/\s+/g, ' ').trim(),
  };
}

/** 选项的中文描述（结果卡片与 Markdown 元信息共用） */
export function describeSummaryOptions(options: ResolvedSummaryOptions): string {
  const parts = [
    `篇幅：${SUMMARY_LENGTH_LABELS[options.length]}`,
    `风格：${SUMMARY_STYLE_LABELS[options.style]}`,
  ];
  if (options.focus) parts.push(`重点：${options.focus}`);
  return parts.join(' · ');
}

/** 文件名/Word 文档标题：报告-摘要-详细 */
export function buildSummaryBaseName(
  sourceBase: string,
  options: ResolvedSummaryOptions
): string {
  const base = sourceBase.trim() || '文档';
  return `${base}-摘要-${SUMMARY_LENGTH_LABELS[options.length]}`;
}

/** Markdown 导出内容：标题 + 选项说明 + 正文 */
export function buildSummaryMarkdown(
  sourceBase: string,
  summary: string,
  options: ResolvedSummaryOptions
): string {
  const title = buildSummaryBaseName(sourceBase, options);
  return `# ${title}\n\n> ${describeSummaryOptions(options)}\n\n${summary.trim()}\n`;
}

/**
 * 摘要文本 → Word 的段落/要点：
 * - `- ` / `* ` / `• ` / `1.` 开头的行作为要点；
 * - 其余连续行合并为段落（中文行之间不插空格，英文单词之间补空格）；
 * - 空行结束当前段落。
 */
export function splitSummaryForWord(summary: string): {
  paragraphs: string[];
  bullets: string[];
} {
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    let merged = '';
    for (const line of buffer) {
      if (!merged) {
        merged = line;
        continue;
      }
      const prev = merged[merged.length - 1];
      const next = line[0];
      const needSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(next);
      merged += (needSpace ? ' ' : '') + line;
    }
    if (merged.trim()) paragraphs.push(merged.trim());
    buffer = [];
  };

  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = /^(?:[-*•]|\d+[.)、])\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      bullets.push(bullet[1].trim());
    } else {
      buffer.push(line);
    }
  }
  flush();

  return { paragraphs, bullets };
}
