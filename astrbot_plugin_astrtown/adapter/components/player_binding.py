from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class PlayerBindingManager:
    """玩家身份绑定管理器。"""

    def __init__(self, data_path: str) -> None:
        """初始化绑定管理器并确保数据文件可用。

        Args:
            data_path: 绑定数据 JSON 文件路径。
        """
        self._data_path = Path(data_path)
        self._bindings: dict[str, dict[str, str]] = {}

        self._ensure_file()
        self._load()

    def bind(self, session_key: str, platform_id: str, player_id: str) -> None:
        """建立或覆盖会话绑定，并立即持久化。"""
        key = str(session_key).strip()
        pid = str(platform_id).strip()
        player = str(player_id).strip()
        if not key:
            logger.warning("[AstrTown] bind 失败：session_key 为空")
            return
        if not pid:
            logger.warning(f"[AstrTown] bind 失败：platform_id 为空，session_key={key}")
            return
        if not player:
            logger.warning(f"[AstrTown] bind 失败：player_id 为空，session_key={key}")
            return

        self._bindings[key] = {
            "platform_id": pid,
            "player_id": player,
        }
        self._save()

    def unbind(self, session_key: str) -> None:
        """解除会话绑定，并立即持久化。"""
        key = str(session_key).strip()
        if not key:
            logger.warning("[AstrTown] unbind 失败：session_key 为空")
            return

        if key in self._bindings:
            self._bindings.pop(key, None)
            self._save()

    def get_binding(self, session_key: str) -> dict[str, str] | None:
        """查询会话绑定。"""
        key = str(session_key).strip()
        if not key:
            return None

        item = self._bindings.get(key)
        if not isinstance(item, dict):
            return None

        platform_id = str(item.get("platform_id") or "").strip()
        player_id = str(item.get("player_id") or "").strip()
        if not platform_id or not player_id:
            return None

        return {
            "platform_id": platform_id,
            "player_id": player_id,
        }

    def get_all_bindings(self) -> dict[str, dict[str, str]]:
        """返回全部绑定数据（浅拷贝）。"""
        return {
            key: {
                "platform_id": str(value.get("platform_id") or "").strip(),
                "player_id": str(value.get("player_id") or "").strip(),
            }
            for key, value in self._bindings.items()
            if isinstance(value, dict)
        }

    def _ensure_file(self) -> None:
        """确保目录与 JSON 文件存在。"""
        self._data_path.parent.mkdir(parents=True, exist_ok=True)
        if not self._data_path.exists():
            self._data_path.write_text("{}", encoding="utf-8")

    def _load(self) -> None:
        """从 JSON 文件读取绑定数据。"""
        try:
            raw = self._data_path.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
            if isinstance(data, dict):
                normalized: dict[str, dict[str, str]] = {}
                for key, value in data.items():
                    if not isinstance(value, dict):
                        continue
                    session_key = str(key).strip()
                    platform_id = str(value.get("platform_id") or "").strip()
                    player_id = str(value.get("player_id") or "").strip()
                    if not session_key or not platform_id or not player_id:
                        continue
                    normalized[session_key] = {
                        "platform_id": platform_id,
                        "player_id": player_id,
                    }
                self._bindings = normalized
                return

            logger.error(f"[AstrTown] 玩家绑定文件格式错误，期望 object: {self._data_path}")
            self._bindings = {}
        except Exception as e:
            logger.error(f"[AstrTown] 读取玩家绑定文件失败: {e}")
            self._bindings = {}

    def _save(self) -> None:
        """将内存绑定数据写回 JSON 文件。"""
        try:
            self._data_path.write_text(
                json.dumps(self._bindings, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.error(f"[AstrTown] 写入玩家绑定文件失败: {e}")
