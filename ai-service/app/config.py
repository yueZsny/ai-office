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

    # 数据目录
    chroma_dir: str = os.getenv("CHROMA_DIR", "./data/vector")
    upload_dir: str = os.getenv("UPLOAD_DIR", "./data/uploads")
    processed_dir: str = os.getenv("PROCESSED_DIR", "./data/processed")

    # Embedding 模型
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "./data/models/bge-small-zh-v1.5")


settings = Settings()
