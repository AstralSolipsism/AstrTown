import type { AstrTownClient } from './astrtownClient.js';
import { createUuid } from './uuid.js';
import { commandsTotal, commandLatencyMs } from './metrics.js';
import type { BotConnection } from './connectionManager.js';
import type { CommandMapper, CommandType } from './commandMapper.js';
import type { CommandQueue } from './commandQueue.js';
import type { WsInboundMessage } from './types.js';

export type CommandRouterDeps = {
  client: AstrTownClient;
  mapper: CommandMapper;
  queue: CommandQueue;
  send: (conn: BotConnection, msg: unknown) => void;
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
};

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
          try {
            const events = this.deps.mapper.mapBatchToExternalEvents(
              batchItems.map((item) => ({
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

            commandsTotal.inc({ type: 'batch', status: 'accepted' });
            for (const item of batchItems) {
              this.safeAckSend(conn, { commandId: item.commandId, status: 'accepted' }, item.commandType);
            }
            this.safeAckSend(conn, { commandId: msg.id, status: 'accepted' }, 'command.batch');
            return { accepted: true };
          } catch (e: any) {
            const reason = String(e?.message ?? e ?? 'Gateway error');
            commandsTotal.inc({ type: 'batch', status: 'rejected' });
            this.deps.log.error({ err: reason }, 'batch command handle failed');
            for (const item of batchItems) {
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
