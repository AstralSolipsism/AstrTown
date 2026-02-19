import { httpAction, mutation, query } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { api } from './_generated/api';
import { insertInput } from './aiTown/insertInput';

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
  | 'leave_conversation'
  | 'continue_doing'
  | 'do_something';

type CommandMapping = {
  inputName:
    | 'finishDoSomething'
    | 'externalBotSendMessage'
    | 'startConversation'
    | 'acceptInvite'
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

  if (agentId !== verified.binding.agentId) {
    return unauthorized('AUTH_FAILED', 'agentId mismatch');
  }
  if (!commandType || !(commandType in commandMappings)) {
    return badRequest('INVALID_ARGS', 'Unknown commandType');
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
    });
    if (commandType === 'say') {
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
      inputId = await ctx.runMutation((api as any).aiTown.main.sendInput as any, {
        worldId: verified.binding.worldId,
        name: 'setExternalControl',
        args: {
          agentId: verified.binding.agentId,
          enabled: false,
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
    isExternalControlled: agent.isExternalControlled ?? false,
    currentActivity: player.activity ?? null,
    inConversation:
      world.conversations.find((c: any) => c.participants?.some?.((m: any) => m.playerId === player.id))?.id ??
      null,
    pathfinding: player.pathfinding ?? null,
    operationInProgress: agent.inProgressOperation?.name ?? null,
    lastInputTime: world._creationTime ?? 0,
  });
});

export const postControl = httpAction(async (ctx: ActionCtx, request: Request) => {
  const token = parseBearerToken(request);
  if (!token) return unauthorized('AUTH_FAILED', 'Missing bearer token');
  const verified = await verifyBotToken(ctx, token);
  if (!verified.valid) return unauthorized(verified.code, verified.message);

  console.log('[botApi.postControl] token verified', {
    tokenPrefix: token.slice(0, 8),
    agentId: verified.binding.agentId,
    playerId: verified.binding.playerId,
    worldId: String(verified.binding.worldId),
  });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
  const enabled = body?.enabled;

  if (typeof enabled !== 'boolean') {
    return badRequest('INVALID_ARGS', 'enabled must be boolean');
  }

  const agentId = verified.binding.agentId;

  console.log('[botApi.postControl] before getWorldById', {
    agentId,
    worldId: String(verified.binding.worldId),
    enabled,
  });

  let world: any;
  try {
    world = await ctx.runQuery((api as any).botApi.getWorldById as any, { worldId: verified.binding.worldId });
    console.log('[botApi.postControl] getWorldById result', {
      worldId: String(verified.binding.worldId),
      found: Boolean(world),
    });
  } catch (e: any) {
    console.error('[botApi.postControl] getWorldById threw', {
      worldId: String(verified.binding.worldId),
      err: String(e?.message ?? e),
    });
    throw e;
  }
  if (!world) return badRequest('WORLD_NOT_FOUND', 'World not found');
  const agent = world.agents.find((a: any) => a.id === agentId);
  console.log('[botApi.postControl] find agent result', {
    agentId,
    worldId: String(verified.binding.worldId),
    found: Boolean(agent),
  });
  if (!agent) return badRequest('NPC_NOT_FOUND', 'Agent not found');

  console.log('[botApi.postControl] enqueue setExternalControl', {
    agentId,
    worldId: String(verified.binding.worldId),
    enabled,
    ctxHasDb: Boolean((ctx as any)?.db),
    usingRunMutation: true,
  });

  try {
    await ctx.runMutation((api as any).aiTown.main.sendInput as any, {
      worldId: verified.binding.worldId,
      name: 'setExternalControl',
      args: {
        agentId,
        enabled,
      },
    });
  } catch (e: any) {
    console.error('[botApi.postControl] enqueue setExternalControl failed', {
      agentId,
      worldId: String(verified.binding.worldId),
      enabled,
      err: String(e?.message ?? e),
    });
    throw e;
  }

  console.log('[botApi.postControl] enqueue setExternalControl done', {
    agentId,
    worldId: String(verified.binding.worldId),
    enabled,
  });

  return jsonResponse({
    agentId,
    isExternalControlled: enabled,
    previousMode: agent.isExternalControlled ? 'external' : 'internal',
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
