import { randomUUID } from 'node:crypto';

export function idempotencyKeyHeader(key: string = randomUUID()): Record<string, string> {
  return { 'Idempotency-Key': key };
}
