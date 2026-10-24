"""
RAG 问答模块：分块 / 向量化 / 检索 / 生成

职责说明：
- 分块：按标题层级切分（Heading 1 作为主块边界，块间保留标题路径），
  每块约 300-500 字符，重叠 50 字符；块记录起始页（1-based）与来源文件名
- 向量化：sentence-transformers 加载 bge-small-zh-v1.5（惰性加载）
- 存储：chromadb 持久化到 CHROMA_DIR，collection 按 fileId 命名
- 检索：单文件 Top-K = 5；多文件问题向量一次编码、逐 collection top-3、
  合并按距离取整体 top-8；合并前后均按相关性阈值过滤（min 硬阈值，
  全池无命中时按 floor 兜底），杜绝无关块挤进引用
- 生成：LLM 流式生成回答（token 增量），命中块作为 sources 事件返回（含 page/fileId/filename）
- 摘要：短文档单次调用；长文档按组分段摘要后合并（map-reduce），支持篇幅/风格/重点选项
"""
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from app.config import settings
from app.core.cache import (
    cache_get,
    cache_get_json,
    cache_set,
    cache_set_json,
    llm_key,
    search_key,
    ttl_llm,
    ttl_search,
)
from app.llm.client import LLMClient

# embedding 模型惰性加载（首次使用才下载/加载）
_embedding_model = None


@dataclass
class Chunk:
    """一个文本块：标题路径 + 内容 + 来源定位（页码 / 文件名）"""

    index: int
    title: str
    content: str
    page: int | None = None      # 块起始页码（1-based；docx 为段落序号）
    filename: str | None = None  # 来源文件名（多文件问答引用展示用）


def _get_embedding_model():
    """惰性加载 bge-small-zh-v1.5（首次较慢，含模型下载）"""
    global _embedding_model
    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer

        _embedding_model = SentenceTransformer(settings.embedding_model)
    return _embedding_model


# ---------- 分块 ----------

class Chunker:
    """按标题层级切分：H1 作为主块边界，块间保留标题路径"""

    CHUNK_SIZE = 500  # 每块约 300-500 字符
    OVERLAP = 50      # 块间重叠 50 字符

    def chunk(self, pages: list, filename: str | None = None) -> list[Chunk]:
        """把解析结果（pages）切分为带标题路径的文本块（记录块起始页与来源文件名）"""
        chunks: list[Chunk] = []
        title_path: list[str] = []  # 当前标题路径，如 ["第一章", "第一节"]
        buffer = ""
        # 缓冲内各行的 (行起始偏移, 页码)：提交时取首项得到块起始页。
        # 缓冲会跨页累积且超长时被切走前半段，仅记首行页码会失准，故逐行记录
        buffer_pages: list[tuple[int, int]] = []

        def make_chunk(content: str) -> Chunk:
            return Chunk(
                index=len(chunks),
                title=" > ".join(title_path),
                content=content.strip(),
                page=buffer_pages[0][1] if buffer_pages else None,
                filename=filename,
            )

        for page in pages:
            page_no = page.page_index + 1  # PageText.page_index 为 0-based，展示与 #page= 定位用 1-based
            for line in page.text.splitlines():
                line = line.strip()
                if not line:
                    continue

                # 识别标题行（parser 中 docx 已标记 H1:/H2:/H3: 前缀）
                level, title = self._parse_heading(line)
                if level is not None:
                    # 遇到标题：先提交当前缓冲，再更新标题路径
                    if buffer.strip():
                        chunks.append(make_chunk(buffer))
                    buffer = ""
                    buffer_pages = []
                    # H1 重置路径，H2/H3 追加（保留标题路径）
                    title_path = title_path[: level - 1] + [title]
                    buffer = f"{' > '.join(title_path)}\n"
                    buffer_pages = [(0, page_no)]
                    continue

                # 普通文本：追加到缓冲（记录行起始偏移与页码）
                buffer_pages.append((len(buffer), page_no))
                buffer += line + "\n"

                # 超过块大小就切分（保留重叠，避免上下文断裂）
                while len(buffer) > self.CHUNK_SIZE:
                    cut = buffer[: self.CHUNK_SIZE]
                    chunks.append(make_chunk(cut))
                    keep_from = self.CHUNK_SIZE - self.OVERLAP
                    buffer = buffer[keep_from:]
                    # 保留切点之后的行起始记录；剩余内容若从跨切点的那一行中间开始，
                    # 用该行页码兜底（仅单行超长时走到）
                    tail = [(off, p) for off, p in buffer_pages if off < keep_from]
                    buffer_pages = [
                        (off - keep_from, p)
                        for off, p in buffer_pages
                        if off >= keep_from
                    ]
                    if not buffer_pages and tail:
                        buffer_pages = [(0, tail[-1][1])]

        # 收尾：提交剩余缓冲
        if buffer.strip():
            chunks.append(make_chunk(buffer))

        return chunks

    @staticmethod
    def _parse_heading(line: str):
        """识别 H1:/H2:/H3: 标题行，返回 (层级, 标题文本)；非标题返回 (None, None)"""
        if len(line) >= 4 and line[0] == "H" and line[1] in "123" and line[2:4] == ": ":
            return int(line[1]), line[4:].strip()
        return None, None


# ---------- 向量存储 ----------

class VectorStore:
    """向量存储：chromadb 持久化，collection 按 fileId 命名"""

    def __init__(self) -> None:
        import chromadb

        self._client = chromadb.PersistentClient(path=settings.chroma_dir)

    def store(self, file_id: str, chunks: list[Chunk]) -> None:
        """把文本块向量化并存入 chromadb"""
        model = _get_embedding_model()
        texts = [c.content for c in chunks]
        embeddings = model.encode(texts, normalize_embeddings=True).tolist()

        collection = self._client.get_or_create_collection(name=file_id)
        # chroma metadata 只接受标量，page/filename 仅在存在时写入（None 会报错）
        metadatas = []
        for c in chunks:
            meta = {"title": c.title, "index": c.index}
            if c.page is not None:
                meta["page"] = c.page
            if c.filename:
                meta["filename"] = c.filename
            metadatas.append(meta)
        collection.upsert(
            ids=[f"{file_id}-{c.index}" for c in chunks],
            documents=texts,
            embeddings=embeddings,
            metadatas=metadatas,
        )

    def query(self, file_id: str, question: str, top_k: int = 5) -> dict:
        """编码问题向量并检索最相关的 top_k 个块"""
        model = _get_embedding_model()
        q_emb = model.encode(question, normalize_embeddings=True).tolist()
        return self.query_with_embedding(file_id, q_emb, top_k)

    def query_with_embedding(self, file_id: str, q_emb: list, top_k: int = 5) -> dict:
        """用预编码的问题向量检索（多文件问答复用，问题向量只编码一次）。

        用 get_collection 而非 get_or_create：检索不存在的文档不应顺手创建空
        collection（全局搜索会遍历全部文档，缺失数据时尤其明显）。
        """
        from chromadb.errors import NotFoundError

        try:
            collection = self._client.get_collection(name=file_id)
        except (ValueError, NotFoundError) as e:
            raise ValueError("该文件尚未解析，请先上传解析") from e
        if collection.count() == 0:
            raise ValueError("该文件尚未解析，请先上传解析")

        return collection.query(
            query_embeddings=[q_emb],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )

    def get_all(self, file_id: str) -> list[str]:
        """取回该文件的全部文本块（用于摘要），按块 index 还原原文顺序。

        Chroma `get()` 的返回顺序不保证与写入顺序一致，而摘要分段依赖原文顺序，
        因此按 metadata.index 排序；旧数据缺 index 时按返回位置兜底。
        用 get_collection 而非 get_or_create：文件不存在时抛「尚未解析」，
        不应顺手创建一个空 collection。
        """
        from chromadb.errors import NotFoundError

        try:
            collection = self._client.get_collection(name=file_id)
        except (ValueError, NotFoundError) as e:
            raise ValueError("该文件尚未解析，请先上传解析") from e

        data = collection.get(include=["documents", "metadatas"])
        docs = data["documents"] or []
        metas = data["metadatas"] or []
        entries = list(zip(docs, metas))

        def sort_key(item):
            pos, (_, meta) = item
            idx = (meta or {}).get("index")
            return (idx if isinstance(idx, int) else pos, pos)

        ordered = [entry for _, entry in sorted(enumerate(entries), key=sort_key)]
        return [doc for doc, _ in ordered if isinstance(doc, str)]

    def get_all_with_meta(self, file_id: str) -> list[dict]:
        """取回该文件的全部文本块及元数据（用于思维导图 titles 路径）"""
        collection = self._client.get_or_create_collection(name=file_id)
        data = collection.get(include=["documents", "metadatas"])
        entries = []
        for doc, meta in zip(data["documents"], data["metadatas"] or []):
            meta = meta or {}
            entries.append(
                {
                    "content": doc,
                    "title": meta.get("title") or "",
                    "filename": meta.get("filename") or "",
                }
            )
        return entries

    def delete(self, file_id: str) -> None:
        """删除该文件的向量 collection（不存在时静默，幂等）"""
        from chromadb.errors import NotFoundError

        try:
            self._client.delete_collection(name=file_id)
        except (ValueError, NotFoundError):
            pass  # collection 不存在


# ---------- 问答 ----------

def _cos_to_l2(cos: float) -> float:
    """余弦相似度 → l2 距离。

    向量均经 normalize_embeddings=True 归一化，collection 用 chroma 默认 l2 空间，
    故 l2 = sqrt(2 - 2*cos) = sqrt(2*(1-cos))。阈值统一用余弦表达（更直观），
    比较时换算为距离。
    """
    return math.sqrt(2 * (1 - cos))


def _filter_relevant(hits: list[dict]) -> list[dict]:
    """按相关性阈值过滤命中块（hit 需含 "distance"，保持原有距离升序）。

    两级策略：先按 rag_min_similarity 硬阈值过滤；若全池无命中，
    再按 rag_floor_similarity 兜底重筛，避免短问句（如「邮箱是多少」，
    最佳块余弦也仅 0.28）整问失败。两级都不命中返回空列表。
    """
    thresholds = (
        _cos_to_l2(settings.rag_min_similarity),
        _cos_to_l2(settings.rag_floor_similarity),
    )
    for threshold in thresholds:
        kept = [h for h in hits if h["distance"] <= threshold]
        if kept:
            return kept
    return []


class QAEngine:
    """RAG 问答：检索 + Prompt + LLM 生成"""

    PROMPT_TEMPLATE = """你是一个文档问答助手。请仅基于以下文档片段回答问题，不要编造文档中不存在的内容。
如果片段中没有答案，请回答"文档中未找到相关信息"。

[文档片段]
{context}

[问题]
{question}
"""

    # 多文件问答：片段按「来源：《文件名》」标注，Prompt 引导综合引用多个来源（对比类问题关键）
    MULTI_PROMPT_TEMPLATE = """你是一个文档问答助手。请仅基于以下来自多个文档的片段回答问题，不要编造文档中不存在的内容。
如果片段中没有答案，请回答"文档中未找到相关信息"。
若问题涉及多个文档的对比，请综合引用多个来源，不要只依赖单一文档。

[文档片段]
{context}

[问题]
{question}
"""

    def __init__(self, store: VectorStore, llm: LLMClient) -> None:
        self._store = store
        self._llm = llm

    def _build_messages(
        self, context: str, question: str, history: list[dict] | None, template: str
    ) -> list[dict]:
        """组装消息：历史（若有）+ 当前问题（Prompt 模板）"""
        messages: list[dict] = []
        for msg in history or []:
            # 兼容 dict / Pydantic 模型两种形态，只保留合法的历史消息
            role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)
            content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
            if role in ("user", "assistant") and str(content).strip():
                messages.append({"role": role, "content": str(content)})
        messages.append(
            {
                "role": "user",
                "content": template.format(context=context, question=question),
            }
        )
        return messages

    def _retrieve_single(self, file_id: str, question: str) -> tuple[str | None, list[dict]]:
        """单文件检索：top-5 → 阈值过滤。返回 (上下文|None, 命中列表)

        检索是纯函数（fileId 每次解析为新 uuid、内容不可变），结果按
        (fileId, question) 缓存 1h——同一问题反复问（前端追问）免重算 question embedding。
        """
        key = search_key([file_id], question)
        cached = cache_get_json(key)
        if cached is not None:
            return cached.get("context"), cached.get("hits", [])

        results = self._store.query(file_id, question, top_k=5)
        hits = [
            {
                "fileId": file_id,
                "filename": (m or {}).get("filename"),
                "page": (m or {}).get("page"),
                "chunkIndex": (m or {}).get("index", i),
                "text": d,
                "distance": dist,
            }
            for i, (d, m, dist) in enumerate(
                zip(results["documents"][0], results["metadatas"][0], results["distances"][0])
            )
        ]

        top = _filter_relevant(hits)
        if not top:
            cache_set_json(key, {"context": None, "hits": []}, ttl_search())  # 未命中同样缓存
            return None, []
        context = "\n\n".join(h["text"] for h in top)
        cache_set_json(key, {"context": context, "hits": top}, ttl_search())
        return context, top

    def _retrieve_multi(self, file_ids: list[str], question: str) -> tuple[str | None, list[dict]]:
        """多文件检索：问题向量只编码一次 → 逐 collection 检索（每文档 top-3）→
        阈值过滤 → 合并按距离排序取整体 top-8。返回 (上下文|None, 命中列表)

        检索是纯函数，结果按 (排序 fileIds, question) 缓存 1h（同 _retrieve_single）。
        """
        key = search_key(file_ids, question)
        cached = cache_get_json(key)
        if cached is not None:
            return cached.get("context"), cached.get("hits", [])

        model = _get_embedding_model()
        q_emb = model.encode(question, normalize_embeddings=True).tolist()

        # 逐 collection 检索：每文档 top-3 防止单文档刷屏；同模型归一化向量，
        # 跨 collection 距离可直接比较（串行逐查，文档数 2-10 时毫秒级）
        hits: list[dict] = []
        for fid in file_ids:
            try:
                results = self._store.query_with_embedding(fid, q_emb, top_k=3)
            except ValueError as e:
                raise ValueError(f"文档尚未解析: {fid}") from e
            docs = results["documents"][0]
            metas = results["metadatas"][0]
            dists = results["distances"][0]
            for i, (d, m, dist) in enumerate(zip(docs, metas, dists)):
                meta = m or {}
                hits.append(
                    {
                        "fileId": fid,
                        "filename": meta.get("filename") or fid,
                        "page": meta.get("page"),
                        "chunkIndex": meta.get("index", i),
                        "text": d,
                        "distance": dist,
                    }
                )

        top = _filter_relevant(hits)
        if not top:
            cache_set_json(key, {"context": None, "hits": []}, ttl_search())  # 未命中同样缓存
            return None, []
        top.sort(key=lambda h: h["distance"])
        top = top[:8]
        context = "\n\n".join(f'【来源：《{h["filename"]}》】\n{h["text"]}' for h in top)
        cache_set_json(key, {"context": context, "hits": top}, ttl_search())
        return context, top

    @staticmethod
    def _source_of(h: dict) -> dict:
        """命中块 → 引用结构（去掉内部 distance，与旧 sources 契约一致）"""
        return {k: h[k] for k in ("chunkIndex", "page", "fileId", "filename", "text")}

    def stream_single(
        self, file_id: str, question: str, history: list[dict] | None = None
    ):
        """单文件问答流式事件：token* → sources → done（无命中时不调 LLM，秒回）"""
        context, top = self._retrieve_single(file_id, question)
        if context is None:
            yield {"type": "token", "content": "文档中未找到相关信息"}
        else:
            messages = self._build_messages(context, question, history, self.PROMPT_TEMPLATE)
            for delta in self._llm.chat_stream(messages):
                yield {"type": "token", "content": delta}
        yield {"type": "sources", "sources": [self._source_of(h) for h in top]}
        yield {"type": "done"}

    def stream_multi(
        self, file_ids: list[str], question: str, history: list[dict] | None = None
    ):
        """多文件问答流式事件：token* → sources → done（无命中时不调 LLM，秒回）"""
        context, top = self._retrieve_multi(file_ids, question)
        if context is None:
            yield {"type": "token", "content": "文档中未找到相关信息"}
        else:
            messages = self._build_messages(context, question, history, self.MULTI_PROMPT_TEMPLATE)
            for delta in self._llm.chat_stream(messages):
                yield {"type": "token", "content": delta}
        yield {"type": "sources", "sources": [self._source_of(h) for h in top]}
        yield {"type": "done"}


# ---------- 摘要 ----------

# 摘要 Prompt / 缓存语义变化时递增，避免命中旧版本结果
SUMMARY_CACHE_VERSION = "v2"
# 单次 LLM 调用可容纳的块数；超过则走 map-reduce
SUMMARY_SINGLE_MAX = 10
# map-reduce 每组的块数
SUMMARY_GROUP_SIZE = 10
# 同步请求的覆盖上限（4 组 × 10 块）：120s 超时下的安全阀；超长文档均匀抽样
SUMMARY_MAX_CHUNKS = 40
# map 阶段并发数：4 组单波跑完，避免多波叠加撞超时
SUMMARY_MAP_WORKERS = 4

_SUMMARY_LENGTHS = ("brief", "standard", "detailed")
_SUMMARY_STYLES = ("paragraph", "bullets")
_SUMMARY_FOCUS_MAX_CHARS = 200


@dataclass(frozen=True)
class SummaryOptions:
    """摘要选项：篇幅 / 风格 / 重点关注（API 与核心共用）"""

    length: Literal["brief", "standard", "detailed"] = "standard"
    style: Literal["paragraph", "bullets"] = "paragraph"
    focus: str = ""

    @classmethod
    def parse(
        cls,
        length: object = None,
        style: object = None,
        focus: object = None,
    ) -> "SummaryOptions":
        """统一校验并归一化选项；非法值抛 ValueError（由 API 层映射 400）"""
        raw_length = "standard" if length is None else length
        if not isinstance(raw_length, str) or raw_length not in _SUMMARY_LENGTHS:
            raise ValueError("length 参数无效，仅支持 brief/standard/detailed")

        raw_style = "paragraph" if style is None else style
        if not isinstance(raw_style, str) or raw_style not in _SUMMARY_STYLES:
            raise ValueError("style 参数无效，仅支持 paragraph/bullets")

        raw_focus = "" if focus is None else focus
        if not isinstance(raw_focus, str):
            raise ValueError("focus 必须是字符串")
        raw_focus = " ".join(raw_focus.split())
        if len(raw_focus) > _SUMMARY_FOCUS_MAX_CHARS:
            raise ValueError(f"focus 不能超过 {_SUMMARY_FOCUS_MAX_CHARS} 字")

        return cls(raw_length, raw_style, raw_focus)


@dataclass(frozen=True)
class SummarySelection:
    """摘要输入分组：single 时 1 组；map-reduce 时多组（可含抽样窗口）"""

    groups: list[list[str]]
    total_chunks: int
    covered_chunks: int
    truncated: bool

    @property
    def mode(self) -> Literal["single", "map_reduce"]:
        return "single" if len(self.groups) == 1 else "map_reduce"


@dataclass(frozen=True)
class SummaryResult:
    """摘要结果 + 覆盖信息（供前端提示长文档抽样）"""

    summary: str
    mode: Literal["single", "map_reduce"]
    total_chunks: int
    covered_chunks: int
    truncated: bool


def select_summary_groups(
    contents: list[str],
    group_size: int = SUMMARY_GROUP_SIZE,
    max_chunks: int = SUMMARY_MAX_CHUNKS,
) -> SummarySelection:
    """把摘要输入切成 map-reduce 分组。

    - ≤ SUMMARY_SINGLE_MAX 块：单组，单次 LLM 调用
    - ≤ max_chunks 块：按 group_size 顺序分组，全量覆盖
    - > max_chunks 块：取 max_chunks // group_size 个连续窗口，首窗从 0 开始、
      末窗覆盖最后一块，窗口之间尽量均匀；truncated=True。
      按窗口保持分组（不扁平化后重新切分），避免切断窗口内的上下文。
    """
    cleaned = [c for c in contents if isinstance(c, str) and c.strip()]
    total = len(cleaned)
    if total == 0:
        raise ValueError("文档内容为空，无法生成摘要")

    if total <= SUMMARY_SINGLE_MAX:
        groups = [cleaned]
    elif total <= max_chunks:
        groups = [cleaned[i : i + group_size] for i in range(0, total, group_size)]
    else:
        group_count = max(1, max_chunks // group_size)
        last_start = max(0, total - group_size)
        starts: list[int] = []
        for i in range(group_count):
            start = (
                round(i * last_start / (group_count - 1)) if group_count > 1 else 0
            )
            start = max(0, min(last_start, start))
            if start not in starts:
                starts.append(start)
        starts.sort()
        groups = [cleaned[s : s + group_size] for s in starts]

    covered = sum(len(group) for group in groups)
    return SummarySelection(
        groups=groups,
        total_chunks=total,
        covered_chunks=covered,
        truncated=covered < total,
    )


class Summarizer:
    """摘要：短文档单次调用；长文档分段 map-reduce 后合并。

    并发约定：所有缓存 key 计算与 Redis 读写都在主线程完成，worker 线程只执行
    LLM 调用——LLM 配置读取共用一条 psycopg2 连接（config_store），不是线程安全的。
    """

    LENGTH_INSTRUCTIONS = {
        "brief": "篇幅控制在 150-200 字，只保留最核心的结论。",
        "standard": "篇幅 300-500 字，覆盖主要内容与关键结论。",
        "detailed": "篇幅不少于 800 字（建议 800-1200 字），分层次展开背景、关键细节、数据与结论。",
    }
    STYLE_INSTRUCTIONS = {
        "paragraph": "使用连贯段落输出，段落之间空一行；不要使用 Markdown 标题或列表。",
        "bullets": "使用要点列表输出：每个要点单独一行、以「- 」开头，每条 1-2 句；不要输出段落。",
    }
    MAP_LENGTH_HINTS = {
        "brief": "100-150 字",
        "standard": "150-250 字",
        "detailed": "250-400 字",
    }

    SINGLE_PROMPT_TEMPLATE = """你是一位文档摘要助手。请仅基于以下文档内容生成摘要，不要编造文档中不存在的信息。
要求：
1. {length_instruction}
2. {style_instruction}
3. 概括文档的核心观点、关键事实与结论。
{focus_line}
[文档内容]
{content}
"""

    MAP_PROMPT_TEMPLATE = """你是一位文档摘要助手。以下内容是一份长文档的一个片段。
请仅基于该片段生成简明摘要（{length_hint}），保留关键事实、数据和结论，不要编造。
{focus_line}
只输出摘要正文，不要开场白或解释。
[文档内容]
{content}
"""

    REDUCE_PROMPT_TEMPLATE = """你是一位文档摘要助手。以下是对同一份长文档按顺序分段生成的摘要。
请仅基于这些分段摘要整合出一份完整摘要，不要编造未出现的信息；合并重复内容，保留关键事实、数据与结论。
要求：
1. {length_instruction}
2. {style_instruction}
3. 体现文档的整体脉络，不要写成简单的分段罗列。
{focus_line}
{sampling_note}
[分段摘要]
{partials}
"""

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    def summarize(
        self, contents: list[str], options: SummaryOptions | None = None
    ) -> SummaryResult:
        """生成摘要（结果按选项 + 内容指纹缓存，重复请求零成本）"""
        options = options or SummaryOptions.parse()
        selection = select_summary_groups(contents)
        selected = [chunk for group in selection.groups for chunk in group]
        content = "\n".join(selected)

        # 缓存 key 在主线程算好；版本 + 全部选项 + 覆盖信息共同决定结果
        key = llm_key(
            "summary",
            SUMMARY_CACHE_VERSION,
            selection.mode,
            str(selection.total_chunks),
            str(selection.covered_chunks),
            options.length,
            options.style,
            options.focus,
            content,
        )
        cached = cache_get(key)
        if cached is not None and cached.strip():
            return self._result(cached.strip(), selection)

        if selection.mode == "single":
            prompt = self._single_prompt(selection.groups[0], options)
            summary = self._ask(prompt)
        else:
            partials = self._map_partials(selection, options)
            summary = self._ask(self._reduce_prompt(partials, selection, options))

        summary = summary.strip()
        if not summary:
            raise RuntimeError("摘要生成失败：模型返回为空")
        cache_set(key, summary, ttl_llm())
        return self._result(summary, selection)

    @staticmethod
    def _result(summary: str, selection: SummarySelection) -> SummaryResult:
        return SummaryResult(
            summary=summary,
            mode=selection.mode,
            total_chunks=selection.total_chunks,
            covered_chunks=selection.covered_chunks,
            truncated=selection.truncated,
        )

    def _ask(self, prompt: str) -> str:
        """单次 LLM 调用（主线程调用；worker 只读调用也走这里）"""
        return self._llm.chat(
            [{"role": "user", "content": prompt}], temperature=0.3
        )

    def _map_partials(
        self, selection: SummarySelection, options: SummaryOptions
    ) -> list[str]:
        """并发生成各分段摘要；缓存命中/写入均在主线程。

        成功的分段立即落缓存：即使另一组失败，重试时也只需补跑失败组。
        """
        prompts = [self._map_prompt(group, options) for group in selection.groups]
        keys = [
            llm_key(
                "summary-map",
                SUMMARY_CACHE_VERSION,
                options.length,
                options.focus,
                "\n".join(group),
            )
            for group in selection.groups
        ]

        partials: dict[int, str] = {}
        missing: list[tuple[int, str, str]] = []
        for idx, (prompt, key) in enumerate(zip(prompts, keys)):
            cached = cache_get(key)
            if cached is not None and cached.strip():
                partials[idx] = cached.strip()
            else:
                missing.append((idx, prompt, key))

        if missing:
            futures: dict = {}
            with ThreadPoolExecutor(
                max_workers=min(SUMMARY_MAP_WORKERS, len(missing))
            ) as pool:
                for idx, prompt, key in missing:
                    # worker 只做 LLM 调用；key/缓存/配置读取都留在主线程
                    futures[pool.submit(self._ask, prompt)] = (idx, key)

                errors: list[tuple[int, Exception]] = []
                for future, (idx, key) in futures.items():
                    try:
                        text = (future.result() or "").strip()
                    except Exception as e:  # noqa: BLE001 - 汇总后统一转 RuntimeError
                        errors.append((idx, e))
                        continue
                    if not text:
                        errors.append((idx, RuntimeError("模型返回为空")))
                        continue
                    partials[idx] = text
                    cache_set(key, text, ttl_llm())

            if errors:
                idx, err = min(errors, key=lambda item: item[0])
                raise RuntimeError(f"分段摘要第 {idx + 1} 组失败: {err}")

        return [partials[i] for i in range(len(selection.groups))]

    def _single_prompt(self, contents: list[str], options: SummaryOptions) -> str:
        return self.SINGLE_PROMPT_TEMPLATE.format(
            length_instruction=self.LENGTH_INSTRUCTIONS[options.length],
            style_instruction=self.STYLE_INSTRUCTIONS[options.style],
            focus_line=self._focus_line(options.focus),
            content="\n".join(contents),
        )

    def _map_prompt(self, contents: list[str], options: SummaryOptions) -> str:
        return self.MAP_PROMPT_TEMPLATE.format(
            length_hint=self.MAP_LENGTH_HINTS[options.length],
            focus_line=self._map_focus_line(options.focus),
            content="\n".join(contents),
        )

    def _reduce_prompt(
        self,
        partials: list[str],
        selection: SummarySelection,
        options: SummaryOptions,
    ) -> str:
        labeled = "\n\n".join(
            f"第 {index + 1} 段：\n{text}" for index, text in enumerate(partials)
        )
        sampling_note = (
            "注意：以上内容是从原文中均匀抽取的部分片段，不是全文；请勿声称已覆盖全文。"
            if selection.truncated
            else ""
        )
        return self.REDUCE_PROMPT_TEMPLATE.format(
            length_instruction=self.LENGTH_INSTRUCTIONS[options.length],
            style_instruction=self.STYLE_INSTRUCTIONS[options.style],
            focus_line=self._focus_line(options.focus),
            sampling_note=sampling_note,
            partials=labeled,
        )

    @staticmethod
    def _focus_line(focus: str) -> str:
        """最终摘要的 focus 要求（编号固定为 4，和模板里的 1-3 衔接）"""
        if not focus:
            return ""
        return (
            f"4. 重点围绕「{focus}」进行总结，除必要背景外不要展开无关内容；"
            f"若文档未涉及该主题，请直接说明「文档中未找到与「{focus}」相关的内容」，"
            "不要编造或用无关内容填充。"
        )

    @staticmethod
    def _map_focus_line(focus: str) -> str:
        """分段摘要的 focus 要求（只提示重点，不要求整段围绕）"""
        if not focus:
            return ""
        return f"重点关注「{focus}」；若本片段未涉及该主题，可简要说明本片段与该主题无关。"


# ---------- 对外入口（供 api 层调用） ----------

_store = None


def get_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore()
    return _store


def delete_store(file_id: str) -> None:
    """删除向量数据（供 /ai/files 删除接口调用）"""
    get_store().delete(file_id)


def search_chunks(
    file_ids: list[str],
    query: str,
    per_doc_k: int = 3,
    max_results: int = 20,
) -> list[dict]:
    """跨文档语义检索（供 /ai/search 调用，不调 LLM）。

    - 问题向量只编码一次，逐 collection top-k 后按距离合并排序
    - 复用 QA 的相关性阈值过滤，避免无关片段进入结果
    - 返回对外结构：fileId/filename/page/chunkIndex/text/similarity
      similarity 由 l2 距离换算回余弦（向量已归一化），仅用于前端展示
    """
    query = query.strip()
    if not query:
        raise ValueError("搜索内容不能为空")

    # 与问答检索分开缓存（query 前缀区分），参数固定无需进 digest
    key = search_key(file_ids, f"global-search:{query}")
    cached = cache_get_json(key)
    if cached is not None:
        return cached

    model = _get_embedding_model()
    q_emb = model.encode(query, normalize_embeddings=True).tolist()

    hits: list[dict] = []
    for fid in file_ids:
        try:
            results = get_store().query_with_embedding(fid, q_emb, top_k=per_doc_k)
        except ValueError:
            # 单个文档向量缺失不应让整次搜索失败（文件可能在解析/被清理）
            continue
        docs = results["documents"][0]
        metas = results["metadatas"][0]
        dists = results["distances"][0]
        for i, (doc, meta, dist) in enumerate(zip(docs, metas, dists)):
            meta = meta or {}
            hits.append(
                {
                    "fileId": fid,
                    "filename": meta.get("filename") or fid,
                    "page": meta.get("page"),
                    "chunkIndex": meta.get("index", i),
                    "text": doc,
                    "distance": dist,
                }
            )

    top = _filter_relevant(hits)
    top.sort(key=lambda h: h["distance"])

    results = []
    for h in top[:max_results]:
        # l2² = 2 - 2cos → cos = 1 - l2²/2；数值误差可能越界，裁剪到 [-1, 1]
        similarity = max(-1.0, min(1.0, 1 - (h["distance"] ** 2) / 2))
        results.append(
            {
                "fileId": h["fileId"],
                "filename": h["filename"],
                "page": h["page"],
                "chunkIndex": h["chunkIndex"],
                "text": h["text"],
                "similarity": round(similarity, 4),
            }
        )
    cache_set_json(key, results, ttl_search())
    return results


def build_and_store(file_id: str, pages: list, filename: str | None = None) -> list[Chunk]:
    """解析结果 → 分块 → 向量化入库（供 /ai/parse 调用；filename 记录块来源文件）"""
    chunks = Chunker().chunk(pages, filename)
    get_store().store(file_id, chunks)
    return chunks


def stream_qa(file_ids: list[str], question: str, history: list[dict] | None = None):
    """问答流式入口（供 /ai/qa 接口调用）：产出 SSE 事件 dict 序列
    （token* → sources → done；无命中时只发一条 token 不调 LLM）"""
    engine = QAEngine(get_store(), LLMClient())
    if len(file_ids) > 1:
        return engine.stream_multi(file_ids, question, history)
    return engine.stream_single(file_ids[0], question, history)


def summarize(
    file_id: str, options: SummaryOptions | None = None
) -> SummaryResult:
    """摘要入口：从向量库按原文顺序取块 → 单次或 map-reduce 摘要。

    供 /ai/summary 接口调用；options 由 API 层先经 SummaryOptions.parse 校验。
    """
    if not file_id or not file_id.strip():
        raise ValueError("fileId 不能为空")
    opts = options or SummaryOptions.parse()
    all_texts = get_store().get_all(file_id)
    if not all_texts:
        raise ValueError("该文件尚未解析，请先上传解析")
    return Summarizer(LLMClient()).summarize(all_texts, opts)
