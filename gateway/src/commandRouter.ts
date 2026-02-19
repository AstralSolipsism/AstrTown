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

  private safeAckSend(conn: BotConnection, payload: { commandId: string; status: 'accepted' | 'rejected'; reason?: string; inputId?: string }, commandType: string): void {
    try {
      this.deps.send(conn, {
        type: 'command.ack',
        id: createUuid(),
        timestamp: Date.now(),
        payload,
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
