# AI 文档处理工作台（ai-office-mvp）

面向学生和白领的 AI 文档处理工具，支持以下功能：

1. **文档问答/摘要**：上传 PDF/Word，可提问、可生成摘要（RAG 方案）；支持多文档对比问答，引用可溯源至「文件名 · 第 X 页」并可点击跳转定位
2. **PDF → Word 转换**
3. **大纲 → Word 文档生成**：支持 # 层级大纲、条目写作要求（`>` 行）、主题一键生成大纲（AI 帮我想大纲，可配置免费/便宜模型）、知识库导入大纲（参考文档提取）、SSE 逐节流式进度、分节工作台（单节重生成/编辑/删除、增量生成、阅读模式）
4. **文档 → 思维导图**：titles 标题树重建 / LLM 提纲双路径，markmap 交互渲染，可一键「用此大纲生成文档」

> 明确不做：PPT 生成、表格识别、用户系统、付费、任务队列、批量处理

## 项目结构（三端分离）

```
ai-office-mvp/
├── docker-compose.yml      # 一键启动
├── backend/                # Node.js + TypeScript + Express（端口 3001）
│   └── 文件上传、API 网关、业务编排、静态托管
├── ai-service/             # Python + FastAPI（端口 8000）
│   └── 文档解析、RAG 问答、PDF→Word、文档生成
└── frontend/               # React + TypeScript + Vite + Ant Design（端口 3000）
    └── 首页 / 问答 / 摘要 / 转换 / 生成
```

文件流转：frontend → backend（上传）→ ai-service（处理）→ backend（下载）。backend 与 ai-service 通过共享目录 `shared-data/` 交换文件（docker 下两个容器挂载同一 `./shared-data`；本地开发时两端 `UPLOAD_DIR`/`PROCESSED_DIR` 配成同一路径）。

## 本地开发（三端分别启动）

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

四大功能（问答 / 摘要 / 转换 / 生成）已完整实现并跑通，另已实现知识库管理、多文档问答（页级引用）、思维导图、主题生成大纲与流式生成进度。详见 [docs/功能拓展指南.md](docs/功能拓展指南.md) 与 [docs/大纲生成优化与串联建议.md](docs/大纲生成优化与串联建议.md)。
