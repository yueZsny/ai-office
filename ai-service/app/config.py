"""
配置模块：集中读取环境变量

所有配置项通过 Settings dataclass 组织，业务代码一律从这里读取，禁止直接访问环境变量。
"""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 关键：加载 .env 文件到环境变量（此前缺失，导致 .env 配置全部无效）
load_dotenv()


@dataclass(frozen=True)
class Settings:
    """AI 服务全局配置（从环境变量读取，与 .env.example 保持一致）"""

    # LLM 配置（OpenAI 兼容接口）
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    llm_model: str = os.getenv("LLM_MODEL", "deepseek-chat")

    # 大纲/提纲类任务专用模型（可选，未配置时回落主模型）：
    # 大纲是中间产物，质量要求低于正文，可指向更便宜/免费模型（如智谱 GLM-4-Flash）
    llm_outline_api_key: str = os.getenv("LLM_OUTLINE_API_KEY", "")
    llm_outline_base_url: str = os.getenv("LLM_OUTLINE_BASE_URL", "")
    llm_outline_model: str = os.getenv("LLM_OUTLINE_MODEL", "")

    # 数据目录
    chroma_dir: str = os.getenv("CHROMA_DIR", "./data/vector")
    upload_dir: str = os.getenv("UPLOAD_DIR", "./data/uploads")
    processed_dir: str = os.getenv("PROCESSED_DIR", "./data/processed")

    # Embedding 模型
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "./data/models/bge-small-zh-v1.5")

    # RAG 检索相关性阈值（余弦相似度，向量已归一化 + chroma 默认 l2 空间换算）
    # min：硬阈值，低于此的块不进上下文也不进引用（实测相关块 0.55~0.90，噪音 0.07~0.49）
    # floor：兜底阈值，全池无 min 命中时按 floor 重筛，避免短问句（如「邮箱是多少」）整问失败
    rag_min_similarity: float = float(os.getenv("RAG_MIN_SIMILARITY", "0.5"))
    rag_floor_similarity: float = float(os.getenv("RAG_FLOOR_SIMILARITY", "0.25"))


settings = Settings()
