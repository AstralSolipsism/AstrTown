from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlencode

try:
    import aiohttp
except Exception:  # pragma: no cover
    aiohttp = None

from astrbot import logger

from ..astrtown_adapter import get_reflection_llm_callback
from .contracts import AdapterHostProtocol
from .gateway_http_client import GatewayHttpClient
from .reflection_parser import ReflectionParser


class ReflectionOrchestrator:
    """反思任务编排器。"""

    def __init__(
        self,
        host: AdapterHostProtocol,
        parser: ReflectionParser,
        http_client: GatewayHttpClient,
    ) -> None:
        self._host = host
        self._parser = parser
        self._http_client = http_client

    async def async_reflect_on_conversation(
        self,
        conversation_id: str,
        other_player_name: str,
        other_player_id: str,
        messages: list[dict[str, str]],
    ) -> None:
        try:
            if self._host._stop_event.is_set():
                return

            if aiohttp is None:
                logger.warning("[AstrTown] aiohttp not available; skip async reflection")
                return

            callback = get_reflection_llm_callback()
            if callback is None:
                logger.warning("[AstrTown] reflection llm callback not set; skip async reflection")
                return

            owner_id = str(self._host._player_id or "").strip()
            agent_id = str(self._host._agent_id or "").strip()
            if not owner_id or not agent_id:
                logger.warning("[AstrTown] missing binding(agent/player); skip async reflection")
                return

            prompt = self._parser.build_reflection_prompt(
                conversation_id=conversation_id,
                other_player_name=other_player_name,
                other_player_id=other_player_id,
                messages=messages,
            )

            llm_result = await callback(prompt)
            normalized = self._parser.normalize_reflection_response(llm_result)
            if normalized is None:
                logger.warning(
                    f"[AstrTown] reflection llm 返回不可解析 JSON，conversationId={conversation_id}"
                )
                return

            summary = str(normalized["summary"])
            importance = self._parser.to_int_in_range(normalized.get("importance"), 1, 10, 5)
            affinity_delta = self._parser.to_int_in_range(normalized.get("affinity_delta"), -10, 10, 0)
            affinity_label = str(normalized.get("affinity_label") or "暂无明显变化").strip()

            base = self._http_client.build_http_base_url()
            if not base:
                logger.warning("[AstrTown] invalid gateway base url; skip async reflection")
                return

            headers = {"Authorization": f"Bearer {self._host.token}"}
            timeout = aiohttp.ClientTimeout(total=8.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                memory_body = {
                    "agentId": agent_id,
                    "playerId": owner_id,
                    "summary": summary,
                    "importance": importance,
                    "memoryType": "conversation",
                }
                memory_ok = await self._http_client.post_json_best_effort(
                    session=session,
                    url=base + "/api/bot/memory/inject",
                    headers=headers,
                    body=memory_body,
                    action_name="memory.inject",
                )
                if not memory_ok:
                    logger.warning(
                        f"[AstrTown] reflection memory.inject 失败，跳过累计 importance, conversationId={conversation_id}"
                    )
                    return

                target_id = str(other_player_id or "").strip()
                if not target_id:
                    logger.warning(
                        f"[AstrTown] reflection 缺少 other_player_id，跳过好感度回写和累计 importance, conversationId={conversation_id}"
                    )
                    return

                affinity_body = {
                    "ownerId": owner_id,
                    "targetId": target_id,
                    "scoreDelta": affinity_delta,
                    "label": affinity_label,
                }
                affinity_ok = await self._http_client.post_json_best_effort(
                    session=session,
                    url=base + "/api/bot/social/affinity",
                    headers=headers,
                    body=affinity_body,
                    action_name="social.affinity",
                )
                if not affinity_ok:
                    logger.warning(
                        f"[AstrTown] reflection social.affinity 失败，跳过累计 importance, conversationId={conversation_id}"
                    )
                    return

            logger.info(
                f"[AstrTown] conversation reflection completed: conversationId={conversation_id}, delta={affinity_delta}"
            )

            self._host._importance_accumulator += float(importance)
            if self._host._importance_accumulator >= self._host._reflection_threshold:
                if not self._host._stop_event.is_set():
                    higher_reflect_task = asyncio.create_task(
                        self.async_higher_reflection(),
                        name=f"astrtown_higher_reflect_{owner_id or 'unknown'}",
                    )
                    self._host._track_background_task(higher_reflect_task)
                self._host._importance_accumulator = 0.0
        except Exception as e:
            logger.warning(
                f"[AstrTown] async reflection task failed: conversationId={conversation_id}, error={e}"
            )

    async def async_higher_reflection(self) -> None:
        try:
            if self._host._stop_event.is_set():
                return

            if aiohttp is None:
                logger.warning("[AstrTown] aiohttp not available; skip higher reflection")
                return

            callback = get_reflection_llm_callback()
            if callback is None:
                logger.warning("[AstrTown] reflection llm callback not set; skip higher reflection")
                return

            owner_id = str(self._host._player_id or "").strip()
            agent_id = str(self._host._agent_id or "").strip()
            if not owner_id or not agent_id:
                logger.warning("[AstrTown] missing binding(agent/player); skip higher reflection")
                return

            role_name = str(self._host._player_name or "").strip() or owner_id or "该角色"
            world_id = str(self._host._world_id or "").strip()
            if not world_id:
                logger.warning("[AstrTown] missing binding(world); skip higher reflection")
                return

            base = self._http_client.build_http_base_url()
            if not base:
                logger.warning("[AstrTown] invalid gateway base url; skip higher reflection")
                return

            headers = {"Authorization": f"Bearer {self._host.token}"}
            timeout = aiohttp.ClientTimeout(total=8.0)
            recent_url = base + "/api/bot/memory/recent?" + urlencode(
                {"worldId": world_id, "playerId": owner_id, "count": 50}
            )
            recent_memories: Any = None
            async with aiohttp.ClientSession(timeout=timeout) as session:
                try:
                    async with session.get(recent_url, headers=headers) as resp:
                        if resp.status < 200 or resp.status >= 300:
                            text = ""
                            try:
                                text = await resp.text()
                            except Exception:
                                text = ""
                            logger.warning(
                                f"[AstrTown] 获取近期记忆失败 http={resp.status}, worldId={world_id}, playerId={owner_id}, body={text[:200]}"
                            )
                            return
                        recent_memories = await resp.json()
                except Exception as e:
                    logger.warning(f"[AstrTown] 获取近期记忆网络异常: {e}")
                    return

            if not isinstance(recent_memories, list):
                logger.warning("[AstrTown] higher reflection skipped: recent memories payload invalid")
                return

            memory_lines: list[str] = []
            for idx, memory in enumerate(recent_memories, start=1):
                if not isinstance(memory, dict):
                    continue
                description = str(memory.get("description") or "").strip()
                if not description:
                    continue
                memory_lines.append(f"{idx}. {description}")

            if not memory_lines:
                logger.info("[AstrTown] higher reflection skipped: memory descriptions empty")
                return

            memory_text = "\n".join(memory_lines)
            prompt = (
                f"你是 {role_name} 的深层意识。以下是你最近的 {len(memory_lines)} 条记忆片段：\n"
                f"{memory_text}\n\n"
                "请从这些记忆中提取 3-5 条高层顿悟或长期价值观（Insights），每条顿悟应是对多段经历的抽象总结，反映你作为这个角色的核心认知变化。\n"
                '请严格输出 JSON 数组：[{"insight":"..."},{"insight":"..."},...]'
            )

            llm_result = await callback(prompt)
            insights = self._parser.normalize_higher_reflection_response(llm_result)
            if not insights:
                logger.warning("[AstrTown] higher reflection llm 返回不可解析 JSON 数组，已跳过")
                return

            success_count = 0
            async with aiohttp.ClientSession(timeout=timeout) as session:
                for insight in insights:
                    body = {
                        "agentId": agent_id,
                        "playerId": owner_id,
                        "summary": insight,
                        "importance": 10,
                        "memoryType": "reflection",
                    }
                    ok = await self._http_client.post_json_best_effort(
                        session=session,
                        url=base + "/api/bot/memory/inject",
                        headers=headers,
                        body=body,
                        action_name="memory.inject.higher_reflection",
                    )
                    if ok:
                        success_count += 1

            if success_count <= 0:
                logger.warning("[AstrTown] higher reflection completed but no insight persisted")
                return

            logger.info(f"[AstrTown] higher reflection completed: injected={success_count}")
        except Exception as e:
            logger.warning(f"[AstrTown] higher reflection task failed: {e}")
