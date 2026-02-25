from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlencode, urlparse

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.config.default import CONFIG_METADATA_2
from astrbot.core.star.register.star_handler import register_on_llm_request

from astrbot.api import logger

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
        injected_social_context: Context | None = None

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

        # 3.4 动态张力 Prompt 注入（失败静默跳过）
        if is_astrtown:
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
                    base_url = ""
                    if hasattr(adapter, "_build_http_base_url") and callable(adapter._build_http_base_url):
                        try:
                            base_url = str(adapter._build_http_base_url() or "").strip().rstrip("/")
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
                            timeout = aiohttp.ClientTimeout(total=2.0)
                            async with aiohttp.ClientSession(timeout=timeout) as session:
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
        new_contexts: list[Context] = []
        new_contexts.extend(system_msgs)
        if injected_memory_context:
            new_contexts.append(injected_memory_context)
        if injected_social_context:
            new_contexts.append(injected_social_context)
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
