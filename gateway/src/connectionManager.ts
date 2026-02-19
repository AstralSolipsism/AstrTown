import type { BotSession, ConnectionState } from './types.js';

export type BotConnection = {
  state: ConnectionState;
  session: BotSession;
  socket: WebSocket;
  lastPongAt: number;
  subscribedEvents: string[];
};

export class ConnectionManager {
  private readonly byToken = new Map<string, BotConnection>();
  private readonly byAgentId = new Map<string, BotConnection>();

  hasToken(token: string): boolean {
    return this.byToken.has(token);
  }

  getByToken(token: string): BotConnection | undefined {
    return this.byToken.get(token);
  }

  getByAgentId(agentId: string): BotConnection | undefined {
    return this.byAgentId.get(agentId);
  }

  register(conn: BotConnection): void {
    this.byToken.set(conn.session.token, conn);
    this.byAgentId.set(conn.session.agentId, conn);
  }

  unregisterByToken(token: string): BotConnection | undefined {
    const conn = this.byToken.get(token);
    if (!conn) return undefined;
    this.byToken.delete(token);
    this.byAgentId.delete(conn.session.agentId);
    return conn;
  }

  listSessions(): BotSession[] {
    return [...this.byToken.values()].map((c) => c.session);
  }

  size(): number {
    return this.byToken.size;
  }
}
