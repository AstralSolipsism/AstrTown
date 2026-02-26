from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

try:
    import aiohttp
except Exception:  # pragma: no cover
    aiohttp = None

from astrbot import logger

from .contracts import AdapterHostProtocol


class GatewayHttpClient:
    """Gateway HTTP 客户端。"""

    def __init__(self, host: AdapterHostProtocol) -> None:
        self._host = host

    async def post_json_best_effort(
        self,
        session: Any,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any],
        action_name: str,
    ) -> bool:
        try:
            async with session.post(url, json=body, headers=headers) as resp:
                if 200 <= resp.status < 300:
                    return True
                text = ""
                try:
                    text = await resp.text()
                except Exception:
                    text = ""
                logger.warning(f"[AstrTown] {action_name} 失败 http={resp.status}: {text[:200]}")
                return False
        except Exception as e:
            logger.warning(f"[AstrTown] {action_name} 网络异常: {e}")
            return False

    def build_http_base_url(self) -> str:
        """将 adapter 配置的 gateway_url 统一规范为 http/https base url。

        兼容用户误配为 ws/wss 的情况（例如复制了 ws 地址）。
        """
        base = (self._host.gateway_url or "").strip().rstrip("/")
        if not base:
            return ""

        try:
            p = urlparse(base)
            if p.scheme == "wss":
                return p._replace(scheme="https").geturl().rstrip("/")
            if p.scheme == "ws":
                return p._replace(scheme="http").geturl().rstrip("/")
        except Exception:
            # 最佳努力回退
            return base

        return base

    async def search_world_memory(self, query_text: str, limit: int = 3) -> list[dict[str, Any]]:
        """向 Gateway 发起“世界记忆检索”请求。

        返回：
            list[dict]：Gateway 返回的 memories 列表，元素形如 {description, importance}。
            任何异常/非 2xx 响应都会返回空列表。
        """
        if aiohttp is None:
            logger.warning("[AstrTown] aiohttp not available; world memory search skipped")
            return []

        q = (query_text or "").strip()
        if not q:
            return []

        base = self.build_http_base_url()
        if not base:
            return []

        url = base + "/api/bot/memory/search"
        headers = {"Authorization": f"Bearer {self._host.token}"}
        body = {"queryText": q, "limit": int(limit)}

        try:
            timeout = aiohttp.ClientTimeout(total=3.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json=body, headers=headers) as resp:
                    if resp.status < 200 or resp.status >= 300:
                        text = ""
                        try:
                            text = await resp.text()
                        except Exception:
                            text = ""
                        logger.warning(f"[AstrTown] 记忆检索 http {resp.status}: {text[:200]}")
                        return []

                    data = await resp.json()
                    if isinstance(data, dict):
                        memories = data.get("memories")
                        if isinstance(memories, list):
                            return [m for m in memories if isinstance(m, dict)]
        except Exception as e:
            logger.error(f"[AstrTown] AstrTown 记忆检索网络异常: {e}")

        return []

    async def sync_persona_to_gateway(self, player_id: str | None) -> None:
        """尽最大努力将人设描述同步到 Gateway -> Convex。

        不记录 token 或请求体。
        """
        if aiohttp is None:
            logger.warning("[AstrTown] aiohttp not available; skip persona sync")
            return

        pid = (player_id or "").strip()
        if not pid:
            logger.debug("[AstrTown] skip persona sync: playerId empty")
            return

        from ..astrtown_adapter import get_persona_data

        description = get_persona_data()
        if not description:
            logger.info("[AstrTown] persona description empty; skip sync")
            return

        url = self._host.gateway_url.rstrip("/") + "/api/bot/description/update"
        headers = {"Authorization": f"Bearer {self._host.token}"}
        body = {"playerId": pid, "description": description}

        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json=body, headers=headers) as resp:
                    if resp.status < 200 or resp.status >= 300:
                        text = ""
                        try:
                            text = await resp.text()
                        except Exception:
                            text = ""
                        logger.warning(
                            f"[AstrTown] persona sync http {resp.status} for playerId={pid}: {text[:200]}"
                        )
                        return
        except Exception as e:
            logger.warning(f"[AstrTown] persona sync request failed for playerId={pid}: {e}")
            return

        logger.info(f"[AstrTown] persona synced for playerId={pid}")
