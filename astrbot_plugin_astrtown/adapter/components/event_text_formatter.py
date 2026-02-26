from __future__ import annotations

import json
from typing import Any

from .contracts import AdapterHostProtocol


class EventTextFormatter:
    """世界事件文本格式化服务。"""

    def __init__(self, host: AdapterHostProtocol) -> None:
        self._host = host

    def format_event_to_text(
        self,
        event_type: str,
        payload: dict[str, Any],
        world_context: dict[str, Any] | None = None,
    ) -> str:
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

        if event_type == "agent.queue_refill_requested":
            lines = [
                "[AstrTown] 行动规划窗口：外控行动队列需要补充。",
                "这不是普通事件通知，请你立即规划下一步行动。",
                "可用工具：invite(targetPlayerId)、move_to(destination)、say(content)。",
                "请结合附近角色主动发起社交互动，优先考虑接近并对话/邀请。",
                "严禁将事件元数据字段（agentId/playerId/requestId/reason）当作动作参数。",
                "请规划 1~3 个具体行动并按顺序填充队列。",
            ]

            if isinstance(world_context, dict):
                self_ctx_raw = world_context.get("self")
                self_ctx = self_ctx_raw if isinstance(self_ctx_raw, dict) else {}
                pos_raw = self_ctx.get("position")
                pos = pos_raw if isinstance(pos_raw, dict) else {}

                conversation_raw = world_context.get("conversation")
                conversation = conversation_raw if isinstance(conversation_raw, dict) else {}
                participants_raw = conversation.get("participants")
                participants = participants_raw if isinstance(participants_raw, list) else []

                queue_raw = world_context.get("queue")
                queue_ctx = queue_raw if isinstance(queue_raw, dict) else {}

                nearby_raw = world_context.get("nearbyPlayers")
                nearby = nearby_raw if isinstance(nearby_raw, list) else []

                x = pos.get("x")
                y = pos.get("y")
                area_name = pos.get("areaName")
                position_text = "未知"
                if x is not None or y is not None:
                    position_text = f"({x},{y})"
                if isinstance(area_name, str) and area_name.strip():
                    position_text += f" / 区域：{area_name.strip()}"

                participants_text = "、".join(str(x) for x in participants if str(x).strip()) or "无"

                nearby_text_parts: list[str] = []
                for item in nearby:
                    if not isinstance(item, dict):
                        continue
                    player_id = str(item.get("playerId") or "").strip() or "未知ID"
                    name = str(item.get("name") or player_id).strip() or player_id
                    item_pos_raw = item.get("position")
                    item_pos = item_pos_raw if isinstance(item_pos_raw, dict) else {}
                    distance = item.get("distance")

                    item_pos_text = "未知"
                    if item_pos.get("x") is not None or item_pos.get("y") is not None:
                        item_pos_text = f"({item_pos.get('x')},{item_pos.get('y')})"

                    distance_text = ""
                    if isinstance(distance, (int, float)):
                        distance_text = f"，距离≈{distance:.2f}"

                    nearby_text_parts.append(f"{name}[{player_id}]@{item_pos_text}{distance_text}")

                nearby_text = "；".join(nearby_text_parts) if nearby_text_parts else "暂无"

                last_dequeued_ago = queue_ctx.get("lastDequeuedAgoSec")
                if isinstance(last_dequeued_ago, (int, float)):
                    last_dequeued_ago_text = f"{last_dequeued_ago:.1f}s"
                else:
                    last_dequeued_ago_text = "未知"

                lines.extend(
                    [
                        "【世界状态摘要】",
                        f"- 自身位置：{position_text}",
                        f"- 自身状态：{self_ctx.get('state') or '未知'}",
                        f"- 当前活动：{self_ctx.get('currentActivity') or '未知'}",
                        f"- 是否在对话中：{bool(conversation.get('inConversation'))}",
                        f"- 对话参与者：{participants_text}",
                        f"- 附近角色：{nearby_text}",
                        f"- 队列剩余：{queue_ctx.get('remaining')}",
                        f"- 上次出队距今：{last_dequeued_ago_text}",
                    ]
                )

            return "\n".join(lines)

        if event_type == "action.finished":
            return (
                "[AstrTown] 你的动作已完成\n"
                f"动作类型：{payload.get('actionType')}\n"
                f"是否成功：{payload.get('success')}\n"
                f"动作结果：{payload.get('result')}"
            )

        # 兜底分支：避免将完整 payload 直接注入上下文。
        payload_str = json.dumps(payload, ensure_ascii=False)
        if len(payload_str) > 500:
            payload_str = payload_str[:500] + "..."
        return f"[AstrTown] 收到事件 {event_type}：{payload_str}"
