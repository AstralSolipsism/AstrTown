from __future__ import annotations

from astrbot.api.event import AstrMessageEvent


class AstrTownMessageEvent(AstrMessageEvent):
    """AstrTown message event.

    Gateway 推送的世界事件会被转换为此事件并投递到 AstrBot EventBus。

    说明：
    - 对 AstrTown 来说，发送消息/动作应当通过 LLM tools 回写到 Gateway。
    - 因此该事件类不强制提供 send() 等能力，沿用 AstrMessageEvent 基类即可。
    """

    def __init__(
        self,
        message_str: str,
        message_obj,
        platform_meta,
        session_id: str,
        adapter,
        world_event: dict,
    ):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self._adapter = adapter
        self.world_event = world_event

    @property
    def adapter(self):
        return self._adapter
