import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';

import type { AstrTownClient } from './astrtownClient.js';
import type { CommandQueue } from './commandQueue.js';
import type { CommandRouter } from './commandRouter.js';
import type { ConnectionManager } from './connectionManager.js';
import type { EventDispatcher } from './eventDispatcher.js';
import { buildAuthErrorMessage, buildConnectedMessage, negotiateVersion, parseSubscribeList, parseVersionRange } from './auth.js';
import { createSubscriptionMatcher } from './subscription.js';
import { wsConnections, wsConnectionsClosed, wsConnectionsCreated, heartbeatLatencyMs } from './metrics.js';
import { createUuid } from './uuid.js';
import type { BotSession, WsInboundMessage, WsOutboundMessage, WsWorldEventBase } from './types.js';

function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 12) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

export type WsHandlerDeps<TEvent extends WsWorldEventBase<string, any>> = {
  config: {
    serverVersion: string;
    supportedProtocolVersions: number[];
    wsHeartbeatIntervalMs: number;
    wsHeartbeatTimeoutMs: number;
  };
  astr: AstrTownClient;
  connections: ConnectionManager;
  commandRouter: CommandRouter;
  commandQueue: CommandQueue;
  dispatcher: EventDispatcher<TEvent>;
  queues?: { delete: (agentId: string) => void };
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
};

export function registerWsRoutes<TEvent extends WsWorldEventBase<string, any>>(
  app: FastifyInstance,
  deps: WsHandlerDeps<TEvent>,
): void {
  app.get(
    '/ws/bot',
    { websocket: true },
    async (socketOrConnection, req) => {
      const socket = (((socketOrConnection as any)?.socket ?? socketOrConnection) as WebSocket | undefined);
      deps.log.info(
        {
          wsHasConnectionSocket: Boolean((socketOrConnection as any)?.socket),
          wsReadyState: (socket as any)?.readyState,
          wsHasSend: typeof (socket as any)?.send === 'function',
        },
        'ws handler socket resolved',
      );
      if (!socket || typeof (socket as any)?.readyState !== 'number' || typeof (socket as any)?.send !== 'function') {
        deps.log.error(
          {
            wsArgType: typeof socketOrConnection,
            wsHasConnectionSocket: Boolean((socketOrConnection as any)?.socket,
            ),
          },
          'invalid websocket object in ws handler',
        );
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') ?? '';

      const safeSendEarly = (payload: WsOutboundMessage | any) => {
        try {
          if (socket.readyState !== socket.OPEN) return false;
          socket.send(JSON.stringify(payload));
          return true;
        } catch {
          return false;
        }
      };

      const clientRange = parseVersionRange(url.searchParams.get('v') ?? undefined);
      const negotiate = negotiateVersion(clientRange, deps.config.supportedProtocolVersions);
      if (!negotiate.ok) {
        safeSendEarly(
          buildAuthErrorMessage({
            version: 1,
            code: 'VERSION_MISMATCH',
            message: negotiate.message,
            supportedVersions: negotiate.supportedVersions,
          }),
        );
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }

      const subscribedEvents = parseSubscribeList(url.searchParams.get('subscribe') ?? undefined);
      const matcher = createSubscriptionMatcher(subscribedEvents);

      if (!token) {
        safeSendEarly(buildAuthErrorMessage({ version: negotiate.negotiatedVersion, code: 'INVALID_TOKEN', message: 'Missing token' }));
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }

      if (deps.connections.hasToken(token)) {
        safeSendEarly(buildAuthErrorMessage({ version: negotiate.negotiatedVersion, code: 'ALREADY_CONNECTED', message: 'Token already connected' }));
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }

      wsConnectionsCreated.inc();
      wsConnections.inc();

      let verify: Awaited<ReturnType<typeof deps.astr.validateToken>>;
      try {
        verify = await deps.astr.validateToken(token);
      } catch (e: any) {
        deps.log.error({ err: String(e?.message ?? e) }, 'ws validateToken failed');
        try {
          socket.close();
        } catch {
          // ignore
        }
        wsConnections.dec();
        wsConnectionsClosed.inc({ reason: 'auth_error' });
        return;
      }

      if (!verify.valid) {
        safeSendEarly(
          buildAuthErrorMessage({
            version: negotiate.negotiatedVersion,
            code: (verify as any).code ?? 'INVALID_TOKEN',
            message: (verify as any).message ?? 'Invalid token',
          }),
        );
        try {
          socket.close();
        } catch {
          // ignore
        }
        wsConnections.dec();
        wsConnectionsClosed.inc({ reason: 'auth_failed' });
        return;
      }

      // Deduplicate by agentId: evict old connection. IMPORTANT: its `close` callback may fire later,
      // so we must ensure the old socket's cleanup does not wipe resources for the new connection.
      const existing = deps.connections.getByAgentId(verify.binding.agentId);
      if (existing) {
        try {
          // Mark the old socket as evicted so its close handler can skip agent-level cleanup.
          (existing.socket as any)._evictedByReconnect = true;
          existing.socket.close();
        } catch {
          // ignore
        }
        deps.connections.unregisterByToken(existing.session.token);
      }

      const session: BotSession = {
        token,
        agentId: verify.binding.agentId,
        playerId: verify.binding.playerId,
        worldId: verify.binding.worldId,
        playerName: 'NPC',
        negotiatedVersion: negotiate.negotiatedVersion,
        subscribedEvents: matcher.subscribed,
        connectedAt: Date.now(),
      };

      const conn = {
        state: 'authenticated' as const,
        session,
        socket: socket as any,
        lastPongAt: Date.now(),
        subscribedEvents: matcher.subscribed,
      };

      deps.connections.register(conn);

      const safeSend = (payload: WsOutboundMessage | any, context: string) => {
        try {
          if (socket.readyState !== socket.OPEN) return false;
          socket.send(JSON.stringify(payload));
          return true;
        } catch (e: any) {
          deps.log.error({ err: String(e?.message ?? e), agentId: session.agentId, context }, 'ws send failed');
          try {
            socket.close();
          } catch {
            // ignore
          }
          return false;
        }
      };

      const connectedMsg = buildConnectedMessage({
        version: session.negotiatedVersion,
        agentId: session.agentId,
        playerId: session.playerId,
        playerName: session.playerName,
        worldId: session.worldId,
        serverVersion: deps.config.serverVersion,
        negotiatedVersion: session.negotiatedVersion,
        supportedVersions: negotiate.supportedVersions,
        subscribedEvents: session.subscribedEvents,
      });
      const connectedSent = safeSend(connectedMsg, 'connected');
      if (!connectedSent) {
        deps.log.error({ agentId: session.agentId }, 'failed to send connected message; closing connection');
        deps.connections.unregisterByToken(token);
        wsConnections.dec();
        wsConnectionsClosed.inc({ reason: 'send_failed' });
        return;
      }

      deps.log.info(
        {
          agentId: session.agentId,
          worldId: session.worldId,
          token: maskToken(token),
          enabled: true,
        },
        '[WsHandler] 即将调用 setExternalControl',
      );

      void deps.astr.setExternalControl(token, true).then(() => {
        deps.log.info(
          { agentId: session.agentId, worldId: session.worldId, externalControlled: true },
          '[WsHandler] setExternalControl 成功',
        );
      }).catch((e: any) => {
        deps.log.error(
          {
            agentId: session.agentId,
            worldId: session.worldId,
            token: maskToken(token),
            enabled: true,
            err: String(e?.message ?? e),
          },
          'failed to enable external control on ws connect',
        );
      });

      const externalControlReassertTimer = setTimeout(() => {
        const current = deps.connections.getByAgentId(session.agentId);
        const isCurrentSocket = current?.socket === (socket as any);
        const socketOpen = socket.readyState === socket.OPEN;
        if (!isCurrentSocket || !socketOpen) {
          deps.log.info(
            {
              agentId: session.agentId,
              worldId: session.worldId,
              isCurrentSocket,
              socketOpen,
            },
            '[WsHandler] 跳过延迟 setExternalControl 确认',
          );
          return;
        }

        deps.log.info(
          {
            agentId: session.agentId,
            worldId: session.worldId,
            token: maskToken(token),
            enabled: true,
            delayedConfirm: true,
          },
          '[WsHandler] 延迟确认 setExternalControl',
        );

        void deps.astr.setExternalControl(token, true).then(() => {
          deps.log.info(
            {
              agentId: session.agentId,
              worldId: session.worldId,
              externalControlled: true,
              delayedConfirm: true,
            },
            '[WsHandler] 延迟 setExternalControl 成功',
          );
        }).catch((e: any) => {
          deps.log.error(
            {
              agentId: session.agentId,
              worldId: session.worldId,
              token: maskToken(token),
              enabled: true,
              delayedConfirm: true,
              err: String(e?.message ?? e),
            },
            'failed to reassert external control after ws connect',
          );
        });
      }, 1500);

      let degradedOnDisconnect = false;
      const triggerDisconnectDegrade = async () => {
        if (degradedOnDisconnect) return;
        degradedOnDisconnect = true;
        const idempotencyKey = `${session.agentId}:go_home_and_sleep:${Date.now()}:${createUuid().slice(0, 4)}`;
        try {
          const res = await deps.astr.postCommand({
            token,
            idempotencyKey,
            agentId: session.agentId,
            commandType: 'do_something',
            args: {
              actionType: 'go_home_and_sleep',
            },
          });
          if (res.status !== 'accepted') {
            deps.log.warn(
              {
                agentId: session.agentId,
                code: res.code,
                message: res.message,
              },
              'failed to trigger disconnect degrade command',
            );
          }
        } catch (e: any) {
          deps.log.error(
            {
              agentId: session.agentId,
              err: String(e?.message ?? e),
            },
            'disconnect degrade command request failed',
          );
        }
      };

      const hb = startHeartbeat(socket, deps.config.wsHeartbeatIntervalMs, deps.config.wsHeartbeatTimeoutMs, () => {
        deps.log.warn({ agentId: session.agentId }, 'heartbeat timeout, closing');
        socket.close();
      });

      socket.on('message', async (data: any) => {
        let parsed: any;
        try {
          try {
            parsed = JSON.parse(data.toString());
          } catch {
            return;
          }

          const type = String(parsed?.type ?? '');
          if (type === 'pong') {
            conn.lastPongAt = Date.now();
            hb.onPong(parsed?.id);
            return;
          }

          if (type === 'event.ack') {
            const eventId = String(parsed?.payload?.eventId ?? '');
            if (eventId) deps.dispatcher.onAck(session.agentId, eventId);
            return;
          }

          if (type.startsWith('command.')) {
            await deps.commandRouter.handle(conn as any, parsed as WsInboundMessage);
            return;
          }
        } catch (e: any) {
          deps.log.error({ err: String(e?.message ?? e) }, 'ws message handler failed');
          try {
            const commandId = String(parsed?.id ?? '');
            if (commandId) {
              safeSend(
                {
                  type: 'command.ack',
                  id: createUuid(),
                  timestamp: Date.now(),
                  payload: {
                    commandId,
                    status: 'rejected',
                    reason: 'Gateway error',
                  },
                } satisfies WsOutboundMessage,
                'command.ack.on_error',
              );
            }
          } catch {
            // ignore
          }
        }
      });

      socket.on('close', () => {
        clearTimeout(externalControlReassertTimer);
        // If this socket was evicted due to reconnect, avoid agent-level cleanup that would
        // accidentally wipe the new connection's resources.
        const evictedByReconnect = Boolean((socket as any)._evictedByReconnect);
        const current = deps.connections.getByAgentId(session.agentId);
        const isCurrentSocket = current?.socket === (socket as any);

        if (!evictedByReconnect && isCurrentSocket) {
          void triggerDisconnectDegrade();
          deps.log.info(
            {
              agentId: session.agentId,
              worldId: session.worldId,
              token: maskToken(token),
              enabled: false,
            },
            '[WsHandler] 即将调用 setExternalControl',
          );
          void deps.astr.setExternalControl(token, false).then(() => {
            deps.log.info(
              { agentId: session.agentId, worldId: session.worldId, externalControlled: false },
              '[WsHandler] setExternalControl 已关闭',
            );
          }).catch((e: any) => {
            deps.log.error(
              {
                agentId: session.agentId,
                worldId: session.worldId,
                token: maskToken(token),
                enabled: false,
                err: String(e?.message ?? e),
              },
              'failed to disable external control on ws disconnect',
            );
          });
          deps.dispatcher.onDisconnect(session.agentId);
          deps.commandQueue.clearAgent(session.agentId);
          deps.queues?.delete(session.agentId);
          deps.connections.unregisterByToken(token);
        } else {
          deps.log.info(
            { agentId: session.agentId, evictedByReconnect, isCurrentSocket },
            'ws close: skip agent-level cleanup for non-current socket',
          );
          // Best-effort unregister by token (no-op if already removed).
          deps.connections.unregisterByToken(token);
        }

        hb.stop();
        wsConnections.dec();
        wsConnectionsClosed.inc({ reason: 'closed' });
      });
    },
  );
}

function startHeartbeat(socket: WebSocket, intervalMs: number, timeoutMs: number, onTimeout: () => void) {
  let lastPingAt = 0;
  let lastPongAt = Date.now();

  const interval = setInterval(() => {
    const now = Date.now();
    if (now - lastPongAt > timeoutMs) {
      onTimeout();
      return;
    }
    lastPingAt = now;
    if (socket.readyState !== socket.OPEN) {
      clearInterval(interval);
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          type: 'ping',
          id: createUuid(),
          timestamp: now,
          payload: {},
        } satisfies WsOutboundMessage),
      );
    } catch {
      // If send fails, the connection is likely broken; stop heartbeat.
      clearInterval(interval);
    }
  }, intervalMs);

  return {
    onPong: (_id: unknown) => {
      lastPongAt = Date.now();
      if (lastPingAt) heartbeatLatencyMs.observe(Date.now() - lastPingAt);
    },
    stop: () => clearInterval(interval),
  };
}
