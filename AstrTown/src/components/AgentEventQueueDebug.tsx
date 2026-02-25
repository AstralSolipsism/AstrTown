import { useMemo, useState } from 'react';
import type { ExternalEventItem, ExternalQueueState } from '../../convex/aiTown/agent';

interface AgentEventQueueDebugProps {
  externalEventQueue: ExternalEventItem[];
  externalPriorityQueue: ExternalEventItem[];
  externalQueueState: ExternalQueueState | undefined;
}

function formatTime(ts?: number) {
  if (!ts || Number.isNaN(ts)) {
    return '暂无';
  }
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatArgs(args: Record<string, any>) {
  try {
    const raw = JSON.stringify(args);
    if (!raw) {
      return '{}';
    }
    return raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
  } catch {
    return '[参数序列化失败]';
  }
}

function renderExpires(expiresAt?: number) {
  if (!expiresAt) {
    return <span className="text-clay-200/80">expires: 无</span>;
  }
  const expired = expiresAt <= Date.now();
  if (expired) {
    return <span className="text-red-300">expires: 已过期</span>;
  }
  return <span className="text-amber-200">expires: {formatTime(expiresAt)}</span>;
}

function EventListSection({
  title,
  events,
}: {
  title: string;
  events: ExternalEventItem[];
}) {
  return (
    <div className="rounded border border-clay-300/30 bg-clay-700/80">
      <div className="border-b border-clay-300/30 bg-brown-700 px-3 py-1 text-sm tracking-wide text-clay-100">
        {title}
      </div>
      <ul className="space-y-2 p-3">
        {events.map((item) => (
          <li key={item.eventId} className="rounded border border-clay-300/20 bg-[#2f3854] p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded border border-emerald-300/50 bg-emerald-700/40 px-2 py-0.5 font-semibold text-emerald-100">
                {item.kind}
              </span>
              <span className="text-clay-100/80">#{item.eventId.slice(0, 8)}</span>
              <span className="ml-auto text-clay-200/80">priority: {item.priority}</span>
            </div>
            <p className="mt-1 break-all text-clay-100/90">args: {formatArgs(item.args)}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-clay-200/80">
              <span>enqueue: {formatTime(item.enqueueTs)}</span>
              {renderExpires(item.expiresAt)}
              <span>source: {item.source}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AgentEventQueueDebug({
  externalEventQueue,
  externalPriorityQueue,
  externalQueueState,
}: AgentEventQueueDebugProps) {
  const [expanded, setExpanded] = useState(true);

  const mode = externalQueueState?.idle.mode ?? 'unknown';
  const retries = externalQueueState?.prefetch.retries ?? 0;
  const waiting = externalQueueState?.prefetch.waiting ? '是' : '否';
  const dispatched = externalQueueState?.prefetch.dispatched ? '是' : '否';
  const missCount = externalQueueState?.idle.consecutivePrefetchMisses ?? 0;
  const lastDequeuedAt = externalQueueState?.lastDequeuedAt;

  const hasAnyQueue = externalPriorityQueue.length > 0 || externalEventQueue.length > 0;

  const summary = useMemo(
    () =>
      `优先队列 ${externalPriorityQueue.length} 条 | 普通队列 ${externalEventQueue.length} 条 | 模式: ${mode}`,
    [externalPriorityQueue.length, externalEventQueue.length, mode],
  );

  return (
    <div className="box mt-6 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between bg-brown-700 px-3 py-2 text-left text-white"
      >
        <span className="font-display text-lg tracking-wide">事件队列调试</span>
        <span className="text-xs text-clay-100/90">{expanded ? '收起 ▲' : '展开 ▼'}</span>
      </button>

      {expanded && (
        <div className="space-y-3 bg-[#353b59] p-3 text-sm text-clay-100">
          <p className="rounded border border-clay-300/30 bg-clay-700/70 px-3 py-2 text-xs sm:text-sm">
            {summary}
          </p>

          {!hasAnyQueue && (
            <div className="rounded border border-dashed border-clay-300/40 bg-clay-700/60 px-3 py-4 text-center text-clay-200">
              队列为空
            </div>
          )}

          {externalPriorityQueue.length > 0 && (
            <EventListSection title="优先队列" events={externalPriorityQueue} />
          )}

          {externalEventQueue.length > 0 && (
            <EventListSection title="普通队列" events={externalEventQueue} />
          )}

          <div className="rounded border border-clay-300/30 bg-clay-700/80 p-3 text-xs sm:text-sm">
            <p className="font-display text-base text-clay-100">调度状态</p>
            <div className="mt-1 grid grid-cols-1 gap-1 text-clay-100/90 sm:grid-cols-2">
              <p>idle.mode: {mode}</p>
              <p>prefetch.retries: {retries}</p>
              <p>prefetch.waiting: {waiting}</p>
              <p>prefetch.dispatched: {dispatched}</p>
              <p>consecutiveMisses: {missCount}</p>
              <p>lastDequeuedAt: {formatTime(lastDequeuedAt)}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
