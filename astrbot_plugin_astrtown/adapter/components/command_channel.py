from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from astrbot import logger

from ..id_util import new_id
from ..protocol import CommandAckPayload
from .contracts import AdapterHostProtocol


class CommandChannel:
    """命令发送通道。"""

    def __init__(self, host: AdapterHostProtocol) -> None:
        self._host = host

    async def send_command(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        ws = self._host._ws
        if ws is None:
            return {"ok": False, "error": "WebSocket not connected"}

        command_id = new_id("cmd")
        now_ms = int(time.time() * 1000)
        version = int(self._host._negotiated_version or 1)
        msg = {
            "type": msg_type,
            "id": command_id,
            "version": version,
            "timestamp": now_ms,
            "payload": payload,
        }

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[CommandAckPayload] = loop.create_future()
        self._host._pending_commands[command_id] = fut

        try:
            await ws.send(json.dumps(msg, ensure_ascii=False))
        except Exception as e:
            self._host._pending_commands.pop(command_id, None)
            return {"ok": False, "error": f"send failed: {e}"}

        try:
            ack_payload = await asyncio.wait_for(fut, timeout=3.0)
        except asyncio.TimeoutError:
            self._host._pending_commands.pop(command_id, None)
            return {
                "ok": False,
                "status": "timeout",
                "commandId": command_id,
                "note": "command sent, ack timeout",
            }
        except Exception as e:
            self._host._pending_commands.pop(command_id, None)
            return {"ok": False, "commandId": command_id, "error": f"ack wait failed: {e}"}

        if ack_payload.status == "rejected":
            logger.warning(
                f"[AstrTown] 命令被拒绝: commandType={msg_type}, agentId={self._host._agent_id}, reason={ack_payload.reason}"
            )
            return {"ok": False, "commandId": command_id, "reason": ack_payload.reason}

        if ack_payload.status == "accepted":
            semantics = getattr(ack_payload, "ackSemantics", None)
            logger.info(
                f"[AstrTown] 命令发送成功: commandType={msg_type}, agentId={self._host._agent_id}, status={ack_payload.status}, ackSemantics={semantics}"
            )
            return {"ok": True, "commandId": command_id}

        return {
            "ok": False,
            "commandId": command_id,
            "status": "invalid_ack_status",
            "ackStatus": ack_payload.status,
        }
