/**
 * 浏览器端下载工具：Blob 文本下载 + 文件名清洗
 */

/** Windows 保留名（不区分大小写），避免下载/保存时不可用 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Windows 文件名非法字符（反斜杠用 charCode 构造，避免源码转义歧义） */
const ILLEGAL_CHARS = new Set([
  '<',
  '>',
  ':',
  '"',
  '/',
  '|',
  '?',
  '*',
  String.fromCharCode(92),
]);

/** 文件名主体最大长度（不含扩展名） */
const MAX_BASE_LENGTH = 80;

/**
 * 清洗文件名：去掉非法/控制字符、折叠空白、去掉尾部空格与点、避开 Windows 保留名。
 * 保留末尾的短扩展名，避免截断时把 .md/.docx 截掉。
 */
export function sanitizeFilename(name: string, fallback = '文档'): string {
  const cleaned = Array.from(name)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || ILLEGAL_CHARS.has(ch) ? '_' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!cleaned) return fallback;

  const safe = WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
  const extMatch = /(\.[A-Za-z0-9]{1,8})$/.exec(safe);
  const ext = extMatch ? extMatch[1] : '';
  const base = ext ? safe.slice(0, -ext.length) : safe;
  const shortBase = base.length > MAX_BASE_LENGTH ? base.slice(0, MAX_BASE_LENGTH) : base;
  return `${shortBase}${ext}`;
}

/**
 * 通过 Blob 下载文本文件（Markdown 等），不依赖后端。
 * 延迟 revoke object URL：部分浏览器立即释放会中断下载。
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeFilename(filename);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
