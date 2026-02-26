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
        ws = self._ws
        if ws is None:
            return {"ok": False, "error": "WebSocket not connected"}

        command_id = new_id("cmd")
        now_ms = int(time.time() * 1000)
        version = int(self._negotiated_version or 1)
        msg = {
            "type": msg_type,
            "id": command_id,
            "version": version,
            "timestamp": now_ms,
            "payload": payload,
        }

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[CommandAckPayload] = loop.create_future()
        self._pending_commands[command_id] = fut

        try:
            await ws.send(json.dumps(msg, ensure_ascii=False))
        except Exception as e:
            self._pending_commands.pop(command_id, None)
            return {"ok": False, "error": f"send failed: {e}"}

        try:
            ack_payload = await asyncio.wait_for(fut, timeout=3.0)
        except asyncio.TimeoutError:
            self._pending_commands.pop(command_id, None)
            return {
                "ok": False,
                "status": "timeout",
                "commandId": command_id,
                "note": "command sent, ack timeout",
            }
        except Exception as e:
            self._pending_commands.pop(command_id, None)
            return {"ok": False, "commandId": command_id, "error": f"ack wait failed: {e}"}

        if ack_payload.status == "rejected":
            logger.warning(
                f"[AstrTown] 命令被拒绝: commandType={msg_type}, agentId={self._agent_id}, reason={ack_payload.reason}"
            )
            return {"ok": False, "commandId": command_id, "reason": ack_payload.reason}

        if ack_payload.status == "accepted":
            semantics = getattr(ack_payload, "ackSemantics", None)
            logger.info(
                f"[AstrTown] 命令发送成功: commandType={msg_type}, agentId={self._agent_id}, status={ack_payload.status}, ackSemantics={semantics}"
            )
            return {"ok": True, "commandId": command_id}

        return {
            "ok": False,
            "commandId": command_id,
            "status": "invalid_ack_status",
            "ackStatus": ack_payload.status,
        }

    def _build_ws_connect_url(self) -> str:
        ws_base = self.gateway_url
        if ws_base.startswith("https://"):
            ws_base = "wss://" + ws_base[len("https://") :]
        elif ws_base.startswith("http://"):
            ws_base = "ws://" + ws_base[len("http://") :]

        ws_url = ws_base.rstrip("/") + "/ws/bot"
        query = urlencode(
            {
                "token": self.token,
                "v": self.protocol_version_range,
                "subscribe": self.subscribe,
            }
        )
        return f"{ws_url}?{query}"

    def _mask_ws_url_for_log(self, url: str) -> str:
        """Mask sensitive query params (token) in ws url for logging."""
        try:
            p = urlparse(url)
            q = parse_qsl(p.query, keep_blank_values=True)
            masked = []
            for k, v in q:
                if k.lower() == "token" and v:
                    masked.append((k, "***"))
                else:
                    masked.append((k, v))
            new_query = urlencode(masked)
            return urlunparse((p.scheme, p.netloc, p.path, p.params, new_query, p.fragment))
        except Exception:
            # Best-effort fallback: avoid leaking token even if url parsing fails.
            return url.split("?")[0] + "?token=***" if "?" in url else url

    @staticmethod
    def _safe_int(value: Any, default: int, field: str, msg_type: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            logger.warning(f"[AstrTown] invalid {field} for {msg_type}: {value!r}, using {default}")
            return default

    async def _ws_loop(self) -> None:
        delay = float(self.reconnect_min_delay)
        while not self._stop_event.is_set():
            # 每轮连接前刷新 token：支持用户在运行时更新配置后自动恢复。
            latest_token = str(self.config.get("astrtown_token", "") or "").strip()
            if latest_token != self.token:
                old_token = self.token
                self.token = latest_token
                self._auth_failed = False
                self._auth_failed_token = ""
                self._auth_failed_code = None
                self._auth_failed_last_log_ts = 0.0
                if self.token:
                    logger.info("[AstrTown] 检测到 token 已更新，解除鉴权失败锁并重新尝试连接")
                else:
                    logger.warning("[AstrTown] 检测到 token 被更新为空，适配器将暂停连接")

                # token 变化后重置退避，避免恢复时被长延迟阻塞。
                delay = float(self.reconnect_min_delay)

                # 仅用于诊断，避免泄露 token 内容。
                if old_token and self.token:
                    logger.debug("[AstrTown] token 已发生变更（内容已脱敏）")

            # token 缺失时不连接，等待用户补充。
            if not self.token:
                await asyncio.sleep(1.0)
                continue

            # 鉴权失败锁：同一失效 token 不再重连，避免刷屏。
            if self._auth_failed and self.token == self._auth_failed_token:
                now = time.time()
                if (now - float(self._auth_failed_last_log_ts or 0.0)) >= 30.0:
                    code = self._auth_failed_code or "UNKNOWN"
                    logger.error(
                        f"[AstrTown] 当前 token 已鉴权失败(code={code})，暂停自动重连；"
                        "请更新 token 后将自动恢复连接"
                    )
                    self._auth_failed_last_log_ts = now
                await asyncio.sleep(1.0)
                continue

            try:
                await self._ws_connect_once()
                delay = float(self.reconnect_min_delay)
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error(f"[AstrTown] ws loop error: {e}", exc_info=True)

            if self._stop_event.is_set():
                return

            # 鉴权失败时不走退避重连；由上面的 auth_failed 分支接管等待。
            if self._auth_failed and self.token == self._auth_failed_token:
                continue

            jitter = random.random() * 0.3 + 0.85
            sleep_s = min(delay * jitter, float(self.reconnect_max_delay))
            logger.warn(f"[AstrTown] reconnect in {sleep_s:.1f}s")
            await asyncio.sleep(sleep_s)
            delay = min(delay * 2.0, float(self.reconnect_max_delay))

    async def _ws_connect_once(self) -> None:
        url = self._build_ws_connect_url()
        logger.info(f"[AstrTown] connecting ws: {self._mask_ws_url_for_log(url)}")

        try:
            async with connect(
                url,
                ping_interval=30,
                ping_timeout=10,
                close_timeout=5,
                max_queue=256,
            ) as websocket:
                self._ws = websocket
                logger.info("[AstrTown] ws connected")

                async for raw in websocket:
                    if self._stop_event.is_set():
                        break

                    if not isinstance(raw, str):
                        if isinstance(raw, (bytes, bytearray, memoryview)):
                            try:
                                raw = bytes(raw).decode("utf-8")
                            except Exception as e:
                                logger.debug(f"[AstrTown] ws recv non-utf8 binary frame ignored: {e}")
                                continue
                        else:
                            logger.debug(f"[AstrTown] ws recv unknown frame type ignored: {type(raw)!r}")
                            continue

                    try:
                        data = json.loads(raw)
                    except Exception as e:
                        logger.debug(f"[AstrTown] ws recv invalid json ignored: {e}")
                        continue

                    if not isinstance(data, dict):
                        logger.debug(f"[AstrTown] ws recv non-object json ignored: {type(data)!r}")
                        continue

                    await self._handle_ws_message(data)
        finally:
            # Ensure we don't keep stale ws reference/binding across reconnects.
            self._ws = None
            self._negotiated_version = None
            self._agent_id = None
            self._player_id = None
            self._world_id = None
            self._player_name = None

            if self._pending_commands:
                err = ConnectionError("WebSocket disconnected")
                for command_id, fut in list(self._pending_commands.items()):
                    if fut.done():
                        continue
                    try:
                        fut.set_exception(err)
                    except Exception:
                        try:
                            fut.cancel()
                        except Exception:
                            pass
                self._pending_commands.clear()

    async def _handle_ws_message(self, data: dict[str, Any]) -> None:
        if self._stop_event.is_set():
            return

        msg_type = str(data.get("type") or "")

        if msg_type == "ping":
            await self._handle_ping(data)
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
            self._agent_id = _msg.payload.agentId
            self._player_id = _msg.payload.playerId
            self._world_id = _msg.payload.worldId
            self._player_name = _msg.payload.playerName
            self._negotiated_version = self._safe_int(
                _msg.payload.negotiatedVersion,
                self._safe_int(_msg.version, 1, "version", "connected"),
                "negotiatedVersion",
                "connected",
            )

            # 连接成功后清除鉴权失败锁，恢复普通重连逻辑。
            self._auth_failed = False
            self._auth_failed_token = ""
            self._auth_failed_code = None
            self._auth_failed_last_log_ts = 0.0

            logger.info(
                f"[AstrTown] authenticated agentId={self._agent_id} playerId={self._player_id} worldId={self._world_id} v={self._negotiated_version}"
            )

            try:
                await self._sync_persona_to_gateway(player_id=self._player_id)
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
            self._auth_failed = True
            self._auth_failed_token = str(self.token or "")
            self._auth_failed_code = str(_msg.payload.code or "") or None
            self._auth_failed_last_log_ts = time.time()

            # 清理连接态，避免残留绑定信息污染后续逻辑。
            self._negotiated_version = None
            self._agent_id = None
            self._player_id = None
            self._world_id = None
            self._player_name = None
            self._active_conversation_id = None
            self._conversation_partner_id = None

            logger.error(
                f"[AstrTown] 鉴权失败，已暂停自动重连: code={_msg.payload.code} message={_msg.payload.message}。"
                "token 不会被修改，请在配置中更新 token 后自动恢复连接"
            )
            ws = self._ws
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

            fut = self._pending_commands.pop(command_id, None)
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
            await self._handle_world_event(data)
            return

        logger.debug(f"[AstrTown] ws recv unknown message type ignored: {msg_type!r}")

    async def _handle_ping(self, data: dict[str, Any]) -> None:
        ws = self._ws
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

    async def _handle_world_event(self, data: dict[str, Any]) -> None:
        if self._stop_event.is_set():
            return

        payload_raw = data.get("payload")
        metadata_raw = data.get("metadata")
        if payload_raw is None:
            payload_raw = {}
        if not isinstance(payload_raw, dict):
            logger.debug(f"[AstrTown] world event payload invalid: {type(payload_raw)!r}")
            return
        if metadata_raw is not None and not isinstance(metadata_raw, dict):
            logger.debug(f"[AstrTown] world event metadata invalid: {type(metadata_raw)!r}")
            metadata_raw = None

        evt = WorldEvent(
            type=str(data.get("type") or ""),
            id=str(data.get("id") or ""),
            version=self._safe_int(data.get("version", 1), 1, "version", "world_event"),
            timestamp=self._safe_int(data.get("timestamp", 0), 0, "timestamp", "world_event"),
            expiresAt=self._safe_int(data.get("expiresAt", 0), 0, "expiresAt", "world_event"),
            payload=payload_raw,
            metadata=metadata_raw,
        )

        event_id = evt.id
        event_type = evt.type
        payload = evt.payload

        # 方案C：conversation.message 前置过滤
        # 当消息不属于当前 NPC 的活跃对话时，仅 ACK，不 commit_event（不唤醒 LLM）。
        if event_type == "conversation.message":
            incoming_cid = str(payload.get("conversationId") or "").strip()
            active_cid = str(self._active_conversation_id or "").strip()
            if active_cid and incoming_cid and incoming_cid != active_cid:
                logger.info(
                    f"[AstrTown] 过滤 conversation.message: incoming={incoming_cid} active={active_cid} agentId={self._agent_id}"
                )
                try:
                    await self._send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

        if event_type == "conversation.message":
            message_raw = payload.get("message")
            message = message_raw if isinstance(message_raw, dict) else {}
            speaker_id = str(message.get("speakerId") or "").strip()
            owner_id = str(self._player_id or "").strip()
            if speaker_id and speaker_id != owner_id:
                self._conversation_partner_id = speaker_id

        # 方案C：活跃对话状态更新（invited/started/ended/timeout）
        if event_type == "conversation.ended":
            ended_cid = str(payload.get("conversationId") or "").strip()
            if ended_cid and self._active_conversation_id == ended_cid:
                self._active_conversation_id = None
                self._conversation_partner_id = None
            elif not ended_cid:
                # 没有 conversationId 时保守清空，避免残留。
                self._active_conversation_id = None
                self._conversation_partner_id = None

            other_player_id = self._pick_first_non_empty_str(
                payload,
                [
                    "otherPlayerId",
                    "other_player_id",
                    "otherParticipantId",
                    "targetPlayerId",
                    "counterpartId",
                ],
            )
            other_player_name = self._pick_first_non_empty_str(
                payload,
                [
                    "otherPlayerName",
                    "other_player_name",
                    "otherParticipantName",
                    "targetPlayerName",
                    "counterpartName",
                ],
            )
            if not other_player_name:
                other_player_name = other_player_id or "对方"
            messages = self._extract_conversation_messages(payload)

            # 关键约束：反思任务必须异步后台执行，不能阻塞事件主流程。
            reflect_task = asyncio.create_task(
                self._async_reflect_on_conversation(
                    conversation_id=ended_cid,
                    other_player_name=other_player_name,
                    other_player_id=other_player_id,
                    messages=messages,
                ),
                name=f"astrtown_reflect_{ended_cid or event_id or 'unknown'}",
            )
            self._track_background_task(reflect_task)

        if event_type == "conversation.started":
            started_cid = str(payload.get("conversationId") or "").strip()
            if started_cid:
                self._active_conversation_id = started_cid

            owner_id = str(self._player_id or "").strip()
            partner_id = ""
            other_ids = payload.get("otherParticipantIds")
            if isinstance(other_ids, list):
                for item in other_ids:
                    candidate = str(item or "").strip()
                    if candidate and candidate != owner_id:
                        partner_id = candidate
                        break

            if not partner_id:
                partner_id = self._pick_first_non_empty_str(
                    payload,
                    [
                        "otherPlayerId",
                        "other_player_id",
                        "otherParticipantId",
                        "targetPlayerId",
                        "counterpartId",
                    ],
                )

            if partner_id and partner_id != owner_id:
                self._conversation_partner_id = partner_id

        if event_type == "conversation.timeout":
            # 1) 状态清理
            timeout_cid = str(payload.get("conversationId") or "").strip()
            if timeout_cid and self._active_conversation_id == timeout_cid:
                self._active_conversation_id = None
                self._conversation_partner_id = None
            elif not timeout_cid:
                self._active_conversation_id = None
                self._conversation_partner_id = None

            # 2) 构造系统提示文本
            reason = str(payload.get("reason") or "").strip()
            if reason == "invite_timeout":
                text = "【系统提示】对方发起的对话邀请因长时间未响应，已自动失效，你已恢复空闲状态。"
            elif reason == "idle_timeout":
                text = "【系统提示】由于双方长时间未发言，对话已因尴尬的沉默被系统自动结束。"
            else:
                text = "【系统提示】对话已超时结束。"

            # 3) 复用现有 message event 构造路径，commit_event 唤醒 LLM 破除死锁
            session_id = self._build_session_id(event_type, payload)

            abm = AstrBotMessage()
            abm.self_id = str(self._player_id or self.client_self_id)
            abm.sender = MessageMember(
                user_id="system",
                nickname="AstrTown",
            )
            abm.type = MessageType.GROUP_MESSAGE
            abm.session_id = session_id
            abm.message_id = event_id or new_id("evt")
            abm.message = [Plain(text=text)]
            abm.message_str = text
            abm.raw_message = data
            abm.timestamp = int(time.time())

            event = AstrTownMessageEvent(
                message_str=text,
                message_obj=abm,
                platform_meta=self._metadata,
                session_id=session_id,
                adapter=self,
                world_event=data,
            )
            event.set_extra("event_type", event_type)
            event.set_extra("event_id", event_id)
            if timeout_cid:
                event.set_extra("conversation_id", timeout_cid)

            event.is_wake = True
            event.is_at_or_wake_command = True

            try:
                self.commit_event(event)
            except Exception as e:
                logger.error(
                    f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}",
                    exc_info=True,
                )
                return

            logger.info(
                f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._agent_id}"
            )

            try:
                await self._send_event_ack(event_id)
            except Exception as e:
                logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
            return

        if event_type == "social.relationship_proposed":
            proposer_id = str(payload.get("proposerId") or "").strip()
            proposer_name = str(payload.get("proposerName") or proposer_id or "未知玩家").strip() or "未知玩家"
            status = str(payload.get("status") or "").strip() or "未知关系"
            text = (
                f"【系统提示】玩家 {proposer_name} 刚向你申请确立 {status} 关系。"
                "请结合你的潜意识好感度和人设，决定是否调用 respond_relationship 工具接受，并回复对方。"
            )

            session_id = self._build_session_id(event_type, payload)

            abm = AstrBotMessage()
            abm.self_id = str(self._player_id or self.client_self_id)
            abm.sender = MessageMember(
                user_id="system",
                nickname="AstrTown",
            )
            abm.type = MessageType.GROUP_MESSAGE
            abm.session_id = session_id
            abm.message_id = event_id or new_id("evt")
            abm.message = [Plain(text=text)]
            abm.message_str = text
            abm.raw_message = data
            abm.timestamp = int(time.time())

            event = AstrTownMessageEvent(
                message_str=text,
                message_obj=abm,
                platform_meta=self._metadata,
                session_id=session_id,
                adapter=self,
                world_event=data,
            )
            event.set_extra("event_type", event_type)
            event.set_extra("event_id", event_id)
            if proposer_id:
                event.set_extra("proposer_id", proposer_id)
            event.set_extra("relationship_status", status)
            event.set_extra("priority", "high")

            # 高优先级系统事件：始终唤醒 LLM 决策。
            event.is_wake = True
            event.is_at_or_wake_command = True

            try:
                self.commit_event(event)
            except Exception as e:
                logger.error(
                    f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}",
                    exc_info=True,
                )
                return

            logger.info(
                f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._agent_id}"
            )

            try:
                await self._send_event_ack(event_id)
            except Exception as e:
                logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
            return

        if event_type == "social.relationship_responded":
            responder_id = str(payload.get("responderId") or "").strip() or "未知玩家"
            status = str(payload.get("status") or "").strip() or "未知关系"
            accept_raw = payload.get("accept")
            accepted = bool(accept_raw) if isinstance(accept_raw, bool) else False
            decision_text = "接受" if accepted else "拒绝"
            text = (
                f"【系统提示】[{responder_id}] 已{decision_text}了你提出的 [{status}] 关系申请。"
                "请根据这个结果做出反应。"
            )

            session_id = self._build_session_id(event_type, payload)

            abm = AstrBotMessage()
            abm.self_id = str(self._player_id or self.client_self_id)
            abm.sender = MessageMember(
                user_id="system",
                nickname="AstrTown",
            )
            abm.type = MessageType.GROUP_MESSAGE
            abm.session_id = session_id
            abm.message_id = event_id or new_id("evt")
            abm.message = [Plain(text=text)]
            abm.message_str = text
            abm.raw_message = data
            abm.timestamp = int(time.time())

            event = AstrTownMessageEvent(
                message_str=text,
                message_obj=abm,
                platform_meta=self._metadata,
                session_id=session_id,
                adapter=self,
                world_event=data,
            )
            event.set_extra("event_type", event_type)
            event.set_extra("event_id", event_id)
            event.set_extra("responder_id", responder_id)
            event.set_extra("relationship_status", status)
            event.set_extra("relationship_accept", accepted)
            event.set_extra("priority", "high")

            # 高优先级系统事件：始终唤醒 LLM 决策。
            event.is_wake = True
            event.is_at_or_wake_command = True

            try:
                self.commit_event(event)
            except Exception as e:
                logger.error(
                    f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}",
                    exc_info=True,
                )
                return

            logger.info(
                f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._agent_id}"
            )

            try:
                await self._send_event_ack(event_id)
            except Exception as e:
                logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
            return

        # 修复1：邀请策略（在最开始读取配置）
        if event_type == "conversation.invited":
            invite_mode = str(self.config.get("astrtown_invite_decision_mode", "auto_accept") or "auto_accept").strip()
            conversation_id = str(payload.get("conversationId") or "").strip()
            inviter_id = str(payload.get("inviterId") or "").strip()
            inviter_name = str(payload.get("inviterName") or inviter_id or "").strip()
            owner_id = str(self._player_id or "").strip()
            if inviter_id and inviter_id != owner_id:
                self._conversation_partner_id = inviter_id

            logger.info(
                f"[AstrTown] 收到邀请事件: decision_mode={invite_mode}, conversationId={conversation_id}, inviter={inviter_name}"
            )

            if invite_mode == "auto_accept":
                # 不走 LLM：直接发 command.accept_invite（仅传 conversationId），不 commit_event。
                if not conversation_id:
                    logger.warning("[AstrTown] 自动接受邀请失败: conversationId 为空")
                else:
                    logger.info(
                        f"[AstrTown] 自动接受邀请: conversationId={conversation_id}, inviter={inviter_name}"
                    )
                    try:
                        await self.send_command(
                            "command.accept_invite",
                            {"conversationId": conversation_id},
                        )
                        # 方案C：自动接受邀请成功后，记录活跃对话。
                        self._active_conversation_id = conversation_id
                    except Exception as e:
                        logger.error(f"[AstrTown] 自动接受邀请发送命令失败: {e}", exc_info=True)

                # ACK 语义保持闭环：即使不走 LLM，也要 ACK。
                try:
                    await self._send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

        # queue_refill 事件唤醒门控
        if event_type == "agent.queue_refill_requested":
            refill_enabled = bool(self.config.get("astrtown_refill_wake_enabled", True))
            if not refill_enabled:
                try:
                    await self._send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

            min_interval = self._safe_int(
                self.config.get("astrtown_refill_min_wake_interval_sec", 30),
                30,
                "astrtown_refill_min_wake_interval_sec",
                "platform_config",
            )

            now = time.time()
            elapsed = now - float(self._last_refill_wake_ts or 0.0)
            should_wake = elapsed >= float(min_interval)

            # 方案B：当门控条件不满足时，不要每次都打印；
            # - 状态变化时打印（True<->False 或首次进入门控）
            # - 或节流：每 min_interval 秒最多打印一次，并附带累计跳过次数
            if should_wake:
                if self._queue_refill_gate_skip_count > 0:
                    logger.debug(
                        f"[AstrTown] queue_refill 门控: elapsed={elapsed:.1f}s, min_interval={min_interval}s, wake=True"
                        f" (skipped={self._queue_refill_gate_skip_count})"
                    )
                    self._queue_refill_gate_skip_count = 0
                self._queue_refill_gate_last_should_wake = True
            else:
                self._queue_refill_gate_skip_count += 1
                last_state = self._queue_refill_gate_last_should_wake
                state_changed_or_first = last_state is None or last_state is True
                allow_throttle_log = (
                    now - float(self._queue_refill_gate_last_log_ts or 0.0)
                ) >= float(min_interval)
                if state_changed_or_first or allow_throttle_log:
                    logger.debug(
                        f"[AstrTown] queue_refill 门控: elapsed={elapsed:.1f}s, min_interval={min_interval}s, wake=False"
                        f" (skipped={self._queue_refill_gate_skip_count})"
                    )
                    self._queue_refill_gate_last_log_ts = now
                    self._queue_refill_gate_last_should_wake = False

            if not should_wake:
                try:
                    await self._send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

            self._last_refill_wake_ts = now

        # 过期事件处理：阶段 1 将过期事件包装为 action.finished success=False result.reason='expired'
        if event_type == "action.finished":
            result_raw = payload.get("result")
            result = result_raw if isinstance(result_raw, dict) else {}
            if payload.get("success") is False and result.get("reason") == "expired":
                logger.warning(f"指令已过期被丢弃: {payload}")

        text = self._format_event_to_text(event_type, payload)
        session_id = self._build_session_id(event_type, payload)

        # 方案C：adapter 侧兜底计数器
        sid = session_id
        self._session_event_count[sid] = self._session_event_count.get(sid, 0) + 1
        count = self._session_event_count[sid]

        try:
            max_rounds = int(self.config.get("astrtown_max_context_rounds", 50) or 50)
        except (TypeError, ValueError):
            max_rounds = 50

        threshold = max_rounds * 2
        if threshold > 0 and count > threshold:
            logger.warning(
                f"[AstrTown] 会话 {sid} 累积事件 {count} 条，已超过阈值，建议检查上下文压缩配置"
            )
            # 重置计数器，避免重复刷屏
            self._session_event_count[sid] = 0

        abm = AstrBotMessage()
        abm.self_id = str(self._player_id or self.client_self_id)
        msg_payload_raw = payload.get("message")
        msg_payload = msg_payload_raw if isinstance(msg_payload_raw, dict) else {}
        if event_type == "conversation.message":
            speaker_id = msg_payload.get("speakerId")
            speaker_name = speaker_id
        elif event_type == "conversation.invited":
            speaker_id = payload.get("inviterId")
            speaker_name = payload.get("inviterName") or speaker_id
        else:
            speaker_id = None
            speaker_name = None
        abm.sender = MessageMember(
            user_id=str(speaker_id or "system"),
            nickname=str(speaker_name or "AstrTown"),
        )
        abm.type = MessageType.GROUP_MESSAGE
        abm.session_id = session_id
        abm.message_id = event_id or new_id("evt")
        abm.message = [Plain(text=text)]
        abm.message_str = text
        abm.raw_message = data
        abm.timestamp = int(time.time())

        event = AstrTownMessageEvent(
            message_str=text,
            message_obj=abm,
            platform_meta=self._metadata,
            session_id=session_id,
            adapter=self,
            world_event=data,
        )

        event.set_extra("event_type", event_type)
        event.set_extra("event_id", event_id)
        conversation_id = str(payload.get("conversationId") or "")
        if conversation_id:
            event.set_extra("conversation_id", conversation_id)

        # 修复1-B：llm_judge 模式下，显式注入 conversation_id，避免依赖 LLM 从上下文提取。
        if event_type == "conversation.invited":
            invite_mode = str(self.config.get("astrtown_invite_decision_mode", "auto_accept") or "auto_accept").strip()
            if invite_mode == "llm_judge" and conversation_id:
                event.set_extra("conversation_id", conversation_id)

        # 这些事件本质是“外部世界推送”，默认触发 LLM；queue_refill 已在上方门控。
        event.is_wake = True
        event.is_at_or_wake_command = True

        try:
            self.commit_event(event)
        except Exception as e:
            logger.error(f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}", exc_info=True)
            return

        logger.info(f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._agent_id}")

        # Ack only after event is successfully committed.
        try:
            await self._send_event_ack(event_id)
        except Exception as e:
            logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")

    async def _send_event_ack(self, event_id: str) -> None:
        if not event_id:
            return
        ws = self._ws
        if ws is None:
            return
        ack = {
            "type": "event.ack",
            "id": new_id("ack"),
            "timestamp": int(time.time() * 1000),
            "payload": {"eventId": event_id},
        }
        try:
            await ws.send(json.dumps(ack, ensure_ascii=False))
        except ConnectionClosed:
            return
        except Exception:
            return

        # 方案B：ACK 已发送保持功能不变，但降低日志噪声。
        # 这里采用“时间窗口汇总”采样：每 10s 最多打印一次，并附带窗口内 ACK 数量。
        now = time.time()
        self._event_ack_sample_count += 1
        if (now - float(self._event_ack_last_log_ts or 0.0)) >= 10.0:
            count = int(self._event_ack_sample_count)
            self._event_ack_sample_count = 0
            self._event_ack_last_log_ts = now
            # astrbot.logger 不一定支持 trace，这里用 debug 但采样输出，避免刷屏。
            logger.debug(f"[AstrTown] 事件ACK已发送(采样): lastEventId={event_id}, count={count}/10s")

    def _pick_first_non_empty_str(self, payload: dict[str, Any], keys: list[str]) -> str:
        for key in keys:
            value = payload.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        return ""

    def _extract_conversation_messages(self, payload: dict[str, Any]) -> list[dict[str, str]]:
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

    def _build_reflection_prompt(
        self,
        conversation_id: str,
        other_player_name: str,
        other_player_id: str,
        messages: list[dict[str, str]],
    ) -> str:
        role_name = str(self._player_name or "该角色").strip() or "该角色"
        target_name = other_player_name.strip() or other_player_id.strip() or "对方"

        transcript_lines: list[str] = []
        for idx, msg in enumerate(messages, start=1):
            speaker = str(msg.get("speakerId") or "unknown").strip() or "unknown"
            content = str(msg.get("content") or "").strip()
            if not content:
                continue
            transcript_lines.append(f"{idx}. {speaker}: {content}")
        transcript = "\n".join(transcript_lines) if transcript_lines else "（无可用对话记录）"

        return (
            f"请作为 {role_name} 的潜意识反思刚刚结束的对话。\n"
            "1. 提炼对话摘要 (summary) 和重要性 (importance 1-10)\n"
            f"2. 评估对 {target_name} 的单向好感度变动 (-10到10) 以及最新的主观感受标签 "
            "(affinity_label，如'觉得很吵','暗生情愫')\n"
            "请严格输出 JSON：{\"summary\":\"...\",\"importance\":N,\"affinity_delta\":N,"
            "\"affinity_label\":\"...\"}\n"
            "只输出 JSON，不要输出任何额外文字。\n\n"
            f"对话ID：{conversation_id or 'unknown'}\n"
            f"对方ID：{other_player_id or 'unknown'}\n"
            f"对方名字：{target_name}\n"
            "对话记录：\n"
            f"{transcript}"
        )

    @staticmethod
    def _to_int_in_range(value: Any, minimum: int, maximum: int, default: int) -> int:
        try:
            if isinstance(value, bool):
                raise ValueError("bool is not valid number")
            num = int(float(value))
        except Exception:
            return default
        if num < minimum:
            return minimum
        if num > maximum:
            return maximum
        return num

    def _normalize_reflection_response(self, llm_result: Any) -> dict[str, Any] | None:
        parsed: dict[str, Any] | None = None

        if isinstance(llm_result, dict):
            parsed = llm_result
        elif hasattr(llm_result, "completion_text"):
            llm_text = str(getattr(llm_result, "completion_text") or "").strip()
            if llm_text:
                try:
                    obj = json.loads(llm_text)
                except Exception:
                    start = llm_text.find("{")
                    end = llm_text.rfind("}")
                    if start >= 0 and end > start:
                        try:
                            obj = json.loads(llm_text[start : end + 1])
                        except Exception:
                            obj = None
                    else:
                        obj = None
                if isinstance(obj, dict):
                    parsed = obj
        elif isinstance(llm_result, str):
            text = llm_result.strip()
            if not text:
                return None
            try:
                obj = json.loads(text)
            except Exception:
                start = text.find("{")
                end = text.rfind("}")
                if start < 0 or end <= start:
                    return None
                try:
                    obj = json.loads(text[start : end + 1])
                except Exception:
                    return None
            if isinstance(obj, dict):
                parsed = obj

        if not isinstance(parsed, dict):
            return None

        summary = str(parsed.get("summary") or "").strip()
        if not summary:
            summary = "一次对话结束后的潜意识反思。"

        importance = self._to_int_in_range(parsed.get("importance"), 1, 10, 5)
        affinity_delta = self._to_int_in_range(parsed.get("affinity_delta"), -10, 10, 0)
        affinity_label = str(parsed.get("affinity_label") or "").strip() or "暂无明显变化"

        return {
            "summary": summary,
            "importance": importance,
            "affinity_delta": affinity_delta,
            "affinity_label": affinity_label,
        }

    @staticmethod
    def _parse_json_array(text: str) -> list[Any] | None:
        raw = text.strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except Exception:
            start = raw.find("[")
            end = raw.rfind("]")
            if start < 0 or end <= start:
                return None
            try:
                parsed = json.loads(raw[start : end + 1])
            except Exception:
                return None

        if isinstance(parsed, list):
            return parsed
        return None

    def _normalize_higher_reflection_response(self, llm_result: Any) -> list[str]:
        parsed: list[Any] | None = None

        if isinstance(llm_result, list):
            parsed = llm_result
        elif isinstance(llm_result, dict):
            insights = llm_result.get("insights")
            if isinstance(insights, list):
                parsed = insights
            elif "insight" in llm_result:
                parsed = [llm_result]
        elif hasattr(llm_result, "completion_text"):
            text = str(getattr(llm_result, "completion_text") or "").strip()
            parsed = self._parse_json_array(text)
        elif isinstance(llm_result, str):
            parsed = self._parse_json_array(llm_result)

        if not isinstance(parsed, list):
            return []

        normalized: list[str] = []
        for item in parsed:
            if isinstance(item, dict):
                insight = str(item.get("insight") or "").strip()
            elif isinstance(item, str):
                insight = item.strip()
            else:
                insight = ""
            if insight:
                normalized.append(insight)

        deduped: list[str] = []
        seen: set[str] = set()
        for insight in normalized:
            if insight in seen:
                continue
            seen.add(insight)
            deduped.append(insight)
            if len(deduped) >= 5:
                break

        return deduped

    async def _post_json_best_effort(
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

    async def _async_reflect_on_conversation(
        self,
        conversation_id: str,
        other_player_name: str,
        other_player_id: str,
        messages: list[dict[str, str]],
    ) -> None:
        try:
            if self._stop_event.is_set():
                return

            if aiohttp is None:
                logger.warning("[AstrTown] aiohttp not available; skip async reflection")
                return

            callback = get_reflection_llm_callback()
            if callback is None:
                logger.warning("[AstrTown] reflection llm callback not set; skip async reflection")
                return

            owner_id = str(self._player_id or "").strip()
            agent_id = str(self._agent_id or "").strip()
            if not owner_id or not agent_id:
                logger.warning("[AstrTown] missing binding(agent/player); skip async reflection")
                return

            prompt = self._build_reflection_prompt(
                conversation_id=conversation_id,
                other_player_name=other_player_name,
                other_player_id=other_player_id,
                messages=messages,
            )

            llm_result = await callback(prompt)
            normalized = self._normalize_reflection_response(llm_result)
            if normalized is None:
                logger.warning(
                    f"[AstrTown] reflection llm 返回不可解析 JSON，conversationId={conversation_id}"
                )
                return

            summary = str(normalized["summary"])
            importance = self._to_int_in_range(normalized.get("importance"), 1, 10, 5)
            affinity_delta = self._to_int_in_range(normalized.get("affinity_delta"), -10, 10, 0)
            affinity_label = str(normalized.get("affinity_label") or "暂无明显变化").strip()

            base = self._build_http_base_url()
            if not base:
                logger.warning("[AstrTown] invalid gateway base url; skip async reflection")
                return

            headers = {"Authorization": f"Bearer {self.token}"}
            timeout = aiohttp.ClientTimeout(total=8.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                memory_body = {
                    "agentId": agent_id,
                    "playerId": owner_id,
                    "summary": summary,
                    "importance": importance,
                    "memoryType": "conversation",
                }
                memory_ok = await self._post_json_best_effort(
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
                affinity_ok = await self._post_json_best_effort(
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

            self._importance_accumulator += float(importance)
            if self._importance_accumulator >= self._reflection_threshold:
                if not self._stop_event.is_set():
                    higher_reflect_task = asyncio.create_task(
                        self._async_higher_reflection(),
                        name=f"astrtown_higher_reflect_{owner_id or 'unknown'}",
                    )
                    self._track_background_task(higher_reflect_task)
                self._importance_accumulator = 0.0
        except Exception as e:
            logger.warning(
                f"[AstrTown] async reflection task failed: conversationId={conversation_id}, error={e}"
            )

    async def _async_higher_reflection(self) -> None:
        try:
            if self._stop_event.is_set():
                return

            if aiohttp is None:
                logger.warning("[AstrTown] aiohttp not available; skip higher reflection")
                return

            callback = get_reflection_llm_callback()
            if callback is None:
                logger.warning("[AstrTown] reflection llm callback not set; skip higher reflection")
                return

            owner_id = str(self._player_id or "").strip()
            agent_id = str(self._agent_id or "").strip()
            if not owner_id or not agent_id:
                logger.warning("[AstrTown] missing binding(agent/player); skip higher reflection")
                return

            role_name = str(self._player_name or "").strip() or owner_id or "该角色"
            world_id = str(self._world_id or "").strip()
            if not world_id:
                logger.warning("[AstrTown] missing binding(world); skip higher reflection")
                return

            base = self._build_http_base_url()
            if not base:
                logger.warning("[AstrTown] invalid gateway base url; skip higher reflection")
                return

            headers = {"Authorization": f"Bearer {self.token}"}
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
            insights = self._normalize_higher_reflection_response(llm_result)
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
                    ok = await self._post_json_best_effort(
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

    def _build_session_id(self, _event_type: str, payload: dict[str, Any]) -> str:
        player_id = str(self._player_id or payload.get("playerId") or "").strip()
        world_id = str(self._world_id or payload.get("worldId") or "").strip()

        # 修复2：sid world/NPC 二态，受 AstrBot 全局 unique_session 控制（来自 platform_settings）。
        unique_session = bool(getattr(self, "settings", {}) and self.settings.get("unique_session", False))

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

    def _build_http_base_url(self) -> str:
        """将 adapter 配置的 gateway_url 统一规范为 http/https base url。

        兼容用户误配为 ws/wss 的情况（例如复制了 ws 地址）。
        """
        base = (self.gateway_url or "").strip().rstrip("/")
        if not base:
            return ""

        try:
            p = urlparse(base)
            if p.scheme == "wss":
                return p._replace(scheme="https").geturl().rstrip("/")
            if p.scheme == "ws":
                return p._replace(scheme="http").geturl().rstrip("/")
        except Exception:
            # best-effort fallback
            return base

        return base

    async def search_world_memory(self, query_text: str, limit: int = 3) -> list[dict[str, Any]]:
        """向 Gateway 发起“世界记忆检索”请求。

        Returns:
            list[dict]: Gateway 返回的 memories 列表，元素形如 {description, importance}。
            任何异常/非 2xx 响应都会返回空列表。
        """
        if aiohttp is None:
            logger.warning("[AstrTown] aiohttp not available; world memory search skipped")
            return []

        q = (query_text or "").strip()
        if not q:
            return []

        base = self._build_http_base_url()
        if not base:
            return []

        url = base + "/api/bot/memory/search"
        headers = {"Authorization": f"Bearer {self.token}"}
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
 
    async def _sync_persona_to_gateway(self, player_id: str | None) -> None:
        """Best-effort sync persona description to Gateway -> Convex.

        Never logs token / request body.
        """
        if aiohttp is None:
            logger.warning("[AstrTown] aiohttp not available; skip persona sync")
            return

        pid = (player_id or "").strip()
        if not pid:
            logger.debug("[AstrTown] skip persona sync: playerId empty")
            return

        description = get_persona_data()
        if not description:
            logger.info("[AstrTown] persona description empty; skip sync")
            return

        url = self.gateway_url.rstrip("/") + "/api/bot/description/update"
        headers = {"Authorization": f"Bearer {self.token}"}
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

    def _format_event_to_text(self, event_type: str, payload: dict[str, Any]) -> str:
        if event_type == "conversation.message":
            message_raw = payload.get("message")
            message = message_raw if isinstance(message_raw, dict) else {}
            speaker_id = message.get("speakerId")
            content = message.get("content")
            conversation_id = str(payload.get("conversationId") or "")
            return (
                "[AstrTown] 你收到了对话消息\n"
                f"对话ID：{conversation_id}\n"
                f"发言者ID：{speaker_id}\n"
                f"对方说：{content}\n\n"
                "【强制规则】你收到了来自对方的对话消息。你**必须**进行以下操作之一：\n"
                f"1. 使用 say(conversation_id=\"{conversation_id}\", text=\"你的回复内容\") 直接回复对方。\n"
                "2. 如果你需要离开对话，**必须先用 say(text=\"告别语\", leave_after=True)** 说一句话再离开，不能无声地离开。\n"
                "禁止：不能只调用 set_activity 或 leave_conversation 而不先对对方说话。"
            )

        if event_type == "conversation.started":
            return (
                "[AstrTown] 你开始了新的对话\n"
                f"对话ID：{payload.get('conversationId')}\n"
                f"参与者：{payload.get('otherParticipantIds')}"
            )

        if event_type == "conversation.invited":
            conversation_id = str(payload.get("conversationId") or "")
            return (
                "[AstrTown] 你收到了对话邀请\n"
                f"conversation_id：{conversation_id}\n"
                f"对话ID：{conversation_id}\n"
                f"邀请者ID：{payload.get('inviterId')}\n"
                f"邀请者昵称：{payload.get('inviterName')}\n"
                "你必须二选一立刻响应邀请：\n"
                "- 接受：调用工具 accept_invite(conversation_id)\n"
                "- 拒绝：调用工具 reject_invite(conversation_id)\n"
                "不要只输出文字，必须通过工具调用完成响应。"
            )

        if event_type == "social.relationship_proposed":
            proposer_name = payload.get("proposerName") or payload.get("proposerId") or "未知玩家"
            status = payload.get("status") or "未知关系"
            return (
                f"【系统提示】玩家 {proposer_name} 刚向你申请确立 {status} 关系。"
                "请结合你的潜意识好感度和人设，决定是否调用 respond_relationship 工具接受，并回复对方。"
            )

        if event_type == "social.relationship_responded":
            responder_id = payload.get("responderId") or "未知玩家"
            status = payload.get("status") or "未知关系"
            accept = payload.get("accept")
            decision = "接受" if accept is True else "拒绝"
            return f"【系统提示】[{responder_id}] 已{decision}了你提出的 [{status}] 关系申请。请根据这个结果做出反应。"

        if event_type == "agent.state_changed":
            pos = payload.get("position") or {}
            nearby_players_raw = payload.get("nearbyPlayers")
            nearby_players = nearby_players_raw if isinstance(nearby_players_raw, list) else []

            formatted_nearby_players: list[str] = []
            for item in nearby_players:
                if not isinstance(item, dict):
                    continue

                name = str(item.get("name") or item.get("id") or "未知角色").strip() or "未知角色"
                other_pos_raw = item.get("position")
                other_pos = other_pos_raw if isinstance(other_pos_raw, dict) else {}

                # nearbyPlayers 来自后端位置快照，这里按当前位置计算直线距离，便于外部 LLM 决策是否发起对话。
                distance_text = ""
                try:
                    dx = float(other_pos.get("x", 0)) - float(pos.get("x", 0))
                    dy = float(other_pos.get("y", 0)) - float(pos.get("y", 0))
                    distance_text = f"{((dx * dx + dy * dy) ** 0.5):.2f}"
                except (TypeError, ValueError):
                    distance_text = ""

                if distance_text:
                    formatted_nearby_players.append(f"{name}（距离{distance_text}）")
                else:
                    formatted_nearby_players.append(name)

            nearby_text = "、".join(formatted_nearby_players) if formatted_nearby_players else "暂无"
            return (
                "[AstrTown] 你的状态发生变化\n"
                f"状态：{payload.get('state')}\n"
                f"位置：({pos.get('x')},{pos.get('y')})\n"
                f"是否在对话中：{payload.get('inConversation')}\n"
                f"当前活动：{payload.get('currentActivity')}\n"
                f"附近的角色：{nearby_text}"
            )

        if event_type == "action.finished":
            return (
                "[AstrTown] 你的动作已完成\n"
                f"动作类型：{payload.get('actionType')}\n"
                f"是否成功：{payload.get('success')}\n"
                f"动作结果：{payload.get('result')}"
            )

        # fallback: avoid injecting the full payload into context.
        payload_str = json.dumps(payload, ensure_ascii=False)
        if len(payload_str) > 500:
            payload_str = payload_str[:500] + "..."
        return f"[AstrTown] 收到事件 {event_type}：{payload_str}"
