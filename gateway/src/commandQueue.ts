export type CommandQueueItem = {
  commandId: string;
  commandType: string;
  execute: () => Promise<{ accepted: boolean }>;
};

export type CommandQueueDeps = {
  timeoutMs?: number;
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
};

type InflightCommand = {
  agentId: string;
  item: CommandQueueItem;
  timer: NodeJS.Timeout;
  startedAt: number;
};

type CompleteReason = 'action.finished' | 'timeout' | 'rejected' | 'disconnect' | 'accepted';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CommandQueue {
  private readonly pendingByAgent = new Map<string, CommandQueueItem[]>();
  private readonly inflightByAgent = new Map<string, InflightCommand>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: CommandQueueDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  enqueue(agentId: string, item: CommandQueueItem): void {
    const q = this.ensureQueue(agentId);
    q.push(item);
    this.drain(agentId);
  }

  dequeue(agentId: string): CommandQueueItem | undefined {
    const q = this.pendingByAgent.get(agentId);
    if (!q || q.length === 0) return undefined;
    const item = q.shift();
    if (q.length === 0) this.pendingByAgent.delete(agentId);
    return item;
  }

  complete(agentId: string, reason: CompleteReason): boolean {
    const cur = this.inflightByAgent.get(agentId);
    if (!cur) return false;

    clearTimeout(cur.timer);
    this.inflightByAgent.delete(agentId);

    this.deps.log.info(
      {
        agentId,
        commandId: cur.item.commandId,
        commandType: cur.item.commandType,
        reason,
        elapsedMs: Date.now() - cur.startedAt,
      },
      'command queue completed',
    );

    // `drain()` shifts the pending item when it becomes inflight, so `complete()` must NOT
    // dequeue again (otherwise it would drop the next pending command).
    this.drain(agentId);
    return true;
  }

  getInflightAgentId(agentId: string): string | undefined {
    return this.inflightByAgent.get(agentId)?.agentId;
  }

  clearAgent(agentId: string): void {
    const cur = this.inflightByAgent.get(agentId);
    if (cur) {
      clearTimeout(cur.timer);
      this.inflightByAgent.delete(agentId);
    }
    this.pendingByAgent.delete(agentId);
  }

  private ensureQueue(agentId: string): CommandQueueItem[] {
    let q = this.pendingByAgent.get(agentId);
    if (!q) {
      q = [];
      this.pendingByAgent.set(agentId, q);
    }
    return q;
  }

  private drain(agentId: string): void {
    if (this.inflightByAgent.has(agentId)) return;

    const q = this.pendingByAgent.get(agentId);
    if (!q || q.length === 0) return;

    // Important: dequeue the item before executing so `complete()` does not accidentally
    // remove the next pending command.
    const item = q.shift();
    if (!item) return;
    if (q.length === 0) this.pendingByAgent.delete(agentId);

    const timer = setTimeout(() => {
      this.deps.log.warn(
        {
          agentId,
          commandId: item.commandId,
          commandType: item.commandType,
          timeoutMs: this.timeoutMs,
        },
        'command queue timeout',
      );
      this.complete(agentId, 'timeout');
    }, this.timeoutMs);

    this.inflightByAgent.set(agentId, {
      agentId,
      item,
      timer,
      startedAt: Date.now(),
    });

    void item
      .execute()
      .then((res) => {
        if (res.accepted) {
          // Convex 接受命令即视为完成，允许队列执行下一条命令
          this.complete(agentId, 'accepted');
        } else {
          this.complete(agentId, 'rejected');
        }
      })
      .catch((e: any) => {
        this.deps.log.error(
          {
            agentId,
            commandId: item.commandId,
            commandType: item.commandType,
            err: String(e?.message ?? e),
          },
          'command queue execute failed',
        );
        this.complete(agentId, 'rejected');
      });
  }
}
