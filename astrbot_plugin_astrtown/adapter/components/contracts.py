from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any, Protocol


class AdapterHostProtocol(Protocol):
    """组件可访问的适配器宿主协议。"""

    gateway_url: str
    token: str
    _ws: Any
    _stop_event: asyncio.Event
    _tasks: list[asyncio.Task[Any]]
    _pending_commands: dict[str, asyncio.Future[Any]]
    _agent_id: str | None
    _player_id: str | None
    _world_id: str | None
    _player_name: str | None
    _negotiated_version: int | None
    _active_conversation_id: str | None
    _conversation_partner_id: str | None
    _auth_failed: bool
    _auth_failed_token: str
    _auth_failed_code: str | None
    _auth_failed_last_log_ts: float
    _last_refill_wake_ts: float
    _queue_refill_gate_last_log_ts: float
    _queue_refill_gate_last_should_wake: bool | None
    _queue_refill_gate_skip_count: int
    _event_ack_last_log_ts: float
    _event_ack_sample_count: int
    _importance_accumulator: float
    _reflection_threshold: float
    logger: Any
    config: dict[str, Any]
    settings: dict[str, Any]

    def _track_background_task(self, task: asyncio.Task[Any] | Awaitable[Any]) -> None:
        ...

    async def send_command(
        self,
        msg_type: str,
        payload: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, Any]:
        ...
