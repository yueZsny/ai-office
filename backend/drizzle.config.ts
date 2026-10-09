/**
 * drizzle-kit 配置：生成迁移 SQL（npx drizzle-kit generate / npm run db:generate）
 * 连接串与运行时一致从 env 读取（业务约定：环境变量只经 env.ts 读取）
 */
import { defineConfig } from 'drizzle-kit';
import { env } from './src/config/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: env.databaseUrl },
});
