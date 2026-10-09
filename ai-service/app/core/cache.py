"""
缓存模块：Redis 缓存（LLM 结果 / 检索结果）

设计原则：
- fail-open：Redis 不可用只记日志，业务照常走原路径（缓存是加速项，不是依赖）
- 失败短路：连接失败后 30s 内不再尝试（否则 Redis 挂掉时每个请求白等 1s 超时）
- key 收口：所有缓存键在此生成（调用方只传业务字段），key 含生效模型——
  换模型（改 LLM_MODEL 或设置页切换）后旧模型结果不会命中
- 明确不缓存：流式 QA 结果（temperature 0.7 且依赖 history）、mindmap titles 路径
  （毫秒级）、/ai/generate/assemble（无 LLM）、/ai/parse（入库副作用）；删除文件
  不清孤儿缓存键（fileId 不复用 + 短 TTL，无正确性问题）
"""
import hashlib
import json
import logging
import time
from typing import Any

from app.config import settings
from app.llm.config_store import get_llm_config

logger = logging.getLogger("app.cache")

_client = None
# 连接失败后的短路截止时间（epoch 秒）：期间所有缓存函数直接返回 miss
_down_until = 0.0
_SHORT_CIRCUIT_SECONDS = 30.0

# Redis 单次操作超时（秒）：本机/内网部署，1s 足够且能快速 fail-open
_SOCKET_TIMEOUT = 1.0


def _get_client():
    """惰性创建同步客户端（LLM 调用全同步，统一用同步客户端，见 config 注释）"""
    global _client
    if _client is None:
        import redis

        _client = redis.Redis.from_url(
            settings.redis_url,
            socket_connect_timeout=_SOCKET_TIMEOUT,
            socket_timeout=_SOCKET_TIMEOUT,
            decode_responses=True,
        )
    return _client


def _is_down() -> bool:
    return time.time() < _down_until


def _mark_down(err: Exception) -> None:
    global _down_until
    _down_until = time.time() + _SHORT_CIRCUIT_SECONDS
    logger.warning("[cache] Redis 不可用，%s 内跳过缓存: %s", _SHORT_CIRCUIT_SECONDS, err)


# ---------- 通用读写（全部 fail-open） ----------

def cache_get(key: str) -> str | None:
    if not settings.redis_url or _is_down():
        return None
    try:
        return _get_client().get(key)
    except Exception as e:
        _mark_down(e)
        return None


def cache_set(key: str, value: str, ttl_seconds: int) -> None:
    if not settings.redis_url or _is_down():
        return
    try:
        _get_client().set(key, value, ex=ttl_seconds)
    except Exception as e:
        _mark_down(e)


def cache_get_json(key: str) -> Any | None:
    raw = cache_get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        logger.warning("[cache] 缓存值损坏，忽略: %s", key)
        return None


def cache_set_json(key: str, value: Any, ttl_seconds: int) -> None:
    cache_set(key, json.dumps(value, ensure_ascii=False), ttl_seconds)


# ---------- key 生成 ----------

def digest(*parts: str) -> str:
    """输入字段归一化后求 sha256（调用方负责 strip/类型化）"""
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def llm_key(kind: str, *parts: str) -> str:
    """主模型 LLM 结果缓存键：digest 含生效主模型的 model@base_url（动态配置，
    见 config_store），设置页切换模型后自动失效"""
    cfg = get_llm_config("main")
    return f"ai:cache:{kind}:{digest(f'{cfg.model}@{cfg.base_url}', *parts)}"


def outline_key(kind: str, *parts: str) -> str:
    """大纲类任务缓存键：digest 含生效大纲模型（未配置时跟随主模型）"""
    cfg = get_llm_config("outline")
    return f"ai:cache:{kind}:{digest(f'{cfg.model}@{cfg.base_url}', *parts)}"


def search_key(file_ids: list[str], question: str) -> str:
    """检索结果缓存键。fileId 每次解析都是新 uuid、内容不可变，用 fileId 做 key 安全；
    多文件时排序拼接保证同一集合命中"""
    return f"ai:cache:search:{':'.join(sorted(file_ids))}:{digest(question.strip())}"


# ---------- TTL / 健康探测 ----------

def ttl_llm() -> int:
    # 必须返回 int：redis-py 8.x 的 ex 参数不接受 float
    return int(settings.redis_cache_ttl_hours * 3600)


def ttl_search() -> int:
    return int(settings.redis_search_ttl_minutes * 60)


def ping() -> str:
    """健康探测（供 /health）：'ok' | 'down'，永不抛"""
    if not settings.redis_url or _is_down():
        return "down"
    try:
        _get_client().ping()
        return "ok"
    except Exception as e:
        _mark_down(e)
        return "down"
