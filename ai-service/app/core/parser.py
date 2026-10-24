"""
文档解析模块：PDF / Word / OCR 文本提取

职责说明：
- PDF：PyMuPDF（fitz）提取文本，按页面记录
- Word：python-docx 提取段落，识别标题层级（Heading 1/2/3）
- OCR：rapidocr（onnxruntime 推理 PP-OCRv4 模型）识别扫描件（可选，识别失败时降级提示）
- 输出统一结构：{ pages: [{ pageIndex, text }] }
"""
import os
import tempfile
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
    """解析 PDF：按页提取文本；无文字层的页面渲染为图片走 OCR 兜底。

    - 每页先取文本层，少于 PDF_OCR_MIN_CHARS 视为扫描页
    - 扫描页数量超过 PDF_OCR_MAX_PAGES 时直接报错（OCR 慢，避免撞 backend 120s 超时）
    - OCR 仍识别不出内容的页面保持空文本，由 parse_file 统一判断整份文档是否有效
    """
    result = ParseResult()
    doc = fitz.open(src_path)  # 打开 PDF
    try:
        pages = list(doc)
        texts: list[str] = []
        ocr_pages: list[int] = []

        for idx, page in enumerate(pages):
            text = page.get_text().strip()
            texts.append(text)
            if len(text) < settings.pdf_ocr_min_chars:
                ocr_pages.append(idx)

        if len(ocr_pages) > settings.pdf_ocr_max_pages:
            raise ValueError(
                f"检测到 {len(ocr_pages)} 页无文字层内容，超过 OCR 上限 "
                f"{settings.pdf_ocr_max_pages} 页；请拆分文件后重试"
                f"（可调整 PDF_OCR_MAX_PAGES）"
            )

        if ocr_pages:
            print(
                f"[parser] PDF 有 {len(ocr_pages)} 页无文本层，"
                f"开始 OCR（dpi={settings.pdf_ocr_dpi}）"
            )
            for idx in ocr_pages:
                try:
                    text = _ocr_pdf_page(pages[idx], settings.pdf_ocr_dpi)
                except Exception as e:
                    print(f"[parser] 第 {idx + 1} 页 OCR 失败（跳过）: {e}")
                    continue
                if text.strip():
                    texts[idx] = text.strip()

        for idx, text in enumerate(texts):
            result.pages.append(PageText(page_index=idx, text=text))
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


def _ocr_text(image_path: str) -> str:
    """对单张图片做 OCR，返回识别文本（空字符串表示无文字）"""
    engine = _get_ocr_engine()
    output = engine(image_path)  # rapidocr 3.x 返回 RapidOCROutput 对象
    # 新包识别文本在 .txts（元组），旧包是 (results, elapsed) 元组
    if isinstance(output, tuple):
        output = output[0]
    texts = getattr(output, "txts", None)
    return "\n".join(t for t in texts if t) if texts else ""


def _ocr_pdf_page(page, dpi: int) -> str:
    """把 PDF 页面渲染成临时 PNG 后做 OCR（调用方负责按页控制数量）"""
    pix = page.get_pixmap(dpi=dpi)
    fd, tmp_path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        pix.save(tmp_path)
        return _ocr_text(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def parse_ocr(image_path: str) -> ParseResult:
    """解析图片/扫描件：rapidocr 识别，失败时返回空结果（降级提示）"""
    result = ParseResult()
    try:
        text = _ocr_text(image_path)
        if text.strip():
            result.pages.append(PageText(page_index=0, text=text))
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
        result = parse_pdf(src_path)
    elif ext == ".docx":
        result = parse_docx(src_path)
    # 常见图片格式走 OCR
    elif ext in (".jpg", ".jpeg", ".png", ".bmp"):
        result = parse_ocr(src_path)
    else:
        raise ValueError(f"不支持的格式: {ext}（支持 pdf/docx/图片）")

    # 统一兜底：无任何可检索文本视为解析失败，避免「状态 parsed 但问答报未解析」
    if not any(p.text.strip() for p in result.pages):
        raise ValueError(
            "未能从文档中提取到文本（可能是扫描件、图片识别失败或空文件）"
        )
    return result
