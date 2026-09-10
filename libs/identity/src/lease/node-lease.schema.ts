import { bigint, check, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NODE_ID_MAX } from '../node-ids';

/**
 * A lib owning a table, like `outbox.schema.ts` — and unlike the outbox, in its own database. No app
 * schema barrel re-exports it: the only writer is the lease repository, and Phase 6 moves the
 * *process* that connects, not the rows.
 */
export const nodeLeases = pgTable(
  'node_leases',
  {
    // Pools are per service, so `user` node 7 and `scripts` node 7 mint into different id spaces and
    // cannot collide. This is what retires the old global reservation for scripts.
    service: text('service').notNull(),
    node: smallint('node').notNull(),
    // The fencing token. New on every acquire, which a holder string cannot promise — the same
    // container name reappears after a restart.
    leaseId: uuid('lease_id'),
    // Descriptive only. Never appears in a WHERE clause.
    holder: text('holder'),
    renewedAt: timestamp('renewed_at', { withTimezone: true }),
    // Highest ms the holder minted at. Half of the reclaim guard.
    lastTsMs: bigint('last_ts_ms', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.service, table.node] }),
    check('ck_node_leases_range', sql`${table.node} BETWEEN 0 AND ${sql.raw(String(NODE_ID_MAX))}`),
  ],
);
