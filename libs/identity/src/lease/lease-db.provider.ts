import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { nodeLeases } from './node-lease.schema';

/**
 * Its own token and its own pool, deliberately not `DrizzleModule.forRoot`: that module is `@Global`
 * and provides the single `DRIZZLE` token, so binding the lease through it would make the app's
 * database and the lease database the same handle for anything that injects `DRIZZLE`.
 *
 * Between Phases 5 and 6 an app therefore holds two pools. Phase 6 deletes this one when the HTTP
 * adapter takes over — after which no application connects to the lease database at all.
 */
export const DRIZZLE_LEASE = Symbol('DRIZZLE_LEASE');
export const LEASE_PG_POOL = Symbol('LEASE_PG_POOL');

export const LEASE_DB_PROVIDERS: Provider[] = [
  {
    provide: LEASE_PG_POOL,
    inject: [ConfigService],
    useFactory: (config: ConfigService): Pool => {
      const pool = new Pool({
        connectionString: config.getOrThrow<string>('identity.lease.databaseUrl'),
        // A handful of statements per TTL, from one holder. Anything above this is a bug, not load.
        max: 2,
        connectionTimeoutMillis: config.get<number>('database.connectionTimeoutMs'),
      });
      const logger = new Logger('LeaseDb');
      pool.on('error', (err: Error) => logger.error(`Unexpected idle lease-pool client error: ${err.message}`));
      return pool;
    },
  },
  {
    provide: DRIZZLE_LEASE,
    inject: [LEASE_PG_POOL],
    useFactory: (pool: Pool): DrizzleDB => drizzle(pool, { schema: { nodeLeases } }),
  },
];
