"""
跨文档语义检索接口：POST /ai/search

请求：{ fileIds: string[], query: string }
响应：{ results: [{ fileId, filename, page, chunkIndex, text, similarity }] }

不调 LLM，仅做向量检索，供前端知识库全局搜索使用。
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.rag import search_chunks

router = APIRouter()


class SearchRequest(BaseModel):
    """全局检索请求体"""

    fileIds: list[str] = Field(..., description="要检索的文件 ID 列表（ai-service 侧 fileId）")
    query: str = Field(..., description="搜索内容")


@router.post("/search")
async def search(req: SearchRequest):
    """跨文档检索相关文本块（不做问答生成）"""
    if not req.fileIds:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "fileIds 不能为空"}},
        )
    if not req.query.strip():
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "搜索内容不能为空"}},
        )

    try:
        results = search_chunks(req.fileIds, req.query)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return {"results": results}
