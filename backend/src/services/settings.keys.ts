/**
 * 设置存储键注册表（纯常量，无 IO）
 * - llmRow : PostgreSQL settings 表的行键（jsonb 结构见 types.LlmSettingsFile），
 *            前端「模型设置」页的持久化；backend 独占写入，
 *            ai-service 直读同一行实现动态切换（不重启生效）
 *            （行键镜像见 ai-service/app/llm/config_store.py，勿单侧修改）
 * - llm    : 旧 Redis 键 backend:settings:llm（已冻结，仅 redis-import.service.ts
 *            的迁移脚本还在读，割接回滚窗口过后可清理）
 */
const P = 'backend:settings';

export const settingsKeys = {
  /** PG settings 表行键 */
  llmRow: 'llm',
  /** 旧 Redis 键（冻结，迁移源） */
  llm: `${P}:llm`,
};
