"""
思维导图模块：文档 → markdown 大纲（markmap 原生输入格式）

职责说明：
- titles 路径：从向量库 chunk 的 title 元数据重建标题树（docx 已带 H1/H2/H3 标记，开箱即用）
- llm 路径：LLM 从前 N 块生成 markdown 提纲（PDF 无标题标记，auto 模式回退此路径）
- 输出统一为 markdown 大纲字符串，不做 JSON 树，前后端都省一层转换
"""
from app.llm.client import LLMClient

from app.core.rag import get_store

# 空标题路径的块（docx 首个标题之前 / PDF 全文）在 titles 路径下的兜底节点名
UNTITLED_NODE = "未分节内容"


# ---------- titles 路径 ----------

def _insert_path(node: dict, parts: list[str]) -> None:
    """把一条标题路径插入嵌套树（同一路径出现多次时幂等合并）"""
    cur = node
    for part in parts:
        cur = cur.setdefault(part, {})


def _tree_to_markdown(node: dict, lines: list[str], level: int) -> None:
    """嵌套树 → markdown 大纲行（# 数量表示层级）"""
    for title, children in node.items():
        lines.append(f"{'#' * level} {title}")
        _tree_to_markdown(children, lines, level + 1)


def build_from_titles(entries: list[dict]) -> str:
    """从 chunk 的 title 元数据重建标题树 → markdown 大纲。

    entries: [{content, title, filename}]，title 形如 "第一章 > 第一节"。
    根节点用文件名（无文件名时用「文档大纲」），保证 markmap 单根渲染。
    """
    filename = next((e.get("filename") for e in entries if e.get("filename")), "")
    tree: dict = {}
    for e in entries:
        parts = [p.strip() for p in (e.get("title") or "").split(" > ") if p.strip()]
        _insert_path(tree, parts or [UNTITLED_NODE])

    lines = [f"# {filename or '文档大纲'}"]
    _tree_to_markdown(tree, lines, level=2)
    return "\n".join(lines)


# ---------- llm 路径 ----------

class MindmapLLM:
    """LLM 提纲：前 N 块 → markdown 大纲（供 PDF 等无标题标记的文档）"""

    PROMPT_TEMPLATE = """你是一个文档提纲助手。请阅读以下文档内容，输出一份 markdown 思维导图大纲。

要求：
1. 只输出 markdown 大纲（用 # / ## / ### 层级），不要输出任何解释或多余文字
2. 大纲 3-5 级，概括文档的主要结构；第一行 # 为文档主题
3. 每级标题简洁明确（不超过 20 字）

[文档内容]
{content}
"""

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    def outline(self, contents: list[str]) -> str:
        """基于前 N 块生成 markdown 提纲"""
        content = "\n".join(contents[:10])  # 与摘要同取前 10 块，控制长度
        if not content.strip():
            raise ValueError("文档内容为空，无法生成思维导图")
        prompt = self.PROMPT_TEMPLATE.format(content=content)
        markdown = self._llm.chat(
            [{"role": "user", "content": prompt}], temperature=0.3
        )
        return self._strip_fence(markdown)

    @staticmethod
    def _strip_fence(markdown: str) -> str:
        """去掉 LLM 可能输出的 ```markdown ... ``` 代码块包裹"""
        markdown = markdown.strip()
        if markdown.startswith("```"):
            lines = markdown.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]  # 去首行（``` 或 ```markdown）
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]  # 去末行 ```
            markdown = "\n".join(lines).strip()
        return markdown


# ---------- 对外入口（供 api 层调用） ----------

def generate_markdown(file_id: str, mode: str = "auto") -> str:
    """思维导图入口（供 /ai/mindmap 接口调用）：按 mode 分发 titles / llm 路径。

    - auto：标题元数据非空走 titles（秒出），全空（PDF）回退 llm（30-60s）
    - titles：强制 titles 路径，无标题结构时抛 ValueError（400）
    - llm：强制 LLM 提纲
    """
    if mode not in ("auto", "titles", "llm"):
        raise ValueError(f"不支持的 mode: {mode}（支持 auto/titles/llm）")

    entries = get_store().get_all_with_meta(file_id)
    if not entries:
        raise ValueError("该文件尚未解析，请先上传解析")

    has_titles = any((e.get("title") or "").strip() for e in entries)
    if mode == "titles" and not has_titles:
        raise ValueError("该文档没有标题结构（PDF 未做标题识别），请改用 llm 模式")
    if mode == "llm" or (mode == "auto" and not has_titles):
        return MindmapLLM(LLMClient()).outline([e["content"] for e in entries])
    return build_from_titles(entries)
