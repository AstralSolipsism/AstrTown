import type { FastifyInstance } from 'fastify';

import type { AstrTownClient, UpdateDescriptionResponse } from './astrtownClient.js';
import type { EventPriority, WsWorldEventBase } from './types.js';

const SUPPORTED_GATEWAY_EVENT_TYPES = new Set<string>([
  'agent.state_changed',
  'conversation.started',
  'conversation.invited',
  'conversation.message',
  'conversation.timeout',
  'action.finished',
  'agent.queue_refill_requested',
]);

export type IncomingWorldEvent = {
  eventType: string;
  eventAgentId: string;
  targetAgentId: string;
  worldId: string;
  priority: EventPriority;
  expiresAt: number;
  payload: unknown;
};

export function parseIncomingWorldEvent(body: any): IncomingWorldEvent {
  if (!body || typeof body !== 'object') throw new Error('Invalid body');

  const eventType = body.eventType;
  const legacyAgentId = body.agentId;
  const incomingEventAgentId = body.eventAgentId;
  const incomingTargetAgentId = body.targetAgentId;
  const worldId = body.worldId;
  const priority = body.priority;
  let expiresAt = body.expiresAt;
  const legacyEventTs = body.eventTs;
  const payload = body.payload ?? body.eventData;

  let eventAgentId = incomingEventAgentId;
  let targetAgentId = incomingTargetAgentId;

  if ((typeof eventAgentId !== 'string' || eventAgentId.length === 0) && typeof legacyAgentId === 'string' && legacyAgentId.length > 0) {
    eventAgentId = legacyAgentId;
  }
  if ((typeof targetAgentId !== 'string' || targetAgentId.length === 0) && typeof legacyAgentId === 'string' && legacyAgentId.length > 0) {
    targetAgentId = legacyAgentId;
  }
  if ((typeof targetAgentId !== 'string' || targetAgentId.length === 0) && typeof eventAgentId === 'string' && eventAgentId.length > 0) {
    targetAgentId = eventAgentId;
  }

  if (typeof expiresAt !== 'number' && typeof legacyEventTs === 'number' && Number.isFinite(legacyEventTs) && legacyEventTs > 0) {
    expiresAt = legacyEventTs + 60_000;
  }

  if (typeof eventType !== 'string' || eventType.length === 0) throw new Error('Missing eventType');
  if (!SUPPORTED_GATEWAY_EVENT_TYPES.has(eventType)) {
    throw new Error(
      `Unsupported eventType: "${eventType}". Supported: ${[...SUPPORTED_GATEWAY_EVENT_TYPES].join(', ')}`,
    );
  }
  if (typeof eventAgentId !== 'string' || eventAgentId.length === 0) throw new Error('Missing eventAgentId');
  if (typeof targetAgentId !== 'string' || targetAgentId.length === 0) throw new Error('Missing targetAgentId');
  if (typeof worldId !== 'string' || worldId.length === 0) throw new Error('Missing worldId');
  if (![0, 1, 2, 3].includes(priority)) throw new Error('Invalid priority');
  if (typeof expiresAt !== 'number') throw new Error('Missing expiresAt');
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('Invalid expiresAt');

  // payload can be any object; do not over-validate here.
  return { eventType, eventAgentId, targetAgentId, worldId, priority, expiresAt, payload };
}

export function buildWsWorldEvent(args: {
  eventType: string;
  id: string;
  version: number;
  timestamp: number;
  expiresAt: number;
  payload: unknown;
  metadata?: Record<string, unknown>;
}): WsWorldEventBase<string, any> {
  return {
    type: args.eventType,
    id: args.id,
    version: args.version,
    timestamp: args.timestamp,
    expiresAt: args.expiresAt,
    payload: args.payload,
    metadata: args.metadata,
  };
}

function mapUpdateDescriptionErrorStatus(res: UpdateDescriptionResponse): number {
  const code = res.code?.toUpperCase();
  const statusCode = res.statusCode;

  if (
    statusCode === 401 ||
    code === 'AUTH_FAILED' ||
    code === 'INVALID_TOKEN' ||
    code === 'TOKEN_EXPIRED'
  ) {
    return 401;
  }

  if (statusCode === 403 || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') {
    return 403;
  }

  if (statusCode === 400 || code === 'INVALID_ARGS' || code === 'INVALID_JSON') {
    return 400;
  }

  if ((typeof statusCode === 'number' && statusCode >= 500) || code === 'INTERNAL_ERROR') {
    return 500;
  }

  return 500;
}

export function registerBotHttpProxyRoutes(
  app: FastifyInstance,
  deps: {
    astr: AstrTownClient;
    log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
  },
): void {
  app.post('/api/bot/description/update', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
      reply.code(401);
      return { ok: false, error: 'Missing Authorization header' };
    }

    const token = auth.slice('bearer '.length).trim();
    if (!token) {
      reply.code(401);
      return { ok: false, error: 'Missing token' };
    }

    const body: any = req.body;
    const playerId = body?.playerId;
    const description = body?.description;
    if (typeof playerId !== 'string' || playerId.length === 0) {
      reply.code(400);
      return { ok: false, error: 'Missing playerId' };
    }
    if (typeof description !== 'string') {
      reply.code(400);
      return { ok: false, error: 'Missing description' };
    }

    let res: UpdateDescriptionResponse;
    try {
      res = await deps.astr.updateDescription(token, playerId, description);
    } catch (e: any) {
      deps.log.error({ err: String(e?.message ?? e) }, 'updateDescription proxy failed');
      reply.code(500);
      return { ok: false, error: 'Gateway error' };
    }

    if (!res.ok) {
      reply.code(mapUpdateDescriptionErrorStatus(res));
    }
    return res;
  });

  app.post('/api/bot/memory/search', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length === 0) {
      reply.code(401);
      return { ok: false, error: 'Missing Authorization header' };
    }

    try {
      const res = await fetch(`${(deps.astr as any).baseUrl ?? ''}/api/bot/memory/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body: JSON.stringify(req.body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      reply.code(res.status);
      return data;
    } catch (e: any) {
      deps.log.error({ err: String(e?.message ?? e) }, 'memorySearch proxy failed');
      reply.code(500);
      return { ok: false, error: 'Gateway error' };
    }
  });

  app.post('/api/bot/social/affinity', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length === 0) {
      reply.code(401);
      return { ok: false, error: 'Missing Authorization header' };
    }

    try {
      const res = await fetch(`${(deps.astr as any).baseUrl ?? ''}/api/bot/social/affinity`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body: JSON.stringify(req.body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      reply.code(res.status);
      return data;
    } catch (e: any) {
      deps.log.error({ err: String(e?.message ?? e) }, 'socialAffinity proxy failed');
      reply.code(500);
      return { ok: false, error: 'Gateway error' };
    }
  });

  app.get('/api/bot/memory/recent', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length === 0) {
      reply.code(401);
      return { ok: false, error: 'Missing Authorization header' };
    }

    const rawUrl = req.raw.url ?? '';
    const queryIndex = rawUrl.indexOf('?');
    const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';

    try {
      const res = await fetch(`${(deps.astr as any).baseUrl ?? ''}/api/bot/memory/recent${query}`, {
        method: 'GET',
        headers: {
          authorization: auth,
        },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      reply.code(res.status);
      return data;
    } catch (e: any) {
      deps.log.error({ err: String(e?.message ?? e) }, 'memoryRecent proxy failed');
      reply.code(500);
      return { ok: false, error: 'Gateway error' };
    }
  });

  app.get('/api/bot/social/state', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length === 0) {
      reply.code(401);
      return { ok: false, error: 'Missing Authorization header' };
    }

    const rawUrl = req.raw.url ?? '';
    const queryIndex = rawUrl.indexOf('?');
    const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';

    try {
      const res = await fetch(`${(deps.astr as any).baseUrl ?? ''}/api/bot/social/state${query}`, {
        method: 'GET',
        headers: {
          authorization: auth,
        },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      reply.code(res.status);
      return data;
    } catch (e: any) {
      deps.log.error({ err: String(e?.message ?? e) }, 'socialState proxy failed');
      reply.code(500);
      return { ok: false, error: 'Gateway error' };
    }
  });

  app.post('/api/bot/memory/inject', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length === 0) {
      reply.code(401);
      return { ok: false, error: 'Missing Authorization header' };
    }

    try {
      const res = await fetch(`${(deps.astr as any).baseUrl ?? ''}/api/bot/memory/inject`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body: JSON.stringify(req.body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      reply.code(res.status);
      return data;
    } catch (e: any) {
      deps.log.error({ err: String(e?.message ?? e) }, 'memoryInject proxy failed');
      reply.code(500);
      return { ok: false, error: 'Gateway error' };
    }
  });
}
