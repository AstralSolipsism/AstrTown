export type RetryPlan = {
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number[];
};

export const DEFAULT_ACK_PLAN: RetryPlan = {
  timeoutMs: 10_000,
  maxRetries: 3,
  backoffMs: [5_000, 10_000, 20_000],
};

export type QueuedEvent<TEvent> = {
  event: TEvent;
  priority: 0 | 1 | 2 | 3;
  enqueuedAt: number;
  expiresAt: number;
  attempts: number;
  nextAttemptAt: number;
};

export type DequeueResult<TEvent> =
  | { kind: 'empty' }
  | { kind: 'expired'; dropped: QueuedEvent<TEvent> }
  | { kind: 'ready'; item: QueuedEvent<TEvent> };

export class EventQueue<TEvent extends { id: string; type: string; expiresAt: number }>
  implements Iterable<QueuedEvent<TEvent>>
{
  private readonly queues: [QueuedEvent<TEvent>[], QueuedEvent<TEvent>[], QueuedEvent<TEvent>[], QueuedEvent<TEvent>[]] =
    [[], [], [], []];

  constructor(private readonly perPriorityLimit = 100) {}

  enqueue(event: TEvent, priority: 0 | 1 | 2 | 3): { dropped?: QueuedEvent<TEvent> } {
    const now = Date.now();
    const item: QueuedEvent<TEvent> = {
      event,
      priority,
      enqueuedAt: now,
      expiresAt: event.expiresAt,
      attempts: 0,
      nextAttemptAt: now,
    };
    const q = this.queues[priority];
    q.push(item);

    if (q.length > this.perPriorityLimit) {
      const dropped = q.shift();
      return dropped ? { dropped } : {};
    }

    return {};
  }

  peekNextReady(now = Date.now()): DequeueResult<TEvent> {
    for (const priority of [0, 1, 2, 3] as const) {
      const q = this.queues[priority];
      while (q.length > 0) {
        const head = q[0];
        if (now > head.expiresAt) {
          return { kind: 'expired', dropped: q.shift()! };
        }
        if (now < head.nextAttemptAt) {
          break;
        }
        return { kind: 'ready', item: head };
      }
    }
    return { kind: 'empty' };
  }

  dequeue(): QueuedEvent<TEvent> | undefined {
    for (const priority of [0, 1, 2, 3] as const) {
      const q = this.queues[priority];
      const head = q.shift();
      if (head) return head;
    }
    return undefined;
  }

  markAttempt(item: QueuedEvent<TEvent>, plan: RetryPlan = DEFAULT_ACK_PLAN): void {
    item.attempts += 1;
    const idx = Math.min(item.attempts - 1, plan.backoffMs.length - 1);
    const delay = plan.backoffMs[idx] ?? plan.backoffMs[plan.backoffMs.length - 1] ?? 0;
    item.nextAttemptAt = Date.now() + delay;
  }

  removeByEventId(eventId: string): boolean {
    let removed = false;
    for (const q of this.queues) {
      const idx = q.findIndex((it) => it.event.id === eventId);
      if (idx >= 0) {
        q.splice(idx, 1);
        removed = true;
      }
    }
    return removed;
  }

  depth(priority?: 0 | 1 | 2 | 3): number {
    if (priority === undefined) return this.queues.reduce((n, q) => n + q.length, 0);
    return this.queues[priority].length;
  }

  [Symbol.iterator](): Iterator<QueuedEvent<TEvent>> {
    const all = [...this.queues[0], ...this.queues[1], ...this.queues[2], ...this.queues[3]];
    return all[Symbol.iterator]();
  }
}
