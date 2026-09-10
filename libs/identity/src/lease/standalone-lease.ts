import { hostname } from 'node:os';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { DrizzleNodeIdLeaseRepository } from './drizzle-node-id-lease.repository';
import { LeaseHolder, type MintSource } from './lease-holder';
import { nodeLeases } from './node-lease.schema';
import { parseServicePools } from './service-pools';

const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_SKEW_MS = 5_000;
const SCRIPTS_SERVICE = 'scripts';

/**
 * A lease for a process that is not a Nest app. Scripts draw from the `scripts` pool, never an app's,
 * so a seed run can neither narrow the fleet's pool nor be starved by it.
 */
export interface ScriptLease {
  node: number;
  /** Call with the generator built from `node`: it is what the holder fences and reads `lastMs` from. */
  attach: (source: MintSource) => void;
  release: () => Promise<void>;
}

export async function leaseNodeIdForScript(): Promise<ScriptLease> {
  const connectionString = process.env.IDENTITY_LEASE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('IDENTITY_LEASE_DATABASE_URL is required: a script that mints ids must hold a node-id lease');
  }

  const pool = new Pool({ connectionString, max: 2 });
  pool.on('error', (err: Error) => console.error('Lease pool client error:', err.message));

  const db = drizzle(pool, { schema: { nodeLeases } }) as DrizzleDB;
  const skewMs = Number(process.env.IDENTITY_LEASE_SKEW_MS ?? DEFAULT_SKEW_MS);
  const ttlSeconds = Number(process.env.IDENTITY_LEASE_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const pools = parseServicePools(process.env.ID_SERVICE_POOLS ?? 'user:1023,scripts:1023');

  const holder = new LeaseHolder(new DrizzleNodeIdLeaseRepository(db, pools, ttlSeconds, skewMs), {
    service: SCRIPTS_SERVICE,
    holder: `${hostname()}#${process.pid}`,
    ttlSeconds,
    skewMs,
    onLost: () => console.error('Node-id lease lost; the generator is fenced and this run must stop'),
    // A script has no readiness to go red and nothing to drain, so it leaves as soon as it is fenced.
    onGiveUp: () => process.exit(1),
  });
  const node = await holder.start();

  return {
    node,
    attach: (source: MintSource) => holder.attach(source),
    release: async () => {
      await holder.stop();
      await pool.end();
    },
  };
}
