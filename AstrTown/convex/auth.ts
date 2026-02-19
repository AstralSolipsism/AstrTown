import { v } from 'convex/values';
import { api } from './_generated/api';
import { httpAction, mutation, query } from './_generated/server';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEY_LENGTH_BITS = 256;
const INVALID_CREDENTIALS_MESSAGE = '用户名或密码错误';
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
const CORS_ALLOW_HEADERS = 'Authorization, Content-Type';
const CORS_MAX_AGE_SECONDS = '86400';

type DbReadableCtx = Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>;
type SessionValidationCtx = DbReadableCtx | Pick<ActionCtx, 'runQuery'>;

export type UserInfo = {
  userId: Id<'users'>;
  username: string;
  role: 'admin' | 'user';
};

function buildCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': CORS_MAX_AGE_SECONDS,
    ...(origin ? { vary: 'origin' } : {}),
  };
}

function corsPreflightResponse(request: Request) {
  const headers = request.headers;
  if (
    headers.get('origin') !== null &&
    headers.get('access-control-request-method') !== null &&
    headers.get('access-control-request-headers') !== null
  ) {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(request),
    });
  }
  return new Response(null, { status: 204 });
}

function jsonResponse(body: unknown, init?: ResponseInit, request?: Request) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(request ? buildCorsHeaders(request) : {}),
      ...(init?.headers ?? {}),
    },
  });
}

function badRequest(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 400 }, request);
}

function unauthorized(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 401 }, request);
}

function internalError(code: string, message: string, request?: Request) {
  return jsonResponse({ ok: false, code, message }, { status: 500 }, request);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function equalsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCookieToken(request: Request): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const pairs = cookie.split(';');
  for (const pair of pairs) {
    const [rawName, ...rawValue] = pair.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    const name = rawName.trim();
    if (name !== 'astrtown_session_token' && name !== 'sessionToken' && name !== 'session_token') {
      continue;
    }
    const value = rawValue.join('=').trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function extractSessionToken(request: Request): string | null {
  return parseBearerToken(request) ?? parseCookieToken(request);
}

function ensureUsername(username: string) {
  if (!USERNAME_REGEX.test(username)) {
    throw new Error('用户名格式不正确');
  }
}

function ensureRegisterPassword(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`密码长度至少为${PASSWORD_MIN_LENGTH}位`);
  }
}

async function createSession(ctx: MutationCtx, userId: Id<'users'>): Promise<string> {
  const now = Date.now();
  const token = generateSessionToken();
  await ctx.db.insert('sessions', {
    userId,
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return token;
}

async function validateSessionWithDb(ctx: DbReadableCtx, sessionToken: string): Promise<UserInfo | null> {
  const token = sessionToken.trim();
  if (!token) return null;

  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q: any) => q.eq('token', token))
    .unique();
  if (!session) return null;
  if (session.expiresAt <= Date.now()) return null;

  const user = await ctx.db.get(session.userId);
  if (!user) return null;

  return {
    userId: user._id,
    username: user.username,
    role: user.role,
  };
}

function isDbCtx(ctx: SessionValidationCtx): ctx is DbReadableCtx {
  return 'db' in ctx;
}

export async function validateSession(
  ctx: SessionValidationCtx,
  sessionToken: string,
): Promise<UserInfo | null> {
  if (isDbCtx(ctx)) {
    return await validateSessionWithDb(ctx, sessionToken);
  }
  return await ctx.runQuery((api as any).auth.getMe, { sessionToken });
}

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const pepper = ((globalThis as any)?.process?.env?.AUTH_SECRET as string | undefined) ?? '';
  const keyMaterial = encoder.encode(`${password}:${pepper}`);
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    PBKDF2_KEY_LENGTH_BITS,
  );
  return toHex(new Uint8Array(bits));
}

export const register = mutation({
  args: {
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const username = args.username.trim();
    ensureUsername(username);
    ensureRegisterPassword(args.password);

    const existed = await ctx.db
      .query('users')
      .withIndex('by_username', (q: any) => q.eq('username', username))
      .unique();
    if (existed) {
      throw new Error('用户名已存在');
    }

    const salt = generateSalt();
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(args.password, salt);
    } catch {
      throw new Error('密码处理失败');
    }

    const userId = await ctx.db.insert('users', {
      username,
      passwordHash,
      salt,
      role: 'user',
      createdAt: Date.now(),
    });

    const sessionToken = await createSession(ctx, userId);
    return {
      userId,
      sessionToken,
      username,
    };
  },
});

export const login = mutation({
  args: {
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const username = args.username.trim();
    if (!username || !args.password) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE);
    }

    const user = await ctx.db
      .query('users')
      .withIndex('by_username', (q: any) => q.eq('username', username))
      .unique();
    if (!user) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE);
    }

    let expectedHash: string;
    try {
      expectedHash = await hashPassword(args.password, user.salt);
    } catch {
      throw new Error(INVALID_CREDENTIALS_MESSAGE);
    }

    if (!equalsConstantTime(expectedHash, user.passwordHash)) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE);
    }

    const sessionToken = await createSession(ctx, user._id);
    return {
      userId: user._id,
      sessionToken,
      username: user.username,
    };
  },
});

export const logout = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const sessionToken = args.sessionToken.trim();
    if (!sessionToken) {
      throw new Error('缺少 session token');
    }
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_token', (q: any) => q.eq('token', sessionToken))
      .unique();
    if (session) {
      await ctx.db.delete(session._id);
    }
    return { ok: true };
  },
});

export const getMe = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx: any, args: any): Promise<UserInfo | null> => {
    return await validateSessionWithDb({ db: ctx.db }, args.sessionToken);
  },
});

export const optionsAuth = httpAction(async (_ctx: ActionCtx, request: Request) => {
  return corsPreflightResponse(request);
});

export const postAuthRegister = httpAction(async (ctx: ActionCtx, request: Request) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON', request);
  }

  const username = body?.username;
  const password = body?.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return badRequest('INVALID_ARGS', 'Missing username/password', request);
  }

  try {
    const result = await ctx.runMutation((api as any).auth.register, { username, password });
    return jsonResponse(result, undefined, request);
  } catch (e: any) {
    const message = String(e?.message ?? e ?? '注册失败');
    if (message.includes('用户名已存在')) {
      return badRequest('USERNAME_EXISTS', '用户名已存在', request);
    }
    if (message.includes('用户名格式不正确') || message.includes('密码长度至少为')) {
      return badRequest('INVALID_ARGS', message, request);
    }
    return internalError('REGISTER_FAILED', '注册失败，请稍后重试', request);
  }
});

export const postAuthLogin = httpAction(async (ctx: ActionCtx, request: Request) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('INVALID_JSON', 'Request body is not valid JSON', request);
  }

  const username = body?.username;
  const password = body?.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return badRequest('INVALID_ARGS', 'Missing username/password', request);
  }

  try {
    const result = await ctx.runMutation((api as any).auth.login, { username, password });
    return jsonResponse(result, undefined, request);
  } catch (e: any) {
    const message = String(e?.message ?? e ?? INVALID_CREDENTIALS_MESSAGE);
    if (message.includes(INVALID_CREDENTIALS_MESSAGE)) {
      return unauthorized('AUTH_FAILED', INVALID_CREDENTIALS_MESSAGE, request);
    }
    return internalError('LOGIN_FAILED', '登录失败，请稍后重试', request);
  }
});

export const postAuthLogout = httpAction(async (ctx: ActionCtx, request: Request) => {
  let sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return badRequest('INVALID_JSON', 'Request body is not valid JSON', request);
      }
      if (typeof body?.sessionToken === 'string') {
        sessionToken = body.sessionToken.trim();
      }
    }
  }

  if (!sessionToken) {
    return badRequest('INVALID_ARGS', 'Missing session token', request);
  }

  try {
    await ctx.runMutation((api as any).auth.logout, { sessionToken });
    return jsonResponse({ ok: true }, undefined, request);
  } catch {
    return internalError('LOGOUT_FAILED', '注销失败，请稍后重试', request);
  }
});

export const getAuthMe = httpAction(async (ctx: ActionCtx, request: Request) => {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return jsonResponse(null, undefined, request);
  }

  try {
    const me = await ctx.runQuery((api as any).auth.getMe, { sessionToken });
    return jsonResponse(me ?? null, undefined, request);
  } catch {
    return jsonResponse(null, undefined, request);
  }
});
