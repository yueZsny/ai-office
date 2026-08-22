#!/usr/bin/env node
/**
 * 后端接口一键冒烟测试（零依赖，仅用 Node 20+ 内置 fetch）
 *
 * 前置：backend（默认 http://localhost:3001）与 ai-service 已启动
 * 用法：node scripts/smoke-test.mjs [backend_url]
 * 退出码：0 全部通过 / 1 存在失败
 */
import { Buffer } from 'buffer';

const BASE = process.argv[2] || process.env.BACKEND_URL || 'http://localhost:3001';
const AI_BASE = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const REQUEST_TIMEOUT = 120_000; // convert/generate 调 LLM，可能较慢

// ---- 内嵌测试 PDF（带文字层，PyMuPDF 生成，959 字节）----
const TEST_PDF_B64 =
  'JVBERi0xLjcKJcK1wrYKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCgoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzQgMCBSXT4+CmVuZG9iagoKMyAwIG9iago8PC9Gb250PDwvaGVsdiA1IDAgUj4+Pj4KZW5kb2JqCgo0IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveFswIDAgNTk1IDg0Ml0vUm90YXRlIDAvUmVzb3VyY2VzIDMgMCBSL1BhcmVudCAyIDAgUi9Db250ZW50c1s2IDAgUiA3IDAgUl0+PgplbmRvYmoKCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhL0VuY29kaW5nL1dpbkFuc2lFbmNvZGluZz4+CmVuZG9iagoKNiAwIG9iago8PC9MZW5ndGggODg+PgpzdHJlYW0KCnEKQlQKMSAwIDAgMSA3MiA3NzAgVG0KL2hlbHYgMTQgVGYgWzw0ODY1NmM2YzZmMjA1MDQ0NDYyMDczNmQ2ZjZiNjUyMDc0NjU3Mzc0Pl1USgpFVApRCgplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8L0xlbmd0aCAxMDIvRmlsdGVyL0ZsYXRlRGVjb2RlPj4Kc3RyZWFtCnjaHYqxCsMwEEP3+4r7g9pnW0qgdAh06RbwFro02GRIhiz5/h5BID0JySlTlajBFZWmzKb1kMfW9kujc9flmVeMaCgWmEl0CwA6zTOhoxEoNCZ/ebvXAcX99/rWj7yrzPIH/J4YWgplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgOAowMDAwMDAwMDAwIDAwMDAxIGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA2MiAwMDAwMCBuIAowMDAwMDAwMTE0IDAwMDAwIG4gCjAwMDAwMDAxNTUgMDAwMDAgbiAKMDAwMDAwMDI2OCAwMDAwMCBuIAowMDAwMDAwMzU3IDAwMDAwIG4gCjAwMDAwMDA0OTQgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSA4L1Jvb3QgMSAwIFIvSURbPEMzRjFFN0FBNzUzMzE2NTdBRjA1QzU3NDUwQkQzNzJGPjwxOEYyRTU2RTM3M0ExNjY2NkYwRTE3NERFOENBMTgyNz5dPj4Kc3RhcnR4cmVmCjY2NQolJUVPRgo=';
const TEST_PDF = Buffer.from(TEST_PDF_B64, 'base64');

// ---- 结果收集 ----
const results = [];
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 带超时的 fetch 封装，返回 { status, body: Buffer, json } */
async function request(method, url, { body, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: headers ?? (body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined),
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
  if (res.status === 400 && buf.length === 0) {
    // 超限场景下 multer 的 MulterError 走 errorHandler 返回 JSON，不应为空；这里为空仅作兜底展示
  }
    let json = null;
    try {
      json = JSON.parse(buf.toString('utf-8'));
    } catch {
      /* 非 JSON（如文件流） */
    }
    return { status: res.status, body: buf, json };
  } finally {
    clearTimeout(timer);
  }
}

/** 构造 multipart 上传 */
function formWithFile(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  return form;
}

// ---- 前置检查 ----
console.log(`[smoke] backend: ${BASE}  ai-service: ${AI_BASE}\n`);

try {
  const bk = await request('GET', `${BASE}/api/health`);
  check('backend 健康检查', bk.status === 200 && bk.json?.status === 'ok', `status=${bk.status}`);
} catch {
  check('backend 健康检查', false, '无法连接 — backend 是否已启动？(npm run dev)');
  process.exit(1);
}

try {
  const ai = await request('GET', `${AI_BASE}/health`);
  check('ai-service 健康检查', ai.status === 200 && ai.json?.status === 'ok', `status=${ai.status}`);
} catch {
  check('ai-service 健康检查', false, '无法连接 — ai-service 是否已启动？(uvicorn app.main:app --port 8000)');
}

// ---- 1. 上传 / 下载 正常路径 ----
let uploadFileId = '';
{
  const res = await request('POST', `${BASE}/api/upload`, { body: formWithFile(TEST_PDF, 'smoke-test.pdf', 'application/pdf') });
  check('上传 .pdf', res.status === 201 && res.json?.fileId, res.status === 201 ? `fileId=${res.json.fileId}` : `status=${res.status}`);
  if (res.json?.fileId) uploadFileId = res.json.fileId;
}

if (uploadFileId) {
  const dl = await request('GET', `${BASE}/api/download/${uploadFileId}`);
  const same = dl.body.length === TEST_PDF.length && dl.body.equals(TEST_PDF);
  check('下载内容与上传一致', dl.status === 200 && same, `status=${dl.status} size=${dl.body.length}`);
}

// ---- 2. 上传校验失败路径 ----
{
  const res = await request('POST', `${BASE}/api/upload`, { body: formWithFile(Buffer.from('not a pdf'), 'bad.txt', 'text/plain') });
  check('上传 .txt → 400', res.status === 400, `status=${res.status}`);
}

{
  // 生成 21MB 缓冲测超限（multer 限制 20MB）
  const big = Buffer.alloc(21 * 1024 * 1024);
  const res = await request('POST', `${BASE}/api/upload`, { body: formWithFile(big, 'big.pdf', 'application/pdf') });
  check('上传 >20MB → 400', res.status === 400, `status=${res.status}`);
}

{
  const res = await request('GET', `${BASE}/api/download/nonexistent-id`);
  check('下载不存在文件 → 404', res.status === 404, `status=${res.status}`);
}

// ---- 3. PDF → Word 转换 ----
{
  const res = await request('POST', `${BASE}/api/convert/pdf2word`, { body: formWithFile(TEST_PDF, 'smoke-test.pdf', 'application/pdf') });
  check('convert .pdf → downloadUrl', res.status === 200 && typeof res.json?.downloadUrl === 'string', `status=${res.status}`);
  if (res.json?.downloadUrl) {
    const dl = await request('GET', `${BASE}${res.json.downloadUrl}`);
    const isDocx = dl.body.subarray(0, 2).toString() === 'PK'; // zip 魔数
    check('转换结果可下载且为 docx', dl.status === 200 && isDocx, `status=${dl.status} size=${dl.body.length}`);
  }
}

{
  const res = await request('POST', `${BASE}/api/convert/pdf2word`, { body: formWithFile(Buffer.from('x'), 'bad.txt', 'text/plain') });
  check('convert 非 PDF → 400', res.status === 400, `status=${res.status}`);
}

// ---- 4. 大纲生成（UTF-8 中文）----
{
  const res = await request('POST', `${BASE}/api/generate/doc`, {
    body: JSON.stringify({ title: '冒烟测试文档', outline: ['第一点：测试背景', '第二点：测试结论'] }),
  });
  check('generate 中文大纲 → downloadUrl', res.status === 200 && typeof res.json?.downloadUrl === 'string', `status=${res.status}`);
  if (res.json?.downloadUrl) {
    const dl = await request('GET', `${BASE}${res.json.downloadUrl}`);
    const isDocx = dl.body.subarray(0, 2).toString() === 'PK';
    check('生成结果可下载且为 docx', dl.status === 200 && isDocx, `status=${dl.status} size=${dl.body.length}`);
  }
}

{
  const res = await request('POST', `${BASE}/api/generate/doc`, {
    body: JSON.stringify({ title: '', outline: ['x'] }),
  });
  check('generate 空标题 → 400', res.status === 400, `status=${res.status}`);
}

// ---- 5. 问答 ----
{
  const res = await request('POST', `${BASE}/api/qa/ask`, {
    body: JSON.stringify({ fileId: 'x', question: '' }),
  });
  check('qa 空问题 → 400', res.status === 400, `status=${res.status}`);
}

{
  const res = await request('POST', `${BASE}/api/qa/ask`, {
    body: JSON.stringify({ fileId: 'nonexistent', question: '测试问题' }),
  });
  check('qa 未解析文件 → 400（透传 ai-service）', res.status === 400, `status=${res.status}`);
}

{
  const res = await request('POST', `${BASE}/api/qa/summary`, {
    body: JSON.stringify({ fileId: '' }),
  });
  check('summary 空 fileId → 400', res.status === 400, `status=${res.status}`);
}

// ---- 汇总 ----
console.log(`\n========== 冒烟结果: ${passed} 通过 / ${failed} 失败 ==========`);
if (failed > 0) {
  console.log('\n失败用例:');
  for (const r of results.filter((r) => !r.ok)) console.log(`  ❌ ${r.name} — ${r.detail}`);
}
process.exit(failed > 0 ? 1 : 0);
