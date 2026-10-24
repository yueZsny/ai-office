"""
LLM 动态配置存储：读取 backend 经「模型设置」页写入 PostgreSQL 的供应商配置

设计原则（与旧 Redis 实现同构）：
- fail-open：数据库不可用 / 行不存在 / 数据损坏时回落环境变量默认配置，业务照常
- 失败短路：连接失败后 30s 内不再尝试（避免数据库挂掉时每个请求白等超时）
- 短 TTL 内存缓存：默认 3s 内复用已读配置，避免每次构造 LLMClient 都查库；
  改配置后最多 3s 生效（用户切换窗口点按钮的路径上感知为即时）
- 只读：写入由 backend 的 /api/settings/llm 独占，本模块不做任何写操作
"""
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from app.config import settings

logger = logging.getLogger("app.llm.config_store")

# settings 表行键，与 backend/src/services/settings.keys.ts 保持同步（勿单侧修改）
KEY = "llm"

# 未知 version 时整体回落环境变量（为未来兼容留位）
_SUPPORTED_VERSION = 1

_conn = None
# 连接失败后的短路截止时间（epoch 秒）：期间所有读取直接回落环境变量
_down_until = 0.0
_SHORT_CIRCUIT_SECONDS = 30.0

# 数据库单次操作超时（秒）：本机/内网部署，1s 足够且能快速 fail-open
_SOCKET_TIMEOUT = 1.0

# 内存缓存：TTL 见 settings.llm_settings_cache_ttl_seconds（0 = 每次实读）
_cached: dict | None = None
_cached_at = 0.0


@dataclass
class LLMConfig:
    """一套生效的 LLM 连接配置"""

    api_key: str
    base_url: str
    model: str
    source: str  # 'db' | 'env'
    provider_name: str | None = None


def _get_conn():
    """惰性创建只读数据库连接（不复用 core/cache.py 的 Redis 客户端）"""
    global _conn
    if _conn is None or _conn.closed:
        import psycopg2

        _conn = psycopg2.connect(
            settings.llm_settings_database_url,
            connect_timeout=int(_SOCKET_TIMEOUT),  # psycopg2 只接受整数秒
            options="-c statement_timeout=%d" % int(_SOCKET_TIMEOUT * 1000),
            application_name="ai-office-config-store",
        )
        _conn.autocommit = True
    return _conn


def _is_down() -> bool:
    return time.time() < _down_until


def _mark_down(err: Exception) -> None:
    global _down_until
    _down_until = time.time() + _SHORT_CIRCUIT_SECONDS
    logger.warning("[llm-config] 设置数据库不可用，%s 内回落环境变量: %s", _SHORT_CIRCUIT_SECONDS, err)


def _load_remote() -> dict | None:
    """读 PostgreSQL settings 表中的设置 JSON；不可用/损坏/版本未知一律返回 None（回落环境变量）"""
    global _cached, _cached_at
    if not settings.llm_settings_database_url or _is_down():
        return None

    now = time.time()
    ttl = settings.llm_settings_cache_ttl_seconds
    if ttl > 0 and _cached is not None and now - _cached_at < ttl:
        return _cached

    try:
        with _get_conn().cursor() as cur:
            cur.execute("SELECT value FROM settings WHERE key = %s", (KEY,))
            row = cur.fetchone()
    except Exception as e:
        # 连接失效（PG 重启等）时关闭重建，下次读取重连
        global _conn
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
        _mark_down(e)
        return None

    raw = row[0] if row else None

    parsed: dict | None = None
    if raw is not None:
        # jsonb 列通常直接返回 dict；防御性兼容返回字符串的驱动配置
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                logger.warning("[llm-config] 设置数据损坏，回落环境变量（key: %s）", KEY)
                raw = None
        if raw is not None and isinstance(raw, dict):
            if raw.get("version") != _SUPPORTED_VERSION:
                logger.warning("[llm-config] 未知设置版本 %s，回落环境变量", raw.get("version"))
                parsed = None
            else:
                parsed = raw

    _cached, _cached_at = parsed, now
    return parsed


def _resolve(remote: dict, provider_id: str | None) -> dict | None:
    """按 id 查供应商；槽位指向不存在的 provider（被外部改动/删除）时视为未设置"""
    if not provider_id:
        return None
    for p in remote.get("providers", []):
        if isinstance(p, dict) and p.get("id") == provider_id:
            return p
    return None


def get_llm_config(slot: str = "main") -> LLMConfig:
    """取指定槽位的生效 LLM 配置。优先级：

    main    : 数据库 mainProviderId → env LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
    outline : 数据库 outlineProviderId → 数据库 mainProviderId（未选 = 跟随主模型）
              → env LLM_OUTLINE_*（model 与 base_url 均非空才生效，key 空时回落 env 主 key）
              → env 主模型
    """
    remote = _load_remote()

    if slot == "main":
        provider = _resolve(remote, remote.get("mainProviderId")) if remote else None
        if provider:
            return LLMConfig(
                provider["apiKey"], provider["baseUrl"], provider["model"], "db", provider["name"]
            )
        return LLMConfig(settings.llm_api_key, settings.llm_base_url, settings.llm_model, "env")

    # outline
    if remote:
        provider = _resolve(remote, remote.get("outlineProviderId") or remote.get("mainProviderId"))
        if provider:
            return LLMConfig(
                provider["apiKey"], provider["baseUrl"], provider["model"], "db", provider["name"]
            )
    if settings.llm_outline_model and settings.llm_outline_base_url:
        return LLMConfig(
            settings.llm_outline_api_key or settings.llm_api_key,
            settings.llm_outline_base_url,
            settings.llm_outline_model,
            "env",
        )
    return LLMConfig(settings.llm_api_key, settings.llm_base_url, settings.llm_model, "env")


def mask_key(key: str) -> str:
    """API key 打码（与 backend settings.service 的规则一致：前 4 + **** + 后 4，短 key 全遮）"""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}****{key[-4:]}"


def get_effective_snapshot() -> dict[str, Any]:
    """生效配置快照（打码），供 GET /ai/llm/effective"""
    remote = _load_remote()
    main = get_llm_config("main")
    outline = get_llm_config("outline")

    # fallbackToMain：大纲槽未指向有效 provider 时是否最终跟随主模型
    # （远程主槽有效 → 跟随；主槽也空 → 看 env 是否配了独立 outline）
    outline_provider = _resolve(remote, remote.get("outlineProviderId")) if remote else None
    if outline_provider:
        fallback = False
    elif remote and _resolve(remote, remote.get("mainProviderId")):
        fallback = True
    else:
        fallback = not (settings.llm_outline_model and settings.llm_outline_base_url)

    return {
        # 能走到这里说明 ai-service 可达；backend 软失败时返回 available=false，前端据此区分
        "available": True,
        "source": "db" if remote else "env",
        "main": {
            "providerName": main.provider_name,
            "baseUrl": main.base_url,
            "model": main.model,
            "apiKeyMasked": mask_key(main.api_key),
        },
        "outline": {
            "providerName": outline.provider_name,
            "baseUrl": outline.base_url,
            "model": outline.model,
            "apiKeyMasked": mask_key(outline.api_key),
            "fallbackToMain": fallback,
        },
    }


def ping() -> str:
    """健康检查用：读到配置返回 'db'，读不到（回落 env）返回 'env'；永不抛"""
    try:
        return "db" if _load_remote() is not None else "env"
    except Exception:
        return "env"
