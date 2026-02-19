import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from 'prom-client';

collectDefaultMetrics({ prefix: 'gateway_' });

export const wsConnections = new Gauge({
  name: 'gateway_ws_connections_total',
  help: 'Current active WSS connections',
});

export const wsConnectionsCreated = new Counter({
  name: 'gateway_ws_connections_created_total',
  help: 'Total created WSS connections',
});

export const wsConnectionsClosed = new Counter({
  name: 'gateway_ws_connections_closed_total',
  help: 'Total closed WSS connections',
  labelNames: ['reason'] as const,
});

export const commandsTotal = new Counter({
  name: 'gateway_commands_total',
  help: 'Total commands received/forwarded',
  labelNames: ['type', 'status'] as const,
});

export const commandLatencyMs = new Histogram({
  name: 'gateway_command_latency_ms',
  help: 'Command forwarding latency (ms)',
  labelNames: ['type'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const eventsReceivedTotal = new Counter({
  name: 'gateway_events_received_total',
  help: 'Total received world events',
  labelNames: ['type', 'priority'] as const,
});

export const eventsDispatchedTotal = new Counter({
  name: 'gateway_events_dispatched_total',
  help: 'Total dispatched world events',
  labelNames: ['type', 'status'] as const,
});

export const eventDispatchLatencyMs = new Histogram({
  name: 'gateway_event_dispatch_latency_ms',
  help: 'Event dispatch latency (ms)',
  labelNames: ['type'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const ackFailuresTotal = new Counter({
  name: 'gateway_ack_failures_total',
  help: 'Total ACK failures',
  labelNames: ['type'] as const,
});

export const eventsExpiredTotal = new Counter({
  name: 'gateway_events_expired_total',
  help: 'Total expired events dropped',
  labelNames: ['type', 'priority'] as const,
});

export const queueDepth = new Gauge({
  name: 'gateway_queue_depth',
  help: 'Queue depth per agent and priority',
  labelNames: ['agent_id', 'priority'] as const,
});

export const heartbeatLatencyMs = new Histogram({
  name: 'gateway_heartbeat_latency_ms',
  help: 'Heartbeat round-trip latency (ms)',
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return {
    contentType: register.contentType,
    body: await register.metrics(),
  };
}

export async function renderMetricsJson(): Promise<{ timestamp: number; metrics: unknown[] }> {
  const all = await register.getMetricsAsJSON();
  const metrics = all.filter((m: any) => {
    const name = String(m?.name ?? '');
    return !name.startsWith('gateway_nodejs_') && !name.startsWith('gateway_process_');
  });

  return {
    timestamp: Date.now(),
    metrics,
  };
}
