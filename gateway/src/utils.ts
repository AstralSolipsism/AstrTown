import { createId } from './id.js';
import type { AuthErrorMessage } from './types.js';

export class IdempotencyCache {
  private readonly set = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest) this.set.delete(oldest);
    }
  }
}

export function buildAlreadyConnectedError(version: number): AuthErrorMessage {
  return {
    type: 'auth_error',
    id: createId('msg'),
    version,
    timestamp: Date.now(),
    payload: {
      code: 'ALREADY_CONNECTED',
      message: 'Token already connected',
    },
  };
}
