import { useCallback, useMemo, useState } from 'react';
import { useAuth } from './useAuth.tsx';

export type NpcInfo = {
  botTokenId: string;
  agentId: string;
  playerId: string;
  worldId: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  isActive: boolean;
  isExpired: boolean;
  tokenStatus: 'active' | 'inactive' | 'expired';
  hasToken: boolean;
  name: string | null;
  character: string | null;
  description: string | null;
};

export type CreateResult = {
  agentId: string;
  playerId: string;
  token: string;
  name: string;
};

type JsonObject = Record<string, unknown>;

function toHttpBaseUrl(): string {
  // 优先使用显式指定的 Site URL（自托管场景）
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (siteUrl) {
    return siteUrl.replace(/\/$/, '');
  }

  // 回退：从 VITE_CONVEX_URL 推导（云托管场景）
  const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!convexUrl) {
    throw new Error('缺少 VITE_CONVEX_URL 环境变量');
  }

  try {
    const parsed = new URL(convexUrl);
    if (parsed.hostname.endsWith('.convex.cloud')) {
      parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/i, '.convex.site');
    }
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error('VITE_CONVEX_URL 格式不正确');
  }
}

const HTTP_BASE_URL = toHttpBaseUrl();

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const message = (payload as JsonObject).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return fallback;
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseNpcItem(raw: unknown): NpcInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const item = raw as JsonObject;

  const tokenStatus = item.tokenStatus;
  if (tokenStatus !== 'active' && tokenStatus !== 'inactive' && tokenStatus !== 'expired') {
    return null;
  }

  if (
    typeof item.botTokenId !== 'string' ||
    typeof item.agentId !== 'string' ||
    typeof item.playerId !== 'string' ||
    typeof item.worldId !== 'string' ||
    typeof item.createdAt !== 'number' ||
    typeof item.expiresAt !== 'number' ||
    !(item.lastUsedAt === null || typeof item.lastUsedAt === 'number') ||
    typeof item.isActive !== 'boolean' ||
    typeof item.isExpired !== 'boolean' ||
    typeof item.hasToken !== 'boolean' ||
    !(item.name === null || typeof item.name === 'string') ||
    !(item.character === null || typeof item.character === 'string') ||
    !(item.description === null || typeof item.description === 'string')
  ) {
    return null;
  }

  return {
    botTokenId: item.botTokenId,
    agentId: item.agentId,
    playerId: item.playerId,
    worldId: item.worldId,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    lastUsedAt: item.lastUsedAt,
    isActive: item.isActive,
    isExpired: item.isExpired,
    tokenStatus,
    hasToken: item.hasToken,
    name: item.name,
    character: item.character,
    description: item.description,
  };
}

export function useNpcService() {
  const { getSessionToken } = useAuth();
  const [npcs, setNpcs] = useState<NpcInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const authorizedFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const sessionToken = getSessionToken();
      if (!sessionToken) {
        throw new Error('未登录或会话已失效');
      }

      try {
        return await fetch(`${HTTP_BASE_URL}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            ...(init?.headers ?? {}),
          },
        });
      } catch {
        throw new Error('网络请求失败，请检查连接后重试');
      }
    },
    [getSessionToken],
  );

  const refreshList = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await authorizedFetch('/api/npc/list', { method: 'GET' });
      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, '获取 NPC 列表失败'));
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('服务端返回格式不正确');
      }

      const itemsRaw = (payload as JsonObject).items;
      if (!Array.isArray(itemsRaw)) {
        throw new Error('服务端返回缺少 items');
      }

      const parsed = itemsRaw.map(parseNpcItem).filter((item): item is NpcInfo => !!item);
      setNpcs(parsed);
    } finally {
      setIsLoading(false);
    }
  }, [authorizedFetch]);

  const createNpc = useCallback(
    async (name: string, character?: string): Promise<CreateResult> => {
      const body: Record<string, string> = { name };
      if (character && character.trim()) {
        body.character = character;
      }

      const response = await authorizedFetch('/api/npc/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, '创建 NPC 失败'));
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('服务端返回格式不正确');
      }

      const data = payload as JsonObject;
      if (
        typeof data.agentId !== 'string' ||
        typeof data.playerId !== 'string' ||
        typeof data.token !== 'string' ||
        typeof data.name !== 'string'
      ) {
        throw new Error('创建 NPC 响应缺少关键字段');
      }

      return {
        agentId: data.agentId,
        playerId: data.playerId,
        token: data.token,
        name: data.name,
      };
    },
    [authorizedFetch],
  );

  const resetToken = useCallback(
    async (botTokenId: string): Promise<string> => {
      const response = await authorizedFetch('/api/npc/reset-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ botTokenId }),
      });
      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, '重置 Token 失败'));
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('服务端返回格式不正确');
      }

      const token = (payload as JsonObject).token;
      if (typeof token !== 'string' || !token.trim()) {
        throw new Error('重置 Token 响应缺少 token');
      }
      return token;
    },
    [authorizedFetch],
  );

  const getToken = useCallback(
    async (botTokenId: string): Promise<string> => {
      const encoded = encodeURIComponent(botTokenId);
      const response = await authorizedFetch(`/api/npc/token/${encoded}`, { method: 'GET' });
      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, '获取 Token 失败'));
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('服务端返回格式不正确');
      }

      const token = (payload as JsonObject).token;
      if (typeof token !== 'string' || !token.trim()) {
        throw new Error('获取 Token 响应缺少 token');
      }
      return token;
    },
    [authorizedFetch],
  );

  return useMemo(
    () => ({
      npcs,
      isLoading,
      createNpc,
      resetToken,
      getToken,
      refreshList,
    }),
    [createNpc, getToken, isLoading, npcs, refreshList, resetToken],
  );
}

