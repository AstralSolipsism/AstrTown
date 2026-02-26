from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any

from .protocol import (
    AuthErrorMessage,
    AuthErrorPayload,
    CommandAck,
    CommandAckPayload,
    ConnectedMessage,
    ConnectedPayload,
    WorldEvent,
)
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from astrbot import logger
from astrbot.api.message_components import Plain
from astrbot.api.platform import (
    AstrBotMessage,
    MessageMember,
    MessageType,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)

try:
    import aiohttp
except Exception:  # pragma: no cover
    aiohttp = None

_PERSONA_DESCRIPTION: str | None = None


def set_persona_data(description: str) -> None:
    global _PERSONA_DESCRIPTION
    desc = (description or "").strip()
    _PERSONA_DESCRIPTION = desc or None


def get_persona_data() -> str | None:
    return _PERSONA_DESCRIPTION


ReflectLLMCallback = Callable[[str], Awaitable[Any]]
_REFLECTION_LLM_CALLBACK: ReflectLLMCallback | None = None


def set_reflection_llm_callback(callback: ReflectLLMCallback | None) -> None:
    global _REFLECTION_LLM_CALLBACK
    _REFLECTION_LLM_CALLBACK = callback


def get_reflection_llm_callback() -> ReflectLLMCallback | None:
    return _REFLECTION_LLM_CALLBACK


try:
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
except Exception as e:  # pragma: no cover
    raise RuntimeError(
        "astrbot_plugin_astrtown requires 'websockets' dependency available in AstrBot runtime"
    ) from e

from .astrtown_event import AstrTownMessageEvent
from .id_util import new_id
from .components.command_channel import CommandChannel
from .components.event_ack_sender import EventAckSender
from .components.event_text_formatter import EventTextFormatter
from .components.gateway_http_client import GatewayHttpClient
from .components.reflection_orchestrator import ReflectionOrchestrator
from .components.reflection_parser import ReflectionParser
from .components.session_context import SessionContextService
from .components.world_event_dispatcher import WorldEventDispatcher
from .components.ws_lifecycle import WsLifecycleService
from .components.ws_message_router import WsMessageRouter


@register_platform_adapter(
    "astrtown",
    "AstrTown 适配器 - 通过 Gateway 将游戏世界抽象为消息平台",
    default_config_tmpl={
        "astrtown_gateway_url": "http://localhost:40010",
        "astrtown_token": "",
        "astrtown_ws_reconnect_min_delay": 1,
        "astrtown_ws_reconnect_max_delay": 30,
    },
)
class AstrTownAdapter(Platform):
    _ws: Any

    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)

        self.settings = platform_settings

        # 方案C：adapter 侧兜底计数器（按 session_id 统计事件数量）
        self._session_event_count: dict[str, int] = {}

        # 方案C：本地维护“当前活跃对话ID”，用于过滤不属于自己的 conversation.message。
        # 仅作为插件层兜底，防止时序竞争导致 NPC 已离开但仍被投递消息而唤醒 LLM。
        self._active_conversation_id: str | None = None

        # 3.4：维护当前会话对方 player_id，供插件侧张力 Prompt 注入使用。
        self._conversation_partner_id: str | None = None

        self.gateway_url = str(
            platform_config.get("astrtown_gateway_url", "http://localhost:40010")
        ).rstrip("/")
        self.token = str(platform_config.get("astrtown_token", ""))

        # 鉴权失败锁：收到 auth_error 后暂停自动重连，等待用户更新 token。
        self._auth_failed: bool = False
        self._auth_failed_token: str = ""
        self._auth_failed_code: str | None = None
        self._auth_failed_last_log_ts: float = 0.0

        # Internal hard-coded protocol details: do not expose as user config.
        self.subscribe = "*"
        self.protocol_version_range = "1-1"

        self.reconnect_min_delay = self._safe_int(
            platform_config.get("astrtown_ws_reconnect_min_delay", 1),
            1,
            "astrtown_ws_reconnect_min_delay",
            "platform_config",
        )
        self.reconnect_max_delay = self._safe_int(
            platform_config.get("astrtown_ws_reconnect_max_delay", 30),
            30,
            "astrtown_ws_reconnect_max_delay",
            "platform_config",
        )

        platform_id = platform_config.get("id", "astrtown_default")
        self._metadata = PlatformMetadata(
            name="astrtown",
            description="AstrTown 平台适配器",
            id=platform_id,
        )

        self._tasks: list[asyncio.Task] = []
        self._stop_event = asyncio.Event()
        self._ws = None

        self._pending_commands: dict[str, asyncio.Future[CommandAckPayload]] = {}

        self._agent_id: str | None = None
        self._player_id: str | None = None
        self._world_id: str | None = None
        self._player_name: str | None = None
        self._negotiated_version: int | None = None

        # queue_refill 降噪门控：记录上次允许唤醒 LLM 的时间戳。
        self._last_refill_wake_ts: float = 0.0

        # 方案B：queue_refill 门控日志节流/状态变化打印
        self._queue_refill_gate_last_log_ts: float = 0.0
        self._queue_refill_gate_last_should_wake: bool | None = None
        self._queue_refill_gate_skip_count: int = 0

        # 方案B：事件ACK已发送 日志采样（避免高频刷屏）
        self._event_ack_last_log_ts: float = 0.0
        self._event_ack_sample_count: int = 0

        # 高阶反思触发器：累计“日常反思”的 importance，总量达到阈值后触发一次深层反思。
        self._importance_accumulator: float = 0.0
        self._reflection_threshold: float = 300.0

        # --- 组件实例化（组合模式） ---
        self._session_ctx = SessionContextService(self)
        self._text_formatter = EventTextFormatter(self)
        self._ack_sender = EventAckSender(self)
        self._http_client = GatewayHttpClient(self)
        self._reflection_parser = ReflectionParser(self)
        self._reflection_orch = ReflectionOrchestrator(self, self._reflection_parser, self._http_client)
        self._cmd_channel = CommandChannel(self)
        self._event_dispatcher = WorldEventDispatcher(
            self,
            self._ack_sender,
            self._session_ctx,
            self._text_formatter,
            self._reflection_orch,
        )
        self._msg_router = WsMessageRouter(self, self._http_client, self._event_dispatcher)
        self._ws_lifecycle = WsLifecycleService(self, self._msg_router)

    def meta(self) -> PlatformMetadata:
        return self._metadata

    def run(self) -> Coroutine[Any, Any, None]:
        return self._run()

    async def _run(self) -> None:
        if not self.token:
            logger.error("[AstrTown] token 未配置，适配器不启动")
            return

        logger.info("[AstrTown] 启动 AstrTown 平台适配器")
        self._stop_event.clear()

        ws_task = asyncio.create_task(self._ws_loop(), name="astrtown_ws_loop")
        self._tasks = [ws_task]

        try:
            await asyncio.gather(*self._tasks)
        except asyncio.CancelledError:
            logger.info("[AstrTown] adapter cancelled")

    async def terminate(self):
        logger.info("[AstrTown] terminate")
        self._stop_event.set()

        for fut in list(self._pending_commands.values()):
            if not fut.done():
                fut.cancel()
        self._pending_commands.clear()

        current_task = asyncio.current_task()
        tasks_to_cancel = [
            t for t in list(self._tasks) if not t.done() and t is not current_task
        ]
        for t in tasks_to_cancel:
            t.cancel()
        if tasks_to_cancel:
            await asyncio.gather(*tasks_to_cancel, return_exceptions=True)
        self._tasks.clear()

        ws = self._ws
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    def _track_background_task(self, task: asyncio.Task) -> None:
        self._tasks.append(task)

        def _cleanup(done_task: asyncio.Task) -> None:
            try:
                self._tasks.remove(done_task)
            except ValueError:
                pass

        task.add_done_callback(_cleanup)

    def get_binding(self) -> dict[str, str | int | None]:
        return {
            "agentId": self._agent_id,
            "playerId": self._player_id,
            "worldId": self._world_id,
            "playerName": self._player_name,
            "protocolVersion": self._negotiated_version,
        }

    async def send_command(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._cmd_channel.send_command(msg_type, payload)

    def _build_ws_connect_url(self) -> str:
        return self._ws_lifecycle.build_ws_connect_url()

    def _mask_ws_url_for_log(self, url: str) -> str:
        return WsLifecycleService.mask_ws_url_for_log(url)

    @staticmethod
    def _safe_int(value: Any, default: int, field: str, msg_type: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            logger.warning(f"[AstrTown] invalid {field} for {msg_type}: {value!r}, using {default}")
            return default

    async def _ws_loop(self) -> None:
        return await self._ws_lifecycle.ws_loop()

    async def _ws_connect_once(self) -> None:
        return await self._ws_lifecycle.ws_connect_once()

    async def _handle_ws_message(self, data: dict[str, Any]) -> None:
        return await self._msg_router.handle_ws_message(data)

    async def _handle_ping(self, data: dict[str, Any]) -> None:
        return await self._msg_router.handle_ping(data)

    async def _handle_world_event(self, data: dict[str, Any]) -> None:
        return await self._event_dispatcher.handle_world_event(data)

    async def _send_event_ack(self, event_id: str) -> None:
        return await self._ack_sender.send_event_ack(event_id)

    def _pick_first_non_empty_str(self, payload: dict[str, Any], keys: list[str]) -> str:
        return SessionContextService.pick_first_non_empty_str(payload, keys)

    def _extract_conversation_messages(self, payload: dict[str, Any]) -> list[dict[str, str]]:
        return SessionContextService.extract_conversation_messages(payload)

    def _build_reflection_prompt(
        self,
        conversation_id: str,
        other_player_name: str,
        other_player_id: str,
        messages: list[dict[str, str]],
    ) -> str:
        return self._reflection_parser.build_reflection_prompt(
            conversation_id=conversation_id,
            other_player_name=other_player_name,
            other_player_id=other_player_id,
            messages=messages,
        )

    @staticmethod
    def _to_int_in_range(value: Any, minimum: int, maximum: int, default: int) -> int:
        return ReflectionParser.to_int_in_range(value, minimum, maximum, default)

    def _normalize_reflection_response(self, llm_result: Any) -> dict[str, Any] | None:
        return self._reflection_parser.normalize_reflection_response(llm_result)

    @staticmethod
    def _parse_json_array(text: str) -> list[Any] | None:
        return ReflectionParser.parse_json_array(text)

    def _normalize_higher_reflection_response(self, llm_result: Any) -> list[str]:
        return self._reflection_parser.normalize_higher_reflection_response(llm_result)

    async def _post_json_best_effort(
        self,
        session: Any,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any],
        action_name: str,
    ) -> bool:
        return await self._http_client.post_json_best_effort(
            session=session,
            url=url,
            headers=headers,
            body=body,
            action_name=action_name,
        )

    async def _async_reflect_on_conversation(
        self,
        conversation_id: str,
        other_player_name: str,
        other_player_id: str,
        messages: list[dict[str, str]],
    ) -> None:
        return await self._reflection_orch.async_reflect_on_conversation(
            conversation_id=conversation_id,
            other_player_name=other_player_name,
            other_player_id=other_player_id,
            messages=messages,
        )

    async def _async_higher_reflection(self) -> None:
        return await self._reflection_orch.async_higher_reflection()

    def _build_session_id(self, _event_type: str, payload: dict[str, Any]) -> str:
        return self._session_ctx.build_session_id(_event_type, payload)

    def _build_http_base_url(self) -> str:
        return self._http_client.build_http_base_url()

    async def search_world_memory(self, query_text: str, limit: int = 3) -> list[dict[str, Any]]:
        return await self._http_client.search_world_memory(query_text, limit)

    async def _sync_persona_to_gateway(self, player_id: str | None) -> None:
        return await self._http_client.sync_persona_to_gateway(player_id)

    def _format_event_to_text(self, event_type: str, payload: dict[str, Any]) -> str:
        return self._text_formatter.format_event_to_text(event_type, payload)
