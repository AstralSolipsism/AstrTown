import type { SemanticSnapshot } from './types.js';

export type AstrTownClientDeps = {
  baseUrl: string;
  fetchFn?: typeof fetch;
};

export type VerifyTokenResponse =
  | {
      valid: true;
      binding: {
        token: string;
        agentId: string;
        playerId: string;
        worldId: string;
        expiresAt: number;
        isActive: boolean;
      };
    }
  | { valid: false; code: string; message: string };

export type PostCommandResponse =
  | { status: 'accepted'; inputId: string }
  | { status: 'rejected'; code: string; message: string };

export type PostCommandEnqueueMode = 'immediate' | 'queue';

export type PostCommandBatchEvent = {
  eventId: string;
  kind: string;
  args: Record<string, any>;
  priority?: number;
  expiresAt?: number;
};

export type PostCommandBatchArgs = {
  token: string;
  idempotencyKey: string;
  worldId: string;
  agentId: string;
  events: PostCommandBatchEvent[];
};

export type UpdateDescriptionResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  statusCode?: number;
};

export type UpsertRelationshipResponse = {
  ok: boolean;
  relationshipId?: string;
  error?: string;
  code?: string;
  statusCode?: number;
};

export type GetSemanticSnapshotResponse =
  | {
      ok: true;
      snapshot: SemanticSnapshot;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      statusCode?: number;
    };

export class AstrTownClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: AstrTownClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async validateToken(token: string): Promise<VerifyTokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/bot/token/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (e: any) {
      return {
        valid: false,
        code: 'NETWORK_ERROR',
        message: String(e?.message ?? e ?? 'Network error'),
      };
    }

    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return {
        valid: false,
        code: String(json?.code ?? 'INVALID_TOKEN'),
        message: String(json?.message ?? 'Invalid token'),
      };
    }

    // Convex: AstrTown/convex/botApi.ts#postTokenValidate 仅返回 { valid, agentId, playerId, worldId }
    // 不包含 expiresAt/isActive；这里保持缺省值。
    const expiresAt = Number(json?.expiresAt ?? 0);
    const isActive = Boolean(json?.isActive ?? true);

    if (!json?.agentId || !json?.playerId || !json?.worldId) {
      return {
        valid: false,
        code: 'INVALID_TOKEN_RESPONSE',
        message: 'Missing required fields in token response',
      };
    }

    return {
      valid: true,
      binding: {
        token,
        agentId: String(json.agentId),
        playerId: String(json.playerId),
        worldId: String(json.worldId),
        expiresAt,
        isActive,
      },
    };
  }

  async postCommand(args: {
    token: string;
    idempotencyKey: string;
    agentId: string;
    commandType: string;
    args: unknown;
    enqueueMode?: PostCommandEnqueueMode;
  }): Promise<PostCommandResponse> {
    let res: Response;
    try {
      const requestBody: Record<string, unknown> = {
        agentId: args.agentId,
        commandType: args.commandType,
        args: args.args,
      };
      if (args.enqueueMode !== undefined) {
        requestBody.enqueueMode = args.enqueueMode;
      }

      res = await this.fetchFn(`${this.baseUrl}/api/bot/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${args.token}`,
          'x-idempotency-key': args.idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (e: any) {
      return {
        status: 'rejected',
        code: 'NETWORK_ERROR',
        message: String(e?.message ?? e ?? 'Network error'),
      };
    }

    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return {
        status: 'rejected',
        code: String(json?.code ?? 'COMMAND_REJECTED'),
        message: String(json?.message ?? 'Command rejected'),
      };
    }

    return { status: 'accepted', inputId: String(json?.inputId ?? '') };
  }

  async postCommandBatch(args: PostCommandBatchArgs): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/bot/command/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${args.token}`,
          'x-idempotency-key': args.idempotencyKey,
        },
        body: JSON.stringify({
          worldId: args.worldId,
          agentId: args.agentId,
          events: args.events,
        }),
      });
    } catch (e: any) {
      throw new Error(String(e?.message ?? e ?? 'Network error'));
    }

    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any;
      const code = String(json?.code ?? 'COMMAND_BATCH_REJECTED');
      const message = String(json?.message ?? `postCommandBatch failed with status ${res.status}`);
      throw new Error(`${code}: ${message}`);
    }
  }

  async updateDescription(token: string, playerId: string, description: string): Promise<UpdateDescriptionResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/bot/description/update`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ playerId, description }),
      });
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e ?? 'Network error') };
    }

    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return {
        ok: false,
        error: String(json?.error ?? json?.message ?? `Request failed with status ${res.status}`),
        code: typeof json?.code === 'string' ? json.code : undefined,
        statusCode: res.status,
      };
    }

    const ok = Boolean(json?.ok ?? true);
    if (!ok) {
      return {
        ok: false,
        error: String(json?.error ?? json?.message ?? 'Description update rejected'),
        code: typeof json?.code === 'string' ? json.code : undefined,
        statusCode: res.status,
      };
    }

    return { ok: true };
  }

  async getSemanticSnapshot(worldId: string, authorization?: string): Promise<GetSemanticSnapshotResponse> {
    let res: Response;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (authorization) {
        headers.authorization = authorization;
      }

      res = await this.fetchFn(`${this.baseUrl}/api/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: 'mapSemanticService:getSemanticSnapshot',
          args: { worldId },
          format: 'json',
        }),
      });
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e ?? 'Network error') };
    }

    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return {
        ok: false,
        error: String(json?.error ?? json?.message ?? `Request failed with status ${res.status}`),
        code: typeof json?.code === 'string' ? json.code : undefined,
        statusCode: res.status,
      };
    }

    if (json?.status === 'error') {
      return {
        ok: false,
        error: String(json?.errorMessage ?? json?.error ?? 'Semantic snapshot query failed'),
        code: typeof json?.code === 'string' ? json.code : undefined,
        statusCode: 500,
      };
    }

    if (!json?.value || typeof json.value !== 'object') {
      return {
        ok: false,
        error: 'Invalid semantic snapshot response',
        code: 'INVALID_RESPONSE',
        statusCode: 500,
      };
    }

    return {
      ok: true,
      snapshot: json.value as SemanticSnapshot,
    };
  }

  async upsertRelationship(
    token: string,
    args: { playerAId: string; playerBId: string; status: string; establishedAt: number },
  ): Promise<UpsertRelationshipResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/bot/social/relationship`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
      });
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e ?? 'Network error') };
    }

    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return {
        ok: false,
        error: String(json?.error ?? json?.message ?? `Request failed with status ${res.status}`),
        code: typeof json?.code === 'string' ? json.code : undefined,
        statusCode: res.status,
      };
    }

    const ok = Boolean(json?.ok ?? true);
    if (!ok) {
      return {
        ok: false,
        error: String(json?.error ?? json?.message ?? 'Relationship upsert rejected'),
        code: typeof json?.code === 'string' ? json.code : undefined,
        statusCode: res.status,
      };
    }

    return {
      ok: true,
      relationshipId: typeof json?.relationshipId === 'string' ? json.relationshipId : undefined,
    };
  }
}
