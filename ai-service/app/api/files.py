"""
文件删除接口：DELETE /ai/files/{file_id}

清理内容：
- chromadb collection（必须经 PersistentClient 删除，直接删目录会损坏 sqlite 索引）
- ai-service 落盘的文件副本（UPLOAD_DIR / PROCESSED_DIR 下 {file_id}.*）
"""
import glob
import os
import re

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from app.config import settings
from app.core.rag import delete_store

router = APIRouter()

# ai-service 侧 fileId 为 uuid.hex（32 位小写 hex），严格校验防止 glob 路径穿越
UUID_HEX_RE = re.compile(r"^[0-9a-f]{32}$")


@router.delete("/files/{file_id}")
async def delete_file(file_id: str):
    if not UUID_HEX_RE.match(file_id):
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "非法文件 ID"}},
        )

    # 1. 删除向量 collection（幂等，不存在时静默）
    delete_store(file_id)

    # 2. 清理共享目录中的文件副本（parse 上传副本 / convert / generate 结果）
    for directory in (settings.upload_dir, settings.processed_dir):
        for path in glob.glob(os.path.join(directory, f"{file_id}.*")):
            try:
                os.remove(path)
            except OSError:
                pass

    return Response(status_code=204)
