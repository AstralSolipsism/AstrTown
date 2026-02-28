from __future__ import annotations

import asyncio
import time
from math import sqrt
from typing import Any

from astrbot import logger
from astrbot.api.message_components import Plain
from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType

from ..astrtown_event import AstrTownMessageEvent
from ..id_util import new_id
from ..protocol import WorldEvent
from .contracts import AdapterHostProtocol
from .event_ack_sender import EventAckSender
from .event_text_formatter import EventTextFormatter
from .reflection_orchestrator import ReflectionOrchestrator
from .session_context import SessionContextService


class WorldEventDispatcher:
    """世界事件分发服务。"""

    def __init__(
        self,
        host: AdapterHostProtocol,
        ack_sender: EventAckSender,
        session_ctx: SessionContextService,
        text_formatter: EventTextFormatter,
        reflection_orch: ReflectionOrchestrator,
    ) -> None:
        self._host: Any = host
        self._ack_sender = ack_sender
        self._session_ctx = session_ctx
        self._text_formatter = text_formatter
        self._reflection_orch = reflection_orch

        # queue_refill 门控：记录上次处理的 requestId，用于识别新请求。
        self._last_refill_request_id: str | None = None

    @staticmethod
    def _safe_int(value: Any, default: int, field: str, msg_type: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            logger.warning(f"[AstrTown] invalid {field} for {msg_type}: {value!r}, using {default}")
            return default

    @staticmethod
    def _to_float(value: Any) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _distance_sort_key(item: dict[str, Any]) -> float:
        distance = item.get("distance")
        if isinstance(distance, (int, float)):
            return float(distance)
        return float("inf")

    @staticmethod
    def _build_position_dict(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            return {}
        result: dict[str, Any] = {
            "x": raw.get("x"),
            "y": raw.get("y"),
        }

        # 兼容不同后端字段命名，尽量提取区域信息用于提示词。
        area_name = raw.get("areaName")
        if not area_name:
            area_name = raw.get("area")
        if not area_name:
            area_name = raw.get("region")
        if not area_name:
            area_name = raw.get("regionName")
        if isinstance(area_name, str) and area_name.strip():
            result["areaName"] = area_name.strip()

        return result

    def _build_queue_refill_world_context(self, payload: dict[str, Any]) -> dict[str, Any]:
        # 优先使用 queue_refill 事件 payload；缺失时回退到最近一次 state_changed 快照。
        snapshot_raw = getattr(self._host, "_latest_state_snapshot", None)
        snapshot = snapshot_raw if isinstance(snapshot_raw, dict) else {}

        position = self._build_position_dict(payload.get("position"))
        if not position:
            position = self._build_position_dict(snapshot.get("position"))
        self_x = self._to_float(position.get("x"))
        self_y = self._to_float(position.get("y"))

        nearby_raw = payload.get("nearbyPlayers")
        if not isinstance(nearby_raw, list):
            nearby_raw = snapshot.get("nearbyPlayers")
        nearby_players = nearby_raw if isinstance(nearby_raw, list) else []
        nearby_items: list[dict[str, Any]] = []
        for item in nearby_players:
            if not isinstance(item, dict):
                continue
            player_id = str(item.get("id") or item.get("playerId") or "").strip()
            if not player_id:
                continue
            name = str(item.get("name") or player_id).strip() or player_id
            other_pos = self._build_position_dict(item.get("position"))

            distance = None
            other_x = self._to_float(other_pos.get("x"))
            other_y = self._to_float(other_pos.get("y"))
            if self_x is not None and self_y is not None and other_x is not None and other_y is not None:
                distance = sqrt((other_x - self_x) ** 2 + (other_y - self_y) ** 2)

            nearby_items.append(
                {
                    "playerId": player_id,
                    "name": name,
                    "position": other_pos,
                    "distance": distance,
                }
            )

        nearby_items.sort(key=self._distance_sort_key)

        now_ms = int(time.time() * 1000)
        last_dequeued_raw = payload.get("lastDequeuedAt")
        last_dequeued_ago_sec = None
        if isinstance(last_dequeued_raw, (int, float)):
            # Convex 侧 now 来自 Date.now()，这里按 ms 口径计算时间差。
            last_dequeued_ago_sec = max(0.0, (now_ms - float(last_dequeued_raw)) / 1000.0)

        in_conversation = bool(self._host._active_conversation_id)
        snapshot_in_conversation = snapshot.get("inConversation")
        if isinstance(snapshot_in_conversation, bool):
            in_conversation = in_conversation or snapshot_in_conversation
        participants: list[str] = []
        owner_id = str(self._host._player_id or "").strip()
        if owner_id:
            participants.append(owner_id)
        partner_id = str(self._host._conversation_partner_id or "").strip()
        if partner_id and partner_id not in participants:
            participants.append(partner_id)

        world_context = {
            "self": {
                "state": snapshot.get("state"),
                "currentActivity": snapshot.get("currentActivity"),
                "position": position,
            },
            "conversation": {
                "inConversation": in_conversation,
                "participants": participants,
            },
            "nearbyPlayers": nearby_items[:5],
            "queue": {
                "remaining": payload.get("remaining"),
                "lastDequeuedAt": last_dequeued_raw,
                "lastDequeuedAgoSec": last_dequeued_ago_sec,
                "nowTimestamp": now_ms,
            },
        }
        return world_context

    async def handle_world_event(self, data: dict[str, Any]) -> None:
        if self._host._stop_event.is_set():
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
            active_cid = str(self._host._active_conversation_id or "").strip()
            if active_cid and incoming_cid and incoming_cid != active_cid:
                logger.info(
                    f"[AstrTown] 过滤 conversation.message: incoming={incoming_cid} active={active_cid} agentId={self._host._agent_id}"
                )
                try:
                    await self._ack_sender.send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

        if event_type == "conversation.message":
            message_raw = payload.get("message")
            message = message_raw if isinstance(message_raw, dict) else {}
            speaker_id = str(message.get("speakerId") or "").strip()
            owner_id = str(self._host._player_id or "").strip()
            if speaker_id and speaker_id != owner_id:
                self._host._conversation_partner_id = speaker_id

        # 维护最近一次 agent.state_changed 快照，供 queue_refill 提示词注入世界状态使用。
        # 该事件仅用于状态同步，不应触发 LLM：更新快照后仅 ACK 并返回。
        if event_type == "agent.state_changed":
            self._host._latest_state_snapshot = {
                "state": payload.get("state"),
                "position": self._build_position_dict(payload.get("position")),
                "nearbyPlayers": payload.get("nearbyPlayers") if isinstance(payload.get("nearbyPlayers"), list) else [],
                "inConversation": payload.get("inConversation"),
                "currentActivity": payload.get("currentActivity"),
                "updatedAt": int(time.time() * 1000),
            }
            logger.debug(
                f"[AstrTown] state_changed 仅更新快照，不唤醒 LLM: eventId={event_id}, agentId={self._host._agent_id}"
            )
            try:
                await self._ack_sender.send_event_ack(event_id)
            except Exception as e:
                logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
            return

        # 方案C：活跃对话状态更新（invited/started/ended/timeout）
        if event_type == "conversation.ended":
            ended_cid = str(payload.get("conversationId") or "").strip()
            if ended_cid and self._host._active_conversation_id == ended_cid:
                self._host._active_conversation_id = None
                self._host._conversation_partner_id = None
            elif not ended_cid:
                # 没有 conversationId 时保守清空，避免残留。
                self._host._active_conversation_id = None
                self._host._conversation_partner_id = None

            other_player_id = SessionContextService.pick_first_non_empty_str(
                payload,
                [
                    "otherPlayerId",
                    "other_player_id",
                    "otherParticipantId",
                    "targetPlayerId",
                    "counterpartId",
                ],
            )
            other_player_name = SessionContextService.pick_first_non_empty_str(
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
            messages = SessionContextService.extract_conversation_messages(payload)

            # 关键约束：反思任务必须异步后台执行，不能阻塞事件主流程。
            reflect_task = asyncio.create_task(
                self._reflection_orch.async_reflect_on_conversation(
                    conversation_id=ended_cid,
                    other_player_name=other_player_name,
                    other_player_id=other_player_id,
                    messages=messages,
                ),
                name=f"astrtown_reflect_{ended_cid or event_id or 'unknown'}",
            )
            self._host._track_background_task(reflect_task)

        if event_type == "conversation.started":
            started_cid = str(payload.get("conversationId") or "").strip()
            if started_cid:
                self._host._active_conversation_id = started_cid

            owner_id = str(self._host._player_id or "").strip()
            partner_id = ""
            other_ids = payload.get("otherParticipantIds")
            if isinstance(other_ids, list):
                for item in other_ids:
                    candidate = str(item or "").strip()
                    if candidate and candidate != owner_id:
                        partner_id = candidate
                        break

            if not partner_id:
                partner_id = SessionContextService.pick_first_non_empty_str(
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
                self._host._conversation_partner_id = partner_id

        if event_type == "conversation.timeout":
            # 1) 状态清理
            timeout_cid = str(payload.get("conversationId") or "").strip()
            if timeout_cid and self._host._active_conversation_id == timeout_cid:
                self._host._active_conversation_id = None
                self._host._conversation_partner_id = None
            elif not timeout_cid:
                self._host._active_conversation_id = None
                self._host._conversation_partner_id = None

            # 2) 构造系统提示文本
            reason = str(payload.get("reason") or "").strip()
            if reason == "invite_timeout":
                text = "【系统提示】对方发起的对话邀请因长时间未响应，已自动失效，你已恢复空闲状态。"
            elif reason == "idle_timeout":
                text = "【系统提示】由于双方长时间未发言，对话已因尴尬的沉默被系统自动结束。"
            else:
                text = "【系统提示】对话已超时结束。"

            # 3) 复用现有 message event 构造路径，commit_event 唤醒 LLM 破除死锁
            session_id = self._session_ctx.build_session_id(event_type, payload)

            abm = AstrBotMessage()
            abm.self_id = str(self._host._player_id or self._host.client_self_id)
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
                platform_meta=self._host._metadata,
                session_id=session_id,
                adapter=self._host,
                world_event=data,
            )
            event.set_extra("event_type", event_type)
            event.set_extra("event_id", event_id)
            if timeout_cid:
                event.set_extra("conversation_id", timeout_cid)

            event.is_wake = True
            event.is_at_or_wake_command = True

            try:
                self._host.commit_event(event)
            except Exception as e:
                logger.error(
                    f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}",
                    exc_info=True,
                )
                return

            logger.info(
                f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._host._agent_id}"
            )

            try:
                await self._ack_sender.send_event_ack(event_id)
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

            session_id = self._session_ctx.build_session_id(event_type, payload)

            abm = AstrBotMessage()
            abm.self_id = str(self._host._player_id or self._host.client_self_id)
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
                platform_meta=self._host._metadata,
                session_id=session_id,
                adapter=self._host,
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
                self._host.commit_event(event)
            except Exception as e:
                logger.error(
                    f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}",
                    exc_info=True,
                )
                return

            logger.info(
                f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._host._agent_id}"
            )

            try:
                await self._ack_sender.send_event_ack(event_id)
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

            session_id = self._session_ctx.build_session_id(event_type, payload)

            abm = AstrBotMessage()
            abm.self_id = str(self._host._player_id or self._host.client_self_id)
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
                platform_meta=self._host._metadata,
                session_id=session_id,
                adapter=self._host,
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
                self._host.commit_event(event)
            except Exception as e:
                logger.error(
                    f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}",
                    exc_info=True,
                )
                return

            logger.info(
                f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._host._agent_id}"
            )

            try:
                await self._ack_sender.send_event_ack(event_id)
            except Exception as e:
                logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
            return

        # 修复1：邀请策略（在最开始读取配置）
        if event_type == "conversation.invited":
            invite_mode = str(self._host.config.get("astrtown_invite_decision_mode", "auto_accept") or "auto_accept").strip()
            conversation_id = str(payload.get("conversationId") or "").strip()
            inviter_id = str(payload.get("inviterId") or "").strip()
            inviter_name = str(payload.get("inviterName") or inviter_id or "").strip()
            owner_id = str(self._host._player_id or "").strip()
            if inviter_id and inviter_id != owner_id:
                self._host._conversation_partner_id = inviter_id

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
                        await self._host.send_command(
                            "command.accept_invite",
                            {"conversationId": conversation_id},
                        )
                        # 方案C：自动接受邀请成功后，记录活跃对话。
                        self._host._active_conversation_id = conversation_id
                    except Exception as e:
                        logger.error(f"[AstrTown] 自动接受邀请发送命令失败: {e}", exc_info=True)

                # ACK 语义保持闭环：即使不走 LLM，也要 ACK。
                try:
                    await self._ack_sender.send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

        # queue_refill 事件唤醒门控
        if event_type == "agent.queue_refill_requested":
            refill_enabled = bool(self._host.config.get("astrtown_refill_wake_enabled", True))
            if not refill_enabled:
                try:
                    await self._ack_sender.send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

            min_interval = self._safe_int(
                self._host.config.get("astrtown_refill_min_wake_interval_sec", 10),
                10,
                "astrtown_refill_min_wake_interval_sec",
                "platform_config",
            )

            now = time.time()
            elapsed = now - float(self._host._last_refill_wake_ts or 0.0)

            request_id = str(payload.get("requestId") or "").strip()
            reason = str(payload.get("reason") or "").strip().lower()
            is_new_request = bool(request_id) and request_id != self._last_refill_request_id
            is_empty_reason = reason == "empty"
            force_wake = elapsed >= float(min_interval) * 3.0

            # 三条件门控（按优先级）：
            # 1) 长时间未唤醒（>= 3 * min_interval）时强制唤醒一次。
            # 2) 新 requestId + empty：也受 min_interval 约束，避免高频连续唤醒。
            # 3) 其余情况按 min_interval 节流。
            if force_wake:
                should_wake = True
                gate_reason = "force_after_long_idle"
            elif is_new_request and is_empty_reason:
                should_wake = elapsed >= float(min_interval)
                gate_reason = "new_empty_request" if should_wake else "new_empty_request_throttled"
            else:
                should_wake = elapsed >= float(min_interval)
                gate_reason = "interval"

            # 方案B：当门控条件不满足时，不要每次都打印；
            # - 状态变化时打印（True<->False 或首次进入门控）
            # - 或节流：每 min_interval 秒最多打印一次，并附带累计跳过次数
            if should_wake:
                if self._host._queue_refill_gate_skip_count > 0 or gate_reason != "interval":
                    logger.debug(
                        f"[AstrTown] queue_refill 门控: elapsed={elapsed:.1f}s, min_interval={min_interval}s, wake=True,"
                        f" gate={gate_reason}, requestId={request_id or '-'}, reason={reason or '-'}"
                        f" (skipped={self._host._queue_refill_gate_skip_count})"
                    )
                    self._host._queue_refill_gate_skip_count = 0
                self._host._queue_refill_gate_last_should_wake = True
            else:
                self._host._queue_refill_gate_skip_count += 1
                last_state = self._host._queue_refill_gate_last_should_wake
                state_changed_or_first = last_state is None or last_state is True
                allow_throttle_log = (
                    now - float(self._host._queue_refill_gate_last_log_ts or 0.0)
                ) >= float(min_interval)
                if state_changed_or_first or allow_throttle_log:
                    logger.debug(
                        f"[AstrTown] queue_refill 门控: elapsed={elapsed:.1f}s, min_interval={min_interval}s, wake=False,"
                        f" gate={gate_reason}, requestId={request_id or '-'}, reason={reason or '-'}"
                        f" (skipped={self._host._queue_refill_gate_skip_count})"
                    )
                    self._host._queue_refill_gate_last_log_ts = now
                    self._host._queue_refill_gate_last_should_wake = False

            if request_id:
                self._last_refill_request_id = request_id

            if not should_wake:
                try:
                    await self._ack_sender.send_event_ack(event_id)
                except Exception as e:
                    logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
                return

            self._host._last_refill_wake_ts = now

        # action.finished 仅用于状态记录，不应触发 LLM 唤醒。
        if event_type == "action.finished":
            result_raw = payload.get("result")
            result = result_raw if isinstance(result_raw, dict) else {}
            if payload.get("success") is False and result.get("reason") == "expired":
                logger.warning(f"指令已过期被丢弃: {payload}")

            try:
                await self._ack_sender.send_event_ack(event_id)
            except Exception as e:
                logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
            return

        world_context: dict[str, Any] | None = None
        if event_type == "agent.queue_refill_requested":
            try:
                world_context = self._build_queue_refill_world_context(payload)
            except Exception as e:
                # 世界状态注入失败时降级，仍保持 queue_refill 专用提示词分支。
                logger.warning(f"[AstrTown] 构建 queue_refill 世界状态摘要失败: {e}")
                world_context = None

        text = self._text_formatter.format_event_to_text(event_type, payload, world_context)
        session_id = self._session_ctx.build_session_id(event_type, payload)

        # 方案C：adapter 侧兜底计数器
        sid = session_id
        self._host._session_event_count[sid] = self._host._session_event_count.get(sid, 0) + 1
        count = self._host._session_event_count[sid]

        try:
            max_rounds = int(self._host.config.get("astrtown_max_context_rounds", 50) or 50)
        except (TypeError, ValueError):
            max_rounds = 50

        threshold = max_rounds * 2
        if threshold > 0 and count > threshold:
            logger.warning(
                f"[AstrTown] 会话 {sid} 累积事件 {count} 条，已超过阈值，建议检查上下文压缩配置"
            )
            # 重置计数器，避免重复刷屏
            self._host._session_event_count[sid] = 0

        abm = AstrBotMessage()
        abm.self_id = str(self._host._player_id or self._host.client_self_id)
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
            platform_meta=self._host._metadata,
            session_id=session_id,
            adapter=self._host,
            world_event=data,
        )

        event.set_extra("event_type", event_type)
        event.set_extra("event_id", event_id)
        conversation_id = str(payload.get("conversationId") or "")
        if conversation_id:
            event.set_extra("conversation_id", conversation_id)

        # 修复1-B：llm_judge 模式下，显式注入 conversation_id，避免依赖 LLM 从上下文提取。
        if event_type == "conversation.invited":
            invite_mode = str(self._host.config.get("astrtown_invite_decision_mode", "auto_accept") or "auto_accept").strip()
            if invite_mode == "llm_judge" and conversation_id:
                event.set_extra("conversation_id", conversation_id)

        # 这些事件本质是“外部世界推送”，默认触发 LLM；queue_refill 已在上方门控。
        event.is_wake = True
        event.is_at_or_wake_command = True

        try:
            self._host.commit_event(event)
        except Exception as e:
            logger.error(f"[AstrTown] commit_event failed for eventId={event_id} type={event_type}: {e}", exc_info=True)
            return

        logger.info(f"[AstrTown] 已接收世界事件: eventId={event_id}, eventType={event_type}, agentId={self._host._agent_id}")

        # 仅在事件成功提交后再发送 ACK。
        try:
            await self._ack_sender.send_event_ack(event_id)
        except Exception as e:
            logger.warning(f"[AstrTown] send event ack failed for eventId={event_id}: {e}")
