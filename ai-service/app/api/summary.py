"""
摘要接口：POST /ai/summary

请求：{ fileId, length?, style?, focus? }
响应：{ summary, mode, totalChunks, coveredChunks, truncated }

- length: brief（约 150 字）/ standard（300-500 字）/ detailed（800+ 字）
- style: paragraph（段落）/ bullets（要点列表）
- focus: 可选重点关注主题（≤200 字），未涉及时会明确说明而非编造
- 长文档自动 map-reduce 分段归纳；超过覆盖上限时均匀抽样并在 truncated 标记
"""
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.rag import SummaryOptions, summarize

router = APIRouter()


class SummaryRequest(BaseModel):
    """摘要请求体"""

    fileId: str = Field(..., description="文件 ID")
    # 选项用 Any 接收：非法类型不会在 Pydantic 层变成 422 {detail}，
    # 统一由 SummaryOptions.parse 返回可读的 400 错误
    length: Any = Field(default=None, description="brief / standard / detailed，默认 standard")
    style: Any = Field(default=None, description="paragraph / bullets，默认 paragraph")
    focus: Any = Field(default=None, description="重点关注主题（可选，≤200 字）")


@router.post("/summary")
async def summary(req: SummaryRequest):
    """生成摘要（支持篇幅/风格/重点；长文档分段归纳）"""
    if not req.fileId or not req.fileId.strip():
        return JSONResponse(
            status_code=400, content={"error": {"message": "fileId 不能为空"}}
        )

    try:
        options = SummaryOptions.parse(req.length, req.style, req.focus)
        result = summarize(req.fileId, options)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return {
        "summary": result.summary,
        "mode": result.mode,
        "totalChunks": result.total_chunks,
        "coveredChunks": result.covered_chunks,
        "truncated": result.truncated,
    }
