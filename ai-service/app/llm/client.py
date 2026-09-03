"""
LLM API 客户端：OpenAI 兼容接口封装

职责说明：
- base_url + api_key + model 从环境变量读取（见 app/config.py）
- 对外统一提供 chat(messages, temperature=0.7) 方法
- 内部统一处理超时、限流、重试（2 次）
- 支持 DeepSeek / 混元等 OpenAI 兼容服务（切换模型仅需改环境变量）
"""
import time

from openai import OpenAI

from app.config import settings

# 重试退避间隔（秒）：连接类错误多为瞬时网络抖动，间隔留足恢复时间（历史：1s/2s 太短，
# 网络抖动持续几秒即整次失败）
_RETRY_DELAYS = (2, 5)


class LLMClient:
    """OpenAI 兼容 LLM 客户端"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ) -> None:
        key = api_key or settings.llm_api_key
        if not key:
            raise RuntimeError("未配置 LLM_API_KEY，请先在 ai-service/.env 中填写")
        self._client = OpenAI(
            api_key=key,
            base_url=base_url or settings.llm_base_url,
        )
        self._model = model or settings.llm_model

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
    三个 LLM_OUTLINE_* 配置项任一未设置即整体回落主模型。
    """
    if not (settings.llm_outline_model and settings.llm_outline_base_url):
        return LLMClient()
    return LLMClient(
        api_key=settings.llm_outline_api_key or settings.llm_api_key,
        base_url=settings.llm_outline_base_url,
        model=settings.llm_outline_model,
    )
