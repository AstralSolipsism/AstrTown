import type { ConnectionManager } from './connectionManager.js';
import type { EventDispatcher } from './eventDispatcher.js';
import type { EventPriority, WsWorldEventBase } from './types.js';
import { EventQueue, type QueueDropReason } from './eventQueue.js';
import { eventsDroppedTotal } from './metrics.js';

export class BotQueueRegistry<TEvent extends WsWorldEventBase<string, any>> {
  private readonly queues = new Map<string, EventQueue<TEvent>>();

  constructor(private readonly perPriorityLimit: number) {}

  get(agentId: string): EventQueue<TEvent> {
    let q = this.queues.get(agentId);
    if (!q) {
      q = new EventQueue<TEvent>(this.perPriorityLimit);
      this.queues.set(agentId, q);
    }
    return q;
  }

  delete(agentId: string): void {
    this.queues.delete(agentId);
  }
}

export function classifyPriority(event: WsWorldEventBase<string, any>, hinted?: EventPriority): EventPriority {
  if (event.type === 'agent.queue_refill_requested') return 3;

  if (hinted !== undefined) {
    if (event.type.startsWith('conversation.') && hinted !== 0) return 0;
    return hinted;
  }

  // Ensure highest priority for timeout events.
  if (event.type === 'conversation.timeout') return 0;

  // By convention, conversation events are the most important.
  if (event.type.startsWith('conversation.')) return 0;

  if (event.type === 'agent.state_changed') {
    const nearby = (event as any)?.payload?.nearbyPlayers;
    if (Array.isArray(nearby) && nearby.length > 0) return 1;
    return 2;
  }
  if (event.type === 'action.finished') return 2;
  if (event.type === 'social.relationship_proposed') return 1;
  return 3;
}

export function enqueueWorldEvent<TEvent extends WsWorldEventBase<string, any>>(args: {
  agentId: string;
  event: TEvent;
  priority: EventPriority;
  registry: BotQueueRegistry<TEvent>;
  dispatcher: EventDispatcher<TEvent>;
  log: { warn: (o: any, m?: string) => void };
  onDropOldest?: (droppedType: string, priority: EventPriority, reason: QueueDropReason) => void;
}): void {
  const q = args.registry.get(args.agentId);

  if (args.event.type === 'agent.queue_refill_requested') {
    const removed = q.removeByType('agent.queue_refill_requested');
    if (removed > 0) {
      eventsDroppedTotal.inc({ type: 'agent.queue_refill_requested', priority: String(args.priority), reason: 'deduplicated' });
    }
  }

  const { dropped, dropReason } = q.enqueue(args.event, args.priority);
  if (dropped) {
    const reason = dropReason ?? 'overflow_oldest';
    args.log.warn(
      {
        agentId: args.agentId,
        type: dropped.event.type,
        priority: dropped.priority,
        eventId: dropped.event.id,
        reason,
        incomingType: args.event.type,
      },
      'queue overflow, dropped event',
    );
    eventsDroppedTotal.inc({ type: dropped.event.type, priority: String(dropped.priority), reason });
    args.onDropOldest?.(dropped.event.type, dropped.priority, reason);
  }
  args.dispatcher.tryDispatch(args.agentId);
}
