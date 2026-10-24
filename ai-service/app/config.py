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

    # 扫描版 PDF OCR 兜底：页面文本少于阈值时渲染为图片走 rapidocr
    # max_pages 是安全阀（OCR 慢，避免撞 backend 120s 超时）；超限直接报错让用户拆分文件
    pdf_ocr_min_chars: int = int(os.getenv("PDF_OCR_MIN_CHARS", "20"))
    pdf_ocr_max_pages: int = int(os.getenv("PDF_OCR_MAX_PAGES", "30"))
    pdf_ocr_dpi: int = int(os.getenv("PDF_OCR_DPI", "200"))

    # Redis 缓存（fail-open：连不上只记日志，业务照常走原路径）
    # db 1 与 backend 限流（db 0）隔离；未配置时禁用缓存
    redis_url: str = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/1")
    # LLM 结果缓存 TTL（小时）：summary / mindmap-llm / outline / section
    redis_cache_ttl_hours: float = float(os.getenv("REDIS_CACHE_TTL_HOURS", "24"))
    # 检索结果缓存 TTL（分钟）
    redis_search_ttl_minutes: float = float(os.getenv("REDIS_SEARCH_TTL_MINUTES", "60"))

    # LLM 动态设置存储（前端「模型设置」页写入 PostgreSQL，本服务只读，见 app/llm/config_store.py）
    # 与 backend 同库（settings 表 key='llm'），可用 LLM_SETTINGS_DATABASE_URL 单独覆盖
    llm_settings_database_url: str = os.getenv("LLM_SETTINGS_DATABASE_URL") or os.getenv(
        "DATABASE_URL", "postgres://ai_office:ai_office@127.0.0.1:5432/ai_office"
    )
    # LLM 设置内存缓存 TTL（秒）：切模型后最多延迟这么久生效；0 = 每次实读（本地 ~1ms）
    llm_settings_cache_ttl_seconds: float = float(os.getenv("LLM_SETTINGS_CACHE_TTL_SECONDS", "3"))


settings = Settings()
