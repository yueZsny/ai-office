"""
SSE 工具：把同步事件生成器包装为 SSE 帧（问答 / 生成接口共用）

- LLM 走同步 SDK，逐次 next() 放进线程池执行，避免阻塞事件循环
- 生成器抛异常时补发一条 error 事件（不断开连接，由前端提示）
"""
import asyncio
import json

# 哨兵值：用 next(gen, sentinel) 判停，避免 StopIteration 透出协程（PEP 479）
_SENTINEL = object()


def sse_stream(gen):
    """同步事件生成器 → SSE 帧异步生成器（每帧 JSON，data: 前缀）"""

    async def _wrap():
        try:
            while True:
                event = await asyncio.to_thread(next, gen, _SENTINEL)
                if event is _SENTINEL:
                    return
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield (
                f'data: {json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False)}\n\n'
            )

    return _wrap()
