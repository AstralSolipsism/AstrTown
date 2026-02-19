import type { BotConnection, ConnectionManager } from './connectionManager.js';
import { createSubscriptionMatcher } from './subscription.js';
import { ackFailuresTotal, eventDispatchLatencyMs, eventsDispatchedTotal, eventsExpiredTotal, queueDepth } from './metrics.js';
import type { WsWorldEventBase } from './types.js';
import { DEFAULT_ACK_PLAN, EventQueue, type QueuedEvent, type RetryPlan } from './eventQueue.js';

export type EventDispatcherDeps<TEvent extends WsWorldEventBase<string, any>> = {
  connections: ConnectionManager;
  getQueue: (agentId: string) => EventQueue<TEvent>;
  send: (conn: BotConnection, msg: TEvent) => void;
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
  ackPlan?: RetryPlan;
};

export class EventDispatcher<TEvent extends WsWorldEventBase<string, any>> {
  private readonly inflight = new Map<
    string,
    { agentId: string; eventId: string; type: string; enqueuedAt: number; timer: NodeJS.Timeout }
  >();
  private readonly ackPlan: RetryPlan;

  constructor(private readonly deps: EventDispatcherDeps<TEvent>) {
    this.ackPlan = deps.ackPlan ?? DEFAULT_ACK_PLAN;
  }

  onAck(agentId: string, eventId: string): void {
    const key = `${agentId}:${eventId}`;
    const cur = this.inflight.get(key);
    if (!cur) return;
    clearTimeout(cur.timer);
    this.inflight.delete(key);
    eventDispatchLatencyMs.observe({ type: cur.type }, Date.now() - cur.enqueuedAt);
    eventsDispatchedTotal.inc({ type: cur.type, status: 'acked' });

    const q = this.deps.getQueue(agentId);
    q.removeByEventId(eventId);
    this.tryDispatch(agentId);
  }

  onDisconnect(agentId: string): void {
    for (const [key, entry] of this.inflight) {
      if (entry.agentId !== agentId) continue;
      clearTimeout(entry.timer);
      this.inflight.delete(key);
    }
  }

  tryDispatch(agentId: string): void {
    const conn = this.deps.connections.getByAgentId(agentId);
    if (!conn) return;

    const q = this.deps.getQueue(agentId);
    const now = Date.now();

    while (true) {
      const peek = q.peekNextReady(now);
      if (peek.kind === 'empty') return;
      if (peek.kind === 'expired') {
        eventsExpiredTotal.inc({ type: peek.dropped.event.type, priority: String(peek.dropped.priority) });
        this.deps.log.warn({ agentId, eventId: peek.dropped.event.id, type: peek.dropped.event.type }, 'event expired');
        continue;
      }

      const item = peek.item;
      const matcher = createSubscriptionMatcher(conn.subscribedEvents);
      if (!matcher.matches(item.event.type)) {
        q.dequeue();
        continue;
      }

      if (this.isInflight(agentId, item.event.id)) return;

      q.dequeue();
      this.sendWithRetry(conn, item);
      return;
    }
  }

  private isInflight(agentId: string, eventId: string): boolean {
    return this.inflight.has(`${agentId}:${eventId}`);
  }

  private sendWithRetry(conn: BotConnection, item: QueuedEvent<TEvent>): void {
    const agentId = conn.session.agentId;
    const key = `${agentId}:${item.event.id}`;

    try {
      this.deps.send(conn, item.event);
      eventsDispatchedTotal.inc({ type: item.event.type, status: 'sent' });
      this.updateQueueDepth(agentId);
    } catch (e: any) {
      eventsDispatchedTotal.inc({ type: item.event.type, status: 'failed' });
      this.deps.log.warn(
        {
          agentId,
          eventId: item.event.id,
          type: item.event.type,
          err: String(e?.message ?? e),
        },
        'event send failed',
      );
      // Treat as a failed attempt and schedule retry (or drop after max retries).
      this.onSendFailure(agentId, item);
      this.tryDispatch(agentId);
      return;
    }

    const timer = setTimeout(() => {
      this.inflight.delete(key);

      if (item.attempts >= this.ackPlan.maxRetries) {
        ackFailuresTotal.inc({ type: item.event.type });
        eventsDispatchedTotal.inc({ type: item.event.type, status: 'failed' });
        this.deps.log.error({ agentId, eventId: item.event.id, type: item.event.type }, 'ack failed');
        const q = this.deps.getQueue(agentId);
        q.removeByEventId(item.event.id);
        this.tryDispatch(agentId);
        return;
      }

      ackFailuresTotal.inc({ type: item.event.type });
      item.attempts += 1;
      const idx = Math.min(item.attempts - 1, this.ackPlan.backoffMs.length - 1);
      const delay = this.ackPlan.backoffMs[idx] ?? this.ackPlan.backoffMs.at(-1) ?? 0;
      item.nextAttemptAt = Date.now() + delay;

      const q = this.deps.getQueue(agentId);
      q.enqueue(item.event, item.priority);
      this.deps.log.warn({ agentId, eventId: item.event.id, delay }, 'ack timeout, retry scheduled');
      this.tryDispatch(agentId);
    }, this.ackPlan.timeoutMs);

    this.inflight.set(key, {
      agentId,
      eventId: item.event.id,
      type: item.event.type,
      enqueuedAt: item.enqueuedAt,
      timer,
    });
  }

  private onSendFailure(agentId: string, item: QueuedEvent<TEvent>): void {
    if (item.attempts >= this.ackPlan.maxRetries) {
      ackFailuresTotal.inc({ type: item.event.type });
      this.deps.log.error({ agentId, eventId: item.event.id, type: item.event.type }, 'send failed, dropping event');
      const q = this.deps.getQueue(agentId);
      q.removeByEventId(item.event.id);
      this.updateQueueDepth(agentId);
      return;
    }

    ackFailuresTotal.inc({ type: item.event.type });
    item.attempts += 1;
    const idx = Math.min(item.attempts - 1, this.ackPlan.backoffMs.length - 1);
    const delay = this.ackPlan.backoffMs[idx] ?? this.ackPlan.backoffMs.at(-1) ?? 0;
    item.nextAttemptAt = Date.now() + delay;

    const q = this.deps.getQueue(agentId);
    q.enqueue(item.event, item.priority);
    this.updateQueueDepth(agentId);
    this.deps.log.warn({ agentId, eventId: item.event.id, delay }, 'send failed, retry scheduled');
  }

  private updateQueueDepth(agentId: string): void {
    const q = this.deps.getQueue(agentId);
    for (const p of [0, 1, 2, 3] as const) {
      queueDepth.set({ agent_id: agentId, priority: String(p) }, q.depth(p));
    }
  }
}
