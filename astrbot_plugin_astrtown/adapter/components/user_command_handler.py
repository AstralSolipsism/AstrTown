from __future__ import annotations

import asyncio
from typing import Any

try:
    import aiohttp
except Exception:  # pragma: no cover
    aiohttp = None

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent

from ..astrtown_adapter import AstrTownAdapter
from .player_binding import PlayerBindingManager


class UserCommandHandler:
    def __init__(self, adapter: AstrTownAdapter | None, player_binding: PlayerBindingManager) -> None:
        self.adapter = adapter
        self.player_binding = player_binding
        self._context = getattr(adapter, "context", None)

    def set_context(self, context: Any) -> None:
        self._context = context

    async def handle_help(self, event: AstrMessageEvent) -> str:
        return (
            "AstrTown 用户指令：\n"
            "/astrtown help - 查看帮助\n"
            "/astrtown bind [角色ID|list] - 绑定角色或查看可绑定角色列表\n"
            "/astrtown unbind - 解除当前绑定\n"
            "/astrtown whoami - 查看当前绑定\n"
            "/astrtown status - 查看角色状态\n"
            "/astrtown nearby - 查看附近角色\n"
            "/astrtown relations - 查看社交关系快照\n"
            "/astrtown do <行动描述> - 安排角色行动\n"
            "/astrtown talk <目标角色ID> <内容> - 发起/继续对话\n"
            "/astrtown cancel - 取消当前行动"
        )

    async def handle_bind(self, event: AstrMessageEvent, player_id: str) -> str:
        pid = str(player_id or "").strip()
        if not pid or pid.lower() == "list":
            return self._format_registered_role_list()

        target_adapter = self._find_adapter_by_player_id(pid)
        if target_adapter is None:
            return (
                f"绑定失败：未找到角色ID为 {pid} 的 AstrTown 连接。\n"
                f"{self._format_registered_role_list()}"
            )

        session_key = event.unified_msg_origin
        platform_id = str(target_adapter.meta().id or "").strip()
        if not platform_id:
            return "绑定失败：目标 AstrTown 连接缺少平台ID。"

        self.player_binding.bind(session_key, platform_id, pid)

        bind_info = target_adapter.get_binding()
        player_name = str(bind_info.get("playerName") or "").strip()
        if player_name:
            return f"绑定成功：当前会话已绑定角色 {player_name}（{pid}，连接: {platform_id}）。"

        return f"绑定成功：当前会话已绑定角色 {pid}（连接: {platform_id}）。"

    async def handle_unbind(self, event: AstrMessageEvent) -> str:
        session_key = event.unified_msg_origin
        binding = self.player_binding.get_binding(session_key)
        if not binding:
            return "当前会话尚未绑定角色，无需解绑。"

        self.player_binding.unbind(session_key)
        return "解绑成功：当前会话已清除角色绑定。"

    async def handle_whoami(self, event: AstrMessageEvent) -> str:
        binding = self.player_binding.get_binding(event.unified_msg_origin)
        if not binding:
            return "当前会话尚未绑定角色。请先使用 /astrtown bind <角色ID>。"

        player_id = binding.get("player_id", "")
        platform_id = binding.get("platform_id", "")
        adapter = self._resolve_bound_adapter(binding)
        player_name = ""
        if adapter is not None:
            player_name = str(adapter.get_binding().get("playerName") or "").strip()

        if player_name:
            return f"当前绑定：角色 {player_name}（{player_id}），连接 {platform_id}。"
        return f"当前绑定：角色 {player_id}，连接 {platform_id}。"

    async def handle_status(self, event: AstrMessageEvent) -> str:
        binding, adapter, err = self._require_bound_adapter(event)
        if err:
            return err

        assert binding is not None and adapter is not None
        bind_info = adapter.get_binding()
        snapshot_raw = getattr(adapter, "_latest_state_snapshot", None)
        snapshot = snapshot_raw if isinstance(snapshot_raw, dict) else {}

        state = str(snapshot.get("state") or "未知").strip() or "未知"
        activity = snapshot.get("currentActivity")
        in_conversation = snapshot.get("inConversation")
        position_raw = snapshot.get("position")
        position = position_raw if isinstance(position_raw, dict) else {}

        player_name = str(bind_info.get("playerName") or "").strip()
        player_id = str(binding.get("player_id") or "").strip()

        lines = []
        if player_name:
            lines.append(f"角色：{player_name}（{player_id}）")
        else:
            lines.append(f"角色：{player_id}")
        lines.append(f"状态：{state}")

        if isinstance(activity, dict):
            desc = str(activity.get("description") or "").strip()
            emoji = str(activity.get("emoji") or "").strip()
            if desc or emoji:
                lines.append(f"当前行动：{emoji} {desc}".strip())

        if isinstance(in_conversation, bool):
            lines.append(f"是否在对话中：{'是' if in_conversation else '否'}")

        x = position.get("x")
        y = position.get("y")
        area_name = str(position.get("areaName") or "").strip()
        if x is not None and y is not None:
            if area_name:
                lines.append(f"位置：({x}, {y}) · 区域 {area_name}")
            else:
                lines.append(f"位置：({x}, {y})")

        if not snapshot:
            lines.append("提示：尚未收到状态快照，请等待世界事件同步后重试。")

        return "\n".join(lines)

    async def handle_nearby(self, event: AstrMessageEvent) -> str:
        _binding, adapter, err = self._require_bound_adapter(event)
        if err:
            return err

        assert adapter is not None
        snapshot_raw = getattr(adapter, "_latest_state_snapshot", None)
        snapshot = snapshot_raw if isinstance(snapshot_raw, dict) else {}
        nearby = snapshot.get("nearbyPlayers")

        if not isinstance(nearby, list):
            return "暂无附近角色信息（尚未收到状态快照）。"

        items: list[str] = []
        for item in nearby:
            if not isinstance(item, dict):
                continue
            pid = str(item.get("id") or item.get("playerId") or "").strip()
            if not pid:
                continue
            name = str(item.get("name") or pid).strip() or pid
            pos_raw = item.get("position")
            pos = pos_raw if isinstance(pos_raw, dict) else {}
            x = pos.get("x")
            y = pos.get("y")
            if x is not None and y is not None:
                items.append(f"- {name}（{pid}）@ ({x}, {y})")
            else:
                items.append(f"- {name}（{pid}）")

        if not items:
            return "附近暂无可见角色。"

        return "附近角色：\n" + "\n".join(items)

    async def handle_relations(self, event: AstrMessageEvent) -> str:
        binding, adapter, err = self._require_bound_adapter(event)
        if err:
            return err

        assert binding is not None and adapter is not None
        if aiohttp is None:
            return "关系查询失败：运行环境缺少 aiohttp 依赖。"

        owner_id = str(binding.get("player_id") or "").strip()
        target_id = str(getattr(adapter, "_conversation_partner_id", "") or "").strip()
        if not target_id:
            return "暂无关系查询目标：当前未检测到活跃对话对象。"

        base_url = ""
        build_http_base_url = getattr(adapter, "_build_http_base_url", None)
        if callable(build_http_base_url):
            try:
                base_url = str(build_http_base_url() or "").strip().rstrip("/")
            except Exception:
                base_url = ""

        token = str(getattr(adapter, "token", "") or "").strip()
        world_id = str(getattr(adapter, "_world_id", "") or "").strip()
        if not base_url or not token:
            return "关系查询失败：目标 AstrTown 连接尚未就绪。"

        query = {
            "worldId": world_id,
            "ownerId": owner_id,
            "targetId": target_id,
        }
        url = f"{base_url}/api/bot/social/state"
        headers = {"Authorization": f"Bearer {token}"}

        try:
            timeout = aiohttp.ClientTimeout(total=2.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, params=query, headers=headers) as resp:
                    if resp.status < 200 or resp.status >= 300:
                        text = ""
                        try:
                            text = await resp.text()
                        except Exception:
                            text = ""
                        logger.warning(f"[AstrTown] relations 查询失败 http={resp.status}: {text[:200]}")
                        return "关系查询失败：网关返回异常状态。"

                    data = await resp.json()
                    if not isinstance(data, dict):
                        return "关系查询失败：返回数据格式不正确。"
        except asyncio.TimeoutError:
            return "关系查询超时，请稍后重试。"
        except Exception as e:
            logger.warning(f"[AstrTown] relations 查询异常: {e}")
            return "关系查询失败：网络异常。"

        relationship_raw = data.get("relationship")
        relationship = relationship_raw if isinstance(relationship_raw, dict) else {}
        affinity_raw = data.get("affinity")
        affinity = affinity_raw if isinstance(affinity_raw, dict) else {}

        status = str(relationship.get("status") or "stranger").strip() or "stranger"
        score = affinity.get("score", 0)
        label = str(affinity.get("label") or "感觉一般").strip() or "感觉一般"

        return (
            f"关系快照（目标 {target_id}）：\n"
            f"- 公开关系：{status}\n"
            f"- 私下好感：{score}/100（{label}）"
        )

    async def handle_do(self, event: AstrMessageEvent, action: str) -> str:
        _binding, adapter, err = self._require_bound_adapter(event)
        if err:
            return err

        assert adapter is not None
        description = str(action or "").strip()
        if not description:
            return "参数错误：请提供行动描述，例如 /astrtown do 去酒馆打工。"

        try:
            ack = await adapter.send_command(
                "command.set_activity",
                {
                    "description": description,
                    "emoji": "",
                    "duration": 30000,
                },
            )
        except Exception as e:
            logger.warning(f"[AstrTown] do 指令发送失败: {e}")
            return "行动下发失败：网络或连接异常。"

        return self._format_command_ack("行动已下发", ack)

    async def handle_talk(self, event: AstrMessageEvent, target: str, content: str) -> str:
        _binding, adapter, err = self._require_bound_adapter(event)
        if err:
            return err

        assert adapter is not None
        target_player_id = str(target or "").strip()
        text = str(content or "").strip()
        if not target_player_id or not text:
            return "参数错误：用法 /astrtown talk <目标角色ID> <内容>。"

        active_conversation_id = str(getattr(adapter, "_active_conversation_id", "") or "").strip()
        partner_id = str(getattr(adapter, "_conversation_partner_id", "") or "").strip()

        if active_conversation_id and partner_id and partner_id == target_player_id:
            try:
                ack = await adapter.send_command(
                    "command.say",
                    {
                        "conversationId": active_conversation_id,
                        "text": text,
                        "leaveAfter": False,
                    },
                )
            except Exception as e:
                logger.warning(f"[AstrTown] talk(say) 失败: {e}")
                return "发送对话失败：网络或连接异常。"

            return self._format_command_ack("对话内容已发送", ack)

        try:
            ack = await adapter.send_command(
                "command.invite",
                {"targetPlayerId": target_player_id},
            )
        except Exception as e:
            logger.warning(f"[AstrTown] talk(invite) 失败: {e}")
            return "发起对话失败：网络或连接异常。"

        return self._format_command_ack(
            "已发起对话邀请（会话建立后请再次发送内容）",
            ack,
        )

    async def handle_cancel(self, event: AstrMessageEvent) -> str:
        _binding, adapter, err = self._require_bound_adapter(event)
        if err:
            return err

        assert adapter is not None
        try:
            ack = await adapter.send_command(
                "command.do_something",
                {
                    "actionType": "go_home_and_sleep",
                    "args": {},
                },
            )
        except Exception as e:
            logger.warning(f"[AstrTown] cancel 指令发送失败: {e}")
            return "取消行动失败：网络或连接异常。"

        return self._format_command_ack("取消指令已下发", ack)

    def _find_adapter_by_player_id(self, player_id: str) -> Any | None:
        pid = str(player_id or "").strip()
        if not pid:
            return None

        for inst in self._iter_registered_adapters():
            get_binding = getattr(inst, "get_binding", None)
            if not callable(get_binding):
                continue

            try:
                bind_raw = get_binding()
            except Exception:
                continue

            bind = bind_raw if isinstance(bind_raw, dict) else {}
            inst_player_id = str(bind.get("playerId") or "").strip()
            if inst_player_id and inst_player_id == pid:
                return inst

        return None

    def _iter_registered_adapters(self) -> list[Any]:
        adapters: list[Any] = []
        seen: set[int] = set()

        context = self._context
        if context is not None:
            platform_manager = getattr(context, "platform_manager", None)
            platform_insts = getattr(platform_manager, "platform_insts", None) if platform_manager is not None else None
            if isinstance(platform_insts, list):
                for inst in platform_insts:
                    if not self._is_astrtown_adapter_instance(inst):
                        continue
                    inst_key = id(inst)
                    if inst_key in seen:
                        continue
                    seen.add(inst_key)
                    adapters.append(inst)

        if self.adapter is not None and self._is_astrtown_adapter_instance(self.adapter):
            current_key = id(self.adapter)
            if current_key not in seen:
                seen.add(current_key)
                adapters.append(self.adapter)

        return adapters

    @staticmethod
    def _is_astrtown_adapter_instance(inst: Any) -> bool:
        if inst is None:
            return False

        meta_func = getattr(inst, "meta", None)
        get_binding = getattr(inst, "get_binding", None)
        if not callable(meta_func) or not callable(get_binding):
            return False

        try:
            meta = meta_func()
        except Exception:
            return False

        meta_name = str(getattr(meta, "name", "") or "").strip()
        return meta_name == "astrtown"

    def _collect_registered_roles(self) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
        ready_roles: list[dict[str, str]] = []
        pending_platforms: list[dict[str, str]] = []

        for inst in self._iter_registered_adapters():
            platform_id = ""
            try:
                platform_id = str(inst.meta().id or "").strip()
            except Exception:
                platform_id = ""

            bind: dict[str, Any] = {}
            get_binding = getattr(inst, "get_binding", None)
            if callable(get_binding):
                try:
                    bind_raw = get_binding()
                    if isinstance(bind_raw, dict):
                        bind = bind_raw
                except Exception:
                    bind = {}

            player_id = str(bind.get("playerId") or "").strip()
            player_name = str(bind.get("playerName") or "").strip()

            if player_id:
                ready_roles.append(
                    {
                        "platform_id": platform_id,
                        "player_id": player_id,
                        "player_name": player_name,
                    }
                )
                continue

            pending_platforms.append(
                {
                    "platform_id": platform_id or "未配置平台ID",
                }
            )

        return ready_roles, pending_platforms

    def _format_registered_role_list(self) -> str:
        ready_roles, pending_platforms = self._collect_registered_roles()
        if not ready_roles and not pending_platforms:
            return "当前没有可绑定角色。请确认 AstrTown 适配器已加载。"

        lines: list[str] = []
        if ready_roles:
            lines.extend(
                [
                    "可绑定角色列表：",
                    "使用方式：/astrtown bind <角色ID>",
                ]
            )
            for item in ready_roles:
                player_name = item.get("player_name") or "未命名角色"
                player_id = item.get("player_id") or ""
                platform_id = item.get("platform_id") or "未配置平台ID"
                lines.append(f"- {player_name} | 角色ID: {player_id} | 连接: {platform_id}")
        else:
            lines.append("当前暂无可直接绑定的角色ID。")

        if pending_platforms:
            lines.append("")
            lines.append("以下 AstrTown 连接已加载但尚未完成鉴权（playerId 为空）：")
            for item in pending_platforms:
                platform_id = item.get("platform_id") or "未配置平台ID"
                lines.append(f"- 连接: {platform_id}")
            lines.append("请检查 astrtown_token，并确认日志出现 authenticated agentId=... playerId=...。")

        return "\n".join(lines)

    def _resolve_bound_adapter(self, binding: dict[str, str]) -> Any | None:
        platform_id = str(binding.get("platform_id") or "").strip()
        if not platform_id:
            return None

        context = self._context
        if context is not None:
            get_platform_inst = getattr(context, "get_platform_inst", None)
            if callable(get_platform_inst):
                inst = get_platform_inst(platform_id)
                if self._is_astrtown_adapter_instance(inst):
                    return inst

        if self.adapter is not None:
            current_id = str(self.adapter.meta().id or "").strip()
            if (
                current_id
                and current_id == platform_id
                and self._is_astrtown_adapter_instance(self.adapter)
            ):
                return self.adapter

        return None

    def _match_current_adapter_by_player_id(self, player_id: str) -> AstrTownAdapter | None:
        if self.adapter is None:
            return None

        bind = self.adapter.get_binding()
        current_player_id = str(bind.get("playerId") or "").strip()
        if current_player_id and current_player_id == player_id:
            return self.adapter

        return None

    def _require_bound_adapter(
        self,
        event: AstrMessageEvent,
    ) -> tuple[dict[str, str] | None, AstrTownAdapter | None, str | None]:
        binding = self.player_binding.get_binding(event.unified_msg_origin)
        if not binding:
            return None, None, "当前会话尚未绑定角色。请先使用 /astrtown bind <角色ID>。"

        adapter = self._resolve_bound_adapter(binding)
        if adapter is None:
            return binding, None, "当前绑定的 AstrTown 连接不可用。请重新绑定或检查平台配置。"

        return binding, adapter, None

    @staticmethod
    def _format_command_ack(prefix: str, ack: Any) -> str:
        if not isinstance(ack, dict):
            return f"{prefix}：已提交（未获取 ACK 详情）。"

        ok = bool(ack.get("ok"))
        status = str(ack.get("status") or "").strip().lower()
        command_id = str(ack.get("commandId") or "").strip()
        reason = str(ack.get("reason") or "").strip()

        if ok:
            if command_id:
                return f"{prefix}：已受理（commandId={command_id}）。注意：受理不代表已执行完成。"
            return f"{prefix}：已受理。注意：受理不代表已执行完成。"

        if status == "debounced":
            retry_after_ms_raw = ack.get("retryAfterMs")
            if isinstance(retry_after_ms_raw, (int, float)):
                retry_after_sec = max(0.0, float(retry_after_ms_raw) / 1000.0)
                return f"{prefix}失败：发言过快，已触发防抖，请约 {retry_after_sec:.1f} 秒后重试。"
            return f"{prefix}失败：发言过快，已触发防抖，请稍后重试。"

        if status == "timeout":
            if command_id:
                return f"{prefix}失败：命令已发送但 ACK 超时（commandId={command_id}），请稍后确认状态。"
            return f"{prefix}失败：命令已发送但 ACK 超时，请稍后确认状态。"

        if reason:
            return f"{prefix}失败：{reason}"
        return f"{prefix}失败：网关拒绝或未返回原因。"