import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { LEASED_NODE_MAX, LEASED_NODE_MIN } from '@jcool/id-generator';

/** One row per node id a replica may mint under; the rows are seeded once and never deleted. */
export const nodeLeases = pgTable(
  'node_leases',
  {
    nodeId: smallint('node_id').primaryKey(),
    holder: text('holder'),
    generation: bigint('generation', { mode: 'number' }).notNull().default(0),
    // 'epoch' rather than -infinity: the acquire subtracts the quarantine, and -infinity minus an
    // interval is still -infinity, so a never-leased node would never compare as expired.
    leaseUntil: timestamp('lease_until', { withTimezone: true })
      .notNull()
      .default(sql`'epoch'`),
    maxTsMs: bigint('max_ts_ms', { mode: 'number' }),
    // The lease_until this row carried the instant before its current claim overwrote it. An acquire
    // that commits here but whose caller never learns it (a client-side query_timeout) retries and
    // re-adopts this same row by holder; the retry needs this value to floor its generator the same
    // way the original claim would have, since `lease_until` itself has since moved to the new claim.
    priorLeaseUntil: timestamp('prior_lease_until', { withTimezone: true }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }),
    renewedAt: timestamp('renewed_at', { withTimezone: true }),
  },
  (table) => [
    // Nodes 0 and 31 stay reserved for the api and the scripts; a lease must never hand either out.
    check(
      'node_leases_node_id_range',
      sql`${table.nodeId} BETWEEN ${sql.raw(String(LEASED_NODE_MIN))} AND ${sql.raw(String(LEASED_NODE_MAX))}`,
    ),
  ],
);
