import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

export const DRIZZLE = Symbol('DRIZZLE');

export const PG_POOL = Symbol('PG_POOL');

export type DrizzleSchema = Record<string, unknown>;

export type DrizzleDBOf<S extends DrizzleSchema> = NodePgDatabase<S>;

// The handle Drizzle hands the `db.transaction(async (tx) => ...)` callback, so a port can require
// "run inside the caller's unit of work" without the callback binding leaking into every signature.
export type DrizzleTxOf<S extends DrizzleSchema> = Parameters<Parameters<DrizzleDBOf<S>['transaction']>[0]>[0];

export type { Pool as PgPool };
