import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { LeaseGrant, LeaseStore } from '@jcool/id-generator';
import { DRIZZLE, type DrizzleDBOf } from '@jcool/platform/database';
import type * as schema from '../database/schema';

interface AcquiredRow extends Record<string, unknown> {
  node_id: number;
  generation: string;
  max_ts_ms: string | null;
  prev_until_ms: string;
  lease_until_ms: string;
  db_now_ms: string;
}

// One rounding for every lease end, so the value a holder is told and the one its successor reads match.
const epochMs = (column: SQL) => sql`(extract(epoch FROM ${column}) * 1000)::bigint`;

/**
 * Each operation is a single statement: the claim's row lock only lasts as long as its own statement,
 * so splitting select and update would let two replicas claim one node.
 */
@Injectable()
export class PostgresLeaseStore implements LeaseStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDBOf<typeof schema>) {}

  async acquire(request: { holder: string; ttlMs: number; quarantineMs: number }): Promise<LeaseGrant | null> {
    // The candidate's row is locked, so the lease end read here is the one being replaced. The expiry
    // test is repeated on the UPDATE so the claim stays safe if the candidate query is ever widened.
    const { rows } = await this.db.execute<AcquiredRow>(sql`
      WITH candidate AS (
        SELECT node_id, lease_until AS prev_until FROM node_leases
        WHERE lease_until < now() - ${request.quarantineMs}::int * interval '1 millisecond'
        ORDER BY lease_until, node_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE node_leases n
      SET holder = ${request.holder},
          generation = n.generation + 1,
          lease_until = now() + ${request.ttlMs}::int * interval '1 millisecond',
          acquired_at = now(),
          renewed_at = now()
      FROM candidate c
      WHERE n.node_id = c.node_id
        AND n.lease_until < now() - ${request.quarantineMs}::int * interval '1 millisecond'
      RETURNING n.node_id, n.generation, n.max_ts_ms,
        ${epochMs(sql`c.prev_until`)} AS prev_until_ms,
        ${epochMs(sql`n.lease_until`)} AS lease_until_ms,
        ${epochMs(sql`now()`)} AS db_now_ms
    `);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      nodeId: row.node_id,
      generation: Number(row.generation),
      floorMs: row.max_ts_ms === null ? null : Number(row.max_ts_ms),
      prevUntilMs: Number(row.prev_until_ms),
      leaseUntilMs: Number(row.lease_until_ms),
      dbNowMs: Number(row.db_now_ms),
    };
  }

  async renew(request: {
    nodeId: number;
    holder: string;
    generation: number;
    ttlMs: number;
    lastMs: number;
  }): Promise<number | null> {
    // The floor is recorded even when the lease has already run out, so whoever takes the node next
    // still starts above what this holder minted.
    const { rows } = await this.db.execute<{ lease_until_ms: string | null }>(sql`
      UPDATE node_leases
      SET max_ts_ms = GREATEST(max_ts_ms, NULLIF(${request.lastMs}::bigint, 0)),
          renewed_at = CASE WHEN lease_until > now() THEN now() ELSE renewed_at END,
          lease_until = CASE
            WHEN lease_until > now() THEN now() + ${request.ttlMs}::int * interval '1 millisecond'
            ELSE lease_until
          END
      WHERE node_id = ${request.nodeId} AND holder = ${request.holder} AND generation = ${request.generation}
      RETURNING CASE WHEN lease_until > now() THEN ${epochMs(sql`lease_until`)} END AS lease_until_ms
    `);
    const leaseUntilMs = rows[0]?.lease_until_ms ?? null;
    return leaseUntilMs === null ? null : Number(leaseUntilMs);
  }

  async release(request: { nodeId: number; holder: string; generation: number; lastMs: number | null }): Promise<void> {
    await this.db.execute(sql`
      UPDATE node_leases
      SET holder = NULL,
          lease_until = LEAST(lease_until, now()),
          max_ts_ms = GREATEST(max_ts_ms, ${request.lastMs}::bigint)
      WHERE node_id = ${request.nodeId} AND holder = ${request.holder} AND generation = ${request.generation}
    `);
  }
}
