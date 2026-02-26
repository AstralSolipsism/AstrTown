from __future__ import annotations

import json
from typing import Any

from .contracts import AdapterHostProtocol


class ReflectionParser:
    """反思提示词与结果解析器。"""

    def __init__(self, host: AdapterHostProtocol) -> None:
        self._host = host

    def build_reflection_prompt(
        self,
        conversation_id: str,
        other_player_name: str,
        other_player_id: str,
        messages: list[dict[str, str]],
    ) -> str:
        role_name = str(self._host._player_name or "该角色").strip() or "该角色"
        target_name = other_player_name.strip() or other_player_id.strip() or "对方"

        transcript_lines: list[str] = []
        for idx, msg in enumerate(messages, start=1):
            speaker = str(msg.get("speakerId") or "unknown").strip() or "unknown"
            content = str(msg.get("content") or "").strip()
            if not content:
                continue
            transcript_lines.append(f"{idx}. {speaker}: {content}")
        transcript = "\n".join(transcript_lines) if transcript_lines else "（无可用对话记录）"

        return (
            f"请作为 {role_name} 的潜意识反思刚刚结束的对话。\n"
            "1. 提炼对话摘要 (summary) 和重要性 (importance 1-10)\n"
            f"2. 评估对 {target_name} 的单向好感度变动 (-10到10) 以及最新的主观感受标签 "
            "(affinity_label，如'觉得很吵','暗生情愫')\n"
            "请严格输出 JSON：{\"summary\":\"...\",\"importance\":N,\"affinity_delta\":N,"
            "\"affinity_label\":\"...\"}\n"
            "只输出 JSON，不要输出任何额外文字。\n\n"
            f"对话ID：{conversation_id or 'unknown'}\n"
            f"对方ID：{other_player_id or 'unknown'}\n"
            f"对方名字：{target_name}\n"
            "对话记录：\n"
            f"{transcript}"
        )

    @staticmethod
    def to_int_in_range(value: Any, minimum: int, maximum: int, default: int) -> int:
        try:
            if isinstance(value, bool):
                raise ValueError("bool is not valid number")
            num = int(float(value))
        except Exception:
            return default
        if num < minimum:
            return minimum
        if num > maximum:
            return maximum
        return num

    def normalize_reflection_response(self, llm_result: Any) -> dict[str, Any] | None:
        parsed: dict[str, Any] | None = None

        if isinstance(llm_result, dict):
            parsed = llm_result
        elif hasattr(llm_result, "completion_text"):
            llm_text = str(getattr(llm_result, "completion_text") or "").strip()
            if llm_text:
                try:
                    obj = json.loads(llm_text)
                except Exception:
                    start = llm_text.find("{")
                    end = llm_text.rfind("}")
                    if start >= 0 and end > start:
                        try:
                            obj = json.loads(llm_text[start : end + 1])
                        except Exception:
                            obj = None
                    else:
                        obj = None
                if isinstance(obj, dict):
                    parsed = obj
        elif isinstance(llm_result, str):
            text = llm_result.strip()
            if not text:
                return None
            try:
                obj = json.loads(text)
            except Exception:
                start = text.find("{")
                end = text.rfind("}")
                if start < 0 or end <= start:
                    return None
                try:
                    obj = json.loads(text[start : end + 1])
                except Exception:
                    return None
            if isinstance(obj, dict):
                parsed = obj

        if not isinstance(parsed, dict):
            return None

        summary = str(parsed.get("summary") or "").strip()
        if not summary:
            summary = "一次对话结束后的潜意识反思。"

        importance = self.to_int_in_range(parsed.get("importance"), 1, 10, 5)
        affinity_delta = self.to_int_in_range(parsed.get("affinity_delta"), -10, 10, 0)
        affinity_label = str(parsed.get("affinity_label") or "").strip() or "暂无明显变化"

        return {
            "summary": summary,
            "importance": importance,
            "affinity_delta": affinity_delta,
            "affinity_label": affinity_label,
        }

    @staticmethod
    def parse_json_array(text: str) -> list[Any] | None:
        raw = text.strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except Exception:
            start = raw.find("[")
            end = raw.rfind("]")
            if start < 0 or end <= start:
                return None
            try:
                parsed = json.loads(raw[start : end + 1])
            except Exception:
                return None

        if isinstance(parsed, list):
            return parsed
        return None

    def normalize_higher_reflection_response(self, llm_result: Any) -> list[str]:
        parsed: list[Any] | None = None

        if isinstance(llm_result, list):
            parsed = llm_result
        elif isinstance(llm_result, dict):
            insights = llm_result.get("insights")
            if isinstance(insights, list):
                parsed = insights
            elif "insight" in llm_result:
                parsed = [llm_result]
        elif hasattr(llm_result, "completion_text"):
            text = str(getattr(llm_result, "completion_text") or "").strip()
            parsed = self.parse_json_array(text)
        elif isinstance(llm_result, str):
            parsed = self.parse_json_array(llm_result)

        if not isinstance(parsed, list):
            return []

        normalized: list[str] = []
        for item in parsed:
            if isinstance(item, dict):
                insight = str(item.get("insight") or "").strip()
            elif isinstance(item, str):
                insight = item.strip()
            else:
                insight = ""
            if insight:
                normalized.append(insight)

        deduped: list[str] = []
        seen: set[str] = set()
        for insight in normalized:
            if insight in seen:
                continue
            seen.add(insight)
            deduped.append(insight)
            if len(deduped) >= 5:
                break

        return deduped
