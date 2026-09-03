/**
 * 大纲工具：脑图/提纲 markdown ↔ 生成页大纲文本
 * 供摘要页（一键转生成）与生成页（知识库导入）共用
 */

/**
 * 脑图/提纲 markdown → 生成页大纲文本：
 * - 丢弃首行根节点（文件名/主题，生成页已有文档标题，不需要它作为一节）
 * - 其余标题整体下移一级（## 章 → # 章，### 节 → ## 节），层级上限 3 级
 */
export function mindmapMarkdownToOutline(markdown: string): string {
  const lines: string[] = [];
  let skippedRoot = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!m) continue;
    if (!skippedRoot) {
      skippedRoot = true; // 根节点丢弃
      continue;
    }
    const level = Math.max(1, Math.min(m[1].length - 1, 3));
    lines.push(`${'#'.repeat(level)} ${m[2].trim()}`);
  }
  return lines.join('\n');
}
