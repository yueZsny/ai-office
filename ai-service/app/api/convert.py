"""
PDF→Word 转换接口：POST /ai/convert

请求：multipart 文件（file 字段，仅 .pdf）
响应：{ fileId, filePath, filename }
"""
import os
import uuid

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.converter import convert_pdf_to_docx

router = APIRouter()


@router.post("/convert")
async def convert_pdf(file: UploadFile = File(...)):
    """PDF 转 Word，结果写入 PROCESSED_DIR"""
    # 1. 校验扩展名（仅支持 PDF）
    if not (file.filename or "").lower().endswith(".pdf"):
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "仅支持 PDF 文件"}},
        )

    # 2. 保存上传文件到 UPLOAD_DIR（uuid 命名，避免重名）
    file_id = uuid.uuid4().hex
    src_path = os.path.join(settings.upload_dir, f"{file_id}.pdf")
    with open(src_path, "wb") as f:
        f.write(await file.read())

    # 3. 调用核心转换函数
    try:
        result = convert_pdf_to_docx(src_path, settings.processed_dir)
    except RuntimeError as e:
        # 转换失败（如扫描件无文字层）
        return JSONResponse(
            status_code=422,
            content={"error": {"message": str(e)}},
        )

    # 4. 按规格书契约返回（fileId 用于后续下载）
    return {
        "fileId": file_id,
        "filePath": result["filePath"],
        "filename": result["filename"],
    }
