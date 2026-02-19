import { randomUUID } from 'node:crypto';

export function createUuid(): string {
  return randomUUID();
}
