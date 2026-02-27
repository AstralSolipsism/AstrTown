from __future__ import annotations

from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent

from .player_binding import PlayerBindingManager


class MemoryInjector:
    """普通对话记忆注入器。"""

    def __init__(self, adapter_list: list[Any], player_binding: PlayerBindingManager) -> None:
        self._adapter_list = adapter_list
        self._player_binding = player_binding

    async def build_memory_prompt(self, event: AstrMessageEvent, contexts: list[Any]) -> str | None:
        session_key = str(getattr(event, "unified_msg_origin", "") or "").strip()
        if not session_key:
            return None

        binding = self._player_binding.get_binding(session_key)
        if not binding:
            return None

        platform_id = str(binding.get("platform_id") or "").strip()
        player_id = str(binding.get("player_id") or "").strip()
        if not platform_id or not player_id:
            return None

        adapter = self._resolve_adapter(platform_id)
        if adapter is None:
            logger.warning(
                f"[astrtown] 记忆注入跳过：找不到绑定平台实例 platform_id={platform_id}, session={session_key}"
            )
            return None

        query = self._extract_last_user_message(contexts)
        if len(query.strip()) <= 2:
            return None

        try:
            memories = await adapter.search_world_memory(query, limit=3)
        except Exception as e:
            logger.warning(f"[astrtown] 记忆注入查询失败: {e}")
            return None

        if not isinstance(memories, list) or not memories:
            return None

        memory_lines: list[str] = []
        for item in memories:
            if not isinstance(item, dict):
                continue
            description = str(item.get("description") or "").strip()
            if not description:
                continue
            importance = item.get("importance")
            if importance is None:
                memory_lines.append(f"- {description}")
            else:
                memory_lines.append(f"- {description} (重要度:{importance})")

        if not memory_lines:
            return None

        return "[AstrTown 角色记忆]\n" f"角色ID：{player_id}\n" + "\n".join(memory_lines)

    def _resolve_adapter(self, platform_id: str) -> Any | None:
        for inst in self._adapter_list:
            meta_func = getattr(inst, "meta", None)
            if not callable(meta_func):
                continue
            try:
                meta = meta_func()
            except Exception:
                continue

            inst_id = str(getattr(meta, "id", "") or "").strip()
            inst_name = str(getattr(meta, "name", "") or "").strip()
            if inst_id != platform_id:
                continue
            if inst_name != "astrtown":
                continue
            if not hasattr(inst, "search_world_memory"):
                continue
            return inst

        return None

    @staticmethod
    def _extract_last_user_message(contexts: list[Any]) -> str:
        for msg in reversed(contexts):
            role: Any
            content: Any
            if isinstance(msg, dict):
                role = msg.get("role")
                content = msg.get("content")
            else:
                role = getattr(msg, "role", None)
                content = getattr(msg, "content", None)

            if role == "user" and isinstance(content, str):
                return content

        return ""
