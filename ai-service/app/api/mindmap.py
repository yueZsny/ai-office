"""
思维导图接口：POST /ai/mindmap

请求：{ fileId, mode? }
响应：{ markdown }
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.mindmap import generate_markdown

router = APIRouter()


class MindmapRequest(BaseModel):
    """思维导图请求体"""

    fileId: str = Field(..., description="文件 ID")
    mode: str = Field("auto", description="生成模式：auto（标题优先）/ titles / llm")


@router.post("/mindmap")
async def mindmap(req: MindmapRequest):
    """生成文档思维导图（markdown 大纲，markmap 原生输入格式）"""
    try:
        result = generate_markdown(req.fileId, req.mode)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return {"markdown": result}
