import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ClsService } from 'nestjs-cls';
import { Pool } from 'pg';
import { createDbQueryCounterLogger } from '@shared/observability';
import * as schema from './schema';
import { DRIZZLE, PG_POOL, type DrizzleDB } from './drizzle.tokens';

/** Global Drizzle provider — one lazily-connecting pg Pool + `db` opened at startup and closed on shutdown, split into PG_POOL (internal, closed here) and DRIZZLE (exported). See docs/engineering-notes.md (Shared — Database (Drizzle + node-postgres)). */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('database.url'),
        });
        // Without an 'error' listener a dead idle client crashes the process;
        // log and let pg discard it (DB restart, failover, idle timeout).
        const logger = new Logger('DrizzleModule');
        pool.on('error', (err: Error) => {
          logger.error(`Unexpected idle pg client error: ${err.message}`, err.stack);
        });
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL, ClsService],
      // The CLS-backed logger only tallies queries per request (no output) so the
      // canonical log line can report db.queries — e.g. to surface an N+1 (Phase 1).
      useFactory: (pool: Pool, cls: ClsService): DrizzleDB =>
        drizzle(pool, { schema, logger: createDbQueryCounterLogger(cls) }),
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Drain on onApplicationShutdown (the last shutdown hook, after the HTTP server has closed) rather
  // than onModuleDestroy (the first): this keeps the pool alive through the readiness-drain grace
  // window and until in-flight requests finish, so a load balancer can stop routing before the DB
  // connections go away — otherwise late requests would 500 at the data layer mid-drain.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
