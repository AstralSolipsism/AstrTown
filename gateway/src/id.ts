import { createUuid } from './uuid.js';

export function createId(prefix?: string): string {
  const id = createUuid();
  return prefix ? `${prefix}_${id}` : id;
}
