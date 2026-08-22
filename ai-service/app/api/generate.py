"""
文档生成接口：POST /ai/generate

请求：{ title, outline: string[] }
响应：{ fileId, filePath, filename }
"""
import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.core.generator import generate_document

router = APIRouter()


class GenerateRequest(BaseModel):
    """大纲生成请求体"""

    title: str = Field(..., description="文档标题")
    outline: list[str] = Field(..., description="大纲要点列表")


@router.post("/generate")
async def generate_doc(req: GenerateRequest):
    """根据大纲生成 Word 文档，结果写入 PROCESSED_DIR"""
    # 1. 参数校验（title / outline 非空）
    if not req.title.strip() or not req.outline:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "标题和大纲均不能为空"}},
        )

    # 2. 调用核心生成逻辑
    try:
        result = generate_document(req.title, req.outline, settings.processed_dir)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    # 3. 按规格书契约返回（fileId 用于后续下载）
    return {
        "fileId": uuid.uuid4().hex,
        "filePath": result["filePath"],
        "filename": result["filename"],
    }
