"""
RAG 问答模块：分块 / 向量化 / 检索 / 生成

职责说明：
- 分块：按标题层级切分（Heading 1 作为主块边界，块间保留标题路径），
  每块约 300-500 字符，重叠 50 字符
- 向量化：sentence-transformers 加载 bge-small-zh-v1.5（惰性加载）
- 存储：chromadb 持久化到 CHROMA_DIR，collection 按 fileId 命名
- 检索：Top-K = 5，与问题向量相似度检索
- 生成：LLM 基于检索片段回答，命中块作为 sources 返回
- 摘要：提取前 N 块 → 拼接 → LLM 生成 300-500 字摘要
"""
from dataclasses import dataclass

from app.config import settings
from app.llm.client import LLMClient

# embedding 模型惰性加载（首次使用才下载/加载）
_embedding_model = None


@dataclass
class Chunk:
    """一个文本块：标题路径 + 内容"""

    index: int
    title: str
    content: str


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

    def chunk(self, pages: list) -> list[Chunk]:
        """把解析结果（pages）切分为带标题路径的文本块"""
        chunks: list[Chunk] = []
        title_path: list[str] = []  # 当前标题路径，如 ["第一章", "第一节"]
        buffer = ""

        for page in pages:
            for line in page.text.splitlines():
                line = line.strip()
                if not line:
                    continue

                # 识别标题行（parser 中 docx 已标记 H1:/H2:/H3: 前缀）
                level, title = self._parse_heading(line)
                if level is not None:
                    # 遇到标题：先提交当前缓冲，再更新标题路径
                    if buffer.strip():
                        chunks.append(self._make_chunk(chunks, title_path, buffer))
                        buffer = ""
                    # H1 重置路径，H2/H3 追加（保留标题路径）
                    title_path = title_path[: level - 1] + [title]
                    buffer = f"{' > '.join(title_path)}\n"
                    continue

                # 普通文本：追加到缓冲
                buffer += line + "\n"

                # 超过块大小就切分（保留重叠，避免上下文断裂）
                while len(buffer) > self.CHUNK_SIZE:
                    cut = buffer[: self.CHUNK_SIZE]
                    chunks.append(self._make_chunk(chunks, title_path, cut))
                    buffer = buffer[self.CHUNK_SIZE - self.OVERLAP:]

        # 收尾：提交剩余缓冲
        if buffer.strip():
            chunks.append(self._make_chunk(chunks, title_path, buffer))

        return chunks

    @staticmethod
    def _parse_heading(line: str):
        """识别 H1:/H2:/H3: 标题行，返回 (层级, 标题文本)；非标题返回 (None, None)"""
        if len(line) >= 4 and line[0] == "H" and line[1] in "123" and line[2:4] == ": ":
            return int(line[1]), line[4:].strip()
        return None, None

    @staticmethod
    def _make_chunk(chunks: list[Chunk], title_path: list[str], content: str) -> Chunk:
        return Chunk(
            index=len(chunks),
            title=" > ".join(title_path),
            content=content.strip(),
        )


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
        collection.upsert(
            ids=[f"{file_id}-{c.index}" for c in chunks],
            documents=texts,
            embeddings=embeddings,
            metadatas=[{"title": c.title, "index": c.index} for c in chunks],
        )

    def query(self, file_id: str, question: str, top_k: int = 5) -> dict:
        """检索最相关的 top_k 个块"""
        collection = self._client.get_or_create_collection(name=file_id)
        if collection.count() == 0:
            raise ValueError("该文件尚未解析，请先上传解析")

        model = _get_embedding_model()
        q_emb = model.encode(question, normalize_embeddings=True).tolist()

        return collection.query(
            query_embeddings=[q_emb],
            n_results=min(top_k, 5),
            include=["documents", "metadatas", "distances"],
        )

    def get_all(self, file_id: str) -> list[str]:
        """取回该文件的全部文本块（用于摘要）"""
        collection = self._client.get_or_create_collection(name=file_id)
        data = collection.get(include=["documents"])
        return data["documents"]


# ---------- 问答 ----------

class QAEngine:
    """RAG 问答：检索 + Prompt + LLM 生成"""

    PROMPT_TEMPLATE = """你是一个文档问答助手。请仅基于以下文档片段回答问题，不要编造文档中不存在的内容。
如果片段中没有答案，请回答"文档中未找到相关信息"。

[文档片段]
{context}

[问题]
{question}
"""

    def __init__(self, store: VectorStore, llm: LLMClient) -> None:
        self._store = store
        self._llm = llm

    def ask(self, file_id: str, question: str, history: list[dict] | None = None) -> dict:
        """检索 + 生成，返回 { answer, sources }"""
        results = self._store.query(file_id, question, top_k=5)
        docs = results["documents"][0]
        metas = results["metadatas"][0]

        context = "\n\n".join(docs)

        # 组装消息：历史（若有）+ 当前问题（Prompt 模板）
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
                "content": self.PROMPT_TEMPLATE.format(context=context, question=question),
            }
        )

        answer = self._llm.chat(messages)

        # 引用：返回命中的块索引与文本
        sources = [
            {"chunkIndex": m.get("index", i), "text": d}
            for i, (d, m) in enumerate(zip(docs, metas))
        ]
        return {"answer": answer, "sources": sources}


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


def build_and_store(file_id: str, pages: list) -> list[Chunk]:
    """解析结果 → 分块 → 向量化入库（供 /ai/parse 调用）"""
    chunks = Chunker().chunk(pages)
    get_store().store(file_id, chunks)
    return chunks


def ask(file_id: str, question: str, history: list[dict] | None = None) -> dict:
    """问答入口（供 /ai/qa 接口调用）"""
    engine = QAEngine(get_store(), LLMClient())
    return engine.ask(file_id, question, history)


def summarize(file_id: str) -> str:
    """摘要入口：从向量库取全部块 → LLM 生成摘要（供 /ai/summary 接口调用）"""
    all_texts = get_store().get_all(file_id)
    if not all_texts:
        raise ValueError("该文件尚未解析，请先上传解析")
    return Summarizer(LLMClient()).summarize(all_texts)
