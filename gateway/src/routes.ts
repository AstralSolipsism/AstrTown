import type { FastifyInstance } from 'fastify';

import type { GatewayConfig } from './config.js';
import { buildWsWorldEvent, parseIncomingWorldEvent, registerBotHttpProxyRoutes } from './httpRoutes.js';
import { eventsReceivedTotal, renderMetrics, renderMetricsJson, wsConnections } from './metrics.js';
import type { WsWorldEventBase } from './types.js';
import { enqueueWorldEvent, type BotQueueRegistry, classifyPriority } from './queueRegistry.js';
import type { EventDispatcher } from './eventDispatcher.js';
import type { ConnectionManager } from './connectionManager.js';
import type { CommandQueue } from './commandQueue.js';
import type { IdempotencyCache } from './utils.js';
import { createUuid } from './uuid.js';

export function registerHttpRoutes<TEvent extends WsWorldEventBase<string, any>>(app: FastifyInstance, deps: {
  config: GatewayConfig & {
    ackTimeoutMs: number;
    ackMaxRetries: number;
    queueMaxSizePerLevel: number;
  };
  astr: import('./astrtownClient.js').AstrTownClient;
  connections: ConnectionManager;
  queues: BotQueueRegistry<TEvent>;
  dispatcher: EventDispatcher<TEvent>;
  commandQueue: CommandQueue;
  idempotency: IdempotencyCache;
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}): void {
  const isGatewayEventAuthorized = (headers: Record<string, unknown>): boolean => {
    const expectedSecret = deps.config.gatewaySecret;
    if (!expectedSecret) return false;

    const authHeaderRaw = headers['authorization'];
    const authHeader = typeof authHeaderRaw === 'string' ? authHeaderRaw : '';
    const expectedBearer = `Bearer ${expectedSecret}`;
    if (authHeader === expectedBearer) return true;

    const xGatewaySecretRaw = headers['x-gateway-secret'];
    const xGatewaySecret = typeof xGatewaySecretRaw === 'string' ? xGatewaySecretRaw : '';
    if (xGatewaySecret === expectedSecret) return true;

    return false;
  };

  registerBotHttpProxyRoutes(app, { astr: deps.astr, log: deps.log });

  app.get('/gateway/status', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      connections: deps.connections.size(),
      version: deps.config.serverVersion,
    };
  });

  app.get('/gateway/metrics', async (_req, reply) => {
    const rendered = await renderMetrics();
    reply.header('content-type', rendered.contentType);
    return rendered.body;
  });

  app.get('/gateway/metrics/json', async () => {
    return await renderMetricsJson();
  });

  app.post('/gateway/event', async (req, reply) => {
    if (!isGatewayEventAuthorized(req.headers as Record<string, unknown>)) {
      reply.code(401);
      return { received: false };
    }

    const headerIdemKey = req.headers['x-idempotency-key'];
    const bodyIdemKey = (req.body as any)?.idempotencyKey;
    const idemKey =
      typeof headerIdemKey === 'string' && headerIdemKey.length > 0
        ? headerIdemKey
        : (typeof bodyIdemKey === 'string' ? bodyIdemKey : '');
    if (idemKey.length === 0) {
      reply.code(400);
      return { received: false, error: 'Missing x-idempotency-key' };
    }
    if (deps.idempotency.has(idemKey)) {
      return { received: true };
    }

    let parsed;
    try {
      parsed = parseIncomingWorldEvent(req.body);
    } catch (e: any) {
      reply.code(400);
      return { received: false, error: String(e?.message ?? e) };
    }

    const eventId = createUuid();
    const event = buildWsWorldEvent({
      eventType: parsed.eventType,
      id: eventId,
      version: 1,
      timestamp: Date.now(),
      expiresAt: parsed.expiresAt,
      payload: parsed.payload,
      metadata: {
        eventAgentId: parsed.eventAgentId,
        targetAgentId: parsed.targetAgentId,
      },
    }) as TEvent;

    const priority = classifyPriority(event, parsed.priority);
    eventsReceivedTotal.inc({ type: event.type, priority: String(priority) });
    deps.idempotency.add(idemKey);

    enqueueWorldEvent({
      agentId: parsed.targetAgentId,
      event,
      priority,
      registry: deps.queues,
      dispatcher: deps.dispatcher,
      log: deps.log,
    });

    // Note: commands are considered completed once Convex accepts them (see commandQueue.ts drain()).
    // Keep this branch as a future extension point for async operations that need engine-side confirmation.
    if (event.type === 'action.finished') {
      const inflightAgentId = deps.commandQueue.getInflightAgentId(parsed.targetAgentId);
      if (inflightAgentId && inflightAgentId === parsed.targetAgentId) {
        deps.commandQueue.complete(parsed.targetAgentId, 'action.finished');
      }
    }

    reply.code(200);
    return { received: true, eventId };
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      connections: deps.connections.size(),
      version: deps.config.serverVersion,
    };
  });
}
