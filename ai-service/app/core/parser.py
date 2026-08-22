"""
文档解析模块：PDF / Word / OCR 文本提取

职责说明：
- PDF：PyMuPDF（fitz）提取文本，按页面记录
- Word：python-docx 提取段落，识别标题层级（Heading 1/2/3）
- OCR：rapidocr（onnxruntime 推理 PP-OCRv4 模型）识别扫描件（可选，识别失败时降级提示）
- 输出统一结构：{ pages: [{ pageIndex, text }] }
"""
import os
from dataclasses import dataclass, field

import fitz  # PyMuPDF

from app.config import settings


@dataclass
class PageText:
    """单页/单节文本"""

    page_index: int
    text: str


@dataclass
class ParseResult:
    """统一解析结果"""

    pages: list[PageText] = field(default_factory=list)


def parse_pdf(src_path: str) -> ParseResult:
    """解析 PDF：按页提取文本"""
    result = ParseResult()
    doc = fitz.open(src_path)  # 打开 PDF
    try:
        for page in doc:  # 遍历每一页
            result.pages.append(
                PageText(page_index=page.number, text=page.get_text().strip())
            )
    finally:
        doc.close()  # 释放资源
    return result


def parse_docx(src_path: str) -> ParseResult:
    """解析 Word：提取段落，识别标题层级（Heading 1/2/3）"""
    from docx import Document  # 延迟导入，避免模块加载即依赖

    result = ParseResult()
    document = Document(src_path)
    for idx, para in enumerate(document.paragraphs):
        text = para.text.strip()
        if not text:
            continue
        # 标题层级 → 用「H1/H2/H3」前缀标记，便于 RAG 分块识别
        style = (para.style.name or "").lower()
        if "heading" in style:
            level = "".join(ch for ch in style if ch.isdigit())
            prefix = f"H{level or '1'}: "
        else:
            prefix = ""
        # 每个段落作为一「页」，index 用段序号
        result.pages.append(PageText(page_index=idx, text=f"{prefix}{text}"))
    return result


# 惰性初始化：OCR 引擎较重，用到才加载
_ocr_engine = None


def _get_ocr_engine():
    """按需初始化 rapidocr 引擎（模块级缓存）"""
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr import RapidOCR

        _ocr_engine = RapidOCR()
    return _ocr_engine


def parse_ocr(image_path: str) -> ParseResult:
    """解析图片/扫描件：rapidocr 识别，失败时返回空结果（降级提示）"""
    result = ParseResult()
    try:
        engine = _get_ocr_engine()
        output = engine(image_path)  # rapidocr 3.x 返回 RapidOCROutput 对象
        # 新包识别文本在 .txts（元组），旧包是 (results, elapsed) 元组
        if isinstance(output, tuple):
            output = output[0]
        texts = getattr(output, "txts", None)
        if texts:
            result.pages.append(
                PageText(page_index=0, text="\n".join(texts))
            )
    except Exception as e:
        # 降级：识别失败不抛异常，返回空，由调用方提示
        print(f"[parser] OCR 识别失败（降级）: {e}")
    return result


def parse_file(src_path: str) -> ParseResult:
    """按扩展名分发解析，返回统一 ParseResult 结构"""
    if not os.path.exists(src_path):
        raise FileNotFoundError(f"文件不存在: {src_path}")

    ext = os.path.splitext(src_path)[1].lower()

    if ext == ".pdf":
        return parse_pdf(src_path)
    if ext == ".docx":
        return parse_docx(src_path)
    # 常见图片格式走 OCR
    if ext in (".jpg", ".jpeg", ".png", ".bmp"):
        return parse_ocr(src_path)

    raise ValueError(f"不支持的格式: {ext}（支持 pdf/docx/图片）")
