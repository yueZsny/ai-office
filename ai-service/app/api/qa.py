"""
问答接口：POST /ai/qa

请求：{ fileId, question, history? }
响应：{ answer, sources: [{ index, text }] }
"""
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.rag import ask

router = APIRouter()


class HistoryMessage(BaseModel):
    """对话历史中的一条消息（必须含 role + content，防止脏数据透传到 LLM）"""

    role: Literal["user", "assistant"] = Field(..., description="消息角色")
    content: str = Field(..., description="消息内容")


class QaRequest(BaseModel):
    """问答请求体"""

    fileId: str = Field(..., description="文件 ID")
    question: str = Field(..., description="问题内容")
    history: list[HistoryMessage] | None = Field(default=None, description="对话历史")


@router.post("/qa")
async def qa(req: QaRequest):
    """基于文档进行 RAG 问答"""
    # 1. 参数校验
    if not req.question.strip():
        return JSONResponse(
            status_code=400, content={"error": {"message": "问题不能为空"}}
        )

    # 2. 调用 RAG 问答（检索 + LLM 生成 + 引用）
    try:
        result = ask(req.fileId, req.question, req.history)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return result
