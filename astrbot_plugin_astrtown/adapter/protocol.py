from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict


class Vector2(TypedDict):
    x: float
    y: float


class WsMessageBase(TypedDict, total=False):
    type: str
    id: str
    version: int
    timestamp: int
    payload: Any
    metadata: dict[str, Any]


class WsWorldEventBase(WsMessageBase, total=False):
    expiresAt: int


@dataclass(frozen=True)
class ConnectedPayload:
    agentId: str
    playerId: str
    playerName: str
    worldId: str
    serverVersion: str
    negotiatedVersion: int
    supportedVersions: list[int]
    subscribedEvents: list[str]


@dataclass(frozen=True)
class ConnectedMessage:
    type: Literal["connected"]
    id: str
    version: int
    timestamp: int
    payload: ConnectedPayload


@dataclass(frozen=True)
class AuthErrorPayload:
    code: Literal[
        "INVALID_TOKEN",
        "TOKEN_EXPIRED",
        "NPC_NOT_FOUND",
        "ALREADY_CONNECTED",
        "VERSION_MISMATCH",
    ]
    message: str
    supportedVersions: list[int] | None = None


@dataclass(frozen=True)
class AuthErrorMessage:
    type: Literal["auth_error"]
    id: str
    version: int
    timestamp: int
    payload: AuthErrorPayload


@dataclass(frozen=True)
class CommandAckPayload:
    commandId: str
    status: Literal["accepted", "rejected"]
    # 语义标注：queued 表示仅“入队/受理成功”，不代表后端执行成功
    ackSemantics: Literal["queued"] | None = None
    reason: str | None = None
    inputId: str | None = None


@dataclass(frozen=True)
class CommandAck:
    type: Literal["command.ack"]
    id: str
    timestamp: int
    payload: CommandAckPayload


@dataclass(frozen=True)
class ActionFinishedPayload:
    actionType: str
    success: bool
    result: Any


@dataclass(frozen=True)
class ConversationMessagePayload:
    conversationId: str
    message: dict[str, Any]


@dataclass(frozen=True)
class ConversationStartedPayload:
    conversationId: str
    otherParticipantIds: list[str]


@dataclass(frozen=True)
class ConversationTimeoutPayload:
    conversationId: str
    reason: Literal["invite_timeout", "idle_timeout"]


@dataclass(frozen=True)
class AgentStateChangedPayload:
    state: str
    position: Any
    nearbyPlayers: Any


@dataclass(frozen=True)
class WorldEvent:
    type: str
    id: str
    version: int
    timestamp: int
    expiresAt: int
    payload: dict[str, Any]
    metadata: dict[str, Any] | None = None
