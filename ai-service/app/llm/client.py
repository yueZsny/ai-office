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


class LLMClient:
    """OpenAI 兼容 LLM 客户端"""

    def __init__(self) -> None:
        if not settings.llm_api_key:
            raise RuntimeError("未配置 LLM_API_KEY，请先在 ai-service/.env 中填写")
        self._client = OpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
        )
        self._model = settings.llm_model

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
                    time.sleep(1 * (attempt + 1))  # 简单退避后重试
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
