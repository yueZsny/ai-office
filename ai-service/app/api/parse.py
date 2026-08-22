"""
文档解析接口：POST /ai/parse

请求：multipart 文件（file 字段，PDF/Word）
响应：{ text, chunks: [{ index, title, content }] }
"""
import os
import uuid

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.parser import parse_file
from app.core.rag import build_and_store

router = APIRouter()


@router.post("/parse")
async def parse_document(file: UploadFile = File(...)):
    """解析文档，返回统一文本结构与分块结果"""
    # 1. 校验文件扩展名
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in (".pdf", ".docx", ".jpg", ".jpeg", ".png", ".bmp"):
        return JSONResponse(
            status_code=400,
            content={"error": {"message": f"不支持的格式: {ext or '无扩展名'}（支持 pdf/docx/图片）"}},
        )

    # 2. 保存上传文件到 UPLOAD_DIR（uuid 命名，避免重名）
    file_id = uuid.uuid4().hex
    src_path = os.path.join(settings.upload_dir, f"{file_id}{ext}")
    with open(src_path, "wb") as f:
        f.write(await file.read())

    # 3. 调用核心解析函数
    try:
        result = parse_file(src_path)
    except FileNotFoundError as e:
        return JSONResponse(status_code=404, content={"error": {"message": str(e)}})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})

    # 4. 分块 + 向量化入库（供 /ai/qa、/ai/summary 按 fileId 检索）
    try:
        stored = build_and_store(file_id, result.pages)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": {"message": f"入库失败: {e}"}},
        )

    # 5. 解析结果组装：text（全文）+ chunks（入库后的块）
    text = "\n".join(p.text for p in result.pages if p.text)
    chunks = [
        {"index": c.index, "title": c.title, "content": c.content}
        for c in stored
    ]

    return {"fileId": file_id, "text": text, "chunks": chunks}
