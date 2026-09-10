import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

export const DRIZZLE = Symbol('DRIZZLE');

export const PG_POOL = Symbol('PG_POOL');

/**
 * The table map an app hands {@link DrizzleModule.forRoot}. Deliberately not the concrete barrel:
 * the barrel collects every context's tables and therefore belongs to an app, while this package is
 * a library every app shares. Nothing reads `db.query.*` (Drizzle's relational API, the only thing
 * the generic parameter feeds), so the erasure costs no call site its types.
 */
export type DbSchema = Record<string, unknown>;

export type DrizzleDB = NodePgDatabase<DbSchema>;
export type { Pool as PgPool };

// The handle Drizzle hands the `db.transaction(async (tx) => ...)` callback, so a port can require
// "run inside the caller's unit of work" without the callback binding leaking into every signature.
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
