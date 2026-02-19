import { createId } from './id.js';
import type {
  AuthErrorMessage,
  BotBinding,
  ConnectedMessage,
  WsInboundMessage,
  WsOutboundMessage,
} from './types.js';

export type TokenVerifyResult =
  | { valid: true; binding: BotBinding; playerName: string }
  | {
      valid: false;
      code:
        | 'INVALID_TOKEN'
        | 'TOKEN_EXPIRED'
        | 'NPC_NOT_FOUND'
        | 'ALREADY_CONNECTED'
        | 'VERSION_MISMATCH';
      message: string;
      supportedVersions?: number[];
    };

export type NegotiationResult =
  | { ok: true; negotiatedVersion: number; supportedVersions: number[] }
  | { ok: false; code: 'VERSION_MISMATCH'; supportedVersions: number[]; message: string };

export function parseVersionRange(v: string | undefined): { min: number; max: number } {
  if (!v) return { min: 1, max: 1 };
  const parts = v.split('-');
  if (parts.length !== 2) return { min: 1, max: 1 };
  const min = Number(parts[0]);
  const max = Number(parts[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    return { min: 1, max: 1 };
  }
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

export function negotiateVersion(
  clientRange: { min: number; max: number },
  supportedVersions: number[],
): NegotiationResult {
  const acceptable = supportedVersions.filter((v) => v >= clientRange.min && v <= clientRange.max);
  if (acceptable.length === 0) {
    return {
      ok: false,
      code: 'VERSION_MISMATCH',
      supportedVersions: [...supportedVersions].sort((a, b) => a - b),
      message: 'No compatible protocol version',
    };
  }
  return {
    ok: true,
    negotiatedVersion: Math.max(...acceptable),
    supportedVersions: [...supportedVersions].sort((a, b) => a - b),
  };
}

export function parseSubscribeList(subscribe: string | undefined): string[] {
  if (!subscribe) return ['*'];
  const items = subscribe
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length === 0 ? ['*'] : items;
}

export function buildConnectedMessage(args: {
  version: number;
  agentId: string;
  playerId: string;
  playerName: string;
  worldId: string;
  serverVersion: string;
  negotiatedVersion: number;
  supportedVersions: number[];
  subscribedEvents: string[];
}): ConnectedMessage {
  return {
    type: 'connected',
    id: createId('msg'),
    version: args.version,
    timestamp: Date.now(),
    payload: {
      agentId: args.agentId,
      playerId: args.playerId,
      playerName: args.playerName,
      worldId: args.worldId,
      serverVersion: args.serverVersion,
      negotiatedVersion: args.negotiatedVersion,
      supportedVersions: args.supportedVersions,
      subscribedEvents: args.subscribedEvents,
    },
  };
}

export function buildAuthErrorMessage(args: {
  version: number;
  code: AuthErrorMessage['payload']['code'];
  message: string;
  supportedVersions?: number[];
}): AuthErrorMessage {
  return {
    type: 'auth_error',
    id: createId('msg'),
    version: args.version,
    timestamp: Date.now(),
    payload: {
      code: args.code,
      message: args.message,
      supportedVersions: args.supportedVersions,
    },
  };
}

export function parseInboundMessage(raw: unknown): WsInboundMessage {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid message');
  const msg = raw as any;
  if (typeof msg.type !== 'string') throw new Error('Missing type');
  if (typeof msg.id !== 'string') throw new Error('Missing id');
  if (typeof msg.timestamp !== 'number') throw new Error('Missing timestamp');
  if (!('payload' in msg)) throw new Error('Missing payload');
  return msg as WsInboundMessage;
}

export function serializeOutboundMessage(msg: WsOutboundMessage): string {
  return JSON.stringify(msg);
}
