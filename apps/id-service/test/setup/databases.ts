import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { inject } from 'vitest';
import * as schema from '../../src/database/schema';
import { PostgresLeaseStore } from '../../src/lease/postgres-lease-store';

export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const TEMPLATE_DATABASE = 'id_service_template';

declare module 'vitest' {
  interface ProvidedContext {
    /** The container's own database: only ever used to create others. */
    PG_ADMIN_URL: string;
  }
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** A migrated, seeded database of the caller's own, cloned from the template. */
export async function freshDatabase(): Promise<string> {
  const adminUrl = inject('PG_ADMIN_URL');
  const name = `ids_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`);
  } finally {
    await admin.end();
  }
  return withDatabase(adminUrl, name);
}

export interface LeaseDatabase {
  pool: Pool;
  store: PostgresLeaseStore;
  close(): Promise<void>;
}

export async function openLeaseDatabase(url?: string, poolMax = 10): Promise<LeaseDatabase> {
  const pool = new Pool({ connectionString: url ?? (await freshDatabase()), max: poolMax });
  return { pool, store: new PostgresLeaseStore(drizzle(pool, { schema })), close: () => pool.end() };
}

/** Takes every node but the listed ones, so a claim can only land where the spec expects. */
export async function holdAllNodesExcept(pool: Pool, ...nodeIds: number[]): Promise<void> {
  await pool.query(
    `UPDATE node_leases SET holder = 'elsewhere', generation = generation + 1, lease_until = now() + interval '1 hour'
     WHERE NOT (node_id = ANY($1::smallint[]))`,
    [nodeIds],
  );
}
