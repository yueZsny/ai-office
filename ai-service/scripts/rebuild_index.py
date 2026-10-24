# -*- coding: utf-8 -*-
"""
一次性重建向量索引：从 backend/data/uploads 源文件重新解析入库，
恢复 chunk 的 page/filename 元数据（旧数据缺这两项，引用显示「未知页」与 hash 文件名）。

用法（ai-office 环境，任意 cwd 均可）：
    python ai-service/scripts/rebuild_index.py            # 实际执行
    python ai-service/scripts/rebuild_index.py --dry-run  # 只列出将要重建的文档

规则：
- 仅处理「backend/data/uploads 有源文件 且 chroma 存在同名 collection」的文档
  （uploads 里还有 convert 上传的 pdf 副本，没有 collection，跳过）
- 原始文件名从 PostgreSQL files 表的 aiFileId -> filename 映射取
  （PG 不可用时回退 backend/data/files.json 冷备份），取不到用 fileId
- 每个文件：先解析（失败则跳过，保留旧 collection）→ 删旧 collection → 重新入库
"""
import argparse
import glob
import json
import os
import sys

# 环境变量必须在导入 app 模块之前设置（config.py 在 import 时读取）
# 本文件位于 ai-service/scripts/ 下，上溯三层为仓库根目录
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("CHROMA_DIR", os.path.join(ROOT, "backend", "data", "vector"))
os.environ.setdefault("UPLOAD_DIR", os.path.join(ROOT, "backend", "data", "uploads"))
os.environ.setdefault("PROCESSED_DIR", os.path.join(ROOT, "backend", "data", "processed"))
os.environ.setdefault(
    "EMBEDDING_MODEL", os.path.join(ROOT, "ai-service", "data", "models", "bge-small-zh-v1.5")
)

sys.path.insert(0, os.path.join(ROOT, "ai-service"))

import chromadb  # noqa: E402

from app.core.parser import parse_file  # noqa: E402
from app.core.rag import build_and_store, get_store  # noqa: E402

UPLOAD_DIR = os.path.join(ROOT, "backend", "data", "uploads")
# 元信息已迁 PostgreSQL；files.json 仅作 PG 不可用时的回退
META_FILE = os.path.join(ROOT, "backend", "data", "files.json")


def load_filename_map() -> dict[str, str]:
    """PG files 表中 aiFileId -> filename 映射；PG 不可用时回退 files.json 冷备份"""
    try:
        import psycopg2

        conn = psycopg2.connect(
            os.environ.get(
                "DATABASE_URL", "postgres://ai_office:ai_office@127.0.0.1:5432/ai_office"
            ),
            connect_timeout=3,
        )
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT ai_file_id, filename FROM files WHERE ai_file_id IS NOT NULL"
                )
                rows = cur.fetchall()
            return {row[0]: row[1] for row in rows}
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 —— 回退路径，任何 PG 异常都不该中断脚本
        print(f"[warn] 无法从 PostgreSQL 读取元信息（{e}），回退 files.json")
        try:
            with open(META_FILE, encoding="utf-8") as f:
                metas = json.load(f)
        except (OSError, ValueError):
            print(f"[warn] 无法读取元信息 {META_FILE}，文件名将回退为 fileId")
            return {}
        return {m["aiFileId"]: m["filename"] for m in metas if m.get("aiFileId")}


def existing_collections(client) -> set[str]:
    return {c.name for c in client.list_collections()}


def main() -> None:
    parser = argparse.ArgumentParser(description="重建向量索引（恢复 page/filename 元数据）")
    parser.add_argument("--dry-run", action="store_true", help="只列出计划，不执行")
    args = parser.parse_args()

    collections = existing_collections(chromadb.PersistentClient(path=os.environ["CHROMA_DIR"]))
    filename_map = load_filename_map()

    # uploads 下 {fid}.{ext} → fid；collection 存在才纳入
    targets: list[tuple[str, str]] = []
    for src in sorted(glob.glob(os.path.join(UPLOAD_DIR, "*.*"))):
        fid = os.path.splitext(os.path.basename(src))[0]
        if fid in collections:
            targets.append((fid, src))
    print(f"共 {len(targets)} 个文档待重建（uploads {len(collections)} 个 collection 中有源文件的）")

    if args.dry_run:
        for fid, src in targets:
            print(f"  [dry-run] {fid} <- {os.path.basename(src)} ({filename_map.get(fid, fid)})")
        return

    store = get_store()
    ok = failed = 0
    for fid, src in targets:
        filename = filename_map.get(fid)
        try:
            # 先解析，成功才删旧数据（解析失败保留原 collection）
            result = parse_file(src)
            store.delete(fid)
            chunks = build_and_store(fid, result.pages, filename=filename)
            ok += 1
            print(f"  [ok] {filename or fid}: {len(chunks)} 块")
        except Exception as e:
            failed += 1
            print(f"  [fail] {filename or fid}: {e}")

    print(f"完成：成功 {ok}，失败 {failed}")


if __name__ == "__main__":
    main()
