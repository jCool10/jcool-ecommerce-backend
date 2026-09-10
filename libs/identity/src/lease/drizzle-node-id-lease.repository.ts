import { sql } from 'drizzle-orm';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { NodeIdLeasePort, NodeLease } from './node-id-lease.port';
import { poolSizeFor, type ServicePools } from './service-pools';

interface AcquireRow extends Record<string, unknown> {
  node: number;
  lease_id: string;
}

/**
 * Bound to `DRIZZLE_LEASE`, never the app's `DRIZZLE`: the lease lives in its own database so
 * Phase 6 can move the connecting *process* without moving a row.
 */
export class DrizzleNodeIdLeaseRepository implements NodeIdLeasePort {
  private readonly expiryMs: number;

  constructor(
    private readonly db: DrizzleDB,
    private readonly pools: ServicePools,
    ttlSeconds: number,
    private readonly skewMs: number,
  ) {
    this.expiryMs = ttlSeconds * 1000 + skewMs;
  }

  async acquire(service: string, holder: string): Promise<NodeLease | null> {
    // Validated before any statement runs: acquire seeds a pool on first contact, so an unchecked
    // name would create one rather than fail.
    const poolSize = poolSizeFor(this.pools, service);

    return this.db.transaction(async (tx) => {
      // Materialize this service's pool once; a no-op on every later acquire. Seeding here rather
      // than in the migration is what lets pools be per service — a migration cannot know which
      // services will exist — and removes "a truncate wiped the seed" as a failure mode.
      await tx.execute(sql`
        INSERT INTO node_leases (service, node)
        SELECT ${service}, g FROM generate_series(0, ${poolSize - 1}) AS g
        ON CONFLICT (service, node) DO NOTHING
      `);

      // Both halves of the reclaim guard carry the skew. Applying it only to last_ts_ms is the
      // subtle bug: a holder keeps minting after its last renewal, so under a partition the
      // reclaimer's last_ts_ms is up to one renewal interval stale and passes on old data. The
      // allowance on renewed_at covers the gap between "the DB stopped hearing from the holder" and
      // "the holder actually stopped".
      const taken = await tx.execute<AcquireRow>(sql`
        UPDATE node_leases
        SET lease_id = gen_random_uuid(), holder = ${holder}, renewed_at = now()
        WHERE (service, node) = (
          SELECT service, node FROM node_leases
          WHERE service = ${service}
            -- Bounded by the pool as configured *now*, not by whatever a past size seeded. Without
            -- it, shrinking a pool would keep handing out the nodes above the new ceiling.
            AND node < ${poolSize}
            AND (
              lease_id IS NULL
              OR extract(epoch from renewed_at) * 1000 < (extract(epoch from now()) * 1000) - ${this.expiryMs}
            )
            AND last_ts_ms + ${this.skewMs} < (extract(epoch from now()) * 1000)
          ORDER BY node
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING node, lease_id
      `);

      const row = taken.rows.at(0);
      return row ? { service, node: Number(row.node), leaseId: row.lease_id } : null;
    });
  }

  async renew(lease: NodeLease, lastMs: number): Promise<boolean> {
    // `lease_id` alone identifies the lease; `service`/`node` are scoping predicates, never
    // authorization ones. `holder` never appears here.
    const renewed = await this.db.execute(sql`
      UPDATE node_leases
      SET renewed_at = now(), last_ts_ms = GREATEST(last_ts_ms, ${lastMs})
      WHERE service = ${lease.service} AND node = ${lease.node} AND lease_id = ${lease.leaseId}
      RETURNING node
    `);

    return renewed.rows.length > 0;
  }

  async release(lease: NodeLease, lastMs: number): Promise<void> {
    // last_ts_ms survives the release — the node is immediately re-acquirable, and the next holder's
    // guard reads the real high-water mark rather than one a renewal interval old.
    await this.db.execute(sql`
      UPDATE node_leases
      SET lease_id = NULL, holder = NULL, renewed_at = NULL, last_ts_ms = GREATEST(last_ts_ms, ${lastMs})
      WHERE service = ${lease.service} AND node = ${lease.node} AND lease_id = ${lease.leaseId}
    `);
  }
}
