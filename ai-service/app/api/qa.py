"""
问答接口：POST /ai/qa（流式 SSE）

请求：{ fileId | fileIds, question, history? }
响应：text/event-stream，事件序列（每帧 JSON，data: 前缀）：
    data: {"type":"token","content":"..."}    # 逐 token 文本增量
    data: {"type":"sources","sources":[...]}  # 引用（结构同旧契约：chunkIndex/page/fileId/filename/text）
    data: {"type":"done"}
    或中途失败：data: {"type":"error","message":"..."}

流开始前的参数校验错误仍返回 JSON + 状态码。
"""
import asyncio
import json
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.core.rag import stream_qa

router = APIRouter()

# 哨兵值：用 next(gen, sentinel) 判停，避免 StopIteration 透出协程（PEP 479）
_SENTINEL = object()


class HistoryMessage(BaseModel):
    """对话历史中的一条消息（必须含 role + content，防止脏数据透传到 LLM）"""

    role: Literal["user", "assistant"] = Field(..., description="消息角色")
    content: str = Field(..., description="消息内容")


class QaRequest(BaseModel):
    """问答请求体（fileId 与 fileIds 二选一，单文件旧契约保留）"""

    fileId: str | None = Field(default=None, description="文件 ID（单文件问答）")
    fileIds: list[str] | None = Field(default=None, description="文件 ID 列表（多文件问答）")
    question: str = Field(..., description="问题内容")
    history: list[HistoryMessage] | None = Field(default=None, description="对话历史")


async def _sse(gen):
    """同步事件生成器 → SSE 帧。

    LLM 走同步 SDK，逐次 next() 放进线程池执行，避免阻塞事件循环；
    生成器抛异常时补发一条 error 事件（不断开连接，由前端提示）。
    """
    try:
        while True:
            event = await asyncio.to_thread(next, gen, _SENTINEL)
            if event is _SENTINEL:
                return
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    except Exception as e:
        yield (
            f'data: {json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False)}\n\n'
        )


@router.post("/qa")
async def qa(req: QaRequest):
    """基于文档进行 RAG 问答（流式 SSE，单文件 / 多文件）"""
    # 1. 参数校验（流开始前，仍走 JSON 错误）
    if not req.question.strip():
        return JSONResponse(
            status_code=400, content={"error": {"message": "问题不能为空"}}
        )

    file_ids = req.fileIds or ([req.fileId] if req.fileId else [])
    if not file_ids:
        return JSONResponse(
            status_code=400, content={"error": {"message": "fileId 或 fileIds 不能为空"}}
        )

    # 2. 构造事件生成器（检索与 LLM 调用在首次 next() 时才执行）
    try:
        gen = stream_qa(file_ids, req.question, req.history)
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    # 3. SSE 响应；文档未解析等检索错误发生在流中 → _sse 包装为 error 事件
    return StreamingResponse(
        _sse(gen),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
