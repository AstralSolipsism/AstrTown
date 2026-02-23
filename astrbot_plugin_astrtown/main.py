from __future__ import annotations

import asyncio
from typing import Any

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.config.default import CONFIG_METADATA_2
from astrbot.core.star.register.star_handler import register_on_llm_request

from astrbot.api import logger


class AstrTownPlugin(Star):
    _registered: bool = False

    @register_on_llm_request(priority=100)
    async def _astrtown_trim_context_and_inject_memory(self, event: AstrMessageEvent, request) -> None:
        """在 LLM 请求前裁剪上下文，并以“阅后即焚”的方式注入相关世界记忆。"""

        contexts = getattr(request, "contexts", None)
        if not isinstance(contexts, list):
            return

        adapter = getattr(event, "adapter", None)
        is_astrtown = bool(
            adapter
            and getattr(adapter, "meta", None)
            and getattr(adapter.meta(), "name", None) == "astrtown"
        )

        try:
            max_rounds = int(self.config.get("astrtown_max_context_rounds", 50) or 50)
        except (TypeError, ValueError):
            max_rounds = 50

        if max_rounds <= 0:
            return

        max_messages = max_rounds * 2

        # 将原始 contexts 分离，绝不直接修改原始对象的内容
        system_msgs = [m for m in contexts if getattr(m, "role", None) == "system"]
        non_system_msgs = [m for m in contexts if getattr(m, "role", None) != "system"]
        kept_non_system = non_system_msgs[-max_messages:]

        injected_memory_context: Context | None = None

        if is_astrtown and kept_non_system:
            # 提取用户最新发言作为 Query
            last_user_msg = next(
                (
                    m.content
                    for m in reversed(kept_non_system)
                    if getattr(m, "role", None) == "user" and isinstance(getattr(m, "content", None), str)
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

        # 安全拼接
        new_contexts: list[Context] = []
        new_contexts.extend(system_msgs)
        if injected_memory_context:
            new_contexts.append(injected_memory_context)
        new_contexts.extend(kept_non_system)

        request.contexts = new_contexts

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
        # 导入适配器以通过装饰器注册
        from .adapter.astrtown_adapter import AstrTownAdapter  # noqa: F401

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
                return

            default_persona = await persona_mgr.get_default_persona_v3()
            prompt = None
            try:
                prompt = default_persona.get("prompt") if isinstance(default_persona, dict) else None
            except Exception:
                prompt = None

            description = str(prompt or "").strip()
            if not description:
                logger.info("[astrtown] 默认人格提示词为空；跳过适配器注入")
                return

            from .adapter.astrtown_adapter import set_persona_data

            set_persona_data(description)
            logger.info("[astrtown] 人格描述已注入适配器")
        except Exception as e:
            logger.warning(f"[astrtown] 提取/注入人格失败: {e}")

    async def terminate(self):
        self._unregister_config()

    # ==================== LLM 工具 ====================

    @filter.llm_tool(name="recall_past_memory")
    async def recall_past_memory(self, event: AstrMessageEvent, search_keyword: str):
        """当你需要努力回想关于某人、某事或过去的约定，但上下文中缺乏线索时，调用此工具深度搜索长期记忆。"""

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
