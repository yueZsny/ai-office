# AI 文档处理工作台（ai-office-mvp）

面向学生和白领的 AI 文档处理工具，支持以下功能：

1. **文档问答/摘要**：上传 PDF/Word（含扫描版 PDF 的 OCR 兜底），可提问、可生成摘要（RAG 方案）；支持多文档对比问答与**全库问答**（不勾选文档时自动检索全部已解析文档），引用可溯源至「文件名 · 第 X 页」并可点击跳转定位；知识库支持**全局语义搜索**；问答会话自动持久化，可回看、重命名、删除
2. **PDF → Word 转换**
3. **大纲 → Word 文档生成**：支持 # 层级大纲、条目写作要求（`>` 行）、主题一键生成大纲（AI 帮我想大纲，可配置免费/便宜模型）、知识库导入大纲（参考文档提取）、SSE 逐节流式进度、分节工作台（单节重生成/编辑/删除、增量生成、阅读模式）
4. **文档 → 思维导图**：titles 标题树重建 / LLM 提纲双路径，markmap 交互渲染，可一键「用此大纲生成文档」
5. **模型设置**：页面化配置 LLM 供应商（API key / base_url / 模型名，支持测试连接），指定主模型与大纲模型两个槽位，保存后即时生效（无需重启）；未配置时回落 ai-service 环境变量

> 明确不做：PPT 生成、表格识别、用户系统、付费、任务队列、批量处理

## 项目结构（三端分离）

```
ai-office-mvp/
├── docker-compose.yml      # 一键启动（含 postgres + redis）
├── backend/                # Node.js + TypeScript + Express（端口 3001）
│   └── 文件上传、API 网关、业务编排、限流；元信息存 PostgreSQL；data/ 为共享数据目录
├── ai-service/             # Python + FastAPI（端口 8000）
│   └── 文档解析、RAG 问答、PDF→Word、文档生成；LLM/检索结果缓存 Redis
└── frontend/               # React + TypeScript + Vite + Ant Design（端口 3000）
    └── 首页 / 问答 / 摘要 / 转换 / 生成
```

文件流转：frontend → backend（上传）→ ai-service（处理）→ backend（下载）。backend 与 ai-service 通过共享目录 `backend/data/` 交换文件（上传 `uploads/`、结果 `processed/`、向量库 `vector/`；docker 下两个容器挂载同一 `./backend/data`；本地开发时两端 `UPLOAD_DIR`/`PROCESSED_DIR` 配成同一路径）。

PostgreSQL（`postgres:16-alpine`）承担：文件元信息事实源（`files` 表）、LLM 设置（`settings` 表 key='llm'，backend 写入 / ai-service 只读）。Redis（`redis:7-alpine`，AOF 持久化）承担：LLM/检索结果缓存（`ai:cache:*`，db 1，fail-open）、网关限流计数（db 0，fail-open）。

## 本地开发（三端分别启动）

> 前置依赖：本机需有 PostgreSQL 16（默认连 `postgres://ai_office:ai_office@127.0.0.1:5432/ai_office`）与 Redis（默认连 `127.0.0.1:6379`，仅限流/缓存，可缺省）。backend 首次启动会自动建表并把 Redis 中的旧元信息一次性导入 PostgreSQL（迁移标记见 `app_meta` 表）。

### 1. AI 服务（ai-service，端口 8000）

```bash
cd ai-service
pip install -r requirements.txt
cp .env.example .env   # 填入 LLM_API_KEY
# 可选：国内网络下载 embedding 模型走镜像
# export HF_ENDPOINT=https://hf-mirror.com
uvicorn app.main:app --reload --port 8000
```

### 2. 后端（backend，端口 3001）

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

### 3. 前端（frontend，端口 3000）

```bash
cd frontend
npm install
npm run dev
```

## Docker 一键启动

```bash
# 先在 ai-service 目录执行 cp .env.example .env 并填入 LLM_API_KEY
docker-compose up --build
# 访问 http://localhost:3000
```

## 环境变量

- 后端：[backend/.env.example](backend/.env.example)
- AI 服务：[ai-service/.env.example](ai-service/.env.example)
- 前端：[frontend/.env.example](frontend/.env.example)（`VITE_API_BASE` 可选，默认 `http://localhost:3001/api`）

## 开发状态

四大功能（问答 / 摘要 / 转换 / 生成）已完整实现并跑通，另已实现知识库管理、多文档问答（页级引用）、全库问答、知识库全局语义搜索、扫描版 PDF OCR 兜底、问答会话持久化（列表/回看/重命名/删除）、思维导图、主题生成大纲、流式生成进度与模型设置页。详见 [docs/功能拓展指南.md](docs/功能拓展指南.md)、[docs/大纲生成优化与串联建议.md](docs/大纲生成优化与串联建议.md) 与 [docs/功能扩展建议清单.md](docs/功能扩展建议清单.md)。
