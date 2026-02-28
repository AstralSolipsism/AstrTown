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

export type QueueDropReason = 'overflow_oldest' | 'overflow_incoming' | 'overflow_replaced_non_critical';

export type EnqueueResult<TEvent> = {
  dropped?: QueuedEvent<TEvent>;
  dropReason?: QueueDropReason;
};

const CRITICAL_EVENT_TYPES = new Set<string>(['conversation.ended', 'conversation.timeout']);

function isCriticalEventType(type: string): boolean {
  return CRITICAL_EVENT_TYPES.has(type);
}

export class EventQueue<TEvent extends { id: string; type: string; expiresAt: number }>
  implements Iterable<QueuedEvent<TEvent>>
{
  private readonly queues: [QueuedEvent<TEvent>[], QueuedEvent<TEvent>[], QueuedEvent<TEvent>[], QueuedEvent<TEvent>[]] =
    [[], [], [], []];

  constructor(private readonly perPriorityLimit = 100) {}

  enqueue(
    event: TEvent,
    priority: 0 | 1 | 2 | 3,
    options?: Partial<Pick<QueuedEvent<TEvent>, 'enqueuedAt' | 'attempts' | 'nextAttemptAt'>>,
  ): EnqueueResult<TEvent> {
    const now = Date.now();
    const item: QueuedEvent<TEvent> = {
      event,
      priority,
      enqueuedAt: options?.enqueuedAt ?? now,
      expiresAt: event.expiresAt,
      attempts: options?.attempts ?? 0,
      nextAttemptAt: options?.nextAttemptAt ?? now,
    };
    const q = this.queues[priority];
    q.push(item);

    if (q.length <= this.perPriorityLimit) {
      return {};
    }

    const incomingCritical = isCriticalEventType(item.event.type);

    if (incomingCritical) {
      const replaceIdx = q.findIndex((queued) => !isCriticalEventType(queued.event.type));
      if (replaceIdx >= 0) {
        const [dropped] = q.splice(replaceIdx, 1);
        return dropped ? { dropped, dropReason: 'overflow_replaced_non_critical' } : {};
      }
    }

    if (!incomingCritical) {
      const hasCritical = q.some((queued, idx) => idx !== q.length - 1 && isCriticalEventType(queued.event.type));
      if (hasCritical) {
        q.pop();
        return { dropped: item, dropReason: 'overflow_incoming' };
      }
    }

    const dropped = q.shift();
    return dropped ? { dropped, dropReason: 'overflow_oldest' } : {};
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

  removeByType(type: string): number {
    let removed = 0;
    for (const q of this.queues) {
      for (let i = q.length - 1; i >= 0; i -= 1) {
        if (q[i].event.type !== type) continue;
        q.splice(i, 1);
        removed += 1;
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
