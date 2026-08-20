import { randomUUID } from 'node:crypto';

// Idempotency-Key header object for supertest `.set(...)`. Defaults to a fresh UUID so each
// create is a distinct attempt; pass a fixed key to exercise retry/replay of the same request.
export function idempotencyKeyHeader(key: string = randomUUID()): Record<string, string> {
  return { 'Idempotency-Key': key };
}
