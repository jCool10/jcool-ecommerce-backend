import { Global, Inject, Logger, Module, OnApplicationShutdown, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ClsService } from 'nestjs-cls';
import { Pool } from 'pg';
import { createDbQueryCounterLogger } from '@shared/observability';
import { DRIZZLE, PG_POOL, type DbSchema, type DrizzleDB } from './drizzle.tokens';

@Global()
@Module({})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * The schema is a parameter, not an import: the barrel that collects every context's tables is
   * app-owned (it is what drizzle-kit reads to generate migrations), and a library that imported it
   * would depend on the app it is supposed to serve.
   *
   * `urlKey` is the config path holding this app's connection string. It is a parameter for the
   * same reason: the e2e harness boots several apps in one process off one `process.env`, so the
   * app decides which database it means rather than inheriting a single global name.
   */
  static forRoot(schema: DbSchema, urlKey = 'database.url'): DynamicModule {
    return {
      module: DrizzleModule,
      providers: [
        {
          provide: PG_POOL,
          inject: [ConfigService],
          useFactory: (config: ConfigService): Pool => {
            const pool = new Pool({
              connectionString: config.getOrThrow<string>(urlKey),
              // Bounded so a connection spike can't exhaust Postgres backends; a finite
              // connectionTimeoutMillis (pg defaults to 0 = wait forever) makes a saturated pool fail
              // fast instead of piling requests up.
              max: config.get<number>('database.poolMax'),
              connectionTimeoutMillis: config.get<number>('database.connectionTimeoutMs'),
              idleTimeoutMillis: config.get<number>('database.idleTimeoutMs'),
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
          // The CLS-backed logger only tallies queries per request (no output) so the canonical log
          // line can report db.queries — e.g. to surface an N+1.
          useFactory: (pool: Pool, cls: ClsService): DrizzleDB =>
            drizzle(pool, { schema, logger: createDbQueryCounterLogger(cls) }),
        },
      ],
      exports: [DRIZZLE],
    };
  }

  // onApplicationShutdown (the last hook, after the HTTP server closed) rather than onModuleDestroy
  // (the first): the pool stays alive through the readiness-drain window and until in-flight
  // requests finish, otherwise late requests would 500 at the data layer mid-drain.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
