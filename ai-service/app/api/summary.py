"""
摘要接口：POST /ai/summary

请求：{ fileId }
响应：{ summary }
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.rag import summarize

router = APIRouter()


class SummaryRequest(BaseModel):
    """摘要请求体"""

    fileId: str = Field(..., description="文件 ID")


@router.post("/summary")
async def summary(req: SummaryRequest):
    """生成文档摘要（300-500 字）"""
    try:
        result = summarize(req.fileId)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return {"summary": result}
