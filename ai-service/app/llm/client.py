"""
LLM API 客户端：OpenAI 兼容接口封装

职责说明：
- 配置优先取动态设置（「模型设置」页写入 Redis，见 app/llm/config_store.py），
  未设置时回落环境变量（app/config.py）；显式传入的参数仍优先
- 对外统一提供 chat(messages, temperature=0.7) 方法
- 内部统一处理超时、限流、重试（2 次）
- 支持 DeepSeek / 混元等 OpenAI 兼容服务
"""
import time

from openai import OpenAI

from app.llm.config_store import get_llm_config

# 重试退避间隔（秒）：连接类错误多为瞬时网络抖动，间隔留足恢复时间（历史：1s/2s 太短，
# 网络抖动持续几秒即整次失败）
_RETRY_DELAYS = (2, 5)


class LLMClient:
    """OpenAI 兼容 LLM 客户端

    slot: 'main'（问答/摘要/文档生成）或 'outline'（思维导图提纲，未配置时跟随主模型）
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        slot: str = "main",
    ) -> None:
        cfg = get_llm_config(slot)
        key = api_key or cfg.api_key
        if not key:
            raise RuntimeError(
                "未配置 LLM API Key：请在「模型设置」页添加供应商，或配置 ai-service/.env 的 LLM_API_KEY"
            )
        self._client = OpenAI(
            api_key=key,
            base_url=base_url or cfg.base_url,
        )
        self._model = model or cfg.model

    def chat(self, messages: list[dict], temperature: float = 0.7) -> str:
        """调用对话模型，返回回复文本；超时/限流自动重试 2 次"""
        last_error = None
        for attempt in range(3):  # 首次调用 + 重试 2 次
            try:
                resp = self._client.chat.completions.create(
                    model=self._model,
                    messages=messages,
                    temperature=temperature,
                    timeout=120,
                )
                return resp.choices[0].message.content or ""
            except Exception as e:
                last_error = e
                if attempt < 2:
                    time.sleep(_RETRY_DELAYS[attempt])  # 2s / 5s 退避后重试
        raise RuntimeError(f"LLM 调用失败: {last_error}") from last_error

    def chat_stream(self, messages: list[dict], temperature: float = 0.7):
        """流式调用对话模型，逐段产出回复文本增量。

        与 chat 的区别：不重试（重试会重复已发出的 token，且可能已开始写响应流），
        失败直接抛出由上层决定如何处理。
        """
        stream = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temperature,
            timeout=120,
            stream=True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                yield delta


def get_outline_client() -> LLMClient:
    """大纲/提纲类任务专用客户端（主题生成大纲、思维导图 LLM 提纲）。

    可指向更便宜/免费的模型（如智谱 GLM-4-Flash，OpenAI 兼容）；
    未配置时跟随主模型（回落逻辑见 config_store.get_llm_config）。
    """
    return LLMClient(slot="outline")


def test_connection(api_key: str, base_url: str, model: str, timeout: float = 20.0) -> dict:
    """测试给定配置的连通性（设置页「测试连接」用）。

    独立快速失败路径：不重试（max_retries=0）、20s 超时，错误 key 秒级返回；
    不走 LLMClient.chat（120s 超时 + 2 次重试会拖到分钟级）。
    返回 { ok, latencyMs, model, message }，调用失败是正常诊断结果（ok=false），非异常。
    """
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=0)
    started = time.time()
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=8,
            temperature=0,
        )
    except Exception as e:
        return {"ok": False, "latencyMs": 0, "model": model, "message": f"{type(e).__name__}: {e}"}
    latency_ms = int((time.time() - started) * 1000)
    return {
        "ok": True,
        "latencyMs": latency_ms,
        "model": model,
        "message": f"连接成功（{resp.model}）",
    }
