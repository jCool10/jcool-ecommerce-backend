import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { createDbQueryCounterLogger } from '@shared/observability';
import { toError } from '@shared/kernel/to-error';
import * as schema from './schema';
import { DRIZZLE, PG_POOL, type DrizzleDB } from './drizzle.tokens';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService, PinoLogger],
      useFactory: (config: ConfigService, logger: PinoLogger): Pool => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('database.url'),
          // Bounded so a connection spike can't exhaust Postgres backends; a finite
          // connectionTimeoutMillis (pg defaults to 0 = wait forever) makes a saturated pool fail
          // fast instead of piling requests up.
          max: config.get<number>('database.poolMax'),
          connectionTimeoutMillis: config.get<number>('database.connectionTimeoutMs'),
          idleTimeoutMillis: config.get<number>('database.idleTimeoutMs'),
        });
        // Without an 'error' listener a dead idle client crashes the process;
        // log and let pg discard it (DB restart, failover, idle timeout).
        logger.setContext('DrizzleModule');
        pool.on('error', (err: Error) => {
          logger.error({ err: toError(err) }, 'unexpected idle pg client error');
        });
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL, ClsService],
      // The CLS-backed logger only tallies queries per request (no output) so the canonical log
      // line can report db.queries — e.g. to surface an N+1.
      useFactory: (pool: Pool, cls: ClsService): DrizzleDB =>
        drizzle(pool, { schema, logger: createDbQueryCounterLogger(cls) }),
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // onApplicationShutdown (the last hook, after the HTTP server closed) rather than onModuleDestroy
  // (the first): the pool stays alive through the readiness-drain window and until in-flight
  // requests finish, otherwise late requests would 500 at the data layer mid-drain.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
