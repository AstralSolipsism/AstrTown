import type { ConnectionManager } from './connectionManager.js';
import type { EventDispatcher } from './eventDispatcher.js';
import type { EventPriority, WsWorldEventBase } from './types.js';
import { EventQueue } from './eventQueue.js';

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
  if (hinted !== undefined) return hinted;
  if (event.type.startsWith('conversation.')) return 0;
  if (event.type === 'agent.state_changed') {
    const nearby = (event as any)?.payload?.nearbyPlayers;
    if (Array.isArray(nearby) && nearby.length > 0) return 1;
    return 2;
  }
  if (event.type === 'action.finished') return 2;
  return 3;
}

export function enqueueWorldEvent<TEvent extends WsWorldEventBase<string, any>>(args: {
  agentId: string;
  event: TEvent;
  priority: EventPriority;
  registry: BotQueueRegistry<TEvent>;
  dispatcher: EventDispatcher<TEvent>;
  log: { warn: (o: any, m?: string) => void };
  onDropOldest?: (droppedType: string, priority: EventPriority) => void;
}): void {
  const q = args.registry.get(args.agentId);
  const { dropped } = q.enqueue(args.event, args.priority);
  if (dropped) {
    args.log.warn(
      { agentId: args.agentId, type: dropped.event.type, priority: dropped.priority, eventId: dropped.event.id },
      'queue overflow, dropped oldest',
    );
    args.onDropOldest?.(dropped.event.type, dropped.priority);
  }
  args.dispatcher.tryDispatch(args.agentId);
}
