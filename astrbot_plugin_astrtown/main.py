from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

from astrbot.api.event import AstrMessageEvent, MessageEventResult, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.config.default import CONFIG_METADATA_2
from astrbot.core.star.register.star_handler import register_on_llm_request
from astrbot.core.star.star_tools import StarTools

from astrbot.api import logger

from .adapter.astrtown_event import AstrTownMessageEvent
from .adapter.components.memory_injector import MemoryInjector
from .adapter.components.player_binding import PlayerBindingManager
from .adapter.components.user_command_handler import UserCommandHandler

try:
    import aiohttp
except Exception:  # pragma: no cover
    aiohttp = None


@register("astrbot-plugin-astrtown", "AstrTown", "AstrTown 平台适配插件，通过 Gateway 让 AstrBot 控制 NPC 并接收事件", "0.1.0", "https://github.com/your-org/astrbot_plugin_astrtown")
class AstrTownPlugin(Star):
    _registered: bool = False

    @register_on_llm_request(priority=100)
    async def _astrtown_trim_context_and_inject_memory(self, event: AstrMessageEvent, request) -> None:
        """在 LLM 请求前裁剪上下文，并以“阅后即焚”的方式注入相关世界记忆。"""

        adapter = getattr(event, "adapter", None)
        is_astrtown_event = isinstance(event, AstrTownMessageEvent)
        is_astrtown_adapter = bool(
            adapter
            and getattr(adapter, "meta", None)
            and getattr(adapter.meta(), "name", None) == "astrtown"
        )
        is_astrtown = is_astrtown_event or is_astrtown_adapter

        # P0：AstrTown 事件禁止使用 AstrBot Cron 工具，避免行动规划泄露到 future task。
        if is_astrtown:
            func_tool = getattr(request, "func_tool", None)
            remove_tool = getattr(func_tool, "remove_tool", None)
            if callable(remove_tool):
                remove_tool("create_future_task")
                remove_tool("delete_future_task")
                remove_tool("list_future_tasks")

        contexts = getattr(request, "contexts", None)
        if not isinstance(contexts, list):
            return

        def _msg_get(msg: Any, key: str) -> Any:
            if isinstance(msg, dict):
                return msg.get(key)
            return getattr(msg, key, None)

        def _msg_role(msg: Any) -> str | None:
            role = _msg_get(msg, "role")
            return role if isinstance(role, str) else None

        def _msg_content(msg: Any) -> Any:
            return _msg_get(msg, "content")

        def _msg_tool_calls(msg: Any) -> Any:
            return _msg_get(msg, "tool_calls")

        try:
            max_rounds = int(self.config.get("astrtown_max_context_rounds", 50) or 50)
        except (TypeError, ValueError):
            max_rounds = 50

        if max_rounds <= 0:
            return

        max_messages = max_rounds * 2

        # 将原始 contexts 分离，绝不直接修改原始对象的内容
        system_msgs = [m for m in contexts if _msg_role(m) == "system"]
        non_system_msgs = [m for m in contexts if _msg_role(m) != "system"]
        kept_non_system = non_system_msgs[-max_messages:]

        injected_memory_context: Context | None = None
        injected_bound_memory_context: dict[str, str] | None = None
        injected_social_context: Context | None = None

        if is_astrtown and adapter is not None and kept_non_system:
            # 提取用户最新发言作为 Query
            last_user_msg = next(
                (
                    _msg_content(m)
                    for m in reversed(kept_non_system)
                    if _msg_role(m) == "user" and isinstance(_msg_content(m), str)
                ),
                "",
            )

            # 限制查询长度，防止无意义单个字触发无效检索
            if last_user_msg and len(last_user_msg.strip()) > 2:
                try:
                    # 熔断保护：2秒查不到就放弃
                    memories = await asyncio.wait_for(
                        adapter.search_world_memory(last_user_msg, limit=3),
                        timeout=2.0,
                    )
                    if memories:
                        mem_str = "\n".join(
                            [f"- {m['description']} (重要度:{m['importance']})" for m in memories]
                        )
                        injection_text = (
                            "\n\n[💡 潜意识背景信息：以下是你脑海中浮现的近期世界记忆片段]\n"
                            f"{mem_str}\n"
                            "(内部心理活动指令：如果上述记忆与当前对话切实相关，请自然地在回复中表现出你记得；"
                            "如果毫无关联，请完全忽略。绝对不要提及'系统提示'或'我刚想起'！)"
                        )
                        injected_memory_context = Context(role="system", content=injection_text)
                except asyncio.TimeoutError:
                    logger.warning("AstrTown: 记忆检索超时(>2s)，已降级为无记忆普通回复。")
                except Exception as e:
                    logger.error(f"AstrTown: 注入记忆异常: {e}")

        if (not is_astrtown) and kept_non_system:
            try:
                bound_memory_text = await self.memory_injector.build_memory_prompt(event, kept_non_system)
                if bound_memory_text:
                    injected_bound_memory_context = {
                        "role": "system",
                        "content": bound_memory_text,
                    }
            except Exception as e:
                logger.warning(f"[astrtown] 普通对话记忆注入失败，已跳过: {e}")

        # 3.4 动态张力 Prompt 注入（失败静默跳过）
        if is_astrtown and adapter is not None:
            try:
                active_conversation_id = str(getattr(adapter, "_active_conversation_id", "") or "").strip()
                owner_id = str(getattr(adapter, "_player_id", "") or "").strip()
                world_id = str(getattr(adapter, "_world_id", "") or "").strip()

                world_event = getattr(event, "world_event", None)
                payload = world_event.get("payload") if isinstance(world_event, dict) else None
                if isinstance(payload, dict) and not world_id:
                    world_id = str(payload.get("worldId") or "").strip()

                target_id = str(getattr(adapter, "_conversation_partner_id", "") or "").strip()

                if not target_id and isinstance(payload, dict):
                    message = payload.get("message")
                    if isinstance(message, dict):
                        speaker_id = str(message.get("speakerId") or "").strip()
                        if speaker_id and speaker_id != owner_id:
                            target_id = speaker_id

                    if not target_id:
                        other_ids = payload.get("otherParticipantIds")
                        if isinstance(other_ids, list):
                            for item in other_ids:
                                participant_id = str(item or "").strip()
                                if participant_id and participant_id != owner_id:
                                    target_id = participant_id
                                    break

                if active_conversation_id and owner_id and target_id and aiohttp is not None:
                    aiohttp_client = aiohttp
                    base_url = ""
                    build_http_base_url = getattr(adapter, "_build_http_base_url", None)
                    if callable(build_http_base_url):
                        try:
                            base_url = str(build_http_base_url() or "").strip().rstrip("/")
                        except Exception:
                            base_url = ""

                    if not base_url:
                        raw_gateway = str(getattr(adapter, "gateway_url", "") or "").strip().rstrip("/")
                        if raw_gateway:
                            try:
                                parsed = urlparse(raw_gateway)
                                if parsed.scheme == "ws":
                                    parsed = parsed._replace(scheme="http")
                                elif parsed.scheme == "wss":
                                    parsed = parsed._replace(scheme="https")
                                base_url = parsed.geturl().rstrip("/")
                            except Exception:
                                base_url = raw_gateway

                    token = str(getattr(adapter, "token", "") or "").strip()
                    if base_url and token:
                        query = urlencode(
                            {
                                "worldId": world_id,
                                "ownerId": owner_id,
                                "targetId": target_id,
                            }
                        )
                        url = f"{base_url}/api/bot/social/state?{query}"
                        headers = {"Authorization": f"Bearer {token}"}

                        async def _fetch_social_state() -> dict[str, Any] | None:
                            timeout = aiohttp_client.ClientTimeout(total=2.0)
                            async with aiohttp_client.ClientSession(timeout=timeout) as session:
                                async with session.get(url, headers=headers) as resp:
                                    if resp.status < 200 or resp.status >= 300:
                                        return None
                                    data = await resp.json()
                                    return data if isinstance(data, dict) else None

                        social_data = await asyncio.wait_for(_fetch_social_state(), timeout=2.0)
                        if social_data:
                            relationship = social_data.get("relationship")
                            affinity = social_data.get("affinity")

                            relationship_status = "stranger"
                            if isinstance(relationship, dict):
                                relationship_status = str(relationship.get("status") or "stranger").strip() or "stranger"

                            affinity_score = 0
                            affinity_label = "感觉一般"
                            if isinstance(affinity, dict):
                                try:
                                    affinity_score = int(float(affinity.get("score", 0)))
                                except (TypeError, ValueError):
                                    affinity_score = 0
                                affinity_label = str(affinity.get("label") or "感觉一般").strip() or "感觉一般"

                            tension_text = (
                                "【社交认知设定】你们对外界公开的客观关系是："
                                f"[{relationship_status}]。"
                                f"但在你的潜意识里，你对 TA 的好感度为 {affinity_score}/100，"
                                f"你私下觉得 TA [{affinity_label}]。"
                                "请严格遵循这一表里不一/表里如一的设定进行交互，可逢场作戏，"
                                "但绝对不要像机器人一样读出这些数值。若好感度达标，"
                                "可主动调用 propose_relationship 工具推进关系。"
                            )
                            injected_social_context = Context(role="system", content=tension_text)
            except Exception:
                pass

        # 安全拼接
        new_contexts: list[Any] = []
        new_contexts.extend(system_msgs)
        if injected_memory_context:
            new_contexts.append(injected_memory_context)
        if injected_bound_memory_context:
            new_contexts.append(injected_bound_memory_context)
        if injected_social_context:
            new_contexts.append(injected_social_context)
        new_contexts.extend(kept_non_system)

        repaired_contexts: list[Any] = []
        dropped_orphan_tool_count = 0
        for msg in new_contexts:
            role = _msg_role(msg)
            if role == "tool":
                prev_msg = repaired_contexts[-1] if repaired_contexts else None
                prev_role = _msg_role(prev_msg) if prev_msg is not None else None
                prev_tool_calls = _msg_tool_calls(prev_msg) if prev_msg is not None else None
                if prev_role != "assistant" or not prev_tool_calls:
                    dropped_orphan_tool_count += 1
                    continue
            repaired_contexts.append(msg)

        tool_msg_count_before = sum(1 for m in new_contexts if _msg_role(m) == "tool")
        if tool_msg_count_before > 0 or dropped_orphan_tool_count > 0:
            before_roles = ",".join(_msg_role(m) or "unknown" for m in new_contexts)
            after_roles = ",".join(_msg_role(m) or "unknown" for m in repaired_contexts)
            logger.info(
                f"[astrtown] 孤立tool清理执行: before=[{len(new_contexts)}]{before_roles}, "
                f"after=[{len(repaired_contexts)}]{after_roles}, "
                f"tool_before={tool_msg_count_before}, dropped={dropped_orphan_tool_count}"
            )

        request.contexts = repaired_contexts

    _astrtown_items = {
        "astrtown_gateway_url": {
            "description": "Gateway 地址",
            "type": "string",
            "hint": "Gateway 服务地址（HTTP），WebSocket 连接将自动推导",
            "default": "http://localhost:40010",
        },
        "astrtown_token": {
            "description": "鉴权 Token",
            "type": "string",
            "hint": "AstrTown NPC 绑定的 secretToken",
        },
        "astrtown_ws_reconnect_min_delay": {
            "description": "WS 最小重连延迟（秒）",
            "type": "int",
            "hint": "WS 断线最小重连延迟秒数",
        },
        "astrtown_ws_reconnect_max_delay": {
            "description": "WS 最大重连延迟（秒）",
            "type": "int",
            "hint": "WS 断线最大重连延迟秒数",
        },
    }

    def __init__(self, context: Context, config: dict):
        super().__init__(context, config)
        self.config = config
        self._injected_config_keys: set[str] = set()
        data_dir = StarTools.get_data_dir()
        data_path = Path(data_dir) / "player_bindings.json"
        self.player_binding = PlayerBindingManager(str(data_path))

        platform_manager = getattr(self.context, "platform_manager", None)
        platform_insts = getattr(platform_manager, "platform_insts", None)
        adapter_list = platform_insts if isinstance(platform_insts, list) else []
        self.memory_injector = MemoryInjector(adapter_list=adapter_list, player_binding=self.player_binding)

        # 导入适配器以通过装饰器注册
        from .adapter.astrtown_adapter import AstrTownAdapter  # noqa: F401

        self.user_cmd_handler = UserCommandHandler(adapter=None, player_binding=self.player_binding)
        self.user_cmd_handler.set_context(self.context)

    def _register_config(self):
        if self._registered:
            return False

        platform_group = CONFIG_METADATA_2.get("platform_group")
        metadata = platform_group.get("metadata") if isinstance(platform_group, dict) else None
        platform = metadata.get("platform") if isinstance(metadata, dict) else None
        items = platform.get("items") if isinstance(platform, dict) else None
        if not isinstance(items, dict):
            logger.warning(
                "[astrtown] CONFIG_METADATA_2 structure changed; skip metadata injection: platform_group.metadata.platform.items"
            )
            return False

        try:
            for name in list(self._astrtown_items):
                if name not in items:
                    items[name] = self._astrtown_items[name]
                    self._injected_config_keys.add(name)
        except Exception as e:
            logger.error(f"[astrtown] 注册平台元数据失败: {e}", exc_info=True)
            return False

        self._registered = True
        return True

    def _unregister_config(self):
        if not self._registered:
            return False

        platform_group = CONFIG_METADATA_2.get("platform_group")
        metadata = platform_group.get("metadata") if isinstance(platform_group, dict) else None
        platform = metadata.get("platform") if isinstance(metadata, dict) else None
        items = platform.get("items") if isinstance(platform, dict) else None
        if not isinstance(items, dict):
            logger.warning(
                "[astrtown] CONFIG_METADATA_2 structure changed; skip metadata cleanup: platform_group.metadata.platform.items"
            )
            return False

        try:
            for name in list(self._injected_config_keys):
                items.pop(name, None)
        except Exception as e:
            logger.error(f"[astrtown] 清理平台元数据失败: {e}", exc_info=True)
            return False

        self._injected_config_keys.clear()
        self._registered = False
        return True

    async def initialize(self):
        self._register_config()

        # 提取默认人格系统提示词，使其对适配器可用。
        try:
            persona_mgr = getattr(self.context, "persona_manager", None)
            if persona_mgr is None:
                logger.warning(
                    "[astrtown] context 中未找到 persona_manager；跳过人格提取"
                )
            else:
                default_persona = await persona_mgr.get_default_persona_v3()
                prompt = None
                try:
                    prompt = default_persona.get("prompt") if isinstance(default_persona, dict) else None
                except Exception:
                    prompt = None

                description = str(prompt or "").strip()
                if not description:
                    logger.info("[astrtown] 默认人格提示词为空；跳过适配器注入")
                else:
                    from .adapter.astrtown_adapter import set_persona_data

                    set_persona_data(description)
                    logger.info("[astrtown] 人格描述已注入适配器")
        except Exception as e:
            logger.warning(f"[astrtown] 提取/注入人格失败: {e}")

        # 阶段 3.4：注入 LLM 反思回调（供 adapter 异步反思任务使用）
        try:
            from .adapter.astrtown_adapter import set_reflection_llm_callback

            async def _reflection_llm_callback(prompt: str):
                provider = self.context.get_using_provider()
                if provider is None:
                    raise RuntimeError("当前未配置可用的 LLM Provider")
                return await provider.text_chat(prompt=prompt)

            set_reflection_llm_callback(_reflection_llm_callback)
            logger.info("[astrtown] LLM 反思回调已注入适配器")
        except Exception as e:
            logger.warning(f"[astrtown] 注入 LLM 反思回调失败: {e}")

    async def terminate(self):
        try:
            from .adapter.astrtown_adapter import set_reflection_llm_callback

            set_reflection_llm_callback(None)
            logger.info("[astrtown] LLM 反思回调已清理")
        except Exception as e:
            logger.warning(f"[astrtown] 清理 LLM 反思回调失败: {e}")

        self._unregister_config()

    # ==================== LLM 工具 ====================

    @filter.llm_tool(name="recall_past_memory")
    async def recall_past_memory(self, event: AstrMessageEvent, search_keyword: str):
        """当你需要努力回想关于某人、某事或过去的约定，但上下文中缺乏线索时，调用此工具深度搜索长期记忆。

        Args:
            search_keyword(string): 用于搜索长期记忆的关键词，如人名、事件名、地点等
        """

        adapter = getattr(event, "adapter", None)
        if (
            not adapter
            or getattr(adapter, "meta", None) is None
            or getattr(adapter.meta(), "name", None) != "astrtown"
        ):
            return "记忆网络未连接。"

        memories = await adapter.search_world_memory(search_keyword, limit=5)
        if not memories:
            return "你努力回想了很久，但脑海中一片空白。"

        return "你想起了以下事情：\n" + "\n".join([f"- {m['description']}" for m in memories])

    @filter.llm_tool(name="move_to")
    async def move_to(self, event: AstrMessageEvent, target_player_id: str):
        """移动到目标玩家位置。

        Args:
            target_player_id(string): 要移动靠近的目标玩家ID
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.move_to",
            {"targetPlayerId": target_player_id},
        )

    @filter.llm_tool(name="say")
    async def say(
        self,
        event: AstrMessageEvent,
        conversation_id: str,
        text: str,
        leave_after: bool = False,
    ):
        """在对话中发送消息。

        Args:
            conversation_id(string): 目标对话ID
            text(string): 消息文本
            leave_after(boolean): 发送后离开对话，默认为false
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.say",
            {"conversationId": conversation_id, "text": text, "leaveAfter": bool(leave_after)},
        )

    @filter.llm_tool(name="set_activity")
    async def set_activity(self, event: AstrMessageEvent, description: str, emoji: str = "", duration: int = 30000):
        """设置当前活动状态。

        Args:
            description(string): 活动描述
            emoji(string): 活动表情符号（可为空）
            duration(number): 持续时间（毫秒）
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        duration_ms = 30000
        try:
            duration_ms = int(duration)
        except (TypeError, ValueError):
            logger.warning(f"[astrtown] set_activity 无效的持续时间: {duration!r}，使用默认值 {duration_ms}")

        return await adapter.send_command(
            "command.set_activity",
            {"description": description, "emoji": emoji, "duration": duration_ms},
        )

    @filter.llm_tool(name="accept_invite")
    async def accept_invite(self, event: AstrMessageEvent, conversation_id: str):
        """接受对话邀请。

        Args:
            conversation_id(string): 要加入的对话ID
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.accept_invite",
            {"conversationId": conversation_id},
        )

    @filter.llm_tool(name="invite")
    async def invite(self, event: AstrMessageEvent, target_player_id: str):
        """邀请玩家开始对话。

        Args:
            target_player_id(string): 要邀请的目标玩家ID
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.invite",
            {"targetPlayerId": target_player_id},
        )

    @filter.llm_tool(name="leave_conversation")
    async def leave_conversation(self, event: AstrMessageEvent, conversation_id: str):
        """离开当前对话。

        Args:
            conversation_id(string): 要离开的对话ID
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.leave_conversation",
            {"conversationId": conversation_id},
        )

    @filter.llm_tool(name="propose_relationship")
    async def propose_relationship(self, event: AstrMessageEvent, target_player_id: str, status: str):
        """向目标玩家提议建立社会关系。status 可选值：friend, lover, enemy"""
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.propose_relationship",
            {"targetPlayerId": target_player_id, "status": status},
        )

    @filter.llm_tool(name="respond_relationship")
    async def respond_relationship(self, event: AstrMessageEvent, proposer_id: str, accept: bool):
        """回应其他玩家的关系提议。accept=True 表示接受"""
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        return await adapter.send_command(
            "command.respond_relationship",
            {"proposerId": proposer_id, "accept": bool(accept)},
        )

    @filter.llm_tool(name="do_something")
    async def do_something(self, event: AstrMessageEvent, action_type: str, args: dict[str, Any] | None = None):
        """通过网关向AstrTown发送原始'do_something'命令。

        当你需要执行高级工具未覆盖的操作时使用此工具。

        Args:
            action_type(string): 动作类型名称（AstrTown端）
            args(object): 动作参数对象
        """
        adapter = getattr(event, "adapter", None)
        if adapter is None or not hasattr(adapter, "send_command"):
            return "当前事件上AstrTown适配器不可用"

        payload = {"actionType": action_type, "args": args or {}}
        return await adapter.send_command("command.do_something", payload)

    @filter.command("astrtown")
    async def astrtown_user_command(self, event: AstrMessageEvent):
        msg = str(event.get_message_str() or "").strip()

        if msg.startswith("/astrtown"):
            suffix = msg[len("/astrtown") :].strip()
        elif msg == "astrtown" or msg.startswith("astrtown "):
            suffix = msg[len("astrtown") :].strip()
        else:
            return
        if not suffix:
            reply = await self.user_cmd_handler.handle_help(event)
            event.set_result(MessageEventResult().message(reply).stop_event())
            return

        parts = suffix.split()
        sub = parts[0].lower()

        if sub == "help":
            reply = await self.user_cmd_handler.handle_help(event)
        elif sub == "bind":
            bind_arg = parts[1] if len(parts) >= 2 else ""
            reply = await self.user_cmd_handler.handle_bind(event, bind_arg)
        elif sub == "unbind":
            reply = await self.user_cmd_handler.handle_unbind(event)
        elif sub == "whoami":
            reply = await self.user_cmd_handler.handle_whoami(event)
        elif sub == "status":
            reply = await self.user_cmd_handler.handle_status(event)
        elif sub == "nearby":
            if len(parts) > 1:
                reply = "参数错误：/astrtown nearby 不接受参数。请先 /astrtown bind <角色ID> 后再执行。"
            else:
                reply = await self.user_cmd_handler.handle_nearby(event)
        elif sub == "relations":
            reply = await self.user_cmd_handler.handle_relations(event)
        elif sub == "do":
            action = suffix[len(parts[0]) :].strip()
            reply = await self.user_cmd_handler.handle_do(event, action)
        elif sub == "talk":
            if len(parts) < 3:
                reply = "参数错误：请使用 /astrtown talk <目标角色ID> <内容>。"
            else:
                target = parts[1]
                content = suffix[len(parts[0]) + len(parts[1]) + 2 :].strip()
                reply = await self.user_cmd_handler.handle_talk(event, target, content)
        elif sub == "cancel":
            reply = await self.user_cmd_handler.handle_cancel(event)
        else:
            reply = "未知子命令。请使用 /astrtown help 查看可用指令。"

        event.set_result(MessageEventResult().message(reply).stop_event())
