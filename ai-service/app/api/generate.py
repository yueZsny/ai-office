"""
文档生成接口：

- POST /ai/generate          { title, outline: string[], context? } → SSE 流式：
  section_start → section_done*（含全文）→ done（含 fileId/filePath）| error
  outline 条目支持 markdown 前缀（#/##/### 表示 1/2/3 级，无前缀视为 1 级），
  条目下一行以 > 开头为该节写作要求（注入 Prompt「特别要求」）；
  增量生成时 outline 只含新条目，context 为已保留节的前文概括
- POST /ai/generate/outline  { topic, sectionCount?, style? } → { markdown }
  主题 → 大纲（供前端「AI 帮我想大纲」）
- POST /ai/generate/section  { docTitle, sectionTitle, level?, requirement?, context? }
  → { title, level, paragraphs, bullets }  单节重生成（一次 LLM 调用）
- POST /ai/generate/assemble { title, sections: [...] } → { fileId, filePath, filename }
  分节内容渲染成 Word（不调 LLM，秒出）
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.api.sse import sse_stream
from app.config import settings
from app.core.generator import assemble_document, generate_document_stream, generate_section
from app.core.mindmap import generate_topic_outline

router = APIRouter()


class GenerateRequest(BaseModel):
    """大纲生成请求体"""

    title: str = Field(..., description="文档标题")
    outline: list[str] = Field(..., description="大纲条目列表（条目可用 # 前缀表示层级）")
    context: str | None = Field(
        default=None, description="前文要点（增量生成时已保留节的概括，注入 Prompt 保持口径一致）"
    )


class OutlineRequest(BaseModel):
    """主题生成大纲请求体"""

    topic: str = Field(..., description="文档主题")
    section_count: int = Field(default=5, ge=2, le=10, description="一级章节数量")
    style: str | None = Field(default=None, description="文档风格（报告/论文/方案）")


class SectionRequest(BaseModel):
    """单节生成请求体"""

    doc_title: str = Field(..., description="文档标题")
    section_title: str = Field(..., description="节标题")
    level: int = Field(default=1, ge=1, le=3, description="节层级")
    requirement: str | None = Field(default=None, description="写作要求/修改意见")
    context: str | None = Field(default=None, description="前文要点（其余节的概括）")


class SectionItem(BaseModel):
    """分节内容（assemble 请求体元素）"""

    title: str = Field(..., description="节标题")
    level: int = Field(default=1, ge=1, le=3, description="节层级")
    paragraphs: list[str] = Field(default_factory=list, description="正文段落")
    bullets: list[str] = Field(default_factory=list, description="要点列表")


class AssembleRequest(BaseModel):
    """组装渲染请求体"""

    title: str = Field(..., description="文档标题")
    sections: list[SectionItem] = Field(..., description="分节内容列表（按文档顺序）")


@router.post("/generate")
async def generate_doc(req: GenerateRequest):
    """根据大纲生成 Word 文档（流式 SSE：section_start → section_done* → done | error）"""
    # 1. 参数校验（流开始前，仍走 JSON 错误）
    if not req.title.strip() or not req.outline:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "标题和大纲均不能为空"}},
        )

    # 2. 构造事件生成器（LLM 调用在首次 next() 时才执行，逐节产出）
    try:
        gen = generate_document_stream(
            req.title, req.outline, settings.processed_dir, context=req.context or ""
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})

    # 3. SSE 响应；单节失败等发生在流中 → sse_stream 包装为 error 事件
    return StreamingResponse(
        sse_stream(gen),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/generate/outline")
async def outline(req: OutlineRequest):
    """根据主题生成 markdown 大纲（供生成页「AI 帮我想大纲」）"""
    if not req.topic.strip():
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "主题不能为空"}},
        )

    try:
        markdown = generate_topic_outline(req.topic.strip(), req.section_count, req.style)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return {"markdown": markdown}


@router.post("/generate/section")
async def section(req: SectionRequest):
    """单节生成/重生成（一次 LLM 调用，返回结构化内容）"""
    try:
        result = generate_section(
            req.doc_title.strip(),
            req.section_title.strip(),
            req.level,
            req.requirement or "",
            req.context or "",
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return result


@router.post("/generate/assemble")
async def assemble(req: AssembleRequest):
    """把分节内容渲染成 Word（不调 LLM，秒出），结果写入 PROCESSED_DIR"""
    try:
        result = assemble_document(
            req.title.strip(),
            [s.model_dump() for s in req.sections],
            settings.processed_dir,
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    except RuntimeError as e:
        return JSONResponse(status_code=502, content={"error": {"message": str(e)}})

    return {
        "fileId": result["filename"].removesuffix(".docx"),
        "filePath": result["filePath"],
        "filename": result["filename"],
    }
