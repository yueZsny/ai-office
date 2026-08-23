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
- 摘要：提取前 N 块 → 拼接 → LLM 生成 300-500 字摘要
"""
import math
from dataclasses import dataclass

from app.config import settings
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
        """用预编码的问题向量检索（多文件问答复用，问题向量只编码一次）"""
        collection = self._client.get_or_create_collection(name=file_id)
        if collection.count() == 0:
            raise ValueError("该文件尚未解析，请先上传解析")

        return collection.query(
            query_embeddings=[q_emb],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )

    def get_all(self, file_id: str) -> list[str]:
        """取回该文件的全部文本块（用于摘要）"""
        collection = self._client.get_or_create_collection(name=file_id)
        data = collection.get(include=["documents"])
        return data["documents"]

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
        """单文件检索：top-5 → 阈值过滤。返回 (上下文|None, 命中列表)"""
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
            return None, []
        return "\n\n".join(h["text"] for h in top), top

    def _retrieve_multi(self, file_ids: list[str], question: str) -> tuple[str | None, list[dict]]:
        """多文件检索：问题向量只编码一次 → 逐 collection 检索（每文档 top-3）→
        阈值过滤 → 合并按距离排序取整体 top-8。返回 (上下文|None, 命中列表)"""
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
            return None, []
        top.sort(key=lambda h: h["distance"])
        top = top[:8]
        context = "\n\n".join(f'【来源：《{h["filename"]}》】\n{h["text"]}' for h in top)
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

class Summarizer:
    """摘要：取前 N 块 → 拼接 → LLM 生成 300-500 字摘要"""

    PROMPT_TEMPLATE = """你是一个文档摘要助手。请基于以下文档内容生成 300-500 字的摘要，概括文档的核心观点。

[文档内容]
{content}
"""

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    def summarize(self, contents: list[str]) -> str:
        """基于前 N 块生成摘要"""
        content = "\n".join(contents[:10])  # 取前 10 块，避免内容过长
        if not content.strip():
            raise ValueError("文档内容为空，无法生成摘要")
        prompt = self.PROMPT_TEMPLATE.format(content=content)
        return self._llm.chat([{"role": "user", "content": prompt}])


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


def summarize(file_id: str) -> str:
    """摘要入口：从向量库取全部块 → LLM 生成摘要（供 /ai/summary 接口调用）"""
    all_texts = get_store().get_all(file_id)
    if not all_texts:
        raise ValueError("该文件尚未解析，请先上传解析")
    return Summarizer(LLMClient()).summarize(all_texts)
