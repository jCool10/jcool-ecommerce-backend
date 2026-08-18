import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from './schema';

// DI tokens + types for the Drizzle layer. Type-only imports → no runtime cost,
// importable anywhere without pulling in `pg`/`drizzle-orm` eagerly.

// Injected by repositories as `@Inject(DRIZZLE) db: DrizzleDB`.
export const DRIZZLE = Symbol('DRIZZLE');

// The underlying pg Pool, held by DrizzleModule to close on shutdown.
export const PG_POOL = Symbol('PG_POOL');

export type DrizzleDB = NodePgDatabase<typeof schema>;
export type { Pool as PgPool };

// The transaction handle Drizzle hands the `db.transaction(async (tx) => ...)`
// callback. Type-only, so a port can require "run inside the caller's unit of
// work" (e.g. reserve stock in the place-order transaction) without the callback
// binding leaking Drizzle internals into every signature.
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
