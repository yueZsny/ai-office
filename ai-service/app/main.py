"""
FastAPI 入口：创建应用实例，注册 CORS 与各业务路由

运行方式：uvicorn app.main:app --reload --port 8000
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import convert, files, generate, mindmap, parse, qa, summary

app = FastAPI(title="AI 文档处理工作台 - AI 服务", version="0.1.0")

# CORS：由 backend 网关调用，放宽跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 内部接口统一挂载在 /ai 前缀下（规格 6.2 节契约）
app.include_router(parse.router, prefix="/ai")
app.include_router(qa.router, prefix="/ai")
app.include_router(summary.router, prefix="/ai")
app.include_router(mindmap.router, prefix="/ai")
app.include_router(convert.router, prefix="/ai")
app.include_router(generate.router, prefix="/ai")
app.include_router(files.router, prefix="/ai")


@app.get("/health")
async def health() -> dict:
    """健康检查"""
    return {"status": "ok"}
