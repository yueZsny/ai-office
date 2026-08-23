/**
 * 上传文件名校正：multer 按 latin1 解码 multipart 头部的原始字节，
 * 中文文件名会被误读为乱码（如「曾臻」→「æ¾ç¥」）。
 * 这里按 latin1 → UTF-8 重新编码还原原始文件名（Buffer 可逆）。
 */
export function decodeOriginalName(name: string): string {
  return Buffer.from(name, 'latin1').toString('utf-8');
}

/**
 * 统一取上传文件名：latin1 版能还原为合法 UTF-8 时用还原版，
 * 否则（文件名本就不含中文）直接使用原始名
 */
export function normalizeUploadName(name: string): string {
  const utf8 = decodeOriginalName(name);
  // 还原结果含替换符（U+FFFD）说明原始名并非 latin1 乱码，保持原名
  return utf8.includes('�') ? name : utf8;
}
