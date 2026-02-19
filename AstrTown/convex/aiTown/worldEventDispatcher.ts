import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internal, api } from '../_generated/api';
import { internalAction, internalQuery } from '../_generated/server';

export type GatewayEventType =
  | 'conversation.started'
  | 'conversation.invited'
  | 'conversation.message'
  | 'agent.state_changed'
  | 'action.finished';

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
  'agent.state_changed': 30_000,
  'action.finished': 60_000,
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
      .filter((a: any) => a?.isExternalControlled === true && typeof a?.id === 'string')
      .map((a: any) => a.id as string);
  },
});

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
  const targetAgentIds = await ctx.runQuery(
    internal.aiTown.worldEventDispatcher.listExternalControlledAgentIds,
    { worldId: args.worldId },
  );
  if (!Array.isArray(targetAgentIds) || targetAgentIds.length === 0) {
    console.log(`[WorldEventDispatcher] 跳过事件推送: 世界中无外部控制的agent, 事件类型: ${args.eventType}, worldId: ${args.worldId}`);
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
