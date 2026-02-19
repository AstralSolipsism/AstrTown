import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

type UserRole = 'admin' | 'user';

type AuthUser = {
  userId: string;
  username: string;
  role: UserRole;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  getSessionToken: () => string | null;
};

const SESSION_STORAGE_KEY = 'astrtown_session_token';

const AuthContext = createContext<AuthContextValue | null>(null);

function readSessionToken(): string | null {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function writeSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    // ignore localStorage failures (e.g. private mode)
  }
}

function removeSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore localStorage failures (e.g. private mode)
  }
}

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

type JsonObject = Record<string, unknown>;

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const candidate = (payload as JsonObject).message;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
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

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${HTTP_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error('网络请求失败，请检查连接后重试');
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const getSessionToken = useCallback((): string | null => {
    return readSessionToken();
  }, []);

  const fetchMe = useCallback(async (sessionToken: string): Promise<AuthUser | null> => {
    const response = await authFetch('/api/auth/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    const payload = await parseJsonSafe(response);
    if (!response.ok) {
      return null;
    }
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const candidate = payload as JsonObject;
    if (
      typeof candidate.userId === 'string' &&
      typeof candidate.username === 'string' &&
      (candidate.role === 'admin' || candidate.role === 'user')
    ) {
      return {
        userId: candidate.userId,
        username: candidate.username,
        role: candidate.role,
      };
    }
    return null;
  }, []);

  const authenticate = useCallback(
    async (path: '/api/auth/login' | '/api/auth/register', username: string, password: string) => {
      const response = await authFetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });
      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, '认证失败，请稍后重试'));
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('服务器返回数据格式不正确');
      }

      const data = payload as JsonObject;
      const sessionToken = data.sessionToken;
      const userId = data.userId;
      const name = data.username;

      if (
        typeof sessionToken !== 'string' ||
        !sessionToken.trim() ||
        typeof userId !== 'string' ||
        typeof name !== 'string'
      ) {
        throw new Error('登录响应缺少必要字段');
      }

      writeSessionToken(sessionToken);
      const me = await fetchMe(sessionToken);
      if (me) {
        setUser(me);
      } else {
        setUser({ userId, username: name, role: 'user' });
      }
    },
    [fetchMe],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      await authenticate('/api/auth/login', username, password);
    },
    [authenticate],
  );

  const register = useCallback(
    async (username: string, password: string) => {
      await authenticate('/api/auth/register', username, password);
    },
    [authenticate],
  );

  const logout = useCallback(async () => {
    const sessionToken = readSessionToken();

    if (sessionToken) {
      try {
        await authFetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });
      } catch {
        // ignore network failures during local logout cleanup
      }
    }

    removeSessionToken();
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const sessionToken = readSessionToken();
      if (!sessionToken) {
        if (!cancelled) {
          setUser(null);
          setIsLoading(false);
        }
        return;
      }

      try {
        const me = await fetchMe(sessionToken);
        if (cancelled) return;
        if (me) {
          setUser(me);
        } else {
          removeSessionToken();
          setUser(null);
        }
      } catch {
        if (cancelled) return;
        removeSessionToken();
        setUser(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
    };
  }, [fetchMe]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      login,
      register,
      logout,
      getSessionToken,
    }),
    [getSessionToken, isLoading, login, logout, register, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return context;
}

