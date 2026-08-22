"""
PDF→Word 转换模块：pdf2docx

职责说明：
- 文字版 PDF 用 pdf2docx 直接转换
- 转换后文件写入 PROCESSED_DIR
- 返回文件名与下载路径
"""
import os
import uuid

from pdf2docx import Converter


def convert_pdf_to_docx(src_path: str, dst_dir: str) -> dict:
    """PDF 转 Word，返回结果信息 { filename, filePath }"""
    # 生成结果文件名（uuid 避免重名）
    filename = f"{uuid.uuid4().hex}.docx"
    dst_path = os.path.join(dst_dir, filename)

    cv = None
    try:
        cv = Converter(src_path)
        cv.convert(dst_path)
    except Exception as e:
        # 转换失败（常见原因：扫描件/图片型 PDF 无文字层）
        raise RuntimeError(f"PDF 转换失败（扫描件或无文字层？）: {e}") from e
    finally:
        # 无论成功失败都释放资源
        if cv is not None:
            cv.close()

    return {"filename": filename, "filePath": dst_path}
