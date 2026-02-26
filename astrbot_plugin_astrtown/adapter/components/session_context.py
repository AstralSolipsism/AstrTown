from __future__ import annotations

from typing import Any

from astrbot import logger

from .contracts import AdapterHostProtocol


class SessionContextService:
    """会话上下文服务。"""

    def __init__(self, host: AdapterHostProtocol) -> None:
        self._host = host

    @staticmethod
    def pick_first_non_empty_str(payload: dict[str, Any], keys: list[str]) -> str:
        for key in keys:
            value = payload.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        return ""

    @staticmethod
    def extract_conversation_messages(payload: dict[str, Any]) -> list[dict[str, str]]:
        raw_messages = payload.get("messages")
        if not isinstance(raw_messages, list):
            return []

        messages: list[dict[str, str]] = []
        for item in raw_messages:
            if not isinstance(item, dict):
                continue

            message_raw = item.get("message")
            message = message_raw if isinstance(message_raw, dict) else item

            speaker_id = str(
                message.get("speakerId")
                or item.get("speakerId")
                or message.get("authorId")
                or message.get("author")
                or "unknown"
            ).strip()
            content = str(message.get("content") or message.get("text") or "").strip()
            if not content:
                continue

            messages.append(
                {
                    "speakerId": speaker_id or "unknown",
                    "content": content,
                }
            )
        return messages

    def build_session_id(self, _event_type: str, payload: dict[str, Any]) -> str:
        player_id = str(self._host._player_id or payload.get("playerId") or "").strip()
        world_id = str(self._host._world_id or payload.get("worldId") or "").strip()

        # 修复2：sid world/NPC 二态，受 AstrBot 全局 unique_session 控制（来自 platform_settings）。
        unique_session = bool(getattr(self._host, "settings", {}) and self._host.settings.get("unique_session", False))

        if not world_id:
            world_id = "default"

        if not unique_session:
            sid = f"astrtown:world:{world_id}"
        else:
            # 开启隔离：每个 NPC 一个会话；player_id 缺失时退化为 world 会话。
            if player_id:
                sid = f"astrtown:world:{world_id}:player:{player_id}"
            else:
                sid = f"astrtown:world:{world_id}"

        logger.info(
            f"[AstrTown] _build_session_id: unique_session={unique_session}, world_id={world_id}, player_id={player_id}, sid={sid}"
        )
        return sid
