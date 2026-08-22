"""
大纲→Word 生成模块：内容生成与格式渲染分离

职责说明：
- 内容生成：LLM 根据 title + outline 逐节生成内容，
  每节输出结构化文本（标题 + 若干段落 + 列表）
- 模板渲染：python-docx 渲染，模板样式：
  - 标题1：黑体 16pt 加粗
  - 标题2：黑体 14pt 加粗
  - 正文：宋体 12pt，1.5 倍行距
  - 列表：项目符号列表
- 生成后写入 PROCESSED_DIR
"""
import os
import uuid
from dataclasses import dataclass, field

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt

from app.llm.client import LLMClient


@dataclass
class SectionContent:
    """一节文档内容：标题 + 若干段落 + 要点列表"""

    title: str
    paragraphs: list[str] = field(default_factory=list)
    bullets: list[str] = field(default_factory=list)


class DocxRenderer:
    """模板渲染器：把结构化内容渲染成 Word 文档（python-docx）"""

    @staticmethod
    def _style_run(run, font_name: str, size: int, bold: bool = False) -> None:
        """设置字体样式。中文字体必须同时设置 ascii 与 eastAsia，否则中文不生效"""
        run.font.name = font_name
        run.font.size = Pt(size)
        run.font.bold = bold
        run._element.rPr.rFonts.set(qn("w:eastAsia"), font_name)

    def render(self, title: str, sections: list[SectionContent]) -> Document:
        """渲染完整文档：文档大标题（标题1）+ 各节内容"""
        document = Document()
        self._add_heading(document, title, size=16)  # 标题1：黑体 16pt
        for section in sections:
            self._add_heading(document, section.title, size=14)  # 标题2：黑体 14pt
            for para in section.paragraphs:
                self._add_paragraph(document, para)
            for bullet in section.bullets:
                self._add_bullet(document, bullet)
        return document

    def _add_heading(self, document: Document, text: str, size: int) -> None:
        """添加标题（黑体加粗）"""
        run = document.add_paragraph().add_run(text)
        self._style_run(run, "黑体", size, bold=True)

    def _add_paragraph(self, document: Document, text: str) -> None:
        """添加正文：宋体 12pt，1.5 倍行距"""
        p = document.add_paragraph()
        p.paragraph_format.line_spacing = 1.5
        self._style_run(p.add_run(text), "宋体", 12)

    def _add_bullet(self, document: Document, text: str) -> None:
        """添加项目符号列表"""
        p = document.add_paragraph(style="List Bullet")
        p.paragraph_format.line_spacing = 1.5
        self._style_run(p.add_run(text), "宋体", 12)


class ContentGenerator:
    """内容生成器：LLM 根据 title + outline 逐节生成结构化内容"""

    def __init__(self) -> None:
        self._llm = LLMClient()

    def generate(self, doc_title: str, outline: list[str]) -> list[SectionContent]:
        """对大纲每个要点，调用 LLM 生成一节内容"""
        sections: list[SectionContent] = []
        for section_title in outline:
            raw = self._ask_llm(doc_title, section_title)
            sections.append(self._parse_section(section_title, raw))
        return sections

    def _ask_llm(self, doc_title: str, section_title: str) -> str:
        """构造 Prompt 并调用 LLM，返回该节原始文本"""
        prompt = (
            f"你是一位文档写作助手。请为文档《{doc_title}》中的章节「{section_title}」撰写内容。\n"
            "要求：\n"
            "1. 直接输出正文内容，禁止输出任何思考过程、解释说明或客套话"
            "（如“好的”“以下是”“我将为您”等开场白）；\n"
            "2. 写 3-5 段正文，每段 2-4 句话；\n"
            "3. 正文结束后另起一行，写 2-3 条要点。\n"
            "格式：要点以 - 开头，其余行均为正文段落。"
        )
        return self._llm.chat([{"role": "user", "content": prompt}])

    @staticmethod
    def _parse_section(title: str, raw: str) -> SectionContent:
        """解析 LLM 输出：- 开头的行为要点，其余行作为正文段落"""
        paragraphs: list[str] = []
        bullets: list[str] = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            # 过滤掉 LLM 可能输出的元话语/思考痕迹（双保险）
            if _is_meta_line(line):
                continue
            if line.startswith("-"):
                bullets.append(line.lstrip("-").strip())
            else:
                paragraphs.append(line)
        return SectionContent(title=title, paragraphs=paragraphs, bullets=bullets)


def _is_meta_line(line: str) -> bool:
    """判断一行是否为 LLM 的元话语/思考痕迹（如开场白、解释说明）"""
    meta_prefixes = ("好的", "以下是", "我将", "我来", "下面", "这里", "（思考", "【思考")
    return line.startswith(meta_prefixes) and len(line) < 40


def generate_document(title: str, outline: list[str], dst_dir: str) -> dict:
    """主入口：LLM 生成内容 → 渲染 Word → 落盘

    返回：{ filename, filePath }
    """
    if not title or not outline:
        raise ValueError("标题和大纲均不能为空")

    sections = ContentGenerator().generate(title, outline)
    document = DocxRenderer().render(title, sections)

    # uuid 命名避免重名
    filename = f"{uuid.uuid4().hex}.docx"
    dst_path = os.path.join(dst_dir, filename)
    document.save(dst_path)
    return {"filename": filename, "filePath": dst_path}
