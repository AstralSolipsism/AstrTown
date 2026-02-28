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

        now_ms = int(time.time() * 1000)

        # command.say 防抖：在发包前拦截，避免连续抢话。
        if msg_type == "command.say":
            conversation_id = str(payload.get("conversationId") or "").strip()
            if conversation_id:
                agent_id = str(self._host._agent_id or "").strip() or "unknown"
                state_key = f"{agent_id}:{conversation_id}"
                debounce_window_ms = 1200
                duplicate_window_ms = 3000
                try:
                    debounce_window_ms = int(
                        self._host.config.get("astrtown_say_debounce_window_ms", debounce_window_ms)
                        or debounce_window_ms
                    )
                except (TypeError, ValueError):
                    debounce_window_ms = 1200
                try:
                    duplicate_window_ms = int(
                        self._host.config.get("astrtown_say_duplicate_window_ms", duplicate_window_ms)
                        or duplicate_window_ms
                    )
                except (TypeError, ValueError):
                    duplicate_window_ms = 3000

                text = str(payload.get("text") or "")
                prev = self._host._say_debounce_state.get(state_key)
                if isinstance(prev, dict):
                    prev_sent_at = prev.get("sentAtMs")
                    prev_text = str(prev.get("text") or "")
                    if isinstance(prev_sent_at, int):
                        elapsed = now_ms - prev_sent_at
                        hit_window = debounce_window_ms > 0 and elapsed < debounce_window_ms
                        hit_duplicate = duplicate_window_ms > 0 and elapsed < duplicate_window_ms and text == prev_text
                        if hit_window or hit_duplicate:
                            retry_after = max(0, (debounce_window_ms if hit_window else duplicate_window_ms) - elapsed)
                            logger.info(
                                "[AstrTown] 命中 say 防抖: "
                                f"agentId={agent_id}, conversationId={conversation_id}, elapsedMs={elapsed}, retryAfterMs={retry_after}"
                            )
                            return {
                                "ok": False,
                                "status": "debounced",
                                "conversationId": conversation_id,
                                "retryAfterMs": retry_after,
                            }

                self._host._say_debounce_state[state_key] = {
                    "sentAtMs": now_ms,
                    "text": text,
                }

                # 轻量清理，避免状态无限增长。
                gc_before = now_ms - max(duplicate_window_ms * 2, 10_000)
                for key, item in list(self._host._say_debounce_state.items()):
                    sent_at = item.get("sentAtMs") if isinstance(item, dict) else None
                    if isinstance(sent_at, int) and sent_at < gc_before:
                        self._host._say_debounce_state.pop(key, None)

        command_id = new_id("cmd")
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

        ack_timeout_sec = 10.0
        try:
            ack_timeout_sec = float(self._host.config.get("astrtown_command_ack_timeout_sec", ack_timeout_sec) or ack_timeout_sec)
        except (TypeError, ValueError):
            ack_timeout_sec = 10.0

        try:
            ack_payload = await asyncio.wait_for(fut, timeout=max(0.1, ack_timeout_sec))
        except asyncio.TimeoutError:
            self._host._pending_commands.pop(command_id, None)
            tombstone_ttl_sec = 120.0
            try:
                tombstone_ttl_sec = float(
                    self._host.config.get("astrtown_late_ack_tombstone_ttl_sec", tombstone_ttl_sec) or tombstone_ttl_sec
                )
            except (TypeError, ValueError):
                tombstone_ttl_sec = 120.0
            self._host._recent_timed_out_commands[command_id] = time.time() + max(1.0, tombstone_ttl_sec)
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
