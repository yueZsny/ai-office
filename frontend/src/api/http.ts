/**
 * axios 实例封装
 * - baseURL 从环境变量 VITE_API_BASE 读取（默认 http://localhost:3001/api）
 * - 文件上传使用 FormData
 * - 统一错误处理（message.error 提示）
 */
import axios from 'axios';
import { message } from 'antd';

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3001/api',
  timeout: 120000, // AI 处理耗时较长，超时放宽到 120s
});

// 响应拦截器：统一提取后端 { error: { message } } 并 message.error 提示
http.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data?.error?.message || '网络异常，请稍后重试';
    message.error(msg);
    return Promise.reject(new Error(msg));
  }
);

export default http;
