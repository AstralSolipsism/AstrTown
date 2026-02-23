import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internal, api } from '../_generated/api';
import { internalAction, internalQuery } from '../_generated/server';
import { EXTERNAL_QUEUE_PREFETCH_TIMEOUT } from '../constants';

export type GatewayEventType =
  | 'conversation.started'
  | 'conversation.invited'
  | 'conversation.message'
  | 'conversation.timeout'
  | 'agent.state_changed'
  | 'action.finished'
  | 'agent.queue_refill_requested';

export type GatewayEventPriority = 0 | 1 | 2 | 3;

function requireEnv(name: string): string {
  const value = (globalThis as any)?.process?.env?.[name];
  if (!value || value.length === 0) throw new Error(`Missing env var ${name}`);
  return value;
}

const EVENT_TTL_MS: Partial<Record<GatewayEventType, number>> = {
  'conversation.started': 120_000,
  'conversation.invited': 120_000,
  'conversation.message': 120_000,
  'conversation.timeout': 120_000,
  'agent.state_changed': 30_000,
  'action.finished': 60_000,
  'agent.queue_refill_requested': EXTERNAL_QUEUE_PREFETCH_TIMEOUT,
};

function computeExpiresAt(eventType: GatewayEventType | string, now: number): number {
  const ttlMs = EVENT_TTL_MS[eventType as GatewayEventType] ?? 60_000;
  return now + ttlMs;
}

function buildIdempotencyKey(args: {
  eventType: string;
  eventAgentId: string;
  targetAgentId: string;
  worldId: string;
  eventTs: number;
}): string {
  return `${args.eventType}:${args.worldId}:${args.eventAgentId}:${args.targetAgentId}:${args.eventTs}`;
}

export const pushEventToGateway = internalAction({
  args: {
    eventType: v.string(),
    eventAgentId: v.string(),
    targetAgentId: v.string(),
    worldId: v.string(),
    payload: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
    expiresAt: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (
    _ctx: any,
    args: {
      eventType: string;
      eventAgentId: string;
      targetAgentId: string;
      worldId: string;
      payload: unknown;
      priority: GatewayEventPriority;
      expiresAt: number;
      idempotencyKey: string;
    },
  ) => {
    const gatewayUrl = requireEnv('GATEWAY_URL');
    const secret = requireEnv('GATEWAY_SECRET');

    const eventContext = {
      eventType: args.eventType,
      eventAgentId: args.eventAgentId,
      targetAgentId: args.targetAgentId,
      worldId: args.worldId,
      idempotencyKey: args.idempotencyKey,
    };

    let res: Response;
    try {
      res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/gateway/event`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-secret': secret,
          'x-idempotency-key': args.idempotencyKey,
        },
        body: JSON.stringify({
          eventType: args.eventType,
          eventAgentId: args.eventAgentId,
          targetAgentId: args.targetAgentId,
          worldId: args.worldId,
          payload: args.payload,
          priority: args.priority,
          expiresAt: args.expiresAt,
          // 兼容字段：便于旧网关/旧解析器读取。
          agentId: args.eventAgentId,
          eventData: args.payload,
          eventTs: Date.now(),
          idempotencyKey: args.idempotencyKey,
        }),
      });
    } catch (e: any) {
      console.error('Gateway push network failure', { ...eventContext, error: String(e?.message ?? e) });
      throw new Error(
        `Gateway push network failure (eventType=${args.eventType}, eventAgentId=${args.eventAgentId}, targetAgentId=${args.targetAgentId})`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Gateway push failed', {
        ...eventContext,
        status: res.status,
        statusText: res.statusText,
        responseBody: text,
      });
      throw new Error(`Failed to push event to gateway: HTTP ${res.status}`);
    }

    console.log(`[WorldEventDispatcher] 事件推送成功: eventType=${args.eventType}, eventAgentId=${args.eventAgentId}, targetAgentId=${args.targetAgentId}, gatewayUrl=${gatewayUrl}`);
    return { ok: true };
  },
});

export const listExternalControlledAgentIds = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];
    const agents = (world as any).agents;
    if (!Array.isArray(agents)) return [];
    return agents
      .filter((a: any) => typeof a?.id === 'string')
      .map((a: any) => a.id as string);
  },
});

export const listExternalControlledAgentIdsByConversation = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];

    const conversations = (world as any).conversations;
    if (!Array.isArray(conversations)) return [];

    const conversation = conversations.find((c: any) => String(c?.id) === String(args.conversationId));
    if (!conversation) return [];

    const participants = (conversation as any).participants;
    if (!Array.isArray(participants)) return [];

    const participantPlayerIds = participants
      .map((m: any) => m?.playerId)
      .filter((pId: any) => typeof pId === 'string');

    const agents = (world as any).agents;
    if (!Array.isArray(agents)) return [];

    return agents
      .filter(
        (a: any) =>
          typeof a?.id === 'string' &&
          typeof a?.playerId === 'string' &&
          participantPlayerIds.includes(a.playerId),
      )
      .map((a: any) => a.id as string);
  },
});

export const listExternalControlledAgentIdsByInvitedPlayer = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
    inviterId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];

    const conversations = (world as any).conversations;
    if (!Array.isArray(conversations)) return [];

    const conversation = conversations.find((c: any) => String(c?.id) === String(args.conversationId));
    if (!conversation) return [];

    const participants = (conversation as any).participants;
    if (!Array.isArray(participants)) return [];

    // 对于 conversation.invited：只投递给“被邀请的那一方”。
    // 数据里现有字段只有 inviterId（邀请者），因此从 participants 中排除 inviterId 来定位 invitee。
    const inviteePlayerId = participants
      .map((m: any) => m?.playerId)
      .find((pId: any) => typeof pId === 'string' && String(pId) !== String(args.inviterId));

    if (!inviteePlayerId) return [];

    const agents = (world as any).agents;
    if (!Array.isArray(agents)) return [];

    return agents
      .filter(
        (a: any) =>
          typeof a?.id === 'string' &&
          typeof a?.playerId === 'string' &&
          String(a.playerId) === String(inviteePlayerId),
      )
      .map((a: any) => a.id as string);
  },
});

function getConversationIdFromPayload(payload: unknown): string | null {
  const p: any = payload;
  const conversationId = p?.conversationId;
  return typeof conversationId === 'string' ? conversationId : null;
}

function getInviterIdFromPayload(payload: unknown): string | null {
  const p: any = payload;
  const inviterId = p?.inviterId;
  return typeof inviterId === 'string' ? inviterId : null;
}

function isConversationEventType(eventType: string): boolean {
  return eventType.startsWith('conversation.');
}

export function buildConversationStartedEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  otherParticipantIds: string[],
) {
  return {
    eventType: 'conversation.started' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      otherParticipantIds,
    },
  };
}

export function buildConversationInvitedEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  inviterId: string,
  inviterName?: string,
) {
  return {
    eventType: 'conversation.invited' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      inviterId,
      inviterName,
    },
  };
}

export function buildConversationMessageEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  messageContent: string,
  speakerId: string,
) {
  return {
    eventType: 'conversation.message' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      message: {
        content: messageContent,
        speakerId,
      },
    },
  };
}

export function buildConversationTimeoutEvent(
  worldId: string,
  agentId: string,
  conversationId: string,
  reason: 'invite_timeout' | 'idle_timeout',
) {
  return {
    eventType: 'conversation.timeout' as const,
    agentId,
    worldId,
    payload: {
      conversationId,
      reason,
    },
  };
}

export function buildAgentStateChangedEvent(
  worldId: string,
  agentId: string,
  state: string,
  position: unknown,
  nearbyPlayers: unknown,
) {
  return {
    eventType: 'agent.state_changed' as const,
    agentId,
    worldId,
    payload: {
      state,
      position,
      nearbyPlayers,
    },
  };
}

export function buildActionFinishedEvent(
  worldId: string,
  agentId: string,
  actionType: string,
  success: boolean,
  resultData: unknown,
) {
  return {
    eventType: 'action.finished' as const,
    agentId,
    worldId,
    payload: {
      actionType,
      success,
      result: resultData,
    },
  };
}

export function buildAgentQueueRefillRequestedEvent(
  worldId: string,
  agentId: string,
  playerId: string,
  requestId: string,
  remaining: number,
  lastDequeuedAt: number | undefined,
) {
  return {
    eventType: 'agent.queue_refill_requested' as const,
    agentId,
    worldId,
    payload: {
      type: 'agent.queue_refill_requested' as const,
      agentId,
      playerId,
      requestId,
      remaining,
      lastDequeuedAt,
      reason: remaining === 0 ? ('empty' as const) : ('low_watermark' as const),
    },
  };
}

export async function scheduleEventPush(
  ctx: {
    scheduler: { runAfter: (delayMs: number, ref: any, args: any) => Promise<any> };
    runQuery: (ref: any, args: any) => Promise<any>;
  },
  args: {
    eventType: GatewayEventType;
    eventAgentId: string;
    worldId: Id<'worlds'>;
    payload: unknown;
    priority: GatewayEventPriority;
  },
) {
  let targetAgentIds: string[];

  if (args.eventType === 'agent.queue_refill_requested') {
    targetAgentIds = [String(args.eventAgentId)];
  } else if (args.eventType === 'conversation.invited') {
    const conversationId = getConversationIdFromPayload(args.payload);
    const inviterId = getInviterIdFromPayload(args.payload);
    if (!conversationId || !inviterId) {
      console.warn(
        `[WorldEventDispatcher] conversation.invited 缺少必要字段, 将跳过定向投递: worldId=${args.worldId}, eventAgentId=${args.eventAgentId}, payloadKeys=${Object.keys((args.payload as any) ?? {}).join(',')}`,
      );
      targetAgentIds = [];
    } else {
      targetAgentIds = await ctx.runQuery(
        internal.aiTown.worldEventDispatcher.listExternalControlledAgentIdsByInvitedPlayer,
        { worldId: args.worldId, conversationId, inviterId },
      );
    }
  } else if (isConversationEventType(args.eventType)) {
    const conversationId = getConversationIdFromPayload(args.payload);
    if (!conversationId) {
      console.warn(
        `[WorldEventDispatcher] conversation.* 缺少 conversationId, 将跳过定向投递: eventType=${args.eventType}, worldId=${args.worldId}, eventAgentId=${args.eventAgentId}`,
      );
      targetAgentIds = [];
    } else {
      targetAgentIds = await ctx.runQuery(
        internal.aiTown.worldEventDispatcher.listExternalControlledAgentIdsByConversation,
        { worldId: args.worldId, conversationId },
      );
    }
  } else {
    targetAgentIds = await ctx.runQuery(
      internal.aiTown.worldEventDispatcher.listExternalControlledAgentIds,
      { worldId: args.worldId },
    );
  }

  if (!Array.isArray(targetAgentIds) || targetAgentIds.length === 0) {
    console.log(`[WorldEventDispatcher] 跳过事件推送: 无目标外控agent, 事件类型: ${args.eventType}, worldId: ${args.worldId}`);
    return;
  }

  const now = Date.now();
  const expiresAt = computeExpiresAt(args.eventType, now);

  for (const targetAgentId of targetAgentIds as string[]) {
    const idempotencyKey = buildIdempotencyKey({
      eventType: args.eventType,
      eventAgentId: String(args.eventAgentId),
      targetAgentId: String(targetAgentId),
      worldId: String(args.worldId),
      eventTs: now,
    });

    await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.pushEventToGateway, {
      eventType: args.eventType,
      eventAgentId: String(args.eventAgentId),
      targetAgentId: String(targetAgentId),
      worldId: String(args.worldId),
      payload: args.payload,
      priority: args.priority,
      expiresAt,
      idempotencyKey,
    });

    console.log(`[WorldEventDispatcher] 已调度事件推送: eventAgentId=${args.eventAgentId}, targetAgentId=${targetAgentId}, 事件类型: ${args.eventType}, worldId: ${args.worldId}`);
  }
}

export const scheduleConversationStarted = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    otherParticipantIds: v.array(v.string()),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildConversationStartedEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.otherParticipantIds,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationInvited = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    inviterId: v.string(),
    inviterName: v.optional(v.string()),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildConversationInvitedEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.inviterId,
      args.inviterName,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    messageContent: v.string(),
    speakerId: v.string(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildConversationMessageEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.messageContent,
      args.speakerId,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleConversationTimeout = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    conversationId: v.string(),
    reason: v.union(v.literal('invite_timeout'), v.literal('idle_timeout')),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildConversationTimeoutEvent(
      String(args.worldId),
      String(args.agentId),
      args.conversationId,
      args.reason,
    );

    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleAgentStateChanged = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    state: v.string(),
    position: v.any(),
    nearbyPlayers: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildAgentStateChangedEvent(
      String(args.worldId),
      String(args.agentId),
      args.state,
      args.position,
      args.nearbyPlayers,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleActionFinished = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    actionType: v.string(),
    success: v.boolean(),
    resultData: v.any(),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildActionFinishedEvent(
      String(args.worldId),
      String(args.agentId),
      args.actionType,
      args.success,
      args.resultData,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});

export const scheduleAgentQueueRefillRequested = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    playerId: v.string(),
    requestId: v.string(),
    remaining: v.number(),
    lastDequeuedAt: v.optional(v.number()),
    priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  },
  handler: async (ctx: any, args: any) => {
    const built = buildAgentQueueRefillRequestedEvent(
      String(args.worldId),
      String(args.agentId),
      String(args.playerId),
      String(args.requestId),
      Number(args.remaining),
      typeof args.lastDequeuedAt === 'number' ? args.lastDequeuedAt : undefined,
    );
    await scheduleEventPush(ctx, {
      eventType: built.eventType,
      eventAgentId: args.agentId,
      worldId: args.worldId,
      payload: built.payload,
      priority: args.priority,
    });
  },
});
