import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');

export const PG_POOL = Symbol('PG_POOL');

export type DrizzleDB = NodePgDatabase<typeof schema>;
export type { Pool as PgPool };

// The handle Drizzle hands the `db.transaction(async (tx) => ...)` callback, so a port can require
// "run inside the caller's unit of work" without the callback binding leaking into every signature.
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
