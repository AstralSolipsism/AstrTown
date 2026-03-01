export const PROTOCOL_VERSION = 1;

export type WsMessageBase<TType extends string, TPayload> = {
  type: TType;
  id: string;
  version: number;
  timestamp: number;
  payload: TPayload;
  metadata?: Record<string, unknown>;
};

export type WsWorldEventBase<TType extends string, TPayload> = WsMessageBase<TType, TPayload> & {
  expiresAt: number;
};

export type MemoryItem = {
  id: string;
  type:
    | 'conversation'
    | 'reflection'
    | 'relationship'
    | 'external_experience'
    | 'world_observation';
  description: string;
  importance: number;
  timestamp: number;
  relevanceScore?: number;
};

export interface MapSummary {
  width: number;
  height: number;
  tileDim: number;
  version: number;
}

export interface ZoneCard {
  zoneId: string;
  name: string;
  description: string;
  priority: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  suggestedActivities: string[];
}

export interface ObjectCard {
  instanceId: string;
  catalogKey: string;
  name: string;
  description: string;
  category: string;
  position: {
    x: number;
    y: number;
  };
  occupiedTiles: Array<{
    dx: number;
    dy: number;
  }>;
  interactionHint: string | null;
  blocksMovement: boolean;
  note: string | null;
}

export interface SemanticSnapshot {
  mapSummary: MapSummary;
  zones: ZoneCard[];
  objects: ObjectCard[];
  coordinateIndex?: Record<string, { zoneId: string; zoneName: string; priority: number }>;
}

export type ConversationStartedPayload = {
  conversationId: string;
  otherParticipantIds: string[];
};

export type ConversationInvitedPayload = {
  conversationId: string;
  inviterId: string;
  inviterName?: string;
};

export type ConversationMessagePayload = {
  conversationId: string;
  message: {
    content: string;
    speakerId: string;
  };
};

export type ConversationEndedPayload = {
  conversationId: string;
  otherParticipantId?: string;
  otherParticipantName?: string;
};

export interface ConversationTimeoutPayload {
  conversationId: string;
  reason: 'invite_timeout' | 'idle_timeout';
}

export type AgentStateChangedPayload = {
  state: string;
  position: unknown;
  nearbyPlayers: unknown;
};

export type ActionFinishedPayload = {
  actionType: string;
  success: boolean;
  result: unknown;
};

export type AgentQueueRefillRequestedPayload = {
  agentId: string;
  playerId: string;
  requestId: string;
  remaining: number;
  lastDequeuedAt?: number;
  nearbyPlayers: unknown;
  reason: 'empty' | 'low_watermark';
};

export type ConnectedMessage = WsMessageBase<
  'connected',
  {
    agentId: string;
    playerId: string;
    playerName: string;
    worldId: string;
    serverVersion: string;
    negotiatedVersion: number;
    supportedVersions: number[];
    subscribedEvents: string[];
  }
>;

export type AuthErrorMessage = WsMessageBase<
  'auth_error',
  {
    code:
      | 'INVALID_TOKEN'
      | 'TOKEN_EXPIRED'
      | 'NPC_NOT_FOUND'
      | 'ALREADY_CONNECTED'
      | 'VERSION_MISMATCH';
    message: string;
    supportedVersions?: number[];
  }
>;

export type AgentStateChangedEvent = WsWorldEventBase<
  'agent.state_changed',
  AgentStateChangedPayload
>;

export type ConversationStartedEvent = WsWorldEventBase<'conversation.started', ConversationStartedPayload>;

export type ConversationInvitedEvent = WsWorldEventBase<'conversation.invited', ConversationInvitedPayload>;

export type ConversationMessageEvent = WsWorldEventBase<
  'conversation.message',
  ConversationMessagePayload
>;

export type ConversationEndedEvent = WsWorldEventBase<'conversation.ended', ConversationEndedPayload>;

export interface ConversationTimeoutEvent
  extends WsWorldEventBase<'conversation.timeout', ConversationTimeoutPayload> {}

export type ActionFinishedEvent = WsWorldEventBase<
  'action.finished',
  ActionFinishedPayload
>;

export type AgentQueueRefillRequestedEvent = WsWorldEventBase<
  'agent.queue_refill_requested',
  AgentQueueRefillRequestedPayload
>;

export type SocialRelationshipProposedPayload = {
  proposerId: string;
  targetPlayerId: string;
  status: string;
};

export type SocialRelationshipProposedEvent = WsWorldEventBase<
  'social.relationship_proposed',
  SocialRelationshipProposedPayload
>;

export type SocialRelationshipRespondedPayload = {
  proposerId: string;
  responderId: string;
  status: string;
  accept: boolean;
};

export type SocialRelationshipRespondedEvent = WsWorldEventBase<
  'social.relationship_responded',
  SocialRelationshipRespondedPayload
>;

export type WorldEvent =
  | AgentStateChangedEvent
  | ConversationStartedEvent
  | ConversationInvitedEvent
  | ConversationMessageEvent
  | ConversationEndedEvent
  | ConversationTimeoutEvent
  | ActionFinishedEvent
  | AgentQueueRefillRequestedEvent
  | SocialRelationshipProposedEvent
  | SocialRelationshipRespondedEvent;

export type MoveToCommand = WsMessageBase<'command.move_to', { targetPlayerId: string }>;

export type SayCommand = WsMessageBase<
  'command.say',
  {
    conversationId: string;
    text: string;
    leaveAfter: boolean;
    metadata?: Record<string, unknown>;
  }
>;

export type SetActivityCommand = WsMessageBase<
  'command.set_activity',
  {
    description: string;
    emoji: string;
    duration: number;
    metadata?: Record<string, unknown>;
  }
>;

export type AcceptInviteCommand = WsMessageBase<
  'command.accept_invite',
  { conversationId: string; metadata?: Record<string, unknown> }
>;

export type RejectInviteCommand = WsMessageBase<
  'command.reject_invite',
  { conversationId: string; metadata?: Record<string, unknown> }
>;

export type InviteCommand = WsMessageBase<
  'command.invite',
  { targetPlayerId: string; metadata?: Record<string, unknown> }
>;

export type StartConversationCommand = WsMessageBase<
  'command.start_conversation',
  { targetPlayerId: string; metadata?: Record<string, unknown> }
>;

export type LeaveConversationCommand = WsMessageBase<
  'command.leave_conversation',
  { conversationId: string; metadata?: Record<string, unknown> }
>;

export type ContinueDoingCommand = WsMessageBase<
  'command.continue_doing',
  { activity: { description: string; emoji: string; until: number }; metadata?: Record<string, unknown> }
>;

export type DoSomethingCommand = WsMessageBase<
  'command.do_something',
  { actionType: string; args?: unknown; metadata?: Record<string, unknown> }
>;

export type ProposeRelationshipCommand = WsMessageBase<
  'command.propose_relationship',
  { targetPlayerId: string; status: string; metadata?: Record<string, unknown> }
>;

export type RespondRelationshipCommand = WsMessageBase<
  'command.respond_relationship',
  { proposerId: string; accept: boolean; metadata?: Record<string, unknown> }
>;

export type CommandAck = {
  type: 'command.ack';
  id: string;
  timestamp: number;
  payload: {
    commandId: string;
    status: 'accepted' | 'rejected';
    /** 语义标注：queued 表示仅“入队/受理成功”，不代表后端执行成功 */
    ackSemantics: 'queued';
    reason?: string;
    inputId?: string;
  };
};

export type EventAck = {
  type: 'event.ack';
  id: string;
  timestamp: number;
  payload: { eventId: string };
};

export type PingMessage = { type: 'ping'; id: string; timestamp: number; payload: {} };
export type PongMessage = { type: 'pong'; id: string; timestamp: number; payload: {} };

export type WsOutboundMessage =
  | ConnectedMessage
  | AuthErrorMessage
  | AgentStateChangedEvent
  | ConversationStartedEvent
  | ConversationInvitedEvent
  | ConversationMessageEvent
  | ConversationEndedEvent
  | ConversationTimeoutEvent
  | ActionFinishedEvent
  | AgentQueueRefillRequestedEvent
  | SocialRelationshipProposedEvent
  | SocialRelationshipRespondedEvent
  | CommandAck
  | PingMessage;

export type CommandBatchItem = {
  id: string;
  type: `command.${
    | 'move_to'
    | 'say'
    | 'set_activity'
    | 'accept_invite'
    | 'reject_invite'
    | 'invite'
    | 'start_conversation'
    | 'leave_conversation'
    | 'continue_doing'
    | 'do_something'
    | 'propose_relationship'
    | 'respond_relationship'}`;
  payload: Record<string, unknown>;
};

export type CommandBatchMessage = WsMessageBase<'command.batch', { commands: CommandBatchItem[] }>;

export type WsInboundMessage =
  | MoveToCommand
  | SayCommand
  | SetActivityCommand
  | AcceptInviteCommand
  | RejectInviteCommand
  | InviteCommand
  | StartConversationCommand
  | LeaveConversationCommand
  | ContinueDoingCommand
  | DoSomethingCommand
  | ProposeRelationshipCommand
  | RespondRelationshipCommand
  | CommandBatchMessage
  | EventAck
  | PongMessage;

export type ConnectionState = 'connecting' | 'authenticated' | 'closing' | 'closed';

export type BotBinding = {
  token: string;
  agentId: string;
  playerId: string;
  worldId: string;
  expiresAt: number;
  isActive: boolean;
};

export type BotSession = {
  token: string;
  agentId: string;
  playerId: string;
  worldId: string;
  playerName: string;
  negotiatedVersion: number;
  subscribedEvents: string[];
  connectedAt: number;
};

export type EventPriority = 0 | 1 | 2 | 3;
