import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Idempotency-key store — the retry-safety backbone for POST /orders. Infrastructure
// only, never imported by domain. Same conventions as the other contexts (UUID v7 ids,
// tz stamps). Holds enough to REPLAY a first response byte-for-byte, to represent an
// in-flight request (IN_PROGRESS), and to reclaim a stuck key after a crash (expiresAt).

export const idempotencyStatus = pgEnum('idempotency_status', ['IN_PROGRESS', 'COMPLETED']);

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    // 'user:{userId}' — idempotency is scoped per user, so one client can never read or
    // collide with another user's cached response.
    scope: text('scope').notNull(),
    // The client-supplied Idempotency-Key header value (a UUID).
    key: text('key').notNull(),
    // sha256(method|path|scope|canonical(body)) — a deterministic fingerprint. Raw body is
    // never stored (avoids table bloat + leaking sensitive input); same key + different
    // hash is a client mistake, answered with 422 rather than a stale replay.
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('IN_PROGRESS'),
    // Populated only on COMPLETED — the frozen result replayed to every retry. jsonb (not
    // text) so the structure round-trips without escape drift.
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    // Soft audit link to the order this key created. No FK: the row is inserted IN_PROGRESS
    // before the order exists, and the order lives in the same context but the link stays a
    // defensive back-reference, not a hard dependency.
    orderId: uuid('order_id'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    // Application sets this to created_at + TTL on insert (kept in app so the TTL stays
    // configurable, not a DB default). A cleanup sweep may delete rows past this instant.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The concurrency backstop: two requests racing the same (scope, key) — the DB lets
    // exactly one INSERT win; the loser sees the conflict instead of double-creating.
    uniqueIndex('uq_idempotency_scope_key').on(t.scope, t.key),
    // Supports the TTL cleanup sweep (DELETE WHERE expires_at < now).
    index('idx_idempotency_expires').on(t.expiresAt),
  ],
);
