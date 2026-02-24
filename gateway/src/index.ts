import fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import pino from 'pino';

import { loadConfig } from './config.js';
import { AstrTownClient } from './astrtownClient.js';
import { ConnectionManager } from './connectionManager.js';
import { createDefaultCommandMapper } from './commandMapper.js';
import { CommandRouter } from './commandRouter.js';
import { CommandQueue } from './commandQueue.js';
import { EventDispatcher } from './eventDispatcher.js';
import { BotQueueRegistry } from './queueRegistry.js';
import { IdempotencyCache } from './utils.js';
import { registerWsRoutes } from './wsHandler.js';
import { registerHttpRoutes } from './routes.js';
import type { WorldEvent } from './types.js';

const config = loadConfig();

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

const app = fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1_048_576 });

await app.register(cors, { origin: true });
await app.register(websocket);

const connections = new ConnectionManager();
const astr = new AstrTownClient({ baseUrl: config.astrTownUrl });
const mapper = createDefaultCommandMapper();
const commandQueue = new CommandQueue({
  timeoutMs: 30_000,
  log: app.log,
});

const queues = new BotQueueRegistry<WorldEvent>(Number(process.env.QUEUE_MAX_SIZE_PER_LEVEL ?? '100'));

const dispatcher = new EventDispatcher<WorldEvent>({
  connections,
  getQueue: (agentId) => queues.get(agentId),
  ackPlan: {
    timeoutMs: config.ackTimeoutMs,
    maxRetries: config.ackMaxRetries,
    backoffMs: config.ackBackoffMs,
  },
  send: (conn, msg) => {
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch (e: any) {
      app.log.warn({ err: String(e?.message ?? e), agentId: conn.session.agentId, eventType: (msg as any)?.type }, 'eventDispatcher ws send failed');
      throw e;
    }
  },
  log: app.log,
});

const commandRouter = new CommandRouter({
  client: astr,
  mapper,
  queue: commandQueue,
  connections,
  worldEventQueues: queues,
  worldEventDispatcher: dispatcher,
  send: (conn, msg) => {
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch (e: any) {
      app.log.warn({ err: String(e?.message ?? e), agentId: conn.session.agentId }, 'commandRouter ws send failed');
      throw e;
    }
  },
  log: app.log,
});

registerWsRoutes(app, {
  config: {
    serverVersion: config.serverVersion,
    supportedProtocolVersions: config.supportedProtocolVersions,
    wsHeartbeatIntervalMs: Number(process.env.WS_HEARTBEAT_INTERVAL ?? '30000'),
    wsHeartbeatTimeoutMs: Number(process.env.WS_HEARTBEAT_TIMEOUT ?? '60000'),
  },
  astr,
  connections,
  commandRouter,
  commandQueue,
  dispatcher,
  queues,
  log: app.log,
});

registerHttpRoutes(app, {
  config: {
    ...config,
    ackTimeoutMs: config.ackTimeoutMs,
    ackMaxRetries: config.ackMaxRetries,
    queueMaxSizePerLevel: Number(process.env.QUEUE_MAX_SIZE_PER_LEVEL ?? '100'),
  },
  astr,
  connections,
  queues,
  dispatcher,
  commandQueue,
  idempotency: new IdempotencyCache(1000),
  log: app.log,
});

await app.listen({ port: config.port, host: '0.0.0.0' });
