import dotenv from 'dotenv';
import { DEFAULT_ACK_PLAN } from './eventQueue.js';

dotenv.config();

export type GatewayConfig = {
  astrTownUrl: string;
  port: number;
  gatewaySecret?: string;
  serverVersion: string;
  supportedProtocolVersions: number[];
  ackTimeoutMs: number;
  ackMaxRetries: number;
  ackBackoffMs: number[];
  queueMaxSizePerLevel: number;
  queueRefillAckTimeoutMs: number;
  queueRefillMaxRetries: number;
};

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = Number(raw ?? String(fallback));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function parseBackoff(raw: string | undefined): number[] {
  if (!raw || raw.trim().length === 0) return [...DEFAULT_ACK_PLAN.backoffMs];
  const values = raw
    .split(',')
    .map((it) => Number(it.trim()))
    .filter((it) => Number.isFinite(it) && it >= 0);

  if (values.length === 0) {
    throw new Error('Invalid ACK_BACKOFF_MS');
  }

  return values;
}

export function loadConfig(): GatewayConfig {
  const astrTownUrl = process.env.ASTRTOWN_URL ?? 'http://localhost:3210';
  const port = Number(process.env.PORT ?? '4000');
  if (!Number.isFinite(port) || port <= 0) throw new Error('Invalid PORT');

  const gatewaySecret = process.env.GATEWAY_SECRET;
  const ackTimeoutMs = parsePositiveInt(process.env.ACK_TIMEOUT, DEFAULT_ACK_PLAN.timeoutMs, 'ACK_TIMEOUT');
  const ackMaxRetries = parsePositiveInt(process.env.ACK_MAX_RETRIES, DEFAULT_ACK_PLAN.maxRetries, 'ACK_MAX_RETRIES');
  const ackBackoffMs = parseBackoff(process.env.ACK_BACKOFF_MS);

  const queueMaxSizePerLevel = parsePositiveInt(
    process.env.QUEUE_MAX_SIZE_PER_LEVEL,
    100,
    'QUEUE_MAX_SIZE_PER_LEVEL',
  );
  const queueRefillAckTimeoutMs = parsePositiveInt(
    process.env.QUEUE_REFILL_ACK_TIMEOUT_MS,
    ackTimeoutMs * 2,
    'QUEUE_REFILL_ACK_TIMEOUT_MS',
  );
  const queueRefillMaxRetries = parsePositiveInt(
    process.env.QUEUE_REFILL_MAX_RETRIES,
    1,
    'QUEUE_REFILL_MAX_RETRIES',
  );

  return {
    astrTownUrl,
    port,
    gatewaySecret,
    serverVersion: process.env.GATEWAY_VERSION ?? '0.1.0',
    supportedProtocolVersions: [1],
    ackTimeoutMs,
    ackMaxRetries,
    ackBackoffMs,
    queueMaxSizePerLevel,
    queueRefillAckTimeoutMs,
    queueRefillMaxRetries,
  };
}
