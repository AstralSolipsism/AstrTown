from __future__ import annotations

import asyncio
import json
import random
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

try:
    from websockets.asyncio.client import connect
except Exception as e:  # pragma: no cover
    raise RuntimeError(
        "astrbot_plugin_astrtown requires 'websockets' dependency available in AstrBot runtime"
    ) from e

from astrbot import logger

from .contracts import AdapterHostProtocol
from .ws_message_router import WsMessageRouter


class WsLifecycleService:
    """WebSocket 生命周期服务。"""

    def __init__(self, host: AdapterHostProtocol, message_router: WsMessageRouter) -> None:
        self._host: Any = host
        self._message_router = message_router

    def build_ws_connect_url(self) -> str:
        ws_base = self._host.gateway_url
        if ws_base.startswith("https://"):
            ws_base = "wss://" + ws_base[len("https://") :]
        elif ws_base.startswith("http://"):
            ws_base = "ws://" + ws_base[len("http://") :]

        ws_url = ws_base.rstrip("/") + "/ws/bot"
        query = urlencode(
            {
                "token": self._host.token,
                "v": self._host.protocol_version_range,
                "subscribe": self._host.subscribe,
            }
        )
        return f"{ws_url}?{query}"

    @staticmethod
    def mask_ws_url_for_log(url: str) -> str:
        """对 ws url 中敏感查询参数（token）进行脱敏后再用于日志。"""
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
            # 最佳努力回退：即使 url 解析失败，也要避免泄露 token。
            return url.split("?")[0] + "?token=***" if "?" in url else url

    async def ws_loop(self) -> None:
        delay = float(self._host.reconnect_min_delay)
        while not self._host._stop_event.is_set():
            # 每轮连接前刷新 token：支持用户在运行时更新配置后自动恢复。
            latest_token = str(self._host.config.get("astrtown_token", "") or "").strip()
            if latest_token != self._host.token:
                old_token = self._host.token
                self._host.token = latest_token
                self._host._auth_failed = False
                self._host._auth_failed_token = ""
                self._host._auth_failed_code = None
                self._host._auth_failed_last_log_ts = 0.0
                if self._host.token:
                    logger.info("[AstrTown] 检测到 token 已更新，解除鉴权失败锁并重新尝试连接")
                else:
                    logger.warning("[AstrTown] 检测到 token 被更新为空，适配器将暂停连接")

                # token 变化后重置退避，避免恢复时被长延迟阻塞。
                delay = float(self._host.reconnect_min_delay)

                # 仅用于诊断，避免泄露 token 内容。
                if old_token and self._host.token:
                    logger.debug("[AstrTown] token 已发生变更（内容已脱敏）")

            # token 缺失时不连接，等待用户补充。
            if not self._host.token:
                await asyncio.sleep(1.0)
                continue

            # 鉴权失败锁：同一失效 token 不再重连，避免刷屏。
            if self._host._auth_failed and self._host.token == self._host._auth_failed_token:
                now = time.time()
                if (now - float(self._host._auth_failed_last_log_ts or 0.0)) >= 30.0:
                    code = self._host._auth_failed_code or "UNKNOWN"
                    logger.error(
                        f"[AstrTown] 当前 token 已鉴权失败(code={code})，暂停自动重连；"
                        "请更新 token 后将自动恢复连接"
                    )
                    self._host._auth_failed_last_log_ts = now
                await asyncio.sleep(1.0)
                continue

            try:
                await self.ws_connect_once()
                delay = float(self._host.reconnect_min_delay)
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error(f"[AstrTown] ws loop error: {e}", exc_info=True)

            if self._host._stop_event.is_set():
                return

            # 鉴权失败时不走退避重连；由上面的 auth_failed 分支接管等待。
            if self._host._auth_failed and self._host.token == self._host._auth_failed_token:
                continue

            jitter = random.random() * 0.3 + 0.85
            sleep_s = min(delay * jitter, float(self._host.reconnect_max_delay))
            logger.warn(f"[AstrTown] reconnect in {sleep_s:.1f}s")
            await asyncio.sleep(sleep_s)
            delay = min(delay * 2.0, float(self._host.reconnect_max_delay))

    async def ws_connect_once(self) -> None:
        url = self.build_ws_connect_url()
        logger.info(f"[AstrTown] connecting ws: {self.mask_ws_url_for_log(url)}")

        try:
            async with connect(
                url,
                ping_interval=30,
                ping_timeout=10,
                close_timeout=5,
                max_queue=256,
            ) as websocket:
                self._host._ws = websocket
                logger.info("[AstrTown] ws connected")

                async for raw in websocket:
                    if self._host._stop_event.is_set():
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

                    await self._message_router.handle_ws_message(data)
        finally:
            # 确保重连时不保留过期的 ws 引用或绑定信息。
            self._host._ws = None
            self._host._negotiated_version = None
            self._host._agent_id = None
            self._host._player_id = None
            self._host._world_id = None
            self._host._player_name = None

            if self._host._pending_commands:
                err = ConnectionError("WebSocket disconnected")
                for command_id, fut in list(self._host._pending_commands.items()):
                    if fut.done():
                        continue
                    try:
                        fut.set_exception(err)
                    except Exception:
                        try:
                            fut.cancel()
                        except Exception:
                            pass
                self._host._pending_commands.clear()
