# -*- coding: utf-8 -*-
"""验证脚本：用真实向量库检验新阈值过滤逻辑（app.core.rag._filter_relevant）

预期：
- 「什么是长期记忆」→ 只保留 只是库.docx 的块（原投诉场景：简历噪音被拦）
- 「前端实习主要做了哪些事」→ 只保留两个简历的块
- 「邮箱是多少」→ floor 兜底：保留简历中含答案的块（不整问失败）
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("CHROMA_DIR", os.path.join(ROOT, "shared-data", "vector"))
os.environ.setdefault(
    "EMBEDDING_MODEL", os.path.join(ROOT, "ai-service", "data", "models", "bge-small-zh-v1.5")
)
sys.path.insert(0, os.path.join(ROOT, "ai-service"))

from sentence_transformers import SentenceTransformer  # noqa: E402
import chromadb  # noqa: E402

from app.core.rag import _filter_relevant, _get_embedding_model  # noqa: E402

FIDS = {
    "ab2d36eebdca41bba1fdc33304eb91bb": "只是库.docx",
    "70fa3a50cbb246ee856c79cb3bf7ebd3": "曾玥-前端实习.pdf",
    "cc0975cdf4ef4b178b4ca50c99998918": "曾玥1.3.docx",
}

QUESTIONS = ["什么是长期记忆", "前端实习主要做了哪些事", "邮箱是多少"]

model = _get_embedding_model()
client = chromadb.PersistentClient(path=os.environ["CHROMA_DIR"])

print("== 重建后 metadata 抽查 ==")
for fid, name in FIDS.items():
    meta = client.get_collection(name=fid).get(limit=1, include=["metadatas"])["metadatas"][0]
    print(f"  {name}: keys={sorted(meta.keys())} page={meta.get('page')} filename={meta.get('filename')}")

print()
for q in QUESTIONS:
    q_emb = model.encode(q, normalize_embeddings=True).tolist()
    # 复刻 ask_multi 的收集逻辑：每文档 top-3
    hits = []
    for fid in FIDS:
        res = client.get_collection(name=fid).query(
            query_embeddings=[q_emb], n_results=3,
            include=["documents", "metadatas", "distances"],
        )
        for i, (d, m, dist) in enumerate(zip(res["documents"][0], res["metadatas"][0], res["distances"][0])):
            hits.append({"filename": (m or {}).get("filename") or fid,
                         "page": (m or {}).get("page"), "text": d, "distance": dist})

    kept = _filter_relevant(hits)
    print(f"== {q} → 过滤后 {len(kept)} 块 ==")
    for h in sorted(kept, key=lambda x: x["distance"]):
        print(f"  {h['filename']} · 第{h['page']}段/页 | {h['text'].replace(chr(10),' ')[:40]}")
    print()
