/**
 * 入口文件：加载环境变量并启动 Express 服务
 */
import 'dotenv/config';
import { app } from './app';
import { env } from './config/env';

app.listen(env.port, () => {
  console.log(`[backend] 服务已启动: http://localhost:${env.port}`);
});
