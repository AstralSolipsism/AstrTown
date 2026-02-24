import type { AstrTownClient } from './astrtownClient.js';
import { createUuid } from './uuid.js';
import { commandsTotal, commandLatencyMs } from './metrics.js';
import type { BotConnection, ConnectionManager } from './connectionManager.js';
import type { CommandMapper, CommandType } from './commandMapper.js';
import type { CommandQueue } from './commandQueue.js';
import type { BotQueueRegistry } from './queueRegistry.js';
import type { EventDispatcher } from './eventDispatcher.js';
import { classifyPriority, enqueueWorldEvent } from './queueRegistry.js';
import type {
  SocialRelationshipProposedEvent,
  SocialRelationshipRespondedEvent,
  WorldEvent,
  WsInboundMessage,
  WsWorldEventBase,
} from './types.js';

export type CommandRouterDeps = {
  client: AstrTownClient;
  mapper: CommandMapper;
  queue: CommandQueue;
  connections: ConnectionManager;
  worldEventQueues: BotQueueRegistry<WorldEvent>;
  worldEventDispatcher: EventDispatcher<WorldEvent>;
  send: (conn: BotConnection, msg: unknown) => void;
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
};

function isWsWorldEventBase(value: unknown): value is WsWorldEventBase<string, any> {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.type === 'string' &&
    typeof obj.timestamp === 'number' &&
    typeof obj.version === 'number' &&
    typeof obj.expiresAt === 'number' &&
    'payload' in obj
  );
}

export class CommandRouter {
  constructor(private readonly deps: CommandRouterDeps) {}

  private toBatchItems(msg: Extract<WsInboundMessage, { type: 'command.batch' }>): Array<{
    commandId: string;
    commandType: CommandType;
    payload: Record<string, unknown>;
  }> {
    const rawCommands = Array.isArray((msg.payload as any)?.commands) ? (msg.payload as any).commands : [];
    if (rawCommands.length === 0) {
      throw new Error('commands must be a non-empty array');
    }

    return rawCommands.map((item: any) => {
      const type = typeof item?.type === 'string' ? item.type : '';
      if (!type.startsWith('command.') || typeof item?.id !== 'string' || item.id.length === 0) {
        throw new Error('invalid command.batch item');
      }

      const commandType = type.replace('command.', '') as CommandType;
      if (!this.deps.mapper.get(commandType)) {
        throw new Error(`unsupported commandType in batch: ${type}`);
      }

      return {
        commandId: item.id,
        commandType,
        payload: (item?.payload ?? {}) as Record<string, unknown>,
      };
    });
  }

  private safeAckSend(
    conn: BotConnection,
    payload: { commandId: string; status: 'accepted' | 'rejected'; reason?: string; inputId?: string },
    commandType: string,
  ): void {
    try {
      this.deps.send(conn, {
        type: 'command.ack',
        id: createUuid(),
        timestamp: Date.now(),
        payload: {
          ...payload,
          // 语义标注：此 ACK 仅表示“已入队/已受理”，并不代表命令已在后端执行成功。
          ackSemantics: 'queued',
        },
      });
    } catch (e: any) {
      this.deps.log.warn(
        {
          err: String(e?.message ?? e),
          commandType,
          ackStatus: payload.status,
        },
        'failed to send command ack',
      );
    }
  }

  private pushRelationshipProposedEvent(
    targetAgentId: string,
    event: SocialRelationshipProposedEvent,
    hintedPriority?: 0 | 1 | 2 | 3,
  ): void {
    if (!isWsWorldEventBase(event)) {
      throw new Error('Invalid relationship_proposed event');
    }

    const priority = classifyPriority(event, hintedPriority);
    enqueueWorldEvent({
      agentId: targetAgentId,
      event,
      priority,
      registry: this.deps.worldEventQueues,
      dispatcher: this.deps.worldEventDispatcher,
      log: this.deps.log,
    });
  }

  private pushRelationshipRespondedEvent(
    targetAgentId: string,
    event: SocialRelationshipRespondedEvent,
    hintedPriority?: 0 | 1 | 2 | 3,
  ): void {
    if (!isWsWorldEventBase(event)) {
      throw new Error('Invalid relationship_responded event');
    }

    const priority = classifyPriority(event, hintedPriority);
    enqueueWorldEvent({
      agentId: targetAgentId,
      event,
      priority,
      registry: this.deps.worldEventQueues,
      dispatcher: this.deps.worldEventDispatcher,
      log: this.deps.log,
    });
  }

  async handle(conn: BotConnection, msg: WsInboundMessage): Promise<void> {
    if (msg.type === 'command.batch') {
      let batchItems: ReturnType<CommandRouter['toBatchItems']>;
      try {
        batchItems = this.toBatchItems(msg);
      } catch (e: any) {
        this.safeAckSend(
          conn,
          { commandId: msg.id, status: 'rejected', reason: String(e?.message ?? e) },
          'command.batch',
        );
        return;
      }

      this.deps.queue.enqueue(conn.session.agentId, {
        commandId: msg.id,
        commandType: 'batch',
        execute: async () => {
          const end = commandLatencyMs.startTimer({ type: 'batch' });
          const acceptedCommandIds = new Set<string>();
          try {
            const passthroughItems: typeof batchItems = [];

            for (const item of batchItems) {
              if (item.commandType === 'propose_relationship') {
                const targetPlayerId = String(item.payload?.targetPlayerId ?? '');
                const status = String(item.payload?.status ?? '');
                if (!targetPlayerId) {
                  throw new Error('propose_relationship missing targetPlayerId');
                }
                if (!status) {
                  throw new Error('propose_relationship missing status');
                }

                const targetConn = this.deps.connections.getByPlayerId(targetPlayerId);
                if (!targetConn) {
                  commandsTotal.inc({ type: item.commandType, status: 'rejected' });
                  this.safeAckSend(
                    conn,
                    { commandId: item.commandId, status: 'rejected', reason: 'target_offline' },
                    item.commandType,
                  );
                  acceptedCommandIds.add(item.commandId);
                  continue;
                }

                const now = Date.now();
                const event: SocialRelationshipProposedEvent = {
                  type: 'social.relationship_proposed',
                  id: createUuid(),
                  version: conn.session.negotiatedVersion,
                  timestamp: now,
                  expiresAt: now + 60_000,
                  payload: {
                    proposerId: conn.session.playerId,
                    targetPlayerId,
                    status,
                  },
                };

                this.pushRelationshipProposedEvent(targetConn.session.agentId, event, 1);
                commandsTotal.inc({ type: item.commandType, status: 'accepted' });
                this.safeAckSend(conn, { commandId: item.commandId, status: 'accepted' }, item.commandType);
                acceptedCommandIds.add(item.commandId);
                continue;
              }

              if (item.commandType === 'respond_relationship') {
                const proposerId = String(item.payload?.proposerId ?? '');
                const accept = Boolean(item.payload?.accept);
                const status = String(item.payload?.status ?? (accept ? 'friends' : 'rejected'));
                if (!proposerId) {
                  throw new Error('respond_relationship missing proposerId');
                }

                if (accept) {
                  const establishedAt = Number(item.payload?.establishedAt ?? Date.now());
                  if (!Number.isFinite(establishedAt)) {
                    throw new Error('respond_relationship establishedAt must be finite number');
                  }

                  const upsertRes = await this.deps.client.upsertRelationship(conn.session.token, {
                    playerAId: proposerId,
                    playerBId: conn.session.playerId,
                    status,
                    establishedAt,
                  });

                  if (!upsertRes.ok) {
                    throw new Error(upsertRes.error ?? 'upsert relationship failed');
                  }
                }

                const proposerConn = this.deps.connections.getByPlayerId(proposerId);
                if (proposerConn) {
                  const now = Date.now();
                  const respondedEvent: SocialRelationshipRespondedEvent = {
                    type: 'social.relationship_responded',
                    id: createUuid(),
                    version: proposerConn.session.negotiatedVersion,
                    timestamp: now,
                    expiresAt: now + 60_000,
                    payload: {
                      proposerId,
                      responderId: conn.session.playerId,
                      status,
                      accept,
                    },
                  };
                  this.pushRelationshipRespondedEvent(proposerConn.session.agentId, respondedEvent, 1);
                } else {
                  this.deps.log.info(
                    {
                      proposerId,
                      responderId: conn.session.playerId,
                      status,
                      accept,
                    },
                    'relationship responder acknowledged but proposer is offline',
                  );
                }

                commandsTotal.inc({ type: item.commandType, status: 'accepted' });
                this.safeAckSend(conn, { commandId: item.commandId, status: 'accepted' }, item.commandType);
                acceptedCommandIds.add(item.commandId);
                continue;
              }

              passthroughItems.push(item);
            }

            if (passthroughItems.length > 0) {
              const events = this.deps.mapper.mapBatchToExternalEvents(
                passthroughItems.map((item) => ({
                  commandType: item.commandType,
                  payload: { agentId: conn.session.agentId, ...item.payload },
                })),
              );

              const idempotencyKey = `${conn.session.agentId}:batch:${msg.id}`;
              await this.deps.client.postCommandBatch({
                token: conn.session.token,
                idempotencyKey,
                worldId: conn.session.worldId,
                agentId: conn.session.agentId,
                events,
              });

              for (const item of passthroughItems) {
                commandsTotal.inc({ type: item.commandType, status: 'accepted' });
                this.safeAckSend(conn, { commandId: item.commandId, status: 'accepted' }, item.commandType);
                acceptedCommandIds.add(item.commandId);
              }
            }

            commandsTotal.inc({ type: 'batch', status: 'accepted' });
            this.safeAckSend(conn, { commandId: msg.id, status: 'accepted' }, 'command.batch');
            return { accepted: true };
          } catch (e: any) {
            const reason = String(e?.message ?? e ?? 'Gateway error');
            commandsTotal.inc({ type: 'batch', status: 'rejected' });
            this.deps.log.error({ err: reason }, 'batch command handle failed');
            for (const item of batchItems) {
              if (acceptedCommandIds.has(item.commandId)) {
                continue;
              }
              this.safeAckSend(conn, { commandId: item.commandId, status: 'rejected', reason }, item.commandType);
            }
            this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason }, 'command.batch');
            return { accepted: false };
          } finally {
            end();
          }
        },
      });
      return;
    }

    if (!msg.type.startsWith('command.')) return;

    const commandType = msg.type.replace('command.', '') as CommandType;
    const mapping = this.deps.mapper.get(commandType);
    if (!mapping) {
      commandsTotal.inc({ type: commandType, status: 'rejected' });
      this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: 'Unknown commandType' }, commandType);
      return;
    }

    this.deps.queue.enqueue(conn.session.agentId, {
      commandId: msg.id,
      commandType,
      execute: async () => {
        const end = commandLatencyMs.startTimer({ type: commandType });
        try {
          if (commandType === 'propose_relationship') {
            const targetPlayerId = String((msg.payload as any)?.targetPlayerId ?? '');
            const status = String((msg.payload as any)?.status ?? '');
            if (!targetPlayerId) {
              commandsTotal.inc({ type: commandType, status: 'rejected' });
              this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: 'Missing targetPlayerId' }, commandType);
              return { accepted: false };
            }
            if (!status) {
              commandsTotal.inc({ type: commandType, status: 'rejected' });
              this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: 'Missing status' }, commandType);
              return { accepted: false };
            }

            const targetConn = this.deps.connections.getByPlayerId(targetPlayerId);
            if (!targetConn) {
              commandsTotal.inc({ type: commandType, status: 'rejected' });
              this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: 'target_offline' }, commandType);
              return { accepted: false };
            }

            const now = Date.now();
            const event: SocialRelationshipProposedEvent = {
              type: 'social.relationship_proposed',
              id: createUuid(),
              version: conn.session.negotiatedVersion,
              timestamp: now,
              expiresAt: now + 60_000,
              payload: {
                proposerId: conn.session.playerId,
                targetPlayerId,
                status,
              },
            };

            this.pushRelationshipProposedEvent(targetConn.session.agentId, event, 1);
            commandsTotal.inc({ type: commandType, status: 'accepted' });
            this.safeAckSend(conn, { commandId: msg.id, status: 'accepted' }, commandType);
            return { accepted: true };
          }

          if (commandType === 'respond_relationship') {
            const proposerId = String((msg.payload as any)?.proposerId ?? '');
            const accept = Boolean((msg.payload as any)?.accept);
            const status = String((msg.payload as any)?.status ?? (accept ? 'friends' : 'rejected'));
            if (!proposerId) {
              commandsTotal.inc({ type: commandType, status: 'rejected' });
              this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: 'Missing proposerId' }, commandType);
              return { accepted: false };
            }

            if (accept) {
              const establishedAt = Number((msg.payload as any)?.establishedAt ?? Date.now());
              if (!Number.isFinite(establishedAt)) {
                commandsTotal.inc({ type: commandType, status: 'rejected' });
                this.safeAckSend(
                  conn,
                  { commandId: msg.id, status: 'rejected', reason: 'establishedAt must be finite number' },
                  commandType,
                );
                return { accepted: false };
              }

              const upsertRes = await this.deps.client.upsertRelationship(conn.session.token, {
                playerAId: proposerId,
                playerBId: conn.session.playerId,
                status,
                establishedAt,
              });
              if (!upsertRes.ok) {
                commandsTotal.inc({ type: commandType, status: 'rejected' });
                this.safeAckSend(
                  conn,
                  { commandId: msg.id, status: 'rejected', reason: upsertRes.error ?? 'Relationship upsert failed' },
                  commandType,
                );
                return { accepted: false };
              }
            }

            const proposerConn = this.deps.connections.getByPlayerId(proposerId);
            if (proposerConn) {
              const now = Date.now();
              const respondedEvent: SocialRelationshipRespondedEvent = {
                type: 'social.relationship_responded',
                id: createUuid(),
                version: proposerConn.session.negotiatedVersion,
                timestamp: now,
                expiresAt: now + 60_000,
                payload: {
                  proposerId,
                  responderId: conn.session.playerId,
                  status,
                  accept,
                },
              };
              this.pushRelationshipRespondedEvent(proposerConn.session.agentId, respondedEvent, 1);
            } else {
              this.deps.log.info(
                {
                  proposerId,
                  responderId: conn.session.playerId,
                  status,
                  accept,
                },
                'relationship responder acknowledged but proposer is offline',
              );
            }

            commandsTotal.inc({ type: commandType, status: 'accepted' });
            this.safeAckSend(conn, { commandId: msg.id, status: 'accepted' }, commandType);
            return { accepted: true };
          }

          const req = mapping.buildRequest({ agentId: conn.session.agentId, ...(msg.payload as any) });
          const idempotencyKey = `${conn.session.agentId}:${commandType}:${Date.now()}:${createUuid().slice(0, 4)}`;

          const res = await this.deps.client.postCommand({
            token: conn.session.token,
            idempotencyKey,
            agentId: req.agentId,
            commandType: req.commandType,
            args: req.args,
            // say 命令走 immediate 路径，让 botApi 直接写入 messages 表（writeExternalBotMessage），
            // 绕过在 participating 状态下不消费的外部事件队列，确保对话气泡正常渲染。
            enqueueMode: commandType === 'say' ? 'immediate' : 'queue',
          });

          if (res.status === 'accepted') {
            commandsTotal.inc({ type: commandType, status: 'accepted' });
            this.safeAckSend(conn, { commandId: msg.id, status: 'accepted', inputId: res.inputId }, commandType);
            return { accepted: true };
          }

          commandsTotal.inc({ type: commandType, status: 'rejected' });
          this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: res.message }, commandType);
          return { accepted: false };
        } catch (e: any) {
          commandsTotal.inc({ type: commandType, status: 'rejected' });
          this.deps.log.error({ err: String(e?.message ?? e), commandType }, 'command handle failed');
          this.safeAckSend(conn, { commandId: msg.id, status: 'rejected', reason: 'Gateway error' }, commandType);
          return { accepted: false };
        } finally {
          end();
        }
      },
    });
  }
}
