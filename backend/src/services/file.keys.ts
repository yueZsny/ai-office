/**
 * 旧 Redis 文件元信息键空间（已冻结：元信息事实源迁往 PostgreSQL）
 * - 仅 redis-import.service.ts 的一次性迁移脚本还在读这些键；
 *   file.service 已不再引用本文件
 * - meta    : string(JSON 序列化的 FileMeta)，per-fileId
 * - index   : ZSET，score = createdAt(ms)
 * - dedup   : HASH，field = `{sha256}:{filename}` → fileId
 * - parsing : ZSET，score = updatedAt(ms)，只含 status=parsing 的记录
 * - migrated: files.json → Redis 迁移标记（旧版本启动判据）
 * - pgImported: Redis → PG 迁移的兜底标记（与 PG app_meta 双保险）
 * - Redis 旧数据在割接后回滚窗口期内保留不删，窗口过后再清理
 */
const P = 'backend:files';

export const fileKeys = {
  /** 键前缀（SCAN 匹配用） */
  prefix: P,
  meta: (fileId: string) => `${P}:${fileId}`,
  index: `${P}:index`,
  dedup: `${P}:dedup`,
  parsing: `${P}:parsing`,
  migrated: `${P}:migrated`,
  pgImported: `${P}:pg-imported`,
  /** 去重字段：内容指纹 + 规范化文件名（与旧线性扫描的命中条件一致） */
  dedupField: (sha256: string, filename: string) => `${sha256}:${filename}`,
  /** SCAN 时要排除的保留键（非单条元信息记录） */
  reserved: [`${P}:index`, `${P}:dedup`, `${P}:parsing`, `${P}:migrated`, `${P}:pg-imported`],
};
