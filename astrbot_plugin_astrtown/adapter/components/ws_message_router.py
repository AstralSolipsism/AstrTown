from __future__ import annotations

import json
import time
from typing import Any

try:
    from websockets.exceptions import ConnectionClosed
except Exception as e:  # pragma: no cover
    raise RuntimeError(
        "astrbot_plugin_astrtown requires 'websockets' dependency available in AstrBot runtime"
    ) from e

from astrbot import logger

from ..id_util import new_id
from ..protocol import (
    AuthErrorMessage,
    AuthErrorPayload,
    CommandAck,
    CommandAckPayload,
    ConnectedMessage,
    ConnectedPayload,
)
from .contracts import AdapterHostProtocol
from .gateway_http_client import GatewayHttpClient
from .world_event_dispatcher import WorldEventDispatcher


class WsMessageRouter:
    """WebSocket 消息路由服务。"""

    def __init__(
        self,
        host: AdapterHostProtocol,
        http_client: GatewayHttpClient,
        event_dispatcher: WorldEventDispatcher,
    ) -> None:
        self._host = host
        self._http_client = http_client
        self._event_dispatcher = event_dispatcher

    @staticmethod
    def _safe_int(value: Any, default: int, field: str, msg_type: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            logger.warning(f"[AstrTown] invalid {field} for {msg_type}: {value!r}, using {default}")
            return default

    async def handle_ws_message(self, data: dict[str, Any]) -> None:
        if self._host._stop_event.is_set():
            return

        msg_type = str(data.get("type") or "")

        if msg_type == "ping":
            await self.handle_ping(data)
            return

        if msg_type == "connected":
            payload_raw = data.get("payload")
            if not isinstance(payload_raw, dict):
                logger.debug(f"[AstrTown] connected payload invalid: {type(payload_raw)!r}")
                return
            try:
                payload = ConnectedPayload(**payload_raw)
            except (TypeError, ValueError, KeyError) as e:
                logger.warn(f"[AstrTown] connected payload parse failed, ignored: {e}")
                return
            _msg = ConnectedMessage(
                type="connected",
                id=str(data.get("id") or ""),
                version=self._safe_int(data.get("version", 1), 1, "version", "connected"),
                timestamp=self._safe_int(data.get("timestamp", 0), 0, "timestamp", "connected"),
                payload=payload,
            )
            self._host._agent_id = _msg.payload.agentId
            self._host._player_id = _msg.payload.playerId
            self._host._world_id = _msg.payload.worldId
            self._host._player_name = _msg.payload.playerName
            self._host._negotiated_version = self._safe_int(
                _msg.payload.negotiatedVersion,
                self._safe_int(_msg.version, 1, "version", "connected"),
                "negotiatedVersion",
                "connected",
            )

            # 连接成功后清除鉴权失败锁，恢复普通重连逻辑。
            self._host._auth_failed = False
            self._host._auth_failed_token = ""
            self._host._auth_failed_code = None
            self._host._auth_failed_last_log_ts = 0.0

            logger.info(
                f"[AstrTown] authenticated agentId={self._host._agent_id} playerId={self._host._player_id} worldId={self._host._world_id} v={self._host._negotiated_version}"
            )

            try:
                await self._http_client.sync_persona_to_gateway(player_id=self._host._player_id)
            except Exception as e:
                logger.warning(f"[AstrTown] sync persona failed: {e}")

            return

        if msg_type == "auth_error":
            payload_raw = data.get("payload")
            if not isinstance(payload_raw, dict):
                logger.debug(f"[AstrTown] auth_error payload invalid: {type(payload_raw)!r}")
                return
            try:
                payload = AuthErrorPayload(**payload_raw)
            except (TypeError, ValueError, KeyError) as e:
                logger.warn(f"[AstrTown] auth_error payload parse failed, ignored: {e}")
                return
            _msg = AuthErrorMessage(
                type="auth_error",
                id=str(data.get("id") or ""),
                version=self._safe_int(data.get("version", 1), 1, "version", "auth_error"),
                timestamp=self._safe_int(data.get("timestamp", 0), 0, "timestamp", "auth_error"),
                payload=payload,
            )

            # auth_error 代表当前 token 不可用，进入鉴权失败锁，停止同 token 重连。
            self._host._auth_failed = True
            self._host._auth_failed_token = str(self._host.token or "")
            self._host._auth_failed_code = str(_msg.payload.code or "") or None
            self._host._auth_failed_last_log_ts = time.time()

            # 清理连接态，避免残留绑定信息污染后续逻辑。
            self._host._negotiated_version = None
            self._host._agent_id = None
            self._host._player_id = None
            self._host._world_id = None
            self._host._player_name = None
            self._host._active_conversation_id = None
            self._host._conversation_partner_id = None

            logger.error(
                f"[AstrTown] 鉴权失败，已暂停自动重连: code={_msg.payload.code} message={_msg.payload.message}。"
                "token 不会被修改，请在配置中更新 token 后自动恢复连接"
            )
            ws = self._host._ws
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass
            return

        if msg_type == "command.ack":
            payload_raw = data.get("payload")
            if not isinstance(payload_raw, dict):
                logger.debug(f"[AstrTown] command.ack payload invalid: {type(payload_raw)!r}")
                return
            try:
                payload = CommandAckPayload(**payload_raw)
            except TypeError as e:
                logger.debug(f"[AstrTown] command.ack payload parse failed: {e}")
                return
            ack = CommandAck(
                type="command.ack",
                id=str(data.get("id") or ""),
                timestamp=self._safe_int(data.get("timestamp", 0), 0, "timestamp", "command.ack"),
                payload=payload,
            )
            command_id = ack.payload.commandId
            if not isinstance(command_id, str):
                logger.debug(f"[AstrTown] command.ack commandId invalid type: {type(command_id)!r}")
                return
            if not command_id:
                logger.debug("[AstrTown] command.ack commandId empty")
                return

            fut = self._host._pending_commands.pop(command_id, None)
            if fut is None:
                logger.debug(f"[AstrTown] command.ack for unknown commandId={command_id}")
                return
            if not fut.done():
                fut.set_result(ack.payload)
            return

        if (
            msg_type.startswith("agent.")
            or msg_type.startswith("conversation.")
            or msg_type.startswith("action.")
            or msg_type.startswith("social.")
        ):
            await self._event_dispatcher.handle_world_event(data)
            return

        logger.debug(f"[AstrTown] ws recv unknown message type ignored: {msg_type!r}")

    async def handle_ping(self, data: dict[str, Any]) -> None:
        ws = self._host._ws
        if ws is None:
            return
        pong = {
            "type": "pong",
            "id": str(data.get("id") or new_id("pong")),
            "timestamp": int(time.time() * 1000),
            "payload": {},
        }
        try:
            await ws.send(json.dumps(pong, ensure_ascii=False))
        except ConnectionClosed:
            return
        except Exception:
            return
