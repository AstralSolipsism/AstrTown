from __future__ import annotations

import json
import time

try:
    from websockets.exceptions import ConnectionClosed
except Exception as e:  # pragma: no cover
    raise RuntimeError(
        "astrbot_plugin_astrtown requires 'websockets' dependency available in AstrBot runtime"
    ) from e

from astrbot import logger

from ..id_util import new_id
from .contracts import AdapterHostProtocol


class EventAckSender:
    """世界事件 ACK 发送服务。"""

    def __init__(self, host: AdapterHostProtocol) -> None:
        self._host = host

    async def send_event_ack(self, event_id: str) -> None:
        if not event_id:
            return
        ws = self._host._ws
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
        self._host._event_ack_sample_count += 1
        if (now - float(self._host._event_ack_last_log_ts or 0.0)) >= 10.0:
            count = int(self._host._event_ack_sample_count)
            self._host._event_ack_sample_count = 0
            self._host._event_ack_last_log_ts = now
            # astrbot.logger 不一定支持 trace，这里用 debug 但采样输出，避免刷屏。
            logger.debug(f"[AstrTown] 事件ACK已发送(采样): lastEventId={event_id}, count={count}/10s")
