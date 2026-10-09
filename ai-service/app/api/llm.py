"""
LLM 配置接口（供 backend 设置页调用）：

- POST /ai/llm/test       { apiKey, baseUrl, model } → { ok, latencyMs, model, message }
  测试连接：失败（ok=false）是正常诊断结果，返回 200，不是错误响应；
  只有入参缺失才走 400 { error: { message } }
- GET  /ai/llm/effective  生效配置快照（key 打码），供设置页「当前生效」展示
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.llm.client import test_connection
from app.llm.config_store import get_effective_snapshot

router = APIRouter()


class LlmTestRequest(BaseModel):
    """测试连接请求体（backend 已解析出明文 key，此处不合并 Redis 配置）"""

    apiKey: str = Field(..., description="API Key（明文）")
    baseUrl: str = Field(..., description="OpenAI 兼容 base_url")
    model: str = Field(..., description="模型名")


@router.post("/llm/test")
async def llm_test(req: LlmTestRequest):
    """测试给定配置的连通性"""
    if not (req.apiKey.strip() and req.baseUrl.strip() and req.model.strip()):
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "apiKey / baseUrl / model 均不能为空"}},
        )
    return test_connection(req.apiKey.strip(), req.baseUrl.strip(), req.model.strip())


@router.get("/llm/effective")
async def llm_effective():
    """生效配置快照（key 打码）"""
    return get_effective_snapshot()
