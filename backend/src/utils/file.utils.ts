/**
 * 文件工具函数：扩展名校验、大小校验、uuid 生成
 */
import { randomUUID } from 'crypto';


/** 允许上传的扩展名 */
export const ALLOWED_EXTENSIONS = ['.pdf', '.docx'] as const;

/** 校验文件扩展名是否合法 */
export function isValidExtension(filename: string): boolean {
  const ext = extname(filename);
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/** 校验文件大小是否超限（单位：MB） */
export function isWithinSizeLimit(bytes: number, maxMb: number): boolean {
  return bytes <= maxMb * 1024 * 1024;
}

/** 提取文件扩展名（小写，含点号） */
export function extname(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

/** 生成 uuid（无连字符） */
export function generateId(): string {
  return randomUUID();
}
