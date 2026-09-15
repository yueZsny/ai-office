/**
 * 入口文件：加载环境变量并启动 Express 服务
 */
import 'dotenv/config';
import { app } from './app';
import { env } from './config/env';
import { fileService } from './services/file.service';

async function main(): Promise<void> {
  const recovered = await fileService.recoverStaleParsingTasks();
  if (recovered > 0) {
    console.log(`[backend] 已恢复 ${recovered} 条卡住的解析任务（parsing → failed）`);
  }

  app.listen(env.port, () => {
    console.log(`[backend] 服务已启动: http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  console.error('[backend] 启动失败:', err);
  process.exit(1);
});
