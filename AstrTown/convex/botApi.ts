import { httpAction, mutation, query } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { insertInput } from './aiTown/insertInput';
import type { ExternalEventItem } from './aiTown/agent';
import * as memory from './agent/memory';
import * as embeddingsCache from './agent/embeddingsCache';

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  });
}

function unauthorized(code: string, message: string) {
  return jsonResponse({ valid: false, status: 'rejected', code, message }, { status: 401 });
}

function badRequest(code: string, message: string) {
  return jsonResponse({ valid: false, status: 'rejected', code, message }, { status: 400 });
}

function conflict(code: string, message: string) {
  return jsonResponse({ valid: false, status: 'rejected', code, message }, { status: 409 });
}

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

export type VerifiedBotToken = {
  token: string;
  agentId: string;
  playerId: string;
  worldId: Id<'worlds'>;
  expiresAt: number;
  isActive: boolean;
};

export const verifyBotTokenQuery = query({
  args: { token: v.string() },
  handler: async (ctx: any, args: any) => {
    const rec = await ctx.db
      .query('botTokens')
      .withIndex('token', (q: any) => q.eq('token', args.token))
      .unique();
    if (!rec) {
      return { valid: false as const, code: 'INVALID_TOKEN', message: 'Token not found' };
    }
    if (!rec.isActive) {
      return { valid: false as const, code: 'INVALID_TOKEN', message: 'Token is inactive' };
    }
    if (rec.expiresAt !== 0 && Date.now() > rec.expiresAt) {
      return { valid: false as const, code: 'TOKEN_EXPIRED', message: 'Token expired' };
    }
    return {
      valid: true as const,
      binding: {
        token: rec.token,
        agentId: rec.agentId,
        playerId: rec.playerId,
        worldId: rec.worldId,
        expiresAt: rec.expiresAt,
        isActive: rec.isActive,
      } satisfies VerifiedBotToken,
    };
  },
});

export async function verifyBotToken(ctx: { runQuery: ActionCtx['runQuery'] }, token: string) {
  return await ctx.runQuery((api as any).botApi.verifyBotTokenQuery as any, { token });
}

type CommandType =
  | 'move_to'
  | 'say'
  | 'start_conversation'
  | 'accept_invite'
  | 'reject_invite'
  | 'leave_conversation'
  | 'continue_doing'
  | 'do_something';

type CommandMapping = {
  inputName:
    | 'finishDoSomething'
    | 'externalBotSendMessage'
    | 'startConversation'
    | 'acceptInvite'
    | 'rejectInvite'
    | 'leaveConversation';
  buildInputArgs: (p: { agentId: string; playerId: string; args: any }) => any;
};

const commandMappings: Record<CommandType, CommandMapping> = {
  move_to: {
    inputName: 'finishDoSomething',
    buildInputArgs: ({ agentId, args }) => ({
      operationId: crypto.randomUUID(),
      agentId,
      destination: args?.destination,
    }),
  },
  say: {
    inputName: 'externalBotSendMessage',
    buildInputArgs: ({ agentId, args }) => ({
      agentId,
      conversationId: args?.conversationId,
      timestamp: Date.now(),
      leaveConversation: !!args?.leaveAfter,
    }),
  },

  start_conversation: {
    inputName: 'startConversation',
    buildInputArgs: ({ playerId, args }) => ({
      playerId,
      invitee: args?.invitee,
    }),
  },
  accept_invite: {
    inputName: 'acceptInvite',
    buildInputArgs: ({ playerId, args }) => ({
      playerId,
      conversationId: args?.conversationId,
    }),
  },
  reject_invite: {
    inputName: 'rejectInvite',
    buildInputArgs: ({ playerId, args }) => ({
      playerId,
      conversationId: args?.conversationId,
    }),
  },
  leave_conversation: {
    inputName: 'leaveConversation',
    buildInputArgs: ({ playerId, args }) => ({
      playerId,
      conversationId: args?.conversationId,
    }),
  },
  continue_doing: {
    inputName: 'finishDoSomething',
    buildInputArgs: ({ agentId, args }) => ({
      operationId: crypto.randomUUID(),
      agentId,
      activity: args?.activity,
    }),
  },
  do_something: {
    inputName: 'finishDoSomething',
    buildInputArgs: ({ agentId, args }) => ({
      operationId: crypto.randomUUID(),
      agentId,
      destination: args?.destination,
      invitee: args?.invitee,
      activity: args?.activity,
    }),
  },
};

type PostCommandEnqueueMode = 'immediate' | 'queue';

const supportedExternalEventKinds = new Set<ExternalEventItem['kind']>([
  'move_to',
  'say',
  'emote',
  'start_conversation',
  'accept_invite',
  'reject_invite',
  'leave_conversation',
  'continue_doing',
  'do_something',
]);

function normalizeExternalEventKind(kind: string, fieldPath: string): ExternalEventItem['kind'] {
  if (!supportedExternalEventKinds.has(kind as ExternalEventItem['kind'])) {
    throw new ParameterValidationError(`${fieldPath} has unsupported value: ${kind}`);
  }
  return kind as ExternalEventItem['kind'];
}

function normalizeExternalEventPriority(
  priority: number | undefined,
  fieldPath: string,
): ExternalEventItem['priority'] {
  const finalPriority = priority ?? 2;
  if (!Number.isInteger(finalPriority) || finalPriority < 0 || finalPriority > 3) {
    throw new ParameterValidationError(`${fieldPath} must be an integer between 0 and 3`);
  }
  return finalPriority as ExternalEventItem['priority'];
}

function normalizeExternalEventArgs(args: any, fieldPath: string): Record<string, any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ParameterValidationError(`${fieldPath} must be an object`);
  }
  return args;
}

function mapCommandTypeToExternalEventKind(commandType: CommandType): ExternalEventItem['kind'] {
  switch (commandType) {
    case 'move_to':
      return 'move_to';
    case 'say':
      return 'say';
    case 'start_conversation':
      return 'start_conversation';
    case 'accept_invite':
      return 'accept_invite';
    case 'reject_invite':
      return 'reject_invite';
    case 'leave_conversation':
      return 'leave_conversation';
    case 'continue_doing':
      return 'continue_doing';
    case 'do_something':
      return 'do_something';
  }
}

function defaultQueuePriorityForCommand(commandType: CommandType): ExternalEventItem['priority'] {
  // 邀请响应需要插队进入 priorityQueue，避免 invited 状态下无法及时消费。
  if (commandType === 'accept_invite' || commandType === 'reject_invite') {
    return 1;
  }
  return 2;
}

function buildExternalEventFromCommand(
  commandType: CommandType,
  normalizedArgs: any,
  now: number,
): ExternalEventItem {
  const expiresAt =
    normalizedArgs?.expiresAt !== undefined && typeof normalizedArgs.expiresAt !== 'number'
      ? (() => {
          throw new ParameterValidationError('args.expiresAt must be number');
        })()
      : normalizedArgs?.expiresAt;

  return {
    eventId: crypto.randomUUID(),
    kind: mapCommandTypeToExternalEventKind(commandType),
    args: normalizeExternalEventArgs(normalizedArgs, 'args'),
    priority: defaultQueuePriorityForCommand(commandType),
    enqueueTs: now,
    expiresAt,
    source: 'gateway',
  };
}

async function loadWorldAndAgent(
  ctx: { runQuery: ActionCtx['runQuery'] },
  worldId: Id<'worlds'>,
  agentId: string,
) {
  const world = await ctx.runQuery((api as any).botApi.getWorldById as any, { worldId });
  if (!world) {
    throw new ParameterValidationError('World not found');
  }
  const agent = world.agents?.find?.((candidate: any) => candidate?.id === agentId);
  if (!agent) {
    throw new ParameterValidationError('Agent not found');
  }
  return { world, agent };
}

export const tokenDocByToken = query({
  args: { token: v.string() },
  handler: async (ctx: any, args: any) => {
    const tokenDoc = await ctx.db
      .query('botTokens')
      .withIndex('token', (q: any) => q.eq('token', args.token))
      .unique();
    if (!tokenDoc) return null;
    return {
      id: tokenDoc._id,
      lastIdempotencyKey: tokenDoc.lastIdempotencyKey,
      lastIdempotencyResult: tokenDoc.lastIdempotencyResult,
    };
  },
});

export const updatePlayerDescription = mutation({
  args: {
    token: v.string(),
    playerId: v.string(),
    description: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const verified = await ctx.runQuery((api as any).botApi.verifyBotTokenQuery as any, { token: args.token });
    if (!verified.valid) {
      throw new Error(verified.message);
    }

    const playerId = args.playerId?.trim?.();
    const description = args.description?.trim?.();

    if (!playerId) {
      throw new Error('Missing playerId');
    }
    if (!description) {
      throw new Error('Missing description');
    }
    if (description.length > 2000) {
      throw new Error('description too long');
    }

    // playerDescriptions is indexed by [worldId, playerId], so we scope by token-bound worldId.
    const existing = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q: any) => q.eq('worldId', verified.binding.worldId).eq('playerId', playerId))
      .unique();

    if (!existing) {
      throw new Error('playerDescription not found');
    }

    await ctx.db.patch(existing._id, { description });
    return { ok: true };
  },
});

export const patchTokenUsage = mutation({
  args: {
    tokenDocId: v.id('botTokens'),
    lastUsedAt: v.number(),
    lastIdempotencyKey: v.string(),
    lastIdempotencyResult: v.any(),
  },
  handler: async (ctx: any, args: any) => {
    await ctx.db.patch(args.tokenDocId, {
      lastUsedAt: args.lastUsedAt,
      lastIdempotencyKey: args.lastIdempotencyKey,
      lastIdempotencyResult: args.lastIdempotencyResult,
    });
  },
});

export const writeExternalBotMessage = mutation({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
    agentId: v.string(),
    playerId: v.string(),
    text: v.string(),
    messageUuid: v.string(),
    leaveConversation: v.boolean(),
  },
  handler: async (ctx: any, args: any) => {
    await ctx.db.insert('messages', {
      conversationId: args.conversationId,
      author: args.playerId,
      text: args.text,
      messageUuid: args.messageUuid,
      worldId: args.worldId,
    });
    return await insertInput(ctx as any, args.worldId, 'externalBotSendMessage' as any, {
      agentId: args.agentId,
      conversationId: args.conversationId,
      text: args.text,
      timestamp: Date.now(),
      leaveConversation: args.leaveConversation,
    } as any);
  },
});

export const getWorldById = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx: any, args: any) => {
    return await ctx.db.get(args.worldId);
  },
});

export const getExternalQueueStatus = query({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error('World not found');
    }
    const agent = world.agents?.find?.((candidate: any) => candidate?.id === args.agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    const priorityQueueDepth = Array.isArray(agent.externalPriorityQueue)
      ? agent.externalPriorityQueue.length
      : 0;
    const normalQueueDepth = Array.isArray(agent.externalEventQueue)
      ? agent.externalEventQueue.length
      : 0;

    const queueState = agent.externalQueueState ?? {
      prefetch: {
        retries: 0,
        waiting: false,
      },
      idle: {
        mode: 'active',
        consecutivePrefetchMisses: 0,
      },
    };

    return {
      worldId: args.worldId,
      agentId: args.agentId,
      isExternalControlled: true,
      queueDepth: priorityQueueDepth + normalQueueDepth,
      priorityQueueDepth,
      normalQueueDepth,
      prefetch: queueState.prefetch,
      idle: queueState.idle,
      lastDequeuedAt: queueState.lastDequeuedAt ?? null,
    };
  },
});

export const postCommandBatch = mutation({
  args: {
    worldId: v.id('worlds'),
    agentId: v.string(),
    events: v.array(
      v.object({
        eventId: v.string(),
        kind: v.string(),
        args: v.any(),
        priority: v.optional(v.number()),
        expiresAt: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx: any, args: any) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new ParameterValidationError('World not found');
    }
    const agent = world.agents?.find?.((candidate: any) => candidate?.id === args.agentId);
    if (!agent) {
      throw new ParameterValidationError('Agent not found');
    }

    const now = Date.now();
    const events: ExternalEventItem[] = args.events.map((event: any, index: number) => {
      if (event.expiresAt !== undefined && typeof event.expiresAt !== 'number') {
        throw new ParameterValidationError(`events[${index}].expiresAt must be number`);
      }
      return {
        eventId: event.eventId,
        kind: normalizeExternalEventKind(event.kind, `events[${index}].kind`),
        args: normalizeExternalEventArgs(event.args, `events[${index}].args`),
        priority: normalizeExternalEventPriority(event.priority, `events[${index}].priority`),
        enqueueTs: now,
        expiresAt: event.expiresAt,
        source: 'gateway',
      };
    });

    return await insertInput(ctx as any, args.worldId, 'enqueueExternalEvents' as any, {
      agentId: args.agentId,
      events,
    } as any);
  },
});

export const postCommandBatchHttp = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  const idemKey = request.headers.get('x-idempotency-key');
  if (!idemKey) return badRequest('INVALID_ARGS', 'Missing X-Idempotency-Key');

  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    const message = String(e?.message ?? 'Request body is not valid JSON');
    return badRequest('INVALID_JSON', message);
  }

  const worldId = body?.worldId;
  const agentId = body?.agentId;
  const events = body?.events;

  if (agentId !== verified.binding.agentId) {
    return unauthorized('AUTH_FAILED', 'agentId mismatch');
  }
  if (worldId !== verified.binding.worldId) {
    return unauthorized('AUTH_FAILED', 'worldId mismatch');
  }
  if (!Array.isArray(events) || events.length === 0) {
    return badRequest('INVALID_ARGS', 'events must be a non-empty array');
  }

  const tokenDoc = await ctx.runQuery((api as any).botApi.tokenDocByToken as any, { token });
  if (!tokenDoc) return unauthorized('INVALID_TOKEN', 'Token not found');

  if (tokenDoc.lastIdempotencyKey && tokenDoc.lastIdempotencyKey === idemKey) {
    if (!tokenDoc.lastIdempotencyResult) {
      return jsonResponse(
        { status: 'conflict', message: 'Duplicate request but history result not found' },
        { status: 409 },
      );
    }
    return jsonResponse(tokenDoc.lastIdempotencyResult, { status: 200 });
  }

  let responseBody: any;
  try {
    const inputId = await ctx.runMutation((api as any).botApi.postCommandBatch as any, {
      worldId,
      agentId,
      events,
    });
    responseBody = { status: 'accepted', inputId };
  } catch (e: any) {
    const rawMessage = String(e?.message ?? e);
    if (e instanceof ParameterValidationError) {
      responseBody = { valid: false, status: 'rejected', code: 'INVALID_ARGS', message: rawMessage };
    } else {
      responseBody = { valid: false, status: 'rejected', code: 'INTERNAL_ERROR', message: 'internal failure' };
    }
  }

  try {
    await ctx.runMutation((api as any).botApi.patchTokenUsage as any, {
      tokenDocId: tokenDoc.id,
      lastUsedAt: Date.now(),
      lastIdempotencyKey: idemKey,
      lastIdempotencyResult: responseBody,
    });
  } catch {
    // ignore
  }

  if (responseBody?.status === 'accepted') return jsonResponse(responseBody);
  const status = responseBody?.code === 'INTERNAL_ERROR' ? 500 : 400;
  return jsonResponse(responseBody, { status });
});

class ParameterValidationError extends Error {
  code = 'INVALID_ARGS' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ParameterValidationError';
  }
}

function isKnownEngineParamError(message: string): boolean {
  // Engine 层当前存在仅靠字符串 message 的参数错误，这里收敛到明确模式，避免宽泛关键词误判。
  return [
    /^Couldn't find (agent|player|conversation): /,
    /^Can't move when in a conversation\./,
    /^Non-integral destination: /,
    /^Invalid input: /,
    /^World for engine .+ not found$/,
  ].some((pattern) => pattern.test(message));
}

async function normalizeCommandArgsForEngine(
  ctx: ActionCtx,
  verified: { binding: VerifiedBotToken },
  commandType: CommandType,
  args: any,
): Promise<any> {
  if (!args || typeof args !== 'object') {
    throw new ParameterValidationError('args must be an object');
  }

  if (commandType === 'move_to') {
    const targetPlayerId = args?.targetPlayerId;
    if (!targetPlayerId || typeof targetPlayerId !== 'string') {
      throw new ParameterValidationError('Missing targetPlayerId');
    }
    const world = await ctx.runQuery((api as any).botApi.getWorldById as any, { worldId: verified.binding.worldId });
    if (!world) {
      throw new ParameterValidationError('World not found');
    }
    const targetPlayer = world.players?.find?.((p: any) => p?.id === targetPlayerId);
    if (!targetPlayer?.position) {
      throw new ParameterValidationError(`Target player not found: ${targetPlayerId}`);
    }
    return {
      ...args,
      destination: targetPlayer.position,
    };
  }

  if (commandType === 'say') {
    if (!args?.conversationId || typeof args.conversationId !== 'string') {
      throw new ParameterValidationError('Missing conversationId');
    }
    if (!args?.text || typeof args.text !== 'string') {
      throw new ParameterValidationError('Missing text');
    }
  }

  return args;
}

export const postCommand = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  const idemKey = request.headers.get('x-idempotency-key');
  if (!idemKey) return badRequest('INVALID_ARGS', 'Missing X-Idempotency-Key');

  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    const message = String(e?.message ?? 'Request body is not valid JSON');
    return badRequest('INVALID_JSON', message);
  }
  const agentId = body?.agentId;
  const commandType = body?.commandType as CommandType | undefined;
  const args = body?.args;
  const enqueueMode = body?.enqueueMode as PostCommandEnqueueMode | undefined;

  if (agentId !== verified.binding.agentId) {
    return unauthorized('AUTH_FAILED', 'agentId mismatch');
  }
  if (!commandType || !(commandType in commandMappings)) {
    return badRequest('INVALID_ARGS', 'Unknown commandType');
  }
  if (
    enqueueMode !== undefined &&
    enqueueMode !== 'immediate' &&
    enqueueMode !== 'queue'
  ) {
    return badRequest('INVALID_ARGS', 'enqueueMode must be immediate or queue');
  }

  const tokenDoc = await ctx.runQuery((api as any).botApi.tokenDocByToken as any, { token });
  if (!tokenDoc) return unauthorized('INVALID_TOKEN', 'Token not found');

  if (tokenDoc.lastIdempotencyKey && tokenDoc.lastIdempotencyKey === idemKey) {
    if (!tokenDoc.lastIdempotencyResult) {
      return jsonResponse(
        { status: 'conflict', message: 'Duplicate request but history result not found' },
        { status: 409 },
      );
    }
    return jsonResponse(tokenDoc.lastIdempotencyResult, { status: 200 });
  }

  const mapping = commandMappings[commandType];
  let responseBody: any;

  try {
    const normalizedArgs = await normalizeCommandArgsForEngine(ctx, verified, commandType, args);
    let inputId;
    console.log('[botApi.postCommand] enqueue input', {
      commandType,
      worldId: String(verified.binding.worldId),
      agentId: verified.binding.agentId,
      playerId: verified.binding.playerId,
      ctxHasDb: Boolean((ctx as any)?.db),
      usingRunMutation: true,
      enqueueMode: enqueueMode ?? 'immediate',
    });
    if (enqueueMode === 'queue') {
      const { agent } = await loadWorldAndAgent(
        ctx,
        verified.binding.worldId,
        verified.binding.agentId,
      );
      const now = Date.now();
      const queueEvent = buildExternalEventFromCommand(commandType, normalizedArgs, now);
      inputId = await ctx.runMutation((api as any).aiTown.main.sendInput as any, {
        worldId: verified.binding.worldId,
        name: 'enqueueExternalEvents',
        args: {
          agentId: verified.binding.agentId,
          events: [queueEvent],
        },
      });
    } else if (commandType === 'say') {
      inputId = await ctx.runMutation((api as any).botApi.writeExternalBotMessage as any, {
        worldId: verified.binding.worldId,
        conversationId: normalizedArgs?.conversationId,
        agentId: verified.binding.agentId,
        playerId: verified.binding.playerId,
        text: normalizedArgs?.text,
        messageUuid: normalizedArgs?.messageUuid ?? crypto.randomUUID(),
        leaveConversation: !!normalizedArgs?.leaveAfter,
      });
    } else if (commandType === 'do_something' && normalizedArgs?.actionType === 'go_home_and_sleep') {
      // 阶段2：Agent 天生外控，不再支持切换模式。这里改为 no-op，保持接口兼容。
      inputId = await ctx.runMutation((api as any).aiTown.main.sendInput as any, {
        worldId: verified.binding.worldId,
        name: 'finishDoSomething',
        args: {
          operationId: crypto.randomUUID(),
          agentId: verified.binding.agentId,
          activity: { description: 'idle', emoji: '😴', until: Date.now() + 60_000 },
        },
      });
    } else {
      inputId = await ctx.runMutation((api as any).aiTown.main.sendInput as any, {
        worldId: verified.binding.worldId,
        name: mapping.inputName,
        args: {
          ...mapping.buildInputArgs({
            agentId: verified.binding.agentId,
            playerId: verified.binding.playerId,
            args: normalizedArgs,
          }),
        },
      });
    }
    responseBody = { status: 'accepted', inputId };
  } catch (e: any) {
    const rawMessage = String(e?.message ?? e);
    console.error('[botApi.postCommand] enqueue failed', {
      commandType,
      worldId: String(verified.binding.worldId),
      agentId: verified.binding.agentId,
      err: rawMessage,
    });
    if (e instanceof ParameterValidationError || isKnownEngineParamError(rawMessage)) {
      responseBody = { valid: false, status: 'rejected', code: 'INVALID_ARGS', message: rawMessage };
    } else {
      responseBody = { valid: false, status: 'rejected', code: 'INTERNAL_ERROR', message: 'internal failure' };
    }
  }

  try {
    await ctx.runMutation((api as any).botApi.patchTokenUsage as any, {
      tokenDocId: tokenDoc.id,
      lastUsedAt: Date.now(),
      lastIdempotencyKey: idemKey,
      lastIdempotencyResult: responseBody,
    });
  } catch (e: any) {
    const message = String(e?.message ?? e ?? 'unknown error');
    console.error('[botApi.postCommand] failed to patch token usage:', message);
  }

  if (responseBody?.status === 'accepted') return jsonResponse(responseBody);
  const status = responseBody?.code === 'INTERNAL_ERROR' ? 500 : 400;
  return jsonResponse(responseBody, { status });
});

export const postEventAck = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  // Current AstrTown does not push events yet in this task scope; accept ACK for forward compatibility.
  try {
    await request.json();
  } catch {
    // ignore
  }
  return jsonResponse({ received: true });
});

export const getWorldState = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  const world = await ctx.runQuery((api as any).botApi.getWorldById as any, { worldId: verified.binding.worldId });
  if (!world) return badRequest('WORLD_NOT_FOUND', 'World not found');
  return jsonResponse({ worldId: verified.binding.worldId, world });
});

export const getAgentStatus = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  const url = new URL(request.url);
  const agentId = url.searchParams.get('agentId');
  if (!agentId) return badRequest('INVALID_ARGS', 'Missing agentId');
  if (agentId !== verified.binding.agentId) return unauthorized('AUTH_FAILED', 'agentId mismatch');

  const world = await ctx.runQuery((api as any).botApi.getWorldById as any, { worldId: verified.binding.worldId });
  if (!world) return badRequest('WORLD_NOT_FOUND', 'World not found');

  const agent = world.agents.find((a: any) => a.id === agentId);
  const player = world.players.find((p: any) => p.id === verified.binding.playerId);
  if (!agent || !player) return badRequest('NPC_NOT_FOUND', 'Agent/player not found');

  return jsonResponse({
    agentId,
    playerId: verified.binding.playerId,
    position: player.position,
    isExternalControlled: true,
    currentActivity: player.activity ?? null,
    inConversation:
      world.conversations.find((c: any) => c.participants?.some?.((m: any) => m.playerId === player.id))?.id ??
      null,
    pathfinding: player.pathfinding ?? null,
    operationInProgress: agent.inProgressOperation?.name ?? null,
    lastInputTime: world._creationTime ?? 0,
  });
});


export const postTokenValidate = httpAction(async (ctx: ActionCtx, request: Request) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
  const token = body?.token;
  if (!token || typeof token !== 'string') {
    return badRequest('INVALID_ARGS', 'Missing token');
  }
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) {
    return jsonResponse({ valid: false, code: verified.code, message: verified.message }, { status: 401 });
  }
  return jsonResponse({
    valid: true,
    agentId: verified.binding.agentId,
    playerId: verified.binding.playerId,
    worldId: verified.binding.worldId,
  });
});

export const createBotToken = mutation({
  args: {
    agentId: v.string(),
    playerId: v.string(),
    userId: v.optional(v.id('users')),
    worldId: v.id('worlds'),
    expiresAt: v.number(),
    description: v.optional(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const now = Date.now();
    await ctx.db.insert('botTokens', {
      token,
      agentId: args.agentId,
      playerId: args.playerId,
      userId: args.userId,
      worldId: args.worldId,
      createdAt: now,
      expiresAt: args.expiresAt,
      isActive: true,
      lastUsedAt: undefined,
      description: args.description,
    });
    return { token };
  },
});

export const postDescriptionUpdate = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }

  const playerId = body?.playerId;
  const description = body?.description;

  if (!playerId || typeof playerId !== 'string') {
    return badRequest('INVALID_ARGS', 'Missing playerId');
  }
  if (!description || typeof description !== 'string') {
    return badRequest('INVALID_ARGS', 'Missing description');
  }

  try {
    await ctx.runMutation((api as any).botApi.updatePlayerDescription as any, {
      token,
      playerId,
      description,
    });
  } catch (e: any) {
    const message = String(e?.message ?? e);
    return badRequest('INVALID_ARGS', message);
  }

  return jsonResponse({ ok: true });
});

export const postTokenCreate = httpAction(async (ctx: ActionCtx, request: Request) => {
  const adminSecret = process.env.BOT_ADMIN_SECRET;
  const provided = parseBearerToken(request);
  if (!adminSecret || !provided || provided !== adminSecret) {
    return unauthorized('AUTH_FAILED', 'Unauthorized');
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
  if (!body?.worldId || !body?.agentId || !body?.playerId) {
    return badRequest('INVALID_ARGS', 'Missing worldId/agentId/playerId');
  }
  let res: any;
  try {
    res = await ctx.runMutation((api as any).botApi.createBotToken as any, {
      worldId: body.worldId,
      agentId: body.agentId,
      playerId: body.playerId,
      expiresAt: body.expiresAt ?? 0,
      description: body.description,
    });
  } catch (e: any) {
    const message = String(e?.message ?? e ?? 'Failed to create bot token');
    return badRequest('INVALID_ARGS', message);
  }
  return jsonResponse(res);
});

export const postMemorySearch = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');

  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    const message = String(e?.message ?? 'Request body is not valid JSON');
    return badRequest('INVALID_JSON', message);
  }

  const queryText = body?.queryText;
  const limit = body?.limit ?? 3;

  if (!queryText || typeof queryText !== 'string') {
    return badRequest('INVALID_ARGS', 'Missing queryText');
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > 50) {
    return badRequest('INVALID_ARGS', 'limit must be an integer between 1 and 50');
  }

  try {
    const embedding = await embeddingsCache.fetch(ctx, queryText);

    const memories = await memory.searchMemories(
      ctx,
      verified.binding.playerId as any,
      embedding,
      limit,
    );

    return jsonResponse({
      ok: true,
      memories: memories.map((m) => ({
        description: m.description,
        importance: m.importance,
      })),
    });
  } catch (error: any) {
    return jsonResponse({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
  }
});
